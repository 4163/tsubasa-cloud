import { getDriveClient } from './client.js';
import { buildTsubasaAppProperties } from './appProperties.js';
import {
  getDriveErrorStatus,
  isAuthInvalidError,
  isDriveNotFoundError,
  runBoundedConcurrency,
  withDriveRetry,
} from './errors.js';
import { executeOutboxItem } from './outboxExecutors.js';
import {
  getStmts,
  insertOutboxEntries,
  ITEM_BATCH_CONCURRENCY,
  MAX_OUTBOX_ATTEMPTS,
  notifyAccountDrainWaitersIfIdle,
  registerOutboxDrainTriggers,
  selectNextReadyForAccount,
  type EnqueueOutboxEntry,
  type PendingDriveSyncRow,
} from './outboxQueue.js';

const ACCOUNT_DRAIN_CONCURRENCY = 4;

let drainTimer: NodeJS.Timeout | null = null;
let drainTimerAt = Infinity;
let activeDrainPromise: Promise<void> | null = null;
let drainRequestedDuringRun = false;
let workerStopped = false;

const activeAccountDrains = new Map<string, Promise<void>>();
const accountDrainRescanRequested = new Set<string>();

function isPermanentOutboxError(err: unknown): boolean {
  const status = getDriveErrorStatus(err);
  if (status === 400 || status === 401 || isAuthInvalidError(err)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('not found in auth pool');
}

function computeNextRetryAt(attempts: number): number {
  const backoffMs = Math.min(
    300_000,
    2_000 * (2 ** (attempts - 1)) * (0.8 + Math.random() * 0.4)
  );
  return Math.round(Date.now() + backoffMs);
}

export function enqueueDriveOutbox(entries: EnqueueOutboxEntry[]): string[] {
  if (entries.length === 0) {
    return [];
  }

  const ids = insertOutboxEntries(entries);

  queueMicrotask(() => {
    scheduleOutboxDrain(0);
  });

  return ids;
}

export function scheduleOutboxDrain(delayMs = 0): void {
  if (workerStopped) {
    return;
  }

  const safeDelay = Math.max(0, Math.round(delayMs));
  const targetAt = Date.now() + safeDelay;

  if (activeDrainPromise) {
    if (safeDelay === 0) {
      drainRequestedDuringRun = true;
      return;
    }
    if (drainTimer && drainTimerAt <= targetAt) {
      return;
    }
  }

  if (drainTimer) {
    if (drainTimerAt <= targetAt) {
      return;
    }
    clearTimeout(drainTimer);
    drainTimer = null;
    drainTimerAt = Infinity;
  }

  drainTimerAt = targetAt;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainTimerAt = Infinity;
    void runDrainCycle().catch((err) => {
      console.error('Drive outbox drain cycle failed:', err);
    });
  }, safeDelay);
  drainTimer.unref?.();
}

export function startOutboxWorker(): void {
  workerStopped = false;
  getStmts().resetProcessing.run();
  scheduleOutboxDrain(0);
}

export function stopOutboxWorker(): void {
  workerStopped = true;
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  drainTimerAt = Infinity;
}

async function drainPendingDriveSync(): Promise<void> {
  const stmts = getStmts();
  const dueRows = stmts.selectDuePendingDriveSync.all(
    MAX_OUTBOX_ATTEMPTS,
    Date.now()
  ) as PendingDriveSyncRow[];

  if (dueRows.length === 0) {
    return;
  }

  await runBoundedConcurrency(dueRows, ITEM_BATCH_CONCURRENCY, async (row) => {
    if (stmts.hasPendingOutboxForDriveFile.get(row.account_id, row.drive_file_id)) {
      return;
    }

    const currentFile = stmts.selectActiveFileByDriveId.get(row.account_id, row.drive_file_id) as
      | { id: string; virtual_path: string }
      | undefined;
    if (!currentFile) {
      stmts.deletePendingDriveSync.run(row.account_id, row.drive_file_id);
      return;
    }

    try {
      const drive = getDriveClient(row.account_id);
      await withDriveRetry(() =>
        drive.files.update({
          fileId: row.drive_file_id,
          requestBody: {
            appProperties: buildTsubasaAppProperties({
              virtualPath: currentFile.virtual_path,
              virtualId: currentFile.id,
            }),
          },
          supportsAllDrives: false,
        })
      );
      stmts.deletePendingDriveSync.run(row.account_id, row.drive_file_id);
    } catch (err) {
      if (isDriveNotFoundError(err)) {
        stmts.deletePendingDriveSync.run(row.account_id, row.drive_file_id);
        return;
      }

      const nextAttempts = row.attempts + 1;
      const errMsg = err instanceof Error ? err.message : String(err);

      if (isPermanentOutboxError(err) || nextAttempts >= MAX_OUTBOX_ATTEMPTS) {
        console.error(
          `pending_drive_sync failed permanently for account ${row.account_id}, driveFileId ${row.drive_file_id}:`,
          errMsg
        );
        stmts.markPendingDriveSyncFailed.run(
          MAX_OUTBOX_ATTEMPTS,
          errMsg,
          0,
          row.account_id,
          row.drive_file_id
        );
      } else {
        const nextRetryAt = computeNextRetryAt(nextAttempts);
        stmts.markPendingDriveSyncFailed.run(
          nextAttempts,
          errMsg,
          nextRetryAt,
          row.account_id,
          row.drive_file_id
        );
        scheduleOutboxDrain(Math.max(0, nextRetryAt - Date.now()));
      }
    }
  });
}

export async function runDrainCycle(): Promise<void> {
  if (activeDrainPromise) {
    drainRequestedDuringRun = true;
    return activeDrainPromise;
  }

  activeDrainPromise = (async () => {
    let nextScheduledRetryAt: number | null = null;
    try {
      do {
        drainRequestedDuringRun = false;
        const stmts = getStmts();
        const readyAccountRows = stmts.selectReadyAccounts.all(Date.now()) as Array<{ account_id: string }>;
        const accountIds = readyAccountRows.map((r) => r.account_id);

        if (accountIds.length > 0) {
          await runBoundedConcurrency(accountIds, ACCOUNT_DRAIN_CONCURRENCY, async (accountId) => {
            await drainAccountQueue(accountId);
          });
        }

        await drainPendingDriveSync();
      } while (drainRequestedDuringRun);

      const stmts = getStmts();
      const minOutboxRow = stmts.selectMinNextRetryAt.get() as { min_retry: number | null } | undefined;
      const minPendingSyncRow = stmts.selectMinPendingDriveSyncRetryAt.get(MAX_OUTBOX_ATTEMPTS) as
        | { min_retry: number | null }
        | undefined;

      const candidates = [minOutboxRow?.min_retry, minPendingSyncRow?.min_retry].filter(
        (v): v is number => v !== null && v !== undefined
      );
      if (candidates.length > 0) {
        nextScheduledRetryAt = Math.min(...candidates);
      }
    } finally {
      activeDrainPromise = null;
      if (nextScheduledRetryAt !== null) {
        scheduleOutboxDrain(Math.max(0, nextScheduledRetryAt - Date.now()));
      }
    }
  })();

  return activeDrainPromise;
}

export async function drainAccountQueue(accountId: string): Promise<void> {
  const existing = activeAccountDrains.get(accountId);
  if (existing) {
    accountDrainRescanRequested.add(accountId);
    return existing;
  }

  const runPromise = (async () => {
    const stmts = getStmts();

    do {
      accountDrainRescanRequested.delete(accountId);

      while (true) {
        const row = selectNextReadyForAccount(accountId, Date.now());
        if (!row) {
          break;
        }

        stmts.markProcessing.run(row.id);

        try {
          await executeOutboxItem(row);
          stmts.deleteById.run(row.id);
        } catch (err) {
          const nextAttempts = row.attempts + 1;
          const errMsg = err instanceof Error ? err.message : String(err);

          if (isPermanentOutboxError(err) || nextAttempts >= MAX_OUTBOX_ATTEMPTS) {
            console.error(
              `Drive outbox item ${row.id} (${row.op_type}, account ${row.account_id}) marked dead after ${nextAttempts} attempt(s):`,
              errMsg
            );
            stmts.markDead.run(nextAttempts, errMsg, row.id);
          } else {
            const nextRetryAt = computeNextRetryAt(nextAttempts);
            stmts.markFailed.run(nextAttempts, nextRetryAt, errMsg, row.id);
            scheduleOutboxDrain(Math.max(0, nextRetryAt - Date.now()));
          }
        }
      }
    } while (accountDrainRescanRequested.has(accountId));

    notifyAccountDrainWaitersIfIdle(accountId);
  })().finally(() => {
    activeAccountDrains.delete(accountId);
    accountDrainRescanRequested.delete(accountId);
  });

  activeAccountDrains.set(accountId, runPromise);
  return runPromise;
}

registerOutboxDrainTriggers({
  scheduleDrain: scheduleOutboxDrain,
  drainAccount: drainAccountQueue,
});
