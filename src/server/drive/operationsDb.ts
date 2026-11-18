import path from 'node:path';
import { db, sqlite } from '../db/index.js';
import { files, folders } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { normalizeVirtualPath } from '../virtualPath.js';
import { ItemConflictError } from './errors.js';
import { enqueueDriveOutbox } from './outbox.js';
import type { EnqueueOutboxEntry } from './outboxQueue.js';

export interface DescendantFileRow {
  id: string;
  virtual_path: string;
  name: string;
  account_id: string;
  drive_file_id: string;
  size_bytes: number;
  hash: string | null;
  is_trashed: number;
  updated_at: number;
}

export interface ActiveDescendantFileRow extends DescendantFileRow {
  size_bytes: number;
  mime_type: string;
  hash: string | null;
}

export interface DescendantFolderRow {
  id: string;
  virtual_path: string;
  name: string;
}

export interface MoveItemInput {
  kind?: 'file' | 'folder';
  type?: 'file' | 'folder';
  id: string;
}

type SqliteStmt = ReturnType<typeof sqlite.prepare<any[], any>>;

let cachedStmts: {
  selectPoolAccountsWithRoot: SqliteStmt;
  selectPoolAccountsForCopy: SqliteStmt;
  displaceTrashedFileAtPath: SqliteStmt;
  displaceAnyTrashedFileAtPath: SqliteStmt;
  displaceTrashedFileAtPathWithId: SqliteStmt;
  displaceAnyTrashedFileAtPathWithId: SqliteStmt;
  updateMovedFile: SqliteStmt;
  updateMovedOrRenamedFile: SqliteStmt;
  deleteFileById: SqliteStmt;
  decrementAccountQuotaUsed: SqliteStmt;
  deleteFolderById: SqliteStmt;
  countAllFilesInSubtree: SqliteStmt;
  selectFileIdByPath: SqliteStmt;
  selectActiveFileAtPath: SqliteStmt;
  selectDescendantFiles: SqliteStmt;
  selectActiveDescendantFiles: SqliteStmt;
  selectDescendantFolders: SqliteStmt;
  updateFolderMove: SqliteStmt;
  updateFolderRename: SqliteStmt;
  updateDescendantFilePath: SqliteStmt;
  renameSingleFile: SqliteStmt;
  trashFilesInFolder: SqliteStmt;
  deleteFoldersInTree: SqliteStmt;
  deleteShareLinksForFolder: SqliteStmt;
  selectAllActiveFilePathsInPool: SqliteStmt;
  selectActiveFilePathsUnderPrefix: SqliteStmt;
  selectAllFolderPathsInPool: SqliteStmt;
  selectFolderPathsUnderPrefix: SqliteStmt;
  insertCopiedFile: SqliteStmt;
  incrementAccountQuotaUsed: SqliteStmt;
  insertTransferLog: SqliteStmt;
} | null = null;

export function getStmts() {
  if (cachedStmts) {
    return cachedStmts;
  }

  cachedStmts = {
    selectPoolAccountsWithRoot: sqlite.prepare(
      'SELECT id FROM accounts WHERE pool_id = ? AND root_folder_id IS NOT NULL'
    ),
    selectPoolAccountsForCopy: sqlite.prepare(
      'SELECT id, email, root_folder_id FROM accounts WHERE pool_id = ?'
    ),
    displaceTrashedFileAtPath: sqlite.prepare(
      'UPDATE files SET virtual_path = ?, updated_at = unixepoch() WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1 AND id != ?'
    ),
    displaceAnyTrashedFileAtPath: sqlite.prepare(
      'UPDATE files SET virtual_path = ?, updated_at = unixepoch() WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1'
    ),
    displaceTrashedFileAtPathWithId: sqlite.prepare(
      "UPDATE files SET virtual_path = ? || '-' || substr(id, 1, 6), updated_at = unixepoch() WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1 AND id != ?"
    ),
    displaceAnyTrashedFileAtPathWithId: sqlite.prepare(
      "UPDATE files SET virtual_path = ? || '-' || substr(id, 1, 6), updated_at = unixepoch() WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1"
    ),
    updateMovedFile: sqlite.prepare(
      'UPDATE files SET virtual_path = ?, folder_id = ?, is_trashed = 0, trashed_at = NULL, updated_at = unixepoch() WHERE id = ?'
    ),
    updateMovedOrRenamedFile: sqlite.prepare(
      'UPDATE files SET name = ?, virtual_path = ?, folder_id = ?, is_trashed = 0, trashed_at = NULL, updated_at = unixepoch() WHERE id = ?'
    ),
    deleteFileById: sqlite.prepare('DELETE FROM files WHERE id = ?'),
    decrementAccountQuotaUsed: sqlite.prepare(
      'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
    ),
    deleteFolderById: sqlite.prepare('DELETE FROM folders WHERE id = ?'),
    countAllFilesInSubtree: sqlite.prepare(
      'SELECT COUNT(*) as cnt FROM files WHERE pool_id = ? AND ((virtual_path >= ? AND virtual_path < ?) OR folder_id = ?)'
    ),
    selectFileIdByPath: sqlite.prepare(
      'SELECT id FROM files WHERE pool_id = ? AND virtual_path = ?'
    ),
    selectActiveFileAtPath: sqlite.prepare(
      'SELECT id, virtual_path FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 LIMIT 1'
    ),
    selectDescendantFiles: sqlite.prepare(
      'SELECT id, virtual_path, name, account_id, drive_file_id, size_bytes, hash, is_trashed, updated_at FROM files WHERE pool_id = ? AND ((virtual_path >= ? AND virtual_path < ?) OR folder_id = ?)'
    ),
    selectActiveDescendantFiles: sqlite.prepare(
      'SELECT id, virtual_path, name, size_bytes, mime_type, hash, account_id, drive_file_id FROM files WHERE pool_id = ? AND ((virtual_path >= ? AND virtual_path < ?) OR folder_id = ?) AND is_trashed = 0'
    ),
    selectDescendantFolders: sqlite.prepare(
      'SELECT id, virtual_path, name FROM folders WHERE pool_id = ? AND virtual_path >= ? AND virtual_path < ?'
    ),
    updateFolderMove: sqlite.prepare(
      'UPDATE folders SET id = ?, virtual_path = ?, parent_folder_id = ?, updated_at = unixepoch() WHERE id = ?'
    ),
    updateFolderRename: sqlite.prepare(
      'UPDATE folders SET id = ?, virtual_path = ?, name = ?, parent_folder_id = ?, updated_at = unixepoch() WHERE id = ?'
    ),
    updateDescendantFilePath: sqlite.prepare(
      'UPDATE files SET virtual_path = ?, folder_id = ?, updated_at = unixepoch() WHERE id = ?'
    ),
    renameSingleFile: sqlite.prepare(
      'UPDATE files SET name = ?, virtual_path = ?, folder_id = ?, updated_at = unixepoch() WHERE id = ?'
    ),
    trashFilesInFolder: sqlite.prepare(
      'UPDATE files SET is_trashed = 1, trashed_at = unixepoch(), updated_at = unixepoch() WHERE pool_id = ? AND ((virtual_path >= ? AND virtual_path < ?) OR folder_id = ?)'
    ),
    deleteFoldersInTree: sqlite.prepare(
      'DELETE FROM folders WHERE pool_id = ? AND (virtual_path = ? OR (virtual_path >= ? AND virtual_path < ?))'
    ),
    deleteShareLinksForFolder: sqlite.prepare(
      "DELETE FROM share_links WHERE pool_id = ? AND ('/' || batch_folder_name) = ?"
    ),
    selectAllActiveFilePathsInPool: sqlite.prepare(
      'SELECT virtual_path FROM files WHERE pool_id = ? AND is_trashed = 0'
    ),
    selectActiveFilePathsUnderPrefix: sqlite.prepare(
      'SELECT virtual_path FROM files WHERE pool_id = ? AND is_trashed = 0 AND virtual_path >= ? AND virtual_path < ?'
    ),
    selectAllFolderPathsInPool: sqlite.prepare(
      'SELECT virtual_path FROM folders WHERE pool_id = ?'
    ),
    selectFolderPathsUnderPrefix: sqlite.prepare(
      'SELECT virtual_path FROM folders WHERE pool_id = ? AND virtual_path >= ? AND virtual_path < ?'
    ),
    insertCopiedFile: sqlite.prepare(
      `INSERT INTO files (
        id, pool_id, virtual_path, name, size_bytes, mime_type, hash,
        account_id, drive_file_id, folder_id, is_trashed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, unixepoch(), unixepoch())`
    ),
    incrementAccountQuotaUsed: sqlite.prepare(
      'UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?'
    ),
    insertTransferLog: sqlite.prepare(
      "INSERT INTO transfer_logs (id, account_id, transfer_type, byte_count, timestamp) VALUES (?, ?, 'upload', ?, ?)"
    ),
  };

  return cachedStmts;
}

export function getRelevantPoolAccountIds(poolId: number, extraAccountIds: Iterable<string>): Set<string> {
  const rows = getStmts().selectPoolAccountsWithRoot.all(poolId) as Array<{ id: string }>;
  const accountIds = new Set<string>(rows.map((row) => row.id));
  for (const accountId of extraAccountIds) {
    if (accountId) {
      accountIds.add(accountId);
    }
  }
  return accountIds;
}

export function enqueuePoolAccountOutbox<TFile, TPayload>(
  poolId: number,
  opType: EnqueueOutboxEntry['opType'],
  filesByAccount: Map<string, TFile[]>,
  buildPayload: (filesForAccount: TFile[]) => TPayload,
  targetEntries?: EnqueueOutboxEntry[]
): void {
  const entries = targetEntries ?? [];
  const relevantAccounts = getRelevantPoolAccountIds(poolId, filesByAccount.keys());
  for (const accountId of relevantAccounts) {
    entries.push({
      accountId,
      poolId,
      opType,
      payload: buildPayload(filesByAccount.get(accountId) ?? []),
    });
  }
  if (!targetEntries) {
    enqueueDriveOutbox(entries);
  }
}

export function assertFolderPathNotOccupiedByFile(folderPath: string, poolId: number): void {
  const normalized = normalizeVirtualPath(folderPath);
  if (normalized === '/') return;

  const stmts = getStmts();
  const segments = normalized.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    const existingFile = stmts.selectActiveFileAtPath.get(poolId, current) as
      | { id: string; virtual_path: string }
      | undefined;
    if (existingFile) {
      throw new ItemConflictError(
        `Cannot use destination folder "${normalized}" because a file exists at "${current}"`
      );
    }
  }
}

export function toEpochSeconds(value: Date | number | null | undefined): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

export type ConflictSuffixStyle = 'numbered' | 'copy' | 'restored';

export function formatConflictCandidateName(
  baseName: string,
  counter: number,
  kind: 'file' | 'folder' = 'file',
  style: ConflictSuffixStyle = 'copy'
): string {
  if (counter <= 0) {
    return baseName;
  }
  const ext = kind === 'file' ? path.posix.extname(baseName) : '';
  const stem = kind === 'file' ? path.posix.basename(baseName, ext) : baseName;
  if (style === 'numbered') {
    return `${stem} (${counter})${ext}`;
  }
  if (style === 'restored') {
    const suffix = counter === 1 ? ' (restored)' : ` (restored ${counter})`;
    return `${stem}${suffix}${ext}`;
  }
  return counter === 1 ? `${stem} (copy)${ext}` : `${stem} (copy ${counter})${ext}`;
}

export interface AllocateUniqueVirtualPathOptions {
  targetDir: string;
  baseName: string;
  kind?: 'file' | 'folder';
  style?: ConflictSuffixStyle;
  startCounter?: number;
  skipBase?: boolean;
  isTaken: (candidatePath: string) => boolean;
}

export function allocateUniqueVirtualPath(options: AllocateUniqueVirtualPathOptions): string {
  const {
    targetDir,
    baseName,
    kind = 'file',
    style = 'copy',
    startCounter = 1,
    skipBase = false,
    isTaken,
  } = options;

  if (!skipBase) {
    const basePath = normalizeVirtualPath(path.posix.join(targetDir, baseName));
    if (!isTaken(basePath)) {
      return basePath;
    }
  }

  for (let counter = startCounter; ; counter++) {
    const candidateName = formatConflictCandidateName(baseName, counter, kind, style);
    const candidatePath = normalizeVirtualPath(path.posix.join(targetDir, candidateName));
    if (!isTaken(candidatePath)) {
      return candidatePath;
    }
  }
}

export function displaceTrashedFileAtPath(
  poolId: number,
  virtualPath: string,
  options?: { excludeFileId?: string; suffix?: string; appendShortId?: boolean }
): void {
  const stmts = getStmts();
  const displacedPath = `${virtualPath}${options?.suffix ?? `.trashed-${Date.now()}`}`;
  if (options?.excludeFileId) {
    const stmt = options.appendShortId
      ? stmts.displaceTrashedFileAtPathWithId
      : stmts.displaceTrashedFileAtPath;
    stmt.run(displacedPath, poolId, virtualPath, options.excludeFileId);
  } else {
    const stmt = options?.appendShortId
      ? stmts.displaceAnyTrashedFileAtPathWithId
      : stmts.displaceAnyTrashedFileAtPath;
    stmt.run(displacedPath, poolId, virtualPath);
  }
}

export function formatCopyCandidateName(
  baseName: string,
  counter: number,
  kind: 'file' | 'folder' = 'file'
): string {
  return formatConflictCandidateName(baseName, counter, kind, 'copy');
}

export async function getAvailableCopyPath(
  targetDir: string,
  baseName: string,
  kind: 'file' | 'folder',
  poolId = 1
): Promise<string> {
  let candidateName = baseName;
  let candidatePath = normalizeVirtualPath(path.posix.join(targetDir, candidateName));
  let counter = 1;

  while (true) {
    if (kind === 'file') {
      const exists = await db.query.files.findFirst({
        where: and(
          eq(files.poolId, poolId),
          eq(files.virtualPath, candidatePath),
          eq(files.isTrashed, false)
        ),
      });
      if (!exists) return candidatePath;
    } else {
      const exists = await db.query.folders.findFirst({
        where: and(
          eq(folders.poolId, poolId),
          eq(folders.virtualPath, candidatePath)
        ),
      });
      if (!exists) return candidatePath;
    }

    candidateName = formatCopyCandidateName(baseName, counter, kind);
    candidatePath = normalizeVirtualPath(path.posix.join(targetDir, candidateName));
    counter++;
  }
}
