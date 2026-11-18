import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sqlite } from '../db/index.js';
import { listBackgroundJobs, type TrackedBackgroundJob } from './backgroundJobs.js';

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
  clearAppProperties?: boolean;
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
  batchFolderIds?: string[];
  batchFolderNames?: string[];
}

export interface EnqueueOutboxEntry {
  accountId: string;
  poolId?: number | null;
  opType: DriveOutboxOpType;
  driveFileId?: string | null;
  payload: unknown;
}

export interface OutboxRow {
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

export interface PendingDriveSyncRow {
  account_id: string;
  drive_file_id: string;
  virtual_path: string;
  file_id: string;
  attempts: number;
}

export interface OutboxTargets {
  driveIds: Set<string>;
  folderPaths: string[];
  isGlobal: boolean;
}

export const MAX_OUTBOX_ATTEMPTS = 8;
export const ITEM_BATCH_CONCURRENCY = 8;

type SqliteStmt = ReturnType<typeof sqlite.prepare<any[], any>>;

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
  selectActiveFileByDriveId: SqliteStmt;
  hasPendingOutboxForDriveFile: SqliteStmt;
} | null = null;

export function getStmts() {
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
    selectActiveFileByDriveId: sqlite.prepare(
      `SELECT id, virtual_path
       FROM files
       WHERE account_id = ? AND drive_file_id = ?
       LIMIT 1`
    ),
    hasPendingOutboxForDriveFile: sqlite.prepare(
      `SELECT 1
       FROM drive_outbox
       WHERE account_id = ? AND drive_file_id = ? AND status IN ('pending', 'processing', 'failed')
       LIMIT 1`
    ),
  };

  return cachedStmts;
}

const accountDrainWaiters = new Map<string, Array<() => void>>();

let scheduleDrainTrigger: ((delayMs?: number) => void) | null = null;
let drainAccountTrigger: ((accountId: string) => Promise<void>) | null = null;

export function registerOutboxDrainTriggers(triggers: {
  scheduleDrain: (delayMs?: number) => void;
  drainAccount: (accountId: string) => Promise<void>;
}): void {
  scheduleDrainTrigger = triggers.scheduleDrain;
  drainAccountTrigger = triggers.drainAccount;
}

export function extractOutboxTargets(row: OutboxRow): OutboxTargets {
  const driveIds = new Set<string>();
  const folderPaths: string[] = [];
  const isGlobal = row.op_type === 'clear_share_account';

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

export function targetsOverlap(a: OutboxTargets, b: OutboxTargets): boolean {
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

export function selectNextReadyForAccount(accountId: string, now: number): OutboxRow | undefined {
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

export function notifyAccountDrainWaitersIfIdle(accountId: string): void {
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

export function insertOutboxEntries(entries: EnqueueOutboxEntry[]): string[] {
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

  return ids;
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
  if (drainAccountTrigger) {
    void drainAccountTrigger(accountId).catch((err) => {
      console.error(`Drive outbox drain failed for account ${accountId}:`, err);
    });
  }

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
  if ((retriedCount > 0 || readyRows.length > 0) && scheduleDrainTrigger) {
    scheduleDrainTrigger(0);
  }
  return { retriedCount };
}
