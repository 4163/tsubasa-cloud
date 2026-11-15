import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import fs from 'node:fs';
import path from 'node:path';

const dbDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = process.env.TSUBASA_DB_PATH || path.join(dbDir, 'tsubasa.db');

export const sqlite = new Database(dbPath);

// Performance pragmas for zero-latency local operations
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('cache_size = -64000'); // 64 MB
sqlite.pragma('temp_store = MEMORY');
sqlite.pragma('mmap_size = 268435456'); // 256 MB
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('wal_autocheckpoint = 2000');
sqlite.pragma('journal_size_limit = 67108864');

export const db = drizzle(sqlite, { schema });
export type DatabaseInstance = typeof db;

let globalPoolRevisionEpoch = 0;
const poolRevisions = new Map<number, number>();

export function getPoolRevision(poolId: number): number {
  return globalPoolRevisionEpoch + (poolRevisions.get(poolId) ?? 0);
}

export function bumpPoolRevision(poolId?: number): number {
  if (poolId === undefined) {
    globalPoolRevisionEpoch += 1;
    return globalPoolRevisionEpoch;
  }
  const next = (poolRevisions.get(poolId) ?? 0) + 1;
  poolRevisions.set(poolId, next);
  return globalPoolRevisionEpoch + next;
}

export function buildDirectoryPrefixBounds(dirPath: string): { lower: string; upper: string } {
  const cleanDir = dirPath.replace(/\/+$/, '');
  if (!cleanDir) {
    return { lower: '/', upper: '0' };
  }
  return { lower: `${cleanDir}/`, upper: `${cleanDir}0` };
}

function prepareRenameStatements() {
  return {
    getAccountById: sqlite.prepare('SELECT id, email FROM accounts WHERE id = ?'),
    getAccountByEmailExcludingId: sqlite.prepare('SELECT id, email FROM accounts WHERE email = ? AND id != ?'),
    updateAccountIdAndEmail: sqlite.prepare('UPDATE accounts SET id = ?, email = ? WHERE id = ?'),
    deleteAccountById: sqlite.prepare('DELETE FROM accounts WHERE id = ?'),
    updateFilesAccount: sqlite.prepare('UPDATE files SET account_id = ? WHERE account_id = ?'),
    updateTransferLogsAccount: sqlite.prepare('UPDATE transfer_logs SET account_id = ? WHERE account_id = ?'),
    updateShareLinksAccount: sqlite.prepare('UPDATE share_links SET account_id = ? WHERE account_id = ?'),
    deleteConflictingShareLinks: sqlite.prepare(
      `DELETE FROM share_links
       WHERE account_id = ?
         AND EXISTS (
           SELECT 1 FROM share_links AS target
           WHERE target.account_id = ?
             AND target.pool_id = share_links.pool_id
             AND target.batch_folder_name = share_links.batch_folder_name
         )`
    ),
    updatePendingDriveSyncAccount: sqlite.prepare('UPDATE pending_drive_sync SET account_id = ? WHERE account_id = ?'),
    updateDriveOutboxAccount: sqlite.prepare('UPDATE drive_outbox SET account_id = ? WHERE account_id = ?'),
    deleteConflictingPendingDriveSync: sqlite.prepare(
      `DELETE FROM pending_drive_sync
       WHERE account_id = ?
         AND EXISTS (
           SELECT 1 FROM pending_drive_sync AS target
           WHERE target.account_id = ?
             AND target.drive_file_id = pending_drive_sync.drive_file_id
         )`
    ),
  };
}

let renameStatements: ReturnType<typeof prepareRenameStatements> | null = null;

function getRenameStatements() {
  if (!renameStatements) {
    renameStatements = prepareRenameStatements();
  }
  return renameStatements;
}

export function renameAccountInDb(oldId: string, newId: string): void {
  if (!oldId || !newId || oldId === newId) {
    return;
  }

  const stmts = getRenameStatements();

  sqlite.transaction(() => {
    sqlite.pragma('defer_foreign_keys = ON');

    const existingWithOld = stmts.getAccountById.get(oldId) as { id: string; email: string } | undefined;
    const existingWithNewId = stmts.getAccountById.get(newId) as { id: string; email: string } | undefined;
    const existingWithNewEmail = stmts.getAccountByEmailExcludingId.get(newId, oldId) as
      | { id: string; email: string }
      | undefined;

    if (existingWithOld) {
      if (existingWithNewId || existingWithNewEmail) {
        const targetId = existingWithNewId?.id ?? existingWithNewEmail?.id ?? newId;
        stmts.deleteConflictingShareLinks.run(oldId, targetId);
        stmts.deleteConflictingPendingDriveSync.run(oldId, targetId);
        stmts.updateFilesAccount.run(targetId, oldId);
        stmts.updateTransferLogsAccount.run(targetId, oldId);
        stmts.updateShareLinksAccount.run(targetId, oldId);
        stmts.updatePendingDriveSyncAccount.run(targetId, oldId);
        stmts.updateDriveOutboxAccount.run(targetId, oldId);
        stmts.deleteAccountById.run(oldId);
      } else {
        stmts.deleteConflictingPendingDriveSync.run(oldId, newId);
        stmts.updateAccountIdAndEmail.run(newId, newId, oldId);
        stmts.updateFilesAccount.run(newId, oldId);
        stmts.updateTransferLogsAccount.run(newId, oldId);
        stmts.updateShareLinksAccount.run(newId, oldId);
        stmts.updatePendingDriveSyncAccount.run(newId, oldId);
        stmts.updateDriveOutboxAccount.run(newId, oldId);
      }
    } else {
      stmts.deleteConflictingPendingDriveSync.run(oldId, newId);
      stmts.updateFilesAccount.run(newId, oldId);
      stmts.updateTransferLogsAccount.run(newId, oldId);
      stmts.updateShareLinksAccount.run(newId, oldId);
      stmts.updatePendingDriveSyncAccount.run(newId, oldId);
      stmts.updateDriveOutboxAccount.run(newId, oldId);
    }
  }).immediate();
}


