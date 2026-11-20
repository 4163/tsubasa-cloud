import { sqlite } from '../db/index.js';
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

export interface DrainOutboxOptions {
  timeoutMs?: number;
  /** Only wait for outbox rows inserted after this SQLite rowid (from getMaxOutboxId()). */
  minId?: number;
  /** Alias for minId. */
  sinceRowId?: number;
}

export interface DrainOutboxResult {
  drained: boolean;
  remaining: number;
  pending: number;
  failed: number;
  dead: number;
  timedOut: boolean;
}

const ACCOUNT_DRAIN_CONCURRENCY = 4;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

let drainTimer: NodeJS.Timeout | null = null;
let drainTimerAt = Infinity;
let activeDrainPromise: Promise<void> | null = null;
let drainRequestedDuringRun = false;
let workerStopped = false;

const activeAccountDrains = new Map<string, Promise<void>>();
const accountDrainRescanRequested = new Set<string>();
const stopListeners = new Set<() => void>();

type SqliteStmt = ReturnType<typeof sqlite.prepare<any[], any>>;

let standaloneStmts: {
  maxRowId: SqliteStmt;
  countsAll: SqliteStmt;
  countsSince: SqliteStmt;
  minRetryAll: SqliteStmt;
  minRetrySince: SqliteStmt;
} | null = null;

function getStandaloneStmts() {
  if (!standaloneStmts) {
    standaloneStmts = {
      maxRowId: sqlite.prepare('SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM drive_outbox'),
      countsAll: sqlite.prepare(
        `SELECT status, COUNT(*) AS cnt FROM drive_outbox GROUP BY status`
      ),
      countsSince: sqlite.prepare(
        `SELECT status, COUNT(*) AS cnt FROM drive_outbox WHERE rowid > ? GROUP BY status`
      ),
      minRetryAll: sqlite.prepare(
        `SELECT MIN(next_retry_at) AS min_retry
         FROM drive_outbox
         WHERE status IN ('pending', 'failed')`
      ),
      minRetrySince: sqlite.prepare(
        `SELECT MIN(next_retry_at) AS min_retry
         FROM drive_outbox
         WHERE rowid > ? AND status IN ('pending', 'failed')`
      ),
    };
  }
  return standaloneStmts;
}

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

export function getMaxOutboxId(): number {
  const row = getStandaloneStmts().maxRowId.get() as { max_rowid: number } | undefined;
  return Number(row?.max_rowid ?? 0);
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
  drainRequestedDuringRun = false;
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  drainTimerAt = Infinity;

  for (const listener of Array.from(stopListeners)) {
    listener();
  }
}

async function drainPendingDriveSync(): Promise<void> {
  if (workerStopped) {
    return;
  }

  const stmts = getStmts();
  const dueRows = stmts.selectDuePendingDriveSync.all(
    MAX_OUTBOX_ATTEMPTS,
    Date.now()
  ) as PendingDriveSyncRow[];

  if (dueRows.length === 0) {
    return;
  }

  await runBoundedConcurrency(dueRows, ITEM_BATCH_CONCURRENCY, async (row) => {
    if (workerStopped) {
      return;
    }
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
  if (workerStopped) {
    return;
  }

  if (activeDrainPromise) {
    drainRequestedDuringRun = true;
    return activeDrainPromise;
  }

  activeDrainPromise = (async () => {
    let nextScheduledRetryAt: number | null = null;
    try {
      do {
        drainRequestedDuringRun = false;
        if (workerStopped) {
          break;
        }
        const stmts = getStmts();
        const readyAccountRows = stmts.selectReadyAccounts.all(Date.now()) as Array<{ account_id: string }>;
        const accountIds = readyAccountRows.map((r) => r.account_id);

        if (accountIds.length > 0) {
          await runBoundedConcurrency(accountIds, ACCOUNT_DRAIN_CONCURRENCY, async (accountId) => {
            if (!workerStopped) {
              await drainAccountQueue(accountId);
            }
          });
        }

        if (!workerStopped) {
          await drainPendingDriveSync();
        }
      } while (drainRequestedDuringRun && !workerStopped);

      if (!workerStopped) {
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
      }
    } finally {
      activeDrainPromise = null;
      if (!workerStopped && nextScheduledRetryAt !== null) {
        scheduleOutboxDrain(Math.max(0, nextScheduledRetryAt - Date.now()));
      }
    }
  })();

  return activeDrainPromise;
}

export async function drainAccountQueue(accountId: string): Promise<void> {
  if (workerStopped) {
    return;
  }

  const existing = activeAccountDrains.get(accountId);
  if (existing) {
    accountDrainRescanRequested.add(accountId);
    return existing;
  }

  const runPromise = (async () => {
    const stmts = getStmts();

    do {
      accountDrainRescanRequested.delete(accountId);

      while (!workerStopped) {
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
    } while (accountDrainRescanRequested.has(accountId) && !workerStopped);

    notifyAccountDrainWaitersIfIdle(accountId);
  })().finally(() => {
    activeAccountDrains.delete(accountId);
    accountDrainRescanRequested.delete(accountId);
  });

  activeAccountDrains.set(accountId, runPromise);
  return runPromise;
}

function readOutboxScopeCounts(minRowId?: number): {
  pending: number;
  processing: number;
  failed: number;
  dead: number;
} {
  const stmts = getStandaloneStmts();
  const rows = (
    minRowId !== undefined ? stmts.countsSince.all(minRowId) : stmts.countsAll.all()
  ) as Array<{ status: 'pending' | 'processing' | 'failed' | 'dead'; cnt: number }>;

  const counts = { pending: 0, processing: 0, failed: 0, dead: 0 };
  for (const row of rows) {
    counts[row.status] = Number(row.cnt);
  }
  return counts;
}

function readMinRetryAt(minRowId?: number): number | null {
  const stmts = getStandaloneStmts();
  const row = (
    minRowId !== undefined ? stmts.minRetrySince.get(minRowId) : stmts.minRetryAll.get()
  ) as { min_retry: number | null } | undefined;
  return row?.min_retry ?? null;
}

async function waitInterruptible(ms: number): Promise<void> {
  if (ms <= 0 || workerStopped) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onStop = () => {
      clearTimeout(timer);
      stopListeners.delete(onStop);
      resolve();
    };
    const timer = setTimeout(() => {
      stopListeners.delete(onStop);
      resolve();
    }, ms);
    stopListeners.add(onStop);
  });
}

async function raceWithTimeout(promise: Promise<unknown>, remainingMs: number): Promise<boolean> {
  if (remainingMs <= 0) {
    return false;
  }
  let timer: NodeJS.Timeout | null = null;
  let onStop: (() => void) | null = null;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        onStop = () => resolve(false);
        stopListeners.add(onStop);
        timer = setTimeout(() => resolve(false), remainingMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (onStop) {
      stopListeners.delete(onStop);
    }
  }
}

export async function drainOutbox(options: DrainOutboxOptions = {}): Promise<DrainOutboxResult> {
  const minRowId = options.minId ?? options.sinceRowId;
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;

  const buildResult = (timedOut: boolean): DrainOutboxResult => {
    const c = readOutboxScopeCounts(minRowId);
    const remaining = c.pending + c.processing + c.failed;
    return {
      drained: remaining === 0,
      remaining,
      pending: c.pending + c.processing,
      failed: c.failed,
      dead: c.dead,
      timedOut,
    };
  };

  const initialCounts = readOutboxScopeCounts(minRowId);
  const initialRemaining = initialCounts.pending + initialCounts.processing + initialCounts.failed;
  if (initialRemaining === 0 && !activeDrainPromise && activeAccountDrains.size === 0) {
    return buildResult(false);
  }

  // Recover orphaned 'processing' rows left by a previous crashed writer when no drain is active in-process.
  if (!activeDrainPromise && activeAccountDrains.size === 0) {
    getStmts().resetProcessing.run();
  }

  while (!workerStopped) {
    const counts = readOutboxScopeCounts(minRowId);
    const remaining = counts.pending + counts.processing + counts.failed;

    if (remaining === 0 && !activeDrainPromise && activeAccountDrains.size === 0) {
      return buildResult(false);
    }

    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0) {
      return buildResult(remaining > 0);
    }

    if (activeDrainPromise || activeAccountDrains.size > 0) {
      const inflight = Promise.allSettled([
        ...(activeDrainPromise ? [activeDrainPromise] : []),
        ...Array.from(activeAccountDrains.values()),
      ]);
      const settled = await raceWithTimeout(inflight, timeLeft);
      if (!settled) {
        return buildResult(true);
      }
      continue;
    }

    const nextRetryAt = readMinRetryAt(minRowId);
    const now = Date.now();

    if (nextRetryAt !== null && nextRetryAt > now) {
      const waitMs = Math.min(nextRetryAt - now, deadline - now);
      if (waitMs <= 0) {
        return buildResult(true);
      }
      await waitInterruptible(waitMs);
      continue;
    }

    const cycleDone = await raceWithTimeout(runDrainCycle(), deadline - Date.now());
    if (!cycleDone) {
      return buildResult(true);
    }

    // If a scoped row is head-of-line blocked behind an older failed row waiting on backoff,
    // wait until that blocker's retry window (or a brief cap) instead of spinning.
    const afterCounts = readOutboxScopeCounts(minRowId);
    const afterRemaining = afterCounts.pending + afterCounts.processing + afterCounts.failed;
    if (afterRemaining > 0 && afterRemaining === remaining && !activeDrainPromise && activeAccountDrains.size === 0) {
      const afterNow = Date.now();
      const globalRetryRow = getStmts().selectMinNextRetryAt.get() as { min_retry: number | null } | undefined;
      const blockerWait =
        globalRetryRow?.min_retry && globalRetryRow.min_retry > afterNow
          ? globalRetryRow.min_retry - afterNow
          : 50;
      const waitMs = Math.min(blockerWait, Math.max(0, deadline - afterNow));
      if (waitMs <= 0) {
        return buildResult(true);
      }
      await waitInterruptible(waitMs);
    }
  }

  return buildResult(false);
}

registerOutboxDrainTriggers({
  scheduleDrain: scheduleOutboxDrain,
  drainAccount: drainAccountQueue,
});
