import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sqlite } from '../db/index.js';
import {
  getAccountRootFolderId,
  getDriveClient,
  getDriveErrorStatus,
  isAuthInvalidError,
  isDriveNotFoundError,
  markAccountQuotaDecreased,
  resolveRemoteFolderTree,
  runBoundedConcurrency,
  withDriveRetry,
} from './client.js';
import { clearRemoteFolderCache, ensureRemoteFolderHierarchy } from './mirror.js';

export type DriveOutboxOpType =
  | 'file_move'
  | 'file_rename'
  | 'file_trash'
  | 'file_restore'
  | 'file_delete'
  | 'folder_rename_account'
  | 'folder_move_account'
  | 'folder_merge_account'
  | 'folder_trash_account'
  | 'clear_share_account';

export interface FileMoveOutboxPayload {
  fileId: string;
  driveFileId: string;
  newVirtualPath: string;
  destFolder: string;
  wasTrashed: boolean;
  newName?: string;
}

export interface FileRenameOutboxPayload {
  fileId: string;
  driveFileId: string;
  newName: string;
  newVirtualPath: string;
}

export interface FileTrashOutboxPayload {
  fileId: string;
  driveFileId: string;
}

export interface FileRestoreOutboxPayload {
  fileId: string;
  driveFileId: string;
  restoredPath?: string;
  newVirtualPath?: string;
  newName?: string;
}

export interface FileDeleteOutboxPayload {
  fileId: string;
  driveFileId: string;
}

export interface FolderRenameAccountOutboxPayload {
  oldFolderPath: string;
  newFolderPath: string;
  newName: string;
  files: Array<{ id: string; driveFileId: string; newVirtualPath: string }>;
}

export interface FolderMoveAccountOutboxPayload {
  oldFolderPath: string;
  newFolderPath: string;
  destFolder: string;
  files: Array<{ id: string; driveFileId: string; newVirtualPath: string }>;
}

export interface FolderMergeAccountOutboxPayload {
  oldFolderPath: string;
  sourceFolderPathsToPrune: string[];
  ensuredFolderPaths: string[];
  files: Array<{
    id: string;
    driveFileId: string;
    newVirtualPath: string;
    destFolder: string;
    wasTrashed: boolean;
    newName?: string;
  }>;
}

export interface FolderTrashAccountOutboxPayload {
  normPath: string;
  files: Array<{ id: string; driveFileId: string }>;
}

export interface ClearShareAccountOutboxPayload {
  sharePoolId: number;
  rootFolderId: string | null;
}

export interface EnqueueOutboxEntry {
  accountId: string;
  poolId?: number | null;
  opType: DriveOutboxOpType;
  driveFileId?: string | null;
  payload: unknown;
}

interface OutboxRow {
  id: string;
  account_id: string;
  pool_id: number | null;
  op_type: DriveOutboxOpType;
  drive_file_id: string | null;
  payload_json: string;
  status: 'pending' | 'processing' | 'failed' | 'dead';
  attempts: number;
  next_retry_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type BackgroundJobKind = 'account_evacuate' | 'oauth_cold_sync';
export type BackgroundJobStatus = 'running' | 'completed' | 'failed';

export interface TrackedBackgroundJob<T = unknown> {
  id: string;
  kind: BackgroundJobKind;
  targetId: string;
  status: BackgroundJobStatus;
  startedAt: number;
  finishedAt: number | null;
  result?: T;
  error?: string;
}

export interface OutboxStatusSummary {
  counts: {
    pending: number;
    processing: number;
    failed: number;
    dead: number;
  };
  recentFailures: Array<{
    id: string;
    accountId: string;
    poolId: number | null;
    opType: DriveOutboxOpType;
    driveFileId: string | null;
    status: 'failed' | 'dead';
    attempts: number;
    nextRetryAt: number;
    lastError: string | null;
    createdAt: number;
    updatedAt: number;
  }>;
  jobs: TrackedBackgroundJob[];
}

const MAX_OUTBOX_ATTEMPTS = 8;
const ACCOUNT_DRAIN_CONCURRENCY = 4;
const ITEM_BATCH_CONCURRENCY = 8;
const MAX_FINISHED_JOBS = 50;

type SqliteStmt = ReturnType<typeof sqlite.prepare<any[], any>>;

interface PendingDriveSyncRow {
  account_id: string;
  drive_file_id: string;
  virtual_path: string;
  file_id: string;
  attempts: number;
}

let cachedStmts: {
  insert: SqliteStmt;
  resetProcessing: SqliteStmt;
  selectReadyAccounts: SqliteStmt;
  selectActiveForAccount: SqliteStmt;
  markProcessing: SqliteStmt;
  deleteById: SqliteStmt;
  markFailed: SqliteStmt;
  markDead: SqliteStmt;
  selectMinNextRetryAt: SqliteStmt;
  countActiveForAccount: SqliteStmt;
  countDeadForAccount: SqliteStmt;
  selectFileVirtualPath: SqliteStmt;
  selectPendingDeleteDriveIds: SqliteStmt;
  selectPendingDriveRows: SqliteStmt;
  selectStatusCounts: SqliteStmt;
  selectRecentFailures: SqliteStmt;
  retryAll: SqliteStmt;
  retryByAccount: SqliteStmt;
  flushFailedForAccount: SqliteStmt;
  selectDuePendingDriveSync: SqliteStmt;
  deletePendingDriveSync: SqliteStmt;
  markPendingDriveSyncFailed: SqliteStmt;
  selectMinPendingDriveSyncRetryAt: SqliteStmt;
} | null = null;

function getStmts() {
  if (cachedStmts) {
    return cachedStmts;
  }

  cachedStmts = {
    insert: sqlite.prepare(
      `INSERT INTO drive_outbox (
        id, account_id, pool_id, op_type, drive_file_id, payload_json,
        status, attempts, next_retry_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, unixepoch(), unixepoch())`
    ),
    resetProcessing: sqlite.prepare(
      `UPDATE drive_outbox SET status = 'pending', updated_at = unixepoch() WHERE status = 'processing'`
    ),
    selectReadyAccounts: sqlite.prepare(
      `SELECT DISTINCT account_id FROM drive_outbox
       WHERE status IN ('pending', 'failed') AND next_retry_at <= ?`
    ),
    selectActiveForAccount: sqlite.prepare(
      `SELECT * FROM drive_outbox
       WHERE account_id = ? AND status IN ('pending', 'processing', 'failed')
       ORDER BY created_at ASC, rowid ASC`
    ),
    markProcessing: sqlite.prepare(
      `UPDATE drive_outbox SET status = 'processing', updated_at = unixepoch() WHERE id = ?`
    ),
    deleteById: sqlite.prepare(`DELETE FROM drive_outbox WHERE id = ?`),
    markFailed: sqlite.prepare(
      `UPDATE drive_outbox
       SET status = 'failed', attempts = ?, next_retry_at = ?, last_error = ?, updated_at = unixepoch()
       WHERE id = ?`
    ),
    markDead: sqlite.prepare(
      `UPDATE drive_outbox
       SET status = 'dead', attempts = ?, last_error = ?, updated_at = unixepoch()
       WHERE id = ?`
    ),
    selectMinNextRetryAt: sqlite.prepare(
      `SELECT MIN(next_retry_at) AS min_retry FROM drive_outbox WHERE status = 'failed'`
    ),
    countActiveForAccount: sqlite.prepare(
      `SELECT COUNT(*) AS cnt FROM drive_outbox WHERE account_id = ? AND status IN ('pending', 'processing', 'failed')`
    ),
    countDeadForAccount: sqlite.prepare(
      `SELECT COUNT(*) AS cnt FROM drive_outbox WHERE account_id = ? AND status = 'dead'`
    ),
    selectFileVirtualPath: sqlite.prepare(
      `SELECT virtual_path FROM files WHERE id = ?`
    ),
    selectPendingDeleteDriveIds: sqlite.prepare(
      `SELECT drive_file_id FROM drive_outbox
       WHERE account_id = ? AND op_type = 'file_delete'
         AND status IN ('pending', 'processing', 'failed') AND drive_file_id IS NOT NULL`
    ),
    selectPendingDriveRows: sqlite.prepare(
      `SELECT op_type, drive_file_id, payload_json FROM drive_outbox
       WHERE account_id = ? AND status IN ('pending', 'processing', 'failed')`
    ),
    selectStatusCounts: sqlite.prepare(
      `SELECT status, COUNT(*) AS cnt FROM drive_outbox GROUP BY status`
    ),
    selectRecentFailures: sqlite.prepare(
      `SELECT id, account_id, pool_id, op_type, drive_file_id, status, attempts, next_retry_at, last_error, created_at, updated_at
       FROM drive_outbox
       WHERE status IN ('failed', 'dead')
       ORDER BY updated_at DESC, rowid DESC
       LIMIT 50`
    ),
    retryAll: sqlite.prepare(
      `UPDATE drive_outbox
       SET status = 'pending', attempts = 0, next_retry_at = 0, last_error = NULL, updated_at = unixepoch()
       WHERE status IN ('failed', 'dead')`
    ),
    retryByAccount: sqlite.prepare(
      `UPDATE drive_outbox
       SET status = 'pending', attempts = 0, next_retry_at = 0, last_error = NULL, updated_at = unixepoch()
       WHERE account_id = ? AND status IN ('failed', 'dead')`
    ),
    flushFailedForAccount: sqlite.prepare(
      `UPDATE drive_outbox
       SET next_retry_at = 0, updated_at = unixepoch()
       WHERE account_id = ? AND status = 'failed'`
    ),
    selectDuePendingDriveSync: sqlite.prepare(
      `SELECT account_id, drive_file_id, virtual_path, file_id, attempts
       FROM pending_drive_sync
       WHERE attempts < ? AND next_retry_at <= ?
       ORDER BY next_retry_at ASC, created_at ASC`
    ),
    deletePendingDriveSync: sqlite.prepare(
      `DELETE FROM pending_drive_sync WHERE account_id = ? AND drive_file_id = ?`
    ),
    markPendingDriveSyncFailed: sqlite.prepare(
      `UPDATE pending_drive_sync
       SET attempts = ?, last_error = ?, next_retry_at = ?
       WHERE account_id = ? AND drive_file_id = ?`
    ),
    selectMinPendingDriveSyncRetryAt: sqlite.prepare(
      `SELECT MIN(next_retry_at) AS min_retry
       FROM pending_drive_sync
       WHERE attempts < ? AND next_retry_at > 0`
    ),
  };

  return cachedStmts;
}

let drainTimer: NodeJS.Timeout | null = null;
let drainTimerAt = Infinity;
let activeDrainPromise: Promise<void> | null = null;
let drainRequestedDuringRun = false;
let workerStopped = false;

const accountDrainWaiters = new Map<string, Array<() => void>>();
const activeAccountDrains = new Map<string, Promise<void>>();
const accountDrainRescanRequested = new Set<string>();
const backgroundJobs = new Map<string, TrackedBackgroundJob>();

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

interface OutboxTargets {
  driveIds: Set<string>;
  folderPaths: string[];
  isGlobal: boolean;
}

function extractOutboxTargets(row: OutboxRow): OutboxTargets {
  const driveIds = new Set<string>();
  const folderPaths: string[] = [];
  let isGlobal = row.op_type === 'clear_share_account';

  if (row.drive_file_id) {
    driveIds.add(row.drive_file_id);
  }

  try {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown> | null;
    if (payload && typeof payload === 'object') {
      if (typeof payload.driveFileId === 'string' && payload.driveFileId) {
        driveIds.add(payload.driveFileId);
      }
      if (Array.isArray(payload.files)) {
        for (const f of payload.files) {
          if (f && typeof f === 'object') {
            const fileObj = f as Record<string, unknown>;
            if (typeof fileObj.driveFileId === 'string' && fileObj.driveFileId) {
              driveIds.add(fileObj.driveFileId);
            }
            if (typeof fileObj.destFolder === 'string' && fileObj.destFolder) {
              folderPaths.push(fileObj.destFolder);
            }
          }
        }
      }

      switch (row.op_type) {
        case 'file_move': {
          if (typeof payload.destFolder === 'string' && payload.destFolder) {
            folderPaths.push(payload.destFolder);
          }
          if (typeof payload.newVirtualPath === 'string' && payload.newVirtualPath) {
            folderPaths.push(path.posix.dirname(payload.newVirtualPath));
          }
          break;
        }
        case 'file_rename': {
          if (typeof payload.newVirtualPath === 'string' && payload.newVirtualPath) {
            folderPaths.push(path.posix.dirname(payload.newVirtualPath));
          }
          break;
        }
        case 'file_restore': {
          const target =
            typeof payload.restoredPath === 'string'
              ? payload.restoredPath
              : typeof payload.newVirtualPath === 'string'
                ? payload.newVirtualPath
                : undefined;
          if (target) {
            folderPaths.push(path.posix.dirname(target));
          }
          break;
        }
        case 'folder_rename_account': {
          if (typeof payload.oldFolderPath === 'string') folderPaths.push(payload.oldFolderPath);
          if (typeof payload.newFolderPath === 'string') folderPaths.push(payload.newFolderPath);
          break;
        }
        case 'folder_move_account': {
          if (typeof payload.oldFolderPath === 'string') folderPaths.push(payload.oldFolderPath);
          if (typeof payload.newFolderPath === 'string') folderPaths.push(payload.newFolderPath);
          if (typeof payload.destFolder === 'string') folderPaths.push(payload.destFolder);
          break;
        }
        case 'folder_merge_account': {
          if (typeof payload.oldFolderPath === 'string') folderPaths.push(payload.oldFolderPath);
          if (Array.isArray(payload.sourceFolderPathsToPrune)) {
            for (const p of payload.sourceFolderPathsToPrune) {
              if (typeof p === 'string') folderPaths.push(p);
            }
          }
          if (Array.isArray(payload.ensuredFolderPaths)) {
            for (const p of payload.ensuredFolderPaths) {
              if (typeof p === 'string') folderPaths.push(p);
            }
          }
          break;
        }
        case 'folder_trash_account': {
          if (typeof payload.normPath === 'string') folderPaths.push(payload.normPath);
          break;
        }
      }
    }
  } catch {
    // Ignore malformed payload JSON during conflict analysis
  }

  return { driveIds, folderPaths, isGlobal };
}

function folderPathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a !== '/' && b.startsWith(a + '/')) return true;
  if (b !== '/' && a.startsWith(b + '/')) return true;
  return false;
}

function targetsOverlap(a: OutboxTargets, b: OutboxTargets): boolean {
  if (a.isGlobal || b.isGlobal) {
    return true;
  }
  for (const id of a.driveIds) {
    if (b.driveIds.has(id)) {
      return true;
    }
  }
  for (const pathA of a.folderPaths) {
    for (const pathB of b.folderPaths) {
      if (folderPathsOverlap(pathA, pathB)) {
        return true;
      }
    }
  }
  return false;
}

function selectNextReadyForAccount(accountId: string, now: number): OutboxRow | undefined {
  const rows = getStmts().selectActiveForAccount.all(accountId) as OutboxRow[];
  const blockedTargets: OutboxTargets[] = [];

  for (const row of rows) {
    const targets = extractOutboxTargets(row);
    const isReady =
      (row.status === 'pending' || row.status === 'failed') && row.next_retry_at <= now;

    if (!isReady) {
      blockedTargets.push(targets);
      continue;
    }

    if (blockedTargets.some((blocked) => targetsOverlap(targets, blocked))) {
      blockedTargets.push(targets);
      continue;
    }

    return row;
  }

  return undefined;
}

function notifyAccountDrainWaitersIfIdle(accountId: string): void {
  const waiters = accountDrainWaiters.get(accountId);
  if (!waiters || waiters.length === 0) {
    return;
  }
  const row = getStmts().countActiveForAccount.get(accountId) as { cnt: number } | undefined;
  if ((row?.cnt ?? 0) === 0) {
    accountDrainWaiters.delete(accountId);
    for (const resolve of waiters) {
      resolve();
    }
  }
}

export function enqueueDriveOutbox(entries: EnqueueOutboxEntry[]): string[] {
  if (entries.length === 0) {
    return [];
  }

  const stmts = getStmts();
  const ids: string[] = [];

  for (const entry of entries) {
    const id = randomUUID();
    stmts.insert.run(
      id,
      entry.accountId,
      entry.poolId ?? null,
      entry.opType,
      entry.driveFileId ?? null,
      JSON.stringify(entry.payload)
    );
    ids.push(id);
  }

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
    try {
      const drive = getDriveClient(row.account_id);
      await withDriveRetry(() =>
        drive.files.update({
          fileId: row.drive_file_id,
          requestBody: {
            appProperties: {
              tsubasa_managed: 'true',
              tsubasa_virtual_path: row.virtual_path,
              tsubasa_virtual_id: row.file_id,
            },
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

async function runDrainCycle(): Promise<void> {
  if (activeDrainPromise) {
    drainRequestedDuringRun = true;
    return activeDrainPromise;
  }

  activeDrainPromise = (async () => {
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
        const nextRetryAt = Math.min(...candidates);
        scheduleOutboxDrain(Math.max(0, nextRetryAt - Date.now()));
      }
    } finally {
      activeDrainPromise = null;
    }
  })();

  return activeDrainPromise;
}

async function drainAccountQueue(accountId: string): Promise<void> {
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

export async function deleteRemoteFileIgnoreNotFound(
  drive: ReturnType<typeof getDriveClient>,
  fileId: string
): Promise<void> {
  try {
    await withDriveRetry(() =>
      drive.files.delete({
        fileId,
        supportsAllDrives: false,
      })
    );
  } catch (err) {
    if (!isDriveNotFoundError(err)) {
      throw err;
    }
  }
}

async function trashDriveFileIgnoreNotFound(
  drive: ReturnType<typeof getDriveClient>,
  fileId: string
): Promise<void> {
  try {
    await withDriveRetry(() =>
      drive.files.update({
        fileId,
        requestBody: { trashed: true },
        supportsAllDrives: false,
      })
    );
  } catch (err) {
    if (!isDriveNotFoundError(err)) {
      throw err;
    }
  }
}

async function syncDescendantFolderAndFilePaths(
  drive: ReturnType<typeof getDriveClient>,
  rootFolderId: string,
  tree: Awaited<ReturnType<typeof resolveRemoteFolderTree>>,
  oldFolderPath: string,
  newFolderPath: string,
  files: Array<{ id: string; driveFileId: string; newVirtualPath: string }>
): Promise<void> {
  const descendantFolders = tree.folders.filter((sub) =>
    sub.virtualPath.startsWith(oldFolderPath + '/')
  );
  await runBoundedConcurrency(descendantFolders, ITEM_BATCH_CONCURRENCY, async (sub) => {
    const subNewPath = newFolderPath + sub.virtualPath.slice(oldFolderPath.length);
    await withDriveRetry(() =>
      drive.files.update({
        fileId: sub.id,
        requestBody: {
          appProperties: {
            tsubasa_managed: 'true',
            tsubasa_folder_path: subNewPath,
          },
        },
        supportsAllDrives: false,
      })
    );
  });

  clearRemoteFolderCache(rootFolderId);

  await runBoundedConcurrency(files, ITEM_BATCH_CONCURRENCY, async (f) => {
    if (!f.driveFileId) return;
    await withDriveRetry(() =>
      drive.files.update({
        fileId: f.driveFileId,
        requestBody: {
          appProperties: {
            tsubasa_managed: 'true',
            tsubasa_virtual_path: f.newVirtualPath,
          },
        },
        supportsAllDrives: false,
      })
    );
  });
}

async function executeOutboxItem(row: OutboxRow): Promise<void> {
  const payload = JSON.parse(row.payload_json) as unknown;
  const drive = getDriveClient(row.account_id);

  switch (row.op_type) {
    case 'file_move': {
      const p = payload as FileMoveOutboxPayload;
      const rootFolderId = await getAccountRootFolderId(row.account_id);
      const targetRemoteFolderId = await ensureRemoteFolderHierarchy(drive, rootFolderId, p.destFolder);
      try {
        const fileRes = await withDriveRetry(() =>
          drive.files.get({
            fileId: p.driveFileId,
            fields: 'parents',
            supportsAllDrives: false,
          })
        );
        const prevParents = (fileRes.data.parents || []).join(',');
        await withDriveRetry(() =>
          drive.files.update({
            fileId: p.driveFileId,
            addParents: targetRemoteFolderId,
            ...(prevParents ? { removeParents: prevParents } : {}),
            requestBody: {
              ...(p.wasTrashed ? { trashed: false } : {}),
              ...(p.newName ? { name: p.newName } : {}),
              appProperties: {
                tsubasa_managed: 'true',
                tsubasa_virtual_path: p.newVirtualPath,
                tsubasa_virtual_id: p.fileId,
              },
            },
            supportsAllDrives: false,
          })
        );
      } catch (err) {
        if (isDriveNotFoundError(err)) return;
        throw err;
      }
      return;
    }

    case 'file_rename': {
      const p = payload as FileRenameOutboxPayload;
      try {
        await withDriveRetry(() =>
          drive.files.update({
            fileId: p.driveFileId,
            requestBody: {
              name: p.newName,
              appProperties: {
                tsubasa_managed: 'true',
                tsubasa_virtual_path: p.newVirtualPath,
                tsubasa_virtual_id: p.fileId,
              },
            },
            supportsAllDrives: false,
          })
        );
      } catch (err) {
        if (isDriveNotFoundError(err)) return;
        throw err;
      }
      return;
    }

    case 'file_trash': {
      const p = payload as FileTrashOutboxPayload;
      await trashDriveFileIgnoreNotFound(drive, p.driveFileId);
      return;
    }

    case 'file_restore': {
      const p = payload as FileRestoreOutboxPayload;
      let targetPath = p.restoredPath ?? p.newVirtualPath;
      if (!targetPath) {
        const fileRow = getStmts().selectFileVirtualPath.get(p.fileId) as
          | { virtual_path: string }
          | undefined;
        targetPath = fileRow?.virtual_path;
      }

      try {
        let addParents: string | undefined;
        let removeParents: string | undefined;

        if (targetPath) {
          const parentDir = path.posix.dirname(targetPath);
          if (parentDir !== '/' && parentDir !== '.') {
            const rootFolderId = await getAccountRootFolderId(row.account_id);
            const targetRemoteFolderId = await ensureRemoteFolderHierarchy(drive, rootFolderId, parentDir);
            const fileRes = await withDriveRetry(() =>
              drive.files.get({
                fileId: p.driveFileId,
                fields: 'parents',
                supportsAllDrives: false,
              })
            );
            const currentParents = fileRes.data.parents || [];
            if (!(currentParents.length === 1 && currentParents[0] === targetRemoteFolderId)) {
              addParents = targetRemoteFolderId;
              if (currentParents.length > 0) {
                removeParents = currentParents.join(',');
              }
            }
          }
        }

        await withDriveRetry(() =>
          drive.files.update({
            fileId: p.driveFileId,
            ...(addParents ? { addParents } : {}),
            ...(removeParents ? { removeParents } : {}),
            requestBody: {
              trashed: false,
              ...(p.newName ? { name: p.newName } : {}),
              ...(targetPath
                ? {
                    appProperties: {
                      tsubasa_managed: 'true',
                      tsubasa_virtual_path: targetPath,
                      tsubasa_virtual_id: p.fileId,
                    },
                  }
                : {}),
            },
            supportsAllDrives: false,
          })
        );
      } catch (err) {
        if (isDriveNotFoundError(err)) return;
        throw err;
      }
      return;
    }

    case 'file_delete': {
      const p = payload as FileDeleteOutboxPayload;
      await deleteRemoteFileIgnoreNotFound(drive, p.driveFileId);
      markAccountQuotaDecreased(row.account_id);
      return;
    }

    case 'folder_rename_account': {
      const p = payload as FolderRenameAccountOutboxPayload;
      const rootFolderId = await getAccountRootFolderId(row.account_id);
      const tree = await resolveRemoteFolderTree(drive, rootFolderId);

      const remoteFolderId = tree.folderIdByPath.get(p.oldFolderPath);
      if (remoteFolderId) {
        await withDriveRetry(() =>
          drive.files.update({
            fileId: remoteFolderId,
            requestBody: {
              name: p.newName,
              appProperties: {
                tsubasa_managed: 'true',
                tsubasa_folder_path: p.newFolderPath,
              },
            },
            supportsAllDrives: false,
          })
        );
      }

      await syncDescendantFolderAndFilePaths(
        drive,
        rootFolderId,
        tree,
        p.oldFolderPath,
        p.newFolderPath,
        p.files
      );
      return;
    }

    case 'folder_move_account': {
      const p = payload as FolderMoveAccountOutboxPayload;
      const rootFolderId = await getAccountRootFolderId(row.account_id);
      const tree = await resolveRemoteFolderTree(drive, rootFolderId);

      const remoteFolderId = tree.folderIdByPath.get(p.oldFolderPath);
      if (remoteFolderId) {
        const targetRemoteParentId = await ensureRemoteFolderHierarchy(drive, rootFolderId, p.destFolder);
        const folderRes = await withDriveRetry(() =>
          drive.files.get({
            fileId: remoteFolderId,
            fields: 'parents',
            supportsAllDrives: false,
          })
        );
        const prevParents = (folderRes.data.parents || []).join(',');
        await withDriveRetry(() =>
          drive.files.update({
            fileId: remoteFolderId,
            addParents: targetRemoteParentId,
            ...(prevParents ? { removeParents: prevParents } : {}),
            requestBody: {
              appProperties: {
                tsubasa_managed: 'true',
                tsubasa_folder_path: p.newFolderPath,
              },
            },
            supportsAllDrives: false,
          })
        );
      }

      await syncDescendantFolderAndFilePaths(
        drive,
        rootFolderId,
        tree,
        p.oldFolderPath,
        p.newFolderPath,
        p.files
      );
      return;
    }

    case 'folder_merge_account': {
      const p = payload as FolderMergeAccountOutboxPayload;
      const rootFolderId = await getAccountRootFolderId(row.account_id);

      await runBoundedConcurrency(p.files, ITEM_BATCH_CONCURRENCY, async (f) => {
        if (!f.driveFileId) return;
        const targetRemoteFolderId = await ensureRemoteFolderHierarchy(drive, rootFolderId, f.destFolder);
        const fileRes = await withDriveRetry(() =>
          drive.files.get({
            fileId: f.driveFileId,
            fields: 'parents',
            supportsAllDrives: false,
          })
        );
        const prevParents = (fileRes.data.parents || []).join(',');
        await withDriveRetry(() =>
          drive.files.update({
            fileId: f.driveFileId,
            addParents: targetRemoteFolderId,
            ...(prevParents ? { removeParents: prevParents } : {}),
            requestBody: {
              ...(f.wasTrashed ? { trashed: false } : {}),
              ...(f.newName ? { name: f.newName } : {}),
              appProperties: {
                tsubasa_managed: 'true',
                tsubasa_virtual_path: f.newVirtualPath,
                tsubasa_virtual_id: f.id,
              },
            },
            supportsAllDrives: false,
          })
        );
      });

      for (const folderPath of p.ensuredFolderPaths) {
        await ensureRemoteFolderHierarchy(drive, rootFolderId, folderPath);
      }

      if (p.sourceFolderPathsToPrune.length > 0) {
        const tree = await resolveRemoteFolderTree(drive, rootFolderId);
        // Prune deepest subfolders first so emptied parents can also be removed cleanly.
        const sortedDesc = [...p.sourceFolderPathsToPrune].sort((a, b) => b.length - a.length);
        for (const sourcePath of sortedDesc) {
          const remoteFolderId = tree.folderIdByPath.get(sourcePath);
          if (!remoteFolderId) continue;
          const childRes = await withDriveRetry(() =>
            drive.files.list({
              q: `'${remoteFolderId}' in parents`,
              fields: 'files(id)',
              pageSize: 1,
              spaces: 'drive',
              supportsAllDrives: false,
            })
          );
          if ((childRes.data.files || []).length === 0) {
            await deleteRemoteFileIgnoreNotFound(drive, remoteFolderId);
          }
        }
        clearRemoteFolderCache(rootFolderId);
      }
      return;
    }

    case 'folder_trash_account': {
      const p = payload as FolderTrashAccountOutboxPayload;
      const rootFolderId = await getAccountRootFolderId(row.account_id);

      await runBoundedConcurrency(p.files, ITEM_BATCH_CONCURRENCY, async (f) => {
        if (!f.driveFileId) return;
        await trashDriveFileIgnoreNotFound(drive, f.driveFileId);
      });

      const tree = await resolveRemoteFolderTree(drive, rootFolderId);
      const remoteFolderId = tree.folderIdByPath.get(p.normPath);
      if (remoteFolderId) {
        await trashDriveFileIgnoreNotFound(drive, remoteFolderId);
      }

      const descendantFolders = tree.folders.filter((sub) => sub.virtualPath.startsWith(p.normPath + '/'));
      await runBoundedConcurrency(descendantFolders, ITEM_BATCH_CONCURRENCY, async (sub) => {
        await trashDriveFileIgnoreNotFound(drive, sub.id);
      });

      clearRemoteFolderCache(rootFolderId);
      return;
    }

    case 'clear_share_account': {
      const p = payload as ClearShareAccountOutboxPayload;
      const rootFolderId = p.rootFolderId || (await getAccountRootFolderId(row.account_id).catch(() => null));

      if (rootFolderId) {
        const itemIds: string[] = [];
        let pageToken: string | undefined = undefined;

        do {
          const listRes: any = await withDriveRetry(() =>
            drive.files.list({
              q: `'${rootFolderId}' in parents`,
              fields: 'nextPageToken, files(id)',
              pageSize: 100,
              pageToken,
              spaces: 'drive',
              supportsAllDrives: false,
            })
          );

          for (const item of listRes.data.files || []) {
            if (item.id) {
              itemIds.push(item.id);
            }
          }

          pageToken = listRes.data.nextPageToken || undefined;
        } while (pageToken);

        await runBoundedConcurrency(itemIds, ITEM_BATCH_CONCURRENCY, async (itemId) => {
          await deleteRemoteFileIgnoreNotFound(drive, itemId);
        });

        clearRemoteFolderCache(rootFolderId);
      }

      markAccountQuotaDecreased(row.account_id);
      return;
    }
  }
}

function assertNoDeadForAccount(accountId: string): void {
  const deadRow = getStmts().countDeadForAccount.get(accountId) as { cnt: number } | undefined;
  const deadCount = deadRow?.cnt ?? 0;
  if (deadCount > 0) {
    throw new Error(`Drive outbox has ${deadCount} dead item(s) for account ${accountId}`);
  }
}

export async function drainOutboxForAccount(accountId: string, timeoutMs = 60_000): Promise<void> {
  const stmts = getStmts();
  const initialRow = stmts.countActiveForAccount.get(accountId) as { cnt: number } | undefined;
  if ((initialRow?.cnt ?? 0) === 0) {
    assertNoDeadForAccount(accountId);
    return;
  }

  stmts.flushFailedForAccount.run(accountId);
  void drainAccountQueue(accountId).catch((err) => {
    console.error(`Drive outbox drain failed for account ${accountId}:`, err);
  });

  await new Promise<void>((resolve, reject) => {
    const checkRow = stmts.countActiveForAccount.get(accountId) as { cnt: number } | undefined;
    if ((checkRow?.cnt ?? 0) === 0) {
      resolve();
      return;
    }

    const waiters = accountDrainWaiters.get(accountId) ?? [];
    const onDone = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      const list = accountDrainWaiters.get(accountId);
      if (list) {
        const idx = list.indexOf(onDone);
        if (idx !== -1) list.splice(idx, 1);
        if (list.length === 0) accountDrainWaiters.delete(accountId);
      }
      reject(new Error(`Timed out waiting for drive outbox drain on account ${accountId}`));
    }, timeoutMs);
    timer.unref?.();

    waiters.push(onDone);
    accountDrainWaiters.set(accountId, waiters);
  });

  assertNoDeadForAccount(accountId);
}

export function getPendingOutboxDeleteDriveIds(accountId: string): Set<string> {
  const rows = getStmts().selectPendingDeleteDriveIds.all(accountId) as Array<{ drive_file_id: string }>;
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.drive_file_id) {
      ids.add(row.drive_file_id);
    }
  }
  return ids;
}

export function getPendingOutboxDriveIds(accountId: string): Set<string> {
  const rows = getStmts().selectPendingDriveRows.all(accountId) as Array<{
    op_type: DriveOutboxOpType;
    drive_file_id: string | null;
    payload_json: string;
  }>;
  const ids = new Set<string>();

  for (const row of rows) {
    if (row.drive_file_id) {
      ids.add(row.drive_file_id);
    }
    if (
      row.op_type === 'folder_rename_account' ||
      row.op_type === 'folder_move_account' ||
      row.op_type === 'folder_merge_account' ||
      row.op_type === 'folder_trash_account'
    ) {
      try {
        const parsed = JSON.parse(row.payload_json) as { files?: Array<{ driveFileId?: string }> };
        for (const f of parsed.files || []) {
          if (f.driveFileId) {
            ids.add(f.driveFileId);
          }
        }
      } catch {
        // Ignore malformed payload JSON during read protection
      }
    }
  }

  return ids;
}

export function getOutboxStatusSummary(): OutboxStatusSummary {
  const stmts = getStmts();
  const countRows = stmts.selectStatusCounts.all() as Array<{
    status: 'pending' | 'processing' | 'failed' | 'dead';
    cnt: number;
  }>;

  const counts = {
    pending: 0,
    processing: 0,
    failed: 0,
    dead: 0,
  };
  for (const row of countRows) {
    counts[row.status] = Number(row.cnt);
  }

  const failureRows = stmts.selectRecentFailures.all() as Array<{
    id: string;
    account_id: string;
    pool_id: number | null;
    op_type: DriveOutboxOpType;
    drive_file_id: string | null;
    status: 'failed' | 'dead';
    attempts: number;
    next_retry_at: number;
    last_error: string | null;
    created_at: number;
    updated_at: number;
  }>;

  return {
    counts,
    recentFailures: failureRows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      poolId: row.pool_id,
      opType: row.op_type,
      driveFileId: row.drive_file_id,
      status: row.status,
      attempts: row.attempts,
      nextRetryAt: row.next_retry_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    jobs: listBackgroundJobs(),
  };
}

export function retryOutboxEntries(accountId?: string): { retriedCount: number } {
  const stmts = getStmts();
  const info = accountId ? stmts.retryByAccount.run(accountId) : stmts.retryAll.run();
  const retriedCount = Number(info.changes ?? 0);
  const readyRows = stmts.selectReadyAccounts.all(Date.now()) as Array<{ account_id: string }>;
  if (retriedCount > 0 || readyRows.length > 0) {
    scheduleOutboxDrain(0);
  }
  return { retriedCount };
}

function pruneFinishedBackgroundJobs(): void {
  const finished = Array.from(backgroundJobs.values())
    .filter((job) => job.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));

  const excess = finished.length - MAX_FINISHED_JOBS;
  for (let i = 0; i < excess; i++) {
    backgroundJobs.delete(finished[i].id);
  }
}

export function startBackgroundJob<T>(
  kind: BackgroundJobKind,
  targetId: string,
  fn: () => Promise<T>
): TrackedBackgroundJob<T> {
  const job: TrackedBackgroundJob<T> = {
    id: randomUUID(),
    kind,
    targetId,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
  };

  backgroundJobs.set(job.id, job);

  void fn()
    .then((result) => {
      job.status = 'completed';
      job.result = result;
      job.finishedAt = Date.now();
      pruneFinishedBackgroundJobs();
    })
    .catch((err) => {
      console.error(`Background job ${job.id} (${kind} for ${targetId}) failed:`, err);
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
      pruneFinishedBackgroundJobs();
    });

  return job;
}

export function listBackgroundJobs(): TrackedBackgroundJob[] {
  return Array.from(backgroundJobs.values()).sort((a, b) => b.startedAt - a.startedAt);
}
