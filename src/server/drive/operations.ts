import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite, buildDirectoryPrefixBounds, bumpPoolRevision } from '../db/index.js';
import { accounts, files, folders } from '../db/schema.js';
import { eq, or, and } from 'drizzle-orm';
import {
  getDriveClient,
  getAccountRootFolderId,
  markAccountQuotaDecreased,
  runBoundedConcurrency,
  withDriveRetry,
} from './client.js';
import { copyDriveFileCrossAccount } from './transfer.js';
import { ensureRemoteFolderHierarchy, normalizeVirtualPath } from './mirror.js';
import { ensureLocalFolderPath, formatFolderId } from './sync.js';
import {
  enqueueDriveOutbox,
  type EnqueueOutboxEntry,
  type FileDeleteOutboxPayload,
  type FileMoveOutboxPayload,
  type FileRenameOutboxPayload,
  type FolderMergeAccountOutboxPayload,
  type FolderMoveAccountOutboxPayload,
  type FolderRenameAccountOutboxPayload,
  type FolderTrashAccountOutboxPayload,
} from './outbox.js';
import {
  planBatchPlacement,
  getEligibleAccounts,
  invalidatePooledStorageOverview,
  MAX_SINGLE_FILE_BYTES,
  FileExceedsCeilingError,
  InsufficientStorageError,
} from '../storage/index.js';

interface DescendantFileRow {
  id: string;
  virtual_path: string;
  name: string;
  account_id: string;
  drive_file_id: string;
  size_bytes: number;
  is_trashed: number;
  updated_at: number;
}

interface ActiveDescendantFileRow extends DescendantFileRow {
  size_bytes: number;
  mime_type: string;
  hash: string | null;
}

interface DescendantFolderRow {
  id: string;
  virtual_path: string;
  name: string;
}

type SqliteStmt = ReturnType<typeof sqlite.prepare<any[], any>>;

export class ItemConflictError extends Error {}
export class ItemNotFoundError extends Error {}

export function validateItemName(rawName: string): string {
  const trimmed = rawName.trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(trimmed)
  ) {
    throw new Error('Invalid name: cannot be empty, ".", "..", or contain slashes or control characters');
  }
  return trimmed;
}

let cachedStmts: {
  selectPoolAccountsWithRoot: SqliteStmt;
  selectPoolAccountsForCopy: SqliteStmt;
  displaceTrashedFileAtPath: SqliteStmt;
  displaceAnyTrashedFileAtPath: SqliteStmt;
  updateMovedFile: SqliteStmt;
  updateMovedOrRenamedFile: SqliteStmt;
  deleteFileById: SqliteStmt;
  decrementAccountQuotaUsed: SqliteStmt;
  deleteFolderById: SqliteStmt;
  countActiveFilesInSubtree: SqliteStmt;
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

function getStmts() {
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
      'UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1 AND id != ?'
    ),
    displaceAnyTrashedFileAtPath: sqlite.prepare(
      'UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1'
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
    countActiveFilesInSubtree: sqlite.prepare(
      'SELECT COUNT(*) as cnt FROM files WHERE pool_id = ? AND is_trashed = 0 AND ((virtual_path >= ? AND virtual_path < ?) OR folder_id = ?)'
    ),
    selectDescendantFiles: sqlite.prepare(
      'SELECT id, virtual_path, name, account_id, drive_file_id, size_bytes, is_trashed, updated_at FROM files WHERE pool_id = ? AND ((virtual_path >= ? AND virtual_path < ?) OR folder_id = ?)'
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

function getRelevantPoolAccountIds(poolId: number, extraAccountIds: Iterable<string>): Set<string> {
  const rows = getStmts().selectPoolAccountsWithRoot.all(poolId) as Array<{ id: string }>;
  const accountIds = new Set<string>(rows.map((row) => row.id));
  for (const accountId of extraAccountIds) {
    if (accountId) {
      accountIds.add(accountId);
    }
  }
  return accountIds;
}

export type MoveConflictMode = 'reject' | 'skip' | 'keep_both' | 'overwrite';

export interface MoveConflictItem {
  sourceFileId: string;
  sourcePath: string;
  sourceName: string;
  sourceSizeBytes: number;
  sourceUpdatedAt: number;
  destPath: string;
  existingFileId?: string;
  existingSizeBytes?: number;
  existingUpdatedAt?: number;
}

export class MoveConflictError extends Error {
  readonly conflicts: MoveConflictItem[];
  readonly cleanCount: number;

  constructor(conflicts: MoveConflictItem[], cleanCount: number) {
    super(
      conflicts.length === 1
        ? `"${conflicts[0].sourceName}" already exists in the destination folder`
        : `${conflicts.length} files already exist in the destination folder`
    );
    this.conflicts = conflicts;
    this.cleanCount = cleanCount;
  }
}

export interface MoveItemInput {
  kind?: 'file' | 'folder';
  type?: 'file' | 'folder';
  id: string;
}

export interface MoveResult {
  id: string;
  kind: 'file' | 'folder';
  type?: 'file' | 'folder';
  oldPath: string;
  newPath: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
}

interface PlannedFileMove {
  kind: 'file';
  fileId: string;
  accountId: string;
  driveFileId: string;
  newName: string;
  renameOnDrive: boolean;
  newVirtualPath: string;
  destFolder: string;
  folderId: string | null;
  wasTrashed: boolean;
}

interface PlannedFolderMove {
  kind: 'folder';
  folderId: string;
  oldFolderPath: string;
  newFolderPath: string;
  parentId: string | null;
  newFolderId: string;
  descendantFolders: DescendantFolderRow[];
  descendantFiles: DescendantFileRow[];
}

interface PlannedFolderMerge {
  kind: 'folder_merge';
  oldFolderPath: string;
  newFolderPath: string;
  sourceFolderIdsAndPaths: Array<{ id: string; oldPath: string; newPath: string }>;
  destFolderPathsToEnsure: string[];
  fileMoves: PlannedFileMove[];
}

type PlannedMoveOp = PlannedFileMove | PlannedFolderMove | PlannedFolderMerge;

interface OverwriteTarget {
  id: string;
  accountId: string;
  driveFileId: string;
  sizeBytes: number;
}

function toEpochSeconds(value: Date | number | null | undefined): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

async function allocateKeepBothMovePath(
  poolId: number,
  targetDir: string,
  baseName: string,
  claimedFilePaths: Set<string>,
  claimedFolderPaths: Set<string>
): Promise<string> {
  const ext = path.posix.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;

  for (let counter = 2; ; counter++) {
    const candidateName = `${stem} (${counter})${ext}`;
    const candidatePath = normalizeVirtualPath(path.posix.join(targetDir, candidateName));
    if (claimedFilePaths.has(candidatePath) || claimedFolderPaths.has(candidatePath)) {
      continue;
    }

    const existingFile = await db.query.files.findFirst({
      where: and(
        eq(files.poolId, poolId),
        eq(files.virtualPath, candidatePath),
        eq(files.isTrashed, false)
      ),
    });
    if (existingFile) continue;

    const existingFolder = await db.query.folders.findFirst({
      where: and(eq(folders.poolId, poolId), eq(folders.virtualPath, candidatePath)),
    });
    if (!existingFolder) {
      return candidatePath;
    }
  }
}

export async function moveItems(
  items: MoveItemInput[],
  targetFolderPath: string,
  poolId = 1,
  conflictMode: MoveConflictMode = 'reject'
): Promise<MoveResult[]> {
  const destFolder = normalizeVirtualPath(targetFolderPath);
  const stmts = getStmts();

  type ResolvedInput =
    | { kind: 'file'; file: typeof files.$inferSelect }
    | { kind: 'folder'; folder: typeof folders.$inferSelect }
    | { kind: 'missing'; item: MoveItemInput; resolvedKind: 'file' | 'folder' };

  const resolvedInputs: ResolvedInput[] = [];
  const selectedFolderPaths: string[] = [];
  const selectedFileIds = new Set<string>();
  const seenIds = new Set<string>();

  for (const item of items) {
    let resolvedKind = item.kind || item.type;
    if (!resolvedKind) {
      const folderExists = await db.query.folders.findFirst({
        where: and(
          eq(folders.poolId, poolId),
          or(eq(folders.id, item.id), eq(folders.virtualPath, item.id))
        ),
      });
      resolvedKind = folderExists ? 'folder' : 'file';
    }

    if (resolvedKind === 'file') {
      const file = await db.query.files.findFirst({
        where: and(
          eq(files.poolId, poolId),
          or(eq(files.id, item.id), eq(files.virtualPath, item.id))
        ),
      });
      if (!file) {
        resolvedInputs.push({ kind: 'missing', item, resolvedKind: 'file' });
        continue;
      }
      if (seenIds.has(file.id)) continue;
      seenIds.add(file.id);
      selectedFileIds.add(file.id);
      resolvedInputs.push({ kind: 'file', file });
    } else {
      const folder = await db.query.folders.findFirst({
        where: and(
          eq(folders.poolId, poolId),
          or(eq(folders.id, item.id), eq(folders.virtualPath, item.id))
        ),
      });
      if (!folder) {
        resolvedInputs.push({ kind: 'missing', item, resolvedKind: 'folder' });
        continue;
      }
      if (seenIds.has(folder.id)) continue;
      seenIds.add(folder.id);
      selectedFolderPaths.push(folder.virtualPath);
      resolvedInputs.push({ kind: 'folder', folder });
    }
  }

  // Prune items whose ancestor folder is already included in this batch.
  const prunedInputs = resolvedInputs.filter((entry) => {
    if (entry.kind === 'missing') return true;
    const itemPath = entry.kind === 'file' ? entry.file.virtualPath : entry.folder.virtualPath;
    return !selectedFolderPaths.some(
      (ancestorPath) => ancestorPath !== itemPath && itemPath.startsWith(`${ancestorPath}/`)
    );
  });

  const results: MoveResult[] = [];
  const plannedOps: PlannedMoveOp[] = [];
  const claimedFilePaths = new Set<string>();
  const claimedFolderPaths = new Set<string>();
  const overwriteTargets = new Map<string, OverwriteTarget>();
  const conflicts: MoveConflictItem[] = [];
  let cleanCount = 0;

  async function planSingleFileMove(source: {
    id: string;
    name: string;
    virtualPath: string;
    accountId: string;
    driveFileId: string;
    sizeBytes: number;
    updatedAt: number;
    isTrashed: boolean;
  }, targetDir: string): Promise<{ status: 'noop' | 'move' | 'skip' | 'conflict' | 'error'; op?: PlannedFileMove; error?: string }> {
    const desiredPath = normalizeVirtualPath(path.posix.join(targetDir, source.name));
    if (desiredPath === source.virtualPath && !source.isTrashed) {
      claimedFilePaths.add(desiredPath);
      return { status: 'noop' };
    }

    const folderBlocking = claimedFolderPaths.has(desiredPath)
      ? true
      : Boolean(
          await db.query.folders.findFirst({
            where: and(eq(folders.poolId, poolId), eq(folders.virtualPath, desiredPath)),
          })
        );

    if (folderBlocking) {
      return {
        status: 'error',
        error: `A folder named "${source.name}" already exists in the destination folder`,
      };
    }

    const existingActive = await db.query.files.findFirst({
      where: and(
        eq(files.poolId, poolId),
        eq(files.virtualPath, desiredPath),
        eq(files.isTrashed, false)
      ),
    });

    const isExistingCollision = Boolean(existingActive && existingActive.id !== source.id);
    const isBatchCollision = claimedFilePaths.has(desiredPath);

    if (!isExistingCollision && !isBatchCollision) {
      claimedFilePaths.add(desiredPath);
      cleanCount++;
      const parentDir = path.posix.dirname(desiredPath);
      const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);
      return {
        status: 'move',
        op: {
          kind: 'file',
          fileId: source.id,
          accountId: source.accountId,
          driveFileId: source.driveFileId,
          newName: source.name,
          renameOnDrive: false,
          newVirtualPath: desiredPath,
          destFolder: parentDir === '.' ? '/' : parentDir,
          folderId,
          wasTrashed: source.isTrashed,
        },
      };
    }

    if (conflictMode === 'reject') {
      conflicts.push({
        sourceFileId: source.id,
        sourcePath: source.virtualPath,
        sourceName: source.name,
        sourceSizeBytes: source.sizeBytes,
        sourceUpdatedAt: source.updatedAt,
        destPath: desiredPath,
        ...(existingActive && existingActive.id !== source.id
          ? {
              existingFileId: existingActive.id,
              existingSizeBytes: existingActive.sizeBytes,
              existingUpdatedAt: toEpochSeconds(existingActive.updatedAt),
            }
          : {}),
      });
      return { status: 'conflict' };
    }

    if (conflictMode === 'skip') {
      return { status: 'skip' };
    }

    if (
      conflictMode === 'overwrite' &&
      existingActive &&
      existingActive.id !== source.id &&
      !selectedFileIds.has(existingActive.id) &&
      !claimedFilePaths.has(desiredPath)
    ) {
      overwriteTargets.set(existingActive.id, {
        id: existingActive.id,
        accountId: existingActive.accountId,
        driveFileId: existingActive.driveFileId,
        sizeBytes: existingActive.sizeBytes,
      });
      claimedFilePaths.add(desiredPath);
      const parentDir = path.posix.dirname(desiredPath);
      const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);
      return {
        status: 'move',
        op: {
          kind: 'file',
          fileId: source.id,
          accountId: source.accountId,
          driveFileId: source.driveFileId,
          newName: source.name,
          renameOnDrive: false,
          newVirtualPath: desiredPath,
          destFolder: parentDir === '.' ? '/' : parentDir,
          folderId,
          wasTrashed: source.isTrashed,
        },
      };
    }

    // Keep both (or same-batch name collision during overwrite where no pre-existing target remains).
    const keepBothPath = await allocateKeepBothMovePath(
      poolId,
      targetDir,
      source.name,
      claimedFilePaths,
      claimedFolderPaths
    );
    claimedFilePaths.add(keepBothPath);
    const keepBothName = path.posix.basename(keepBothPath);
    const parentDir = path.posix.dirname(keepBothPath);
    const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);
    return {
      status: 'move',
      op: {
        kind: 'file',
        fileId: source.id,
        accountId: source.accountId,
        driveFileId: source.driveFileId,
        newName: keepBothName,
        renameOnDrive: keepBothName !== source.name,
        newVirtualPath: keepBothPath,
        destFolder: parentDir === '.' ? '/' : parentDir,
        folderId,
        wasTrashed: source.isTrashed,
      },
    };
  }

  for (const entry of prunedInputs) {
    if (entry.kind === 'missing') {
      results.push({
        id: entry.item.id,
        kind: entry.resolvedKind,
        type: entry.resolvedKind,
        oldPath: entry.item.id,
        newPath: '',
        success: false,
        error: entry.resolvedKind === 'folder' ? 'Folder not found' : 'File not found',
      });
      continue;
    }

    if (entry.kind === 'file') {
      const file = entry.file;
      const plan = await planSingleFileMove(
        {
          id: file.id,
          name: file.name,
          virtualPath: file.virtualPath,
          accountId: file.accountId,
          driveFileId: file.driveFileId,
          sizeBytes: file.sizeBytes,
          updatedAt: toEpochSeconds(file.updatedAt),
          isTrashed: Boolean(file.isTrashed),
        },
        destFolder
      );

      if (plan.status === 'noop') {
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          oldPath: file.virtualPath,
          newPath: file.virtualPath,
          success: true,
        });
      } else if (plan.status === 'move' && plan.op) {
        plannedOps.push(plan.op);
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          oldPath: file.virtualPath,
          newPath: plan.op.newVirtualPath,
          success: true,
        });
      } else if (plan.status === 'skip') {
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          oldPath: file.virtualPath,
          newPath: file.virtualPath,
          success: true,
          skipped: true,
        });
      } else if (plan.status === 'error') {
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          oldPath: file.virtualPath,
          newPath: normalizeVirtualPath(path.posix.join(destFolder, file.name)),
          success: false,
          error: plan.error,
        });
      }
      continue;
    }

    const folder = entry.folder;
    const oldFolderPath = folder.virtualPath;
    if (destFolder === oldFolderPath || destFolder.startsWith(`${oldFolderPath}/`)) {
      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: '',
        success: false,
        error: 'Cannot move a folder into itself or a subfolder',
      });
      continue;
    }

    const newFolderPath = normalizeVirtualPath(path.posix.join(destFolder, folder.name));
    if (newFolderPath === oldFolderPath) {
      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: true,
      });
      continue;
    }

    const activeFileAtFolderTarget = await db.query.files.findFirst({
      where: and(
        eq(files.poolId, poolId),
        eq(files.virtualPath, newFolderPath),
        eq(files.isTrashed, false)
      ),
    });
    if (activeFileAtFolderTarget || claimedFilePaths.has(newFolderPath)) {
      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: false,
        error: `A file named "${folder.name}" already exists in the destination folder`,
      });
      continue;
    }

    const oldFolderBounds = buildDirectoryPrefixBounds(oldFolderPath);
    const descendantFiles = stmts.selectDescendantFiles.all(
      poolId,
      oldFolderBounds.lower,
      oldFolderBounds.upper,
      formatFolderId(poolId, oldFolderPath)
    ) as DescendantFileRow[];

    const descendantFolders = stmts.selectDescendantFolders.all(
      poolId,
      oldFolderBounds.lower,
      oldFolderBounds.upper
    ) as DescendantFolderRow[];

    const existingDestFolder = await db.query.folders.findFirst({
      where: and(eq(folders.poolId, poolId), eq(folders.virtualPath, newFolderPath)),
    });
    const isMerge = Boolean((existingDestFolder && existingDestFolder.id !== folder.id) || claimedFolderPaths.has(newFolderPath));

    if (!isMerge) {
      claimedFolderPaths.add(newFolderPath);
      cleanCount++;
      const parentId = destFolder === '/' ? null : formatFolderId(poolId, destFolder);
      const newFolderId = formatFolderId(poolId, newFolderPath);

      plannedOps.push({
        kind: 'folder',
        folderId: folder.id,
        oldFolderPath,
        newFolderPath,
        parentId,
        newFolderId,
        descendantFolders,
        descendantFiles,
      });

      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: true,
      });
      continue;
    }

    // Destination folder already exists: plan a silent folder merge.
    claimedFolderPaths.add(newFolderPath);
    const destFolderPathsToEnsure: string[] = [newFolderPath];
    const sourceFolderIdsAndPaths: Array<{ id: string; oldPath: string; newPath: string }> = [
      { id: folder.id, oldPath: oldFolderPath, newPath: newFolderPath },
    ];
    let folderTypeMismatchError: string | null = null;

    for (const sub of descendantFolders) {
      const subDestPath = normalizeVirtualPath(newFolderPath + sub.virtual_path.slice(oldFolderPath.length));
      const subFileBlocking = claimedFilePaths.has(subDestPath)
        ? true
        : Boolean(
            await db.query.files.findFirst({
              where: and(
                eq(files.poolId, poolId),
                eq(files.virtualPath, subDestPath),
                eq(files.isTrashed, false)
              ),
            })
          );
      if (subFileBlocking) {
        folderTypeMismatchError = `A file named "${sub.name}" already exists at "${subDestPath}"`;
        break;
      }
      claimedFolderPaths.add(subDestPath);
      destFolderPathsToEnsure.push(subDestPath);
      sourceFolderIdsAndPaths.push({ id: sub.id, oldPath: sub.virtual_path, newPath: subDestPath });
    }

    if (folderTypeMismatchError) {
      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: false,
        error: folderTypeMismatchError,
      });
      continue;
    }

    const mergeFileMoves: PlannedFileMove[] = [];
    let mergeFileTypeError: string | null = null;
    let mergeSkippedCount = 0;

    for (const f of descendantFiles) {
      if (f.is_trashed) continue;
      const relative = f.virtual_path.startsWith(oldFolderPath + '/')
        ? f.virtual_path.slice(oldFolderPath.length)
        : `/${f.name}`;
      const targetFilePath = normalizeVirtualPath(newFolderPath + relative);
      const targetFileDir = path.posix.dirname(targetFilePath);
      const filePlan = await planSingleFileMove(
        {
          id: f.id,
          name: f.name,
          virtualPath: f.virtual_path,
          accountId: f.account_id,
          driveFileId: f.drive_file_id,
          sizeBytes: f.size_bytes,
          updatedAt: f.updated_at,
          isTrashed: false,
        },
        targetFileDir === '.' ? '/' : targetFileDir
      );

      if (filePlan.status === 'move' && filePlan.op) {
        mergeFileMoves.push(filePlan.op);
      } else if (filePlan.status === 'skip') {
        mergeSkippedCount++;
      } else if (filePlan.status === 'error') {
        mergeFileTypeError = filePlan.error || `Cannot move "${f.name}"`;
        break;
      }
    }

    if (mergeFileTypeError) {
      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: false,
        error: mergeFileTypeError,
      });
      continue;
    }

    if (descendantFiles.filter((f) => !f.is_trashed).length === 0) {
      cleanCount++;
    }

    plannedOps.push({
      kind: 'folder_merge',
      oldFolderPath,
      newFolderPath,
      sourceFolderIdsAndPaths,
      destFolderPathsToEnsure,
      fileMoves: mergeFileMoves,
    });

    results.push({
      id: folder.id,
      kind: 'folder',
      type: 'folder',
      oldPath: oldFolderPath,
      newPath: newFolderPath,
      success: true,
      ...(mergeSkippedCount > 0 ? { skipped: true } : {}),
    });
  }

  if (conflictMode === 'reject' && conflicts.length > 0) {
    throw new MoveConflictError(conflicts, cleanCount);
  }

  const hasDestFolderChanges =
    plannedOps.length > 0 || overwriteTargets.size > 0;

  if (hasDestFolderChanges) {
    const accountsWithOverwrites = new Set<string>();

    sqlite.transaction(() => {
      sqlite.pragma('defer_foreign_keys = ON');
      if (destFolder !== '/') {
        ensureLocalFolderPath(destFolder, poolId);
      }

      const outboxEntries: EnqueueOutboxEntry[] = [];

      // Permanently delete overwritten destination files first so Drive deletes precede incoming moves.
      for (const target of overwriteTargets.values()) {
        stmts.deleteFileById.run(target.id);
        stmts.decrementAccountQuotaUsed.run(target.sizeBytes, target.accountId);
        accountsWithOverwrites.add(target.accountId);
        outboxEntries.push({
          accountId: target.accountId,
          poolId,
          opType: 'file_delete',
          driveFileId: target.driveFileId,
          payload: {
            fileId: target.id,
            driveFileId: target.driveFileId,
          } satisfies FileDeleteOutboxPayload,
        });
      }

      const commitFileMove = (op: PlannedFileMove) => {
        if (op.destFolder !== '/' && op.destFolder !== '.') {
          ensureLocalFolderPath(op.destFolder, poolId);
        }
        stmts.displaceTrashedFileAtPath.run(
          `${op.newVirtualPath}.trashed-${Date.now()}`,
          poolId,
          op.newVirtualPath,
          op.fileId
        );
        stmts.updateMovedOrRenamedFile.run(op.newName, op.newVirtualPath, op.folderId, op.fileId);
      };

      for (const op of plannedOps) {
        if (op.kind === 'file') {
          commitFileMove(op);
          outboxEntries.push({
            accountId: op.accountId,
            poolId,
            opType: 'file_move',
            driveFileId: op.driveFileId,
            payload: {
              fileId: op.fileId,
              driveFileId: op.driveFileId,
              newVirtualPath: op.newVirtualPath,
              destFolder: op.destFolder,
              wasTrashed: op.wasTrashed,
              ...(op.renameOnDrive ? { newName: op.newName } : {}),
            } satisfies FileMoveOutboxPayload,
          });
        } else if (op.kind === 'folder') {
          stmts.updateFolderMove.run(op.newFolderId, op.newFolderPath, op.parentId, op.folderId);

          for (const sub of op.descendantFolders) {
            const subNewPath = op.newFolderPath + sub.virtual_path.slice(op.oldFolderPath.length);
            const subParent = path.posix.dirname(subNewPath);
            const subParentId = subParent === '/' ? null : formatFolderId(poolId, subParent);
            const subNewId = formatFolderId(poolId, subNewPath);
            stmts.updateFolderMove.run(subNewId, subNewPath, subParentId, sub.id);
          }

          const filesByAccount = new Map<
            string,
            Array<{ id: string; driveFileId: string; newVirtualPath: string }>
          >();

          for (const f of op.descendantFiles) {
            const fileNewPath = f.virtual_path.startsWith(op.oldFolderPath + '/')
              ? op.newFolderPath + f.virtual_path.slice(op.oldFolderPath.length)
              : path.posix.join(op.newFolderPath, f.name);
            const fileParent = path.posix.dirname(fileNewPath);
            const fileParentId = fileParent === '/' ? null : formatFolderId(poolId, fileParent);
            stmts.updateDescendantFilePath.run(fileNewPath, fileParentId, f.id);

            if (!f.is_trashed) {
              let list = filesByAccount.get(f.account_id);
              if (!list) {
                list = [];
                filesByAccount.set(f.account_id, list);
              }
              list.push({
                id: f.id,
                driveFileId: f.drive_file_id,
                newVirtualPath: fileNewPath,
              });
            }
          }

          const relevantAccounts = getRelevantPoolAccountIds(poolId, filesByAccount.keys());
          for (const accountId of relevantAccounts) {
            outboxEntries.push({
              accountId,
              poolId,
              opType: 'folder_move_account',
              payload: {
                oldFolderPath: op.oldFolderPath,
                newFolderPath: op.newFolderPath,
                destFolder,
                files: filesByAccount.get(accountId) ?? [],
              } satisfies FolderMoveAccountOutboxPayload,
            });
          }
        } else {
          // Folder merge: ensure destination tree, move active files, and prune emptied source folders.
          for (const destPath of op.destFolderPathsToEnsure) {
            ensureLocalFolderPath(destPath, poolId);
          }

          const filesByAccount = new Map<
            string,
            Array<{
              id: string;
              driveFileId: string;
              newVirtualPath: string;
              destFolder: string;
              wasTrashed: boolean;
              newName?: string;
            }>
          >();

          for (const fm of op.fileMoves) {
            commitFileMove(fm);
            let list = filesByAccount.get(fm.accountId);
            if (!list) {
              list = [];
              filesByAccount.set(fm.accountId, list);
            }
            list.push({
              id: fm.fileId,
              driveFileId: fm.driveFileId,
              newVirtualPath: fm.newVirtualPath,
              destFolder: fm.destFolder,
              wasTrashed: fm.wasTrashed,
              ...(fm.renameOnDrive ? { newName: fm.newName } : {}),
            });
          }

          // Delete source folders bottom-up only if zero active files remain under them.
          const sortedSourceFolders = [...op.sourceFolderIdsAndPaths].sort(
            (a, b) => b.oldPath.length - a.oldPath.length
          );
          const prunedSourcePaths: string[] = [];
          for (const sf of sortedSourceFolders) {
            const bounds = buildDirectoryPrefixBounds(sf.oldPath);
            const row = stmts.countActiveFilesInSubtree.get(
              poolId,
              bounds.lower,
              bounds.upper,
              sf.id
            ) as { cnt: number } | undefined;
            if ((row?.cnt ?? 0) === 0) {
              stmts.deleteFolderById.run(sf.id);
              prunedSourcePaths.push(sf.oldPath);
            }
          }

          const relevantAccounts = getRelevantPoolAccountIds(poolId, filesByAccount.keys());
          for (const accountId of relevantAccounts) {
            outboxEntries.push({
              accountId,
              poolId,
              opType: 'folder_merge_account',
              payload: {
                oldFolderPath: op.oldFolderPath,
                sourceFolderPathsToPrune: prunedSourcePaths,
                ensuredFolderPaths: op.destFolderPathsToEnsure,
                files: filesByAccount.get(accountId) ?? [],
              } satisfies FolderMergeAccountOutboxPayload,
            });
          }
        }
      }

      enqueueDriveOutbox(outboxEntries);
    }).immediate();

    for (const accountId of accountsWithOverwrites) {
      markAccountQuotaDecreased(accountId);
    }
    if (accountsWithOverwrites.size > 0) {
      invalidatePooledStorageOverview(poolId);
    }
    bumpPoolRevision(poolId);
  }

  return results;
}

export interface CopyResult {
  id: string;
  kind: 'file' | 'folder';
  type?: 'file' | 'folder';
  sourcePath: string;
  destPath: string;
  success: boolean;
  error?: string;
}

export async function getAvailableCopyPath(
  targetDir: string,
  baseName: string,
  kind: 'file' | 'folder',
  poolId = 1
): Promise<string> {
  const ext = kind === 'file' ? path.extname(baseName) : '';
  const stem = kind === 'file' ? path.basename(baseName, ext) : baseName;

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

    candidateName = counter === 1 ? `${stem} (copy)${ext}` : `${stem} (copy ${counter})${ext}`;
    candidatePath = normalizeVirtualPath(path.posix.join(targetDir, candidateName));
    counter++;
  }
}

function allocateAvailableCopyPath(
  targetDir: string,
  baseName: string,
  kind: 'file' | 'folder',
  occupiedPaths: Set<string>
): string {
  const ext = kind === 'file' ? path.posix.extname(baseName) : '';
  const stem = kind === 'file' ? path.posix.basename(baseName, ext) : baseName;

  let candidateName = baseName;
  let candidatePath = normalizeVirtualPath(path.posix.join(targetDir, candidateName));
  let counter = 1;

  while (occupiedPaths.has(candidatePath)) {
    candidateName = counter === 1 ? `${stem} (copy)${ext}` : `${stem} (copy ${counter})${ext}`;
    candidatePath = normalizeVirtualPath(path.posix.join(targetDir, candidateName));
    counter++;
  }

  occupiedPaths.add(candidatePath);
  return candidatePath;
}

interface CopyFileTask {
  topLevelIndex: number;
  isTopLevelFile: boolean;
  sourceFileId: string;
  sourceVirtualPath: string;
  sourceAccountId: string;
  sourceDriveFileId: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  destVirtualPath: string;
  destFileName: string;
  destParentDir: string;
  targetAccountId?: string;
  newFileId?: string;
  newDriveFileId?: string;
  error?: string;
}

export async function copyItems(
  items: MoveItemInput[],
  targetFolderPath: string,
  poolId = 1
): Promise<CopyResult[]> {
  const destFolder = normalizeVirtualPath(targetFolderPath);
  if (destFolder !== '/') {
    ensureLocalFolderPath(destFolder, poolId);
  }

  const stmts = getStmts();

  const existingFilePaths = new Set<string>();
  const existingFolderPaths = new Set<string>();

  if (destFolder === '/') {
    const fileRows = stmts.selectAllActiveFilePathsInPool.all(poolId) as Array<{ virtual_path: string }>;
    for (const row of fileRows) {
      existingFilePaths.add(row.virtual_path);
    }
    const folderRows = stmts.selectAllFolderPathsInPool.all(poolId) as Array<{ virtual_path: string }>;
    for (const row of folderRows) {
      existingFolderPaths.add(row.virtual_path);
    }
  } else {
    const destBounds = buildDirectoryPrefixBounds(destFolder);
    const fileRows = stmts.selectActiveFilePathsUnderPrefix.all(
      poolId,
      destBounds.lower,
      destBounds.upper
    ) as Array<{ virtual_path: string }>;
    for (const row of fileRows) {
      existingFilePaths.add(row.virtual_path);
    }
    const folderRows = stmts.selectFolderPathsUnderPrefix.all(
      poolId,
      destBounds.lower,
      destBounds.upper
    ) as Array<{ virtual_path: string }>;
    for (const row of folderRows) {
      existingFolderPaths.add(row.virtual_path);
    }
  }

  // Prune items whose ancestor folder is already included in this batch.
  const copyFolderPaths: string[] = [];
  const copySeenIds = new Set<string>();
  const resolvedCopyKinds: Array<'file' | 'folder'> = new Array(items.length);
  const resolvedCopyPaths: Array<string | null> = new Array(items.length).fill(null);
  const duplicateInputIndices = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let resolvedKind = item.kind || item.type;
    if (!resolvedKind) {
      const folderExists = await db.query.folders.findFirst({
        where: and(
          eq(folders.poolId, poolId),
          or(eq(folders.id, item.id), eq(folders.virtualPath, item.id))
        ),
      });
      resolvedKind = folderExists ? 'folder' : 'file';
    }
    resolvedCopyKinds[i] = resolvedKind;
    if (resolvedKind === 'folder') {
      const f = await db.query.folders.findFirst({
        where: and(
          eq(folders.poolId, poolId),
          or(eq(folders.id, item.id), eq(folders.virtualPath, item.id))
        ),
      });
      if (f) {
        if (copySeenIds.has(f.id)) {
          duplicateInputIndices.add(i);
        } else {
          copySeenIds.add(f.id);
          copyFolderPaths.push(f.virtualPath);
          resolvedCopyPaths[i] = f.virtualPath;
        }
      }
    } else {
      const f = await db.query.files.findFirst({
        where: and(
          eq(files.poolId, poolId),
          or(eq(files.id, item.id), eq(files.virtualPath, item.id))
        ),
      });
      if (f) {
        if (copySeenIds.has(f.id)) {
          duplicateInputIndices.add(i);
        } else {
          copySeenIds.add(f.id);
          resolvedCopyPaths[i] = f.virtualPath;
        }
      }
    }
  }

  const results: CopyResult[] = [];
  const fileCopyTasks: CopyFileTask[] = [];
  const foldersToEnsure: string[] = [];

  for (let i = 0; i < items.length; i++) {
    if (duplicateInputIndices.has(i)) continue;
    const itemPath = resolvedCopyPaths[i];
    if (
      itemPath &&
      copyFolderPaths.some((anc) => anc !== itemPath && itemPath.startsWith(`${anc}/`))
    ) {
      continue;
    }
    const item = items[i];
    const resolvedKind = resolvedCopyKinds[i];
    const resultIndex = results.length;
    results.push({
      id: item.id,
      kind: resolvedKind,
      type: resolvedKind,
      sourcePath: item.id,
      destPath: '',
      success: false,
    });

    if (resolvedKind === 'file') {
      const file = await db.query.files.findFirst({
        where: and(
          eq(files.poolId, poolId),
          or(eq(files.id, item.id), eq(files.virtualPath, item.id))
        ),
      });

      if (!file) {
        results[resultIndex] = {
          id: item.id,
          kind: 'file',
          sourcePath: item.id,
          destPath: '',
          success: false,
          error: 'File not found',
        };
        continue;
      }

      const destVirtualPath = allocateAvailableCopyPath(destFolder, file.name, 'file', existingFilePaths);
      const destFileName = path.posix.basename(destVirtualPath);

      fileCopyTasks.push({
        topLevelIndex: resultIndex,
        isTopLevelFile: true,
        sourceFileId: file.id,
        sourceVirtualPath: file.virtualPath,
        sourceAccountId: file.accountId,
        sourceDriveFileId: file.driveFileId,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        hash: file.hash,
        destVirtualPath,
        destFileName,
        destParentDir: destFolder,
      });

      results[resultIndex] = {
        id: file.id,
        kind: 'file',
        type: 'file',
        sourcePath: file.virtualPath,
        destPath: '',
        success: false,
      };
    } else if (resolvedKind === 'folder') {
      const folder = await db.query.folders.findFirst({
        where: and(
          eq(folders.poolId, poolId),
          or(eq(folders.id, item.id), eq(folders.virtualPath, item.id))
        ),
      });

      if (!folder) {
        results[resultIndex] = {
          id: item.id,
          kind: 'folder',
          type: 'folder',
          sourcePath: item.id,
          destPath: '',
          success: false,
          error: 'Folder not found',
        };
        continue;
      }

      const destVirtualPath = allocateAvailableCopyPath(
        destFolder,
        folder.name,
        'folder',
        existingFolderPaths
      );
      foldersToEnsure.push(destVirtualPath);

      const folderBounds = buildDirectoryPrefixBounds(folder.virtualPath);
      const subFolders = stmts.selectDescendantFolders.all(
        poolId,
        folderBounds.lower,
        folderBounds.upper
      ) as DescendantFolderRow[];

      for (const sub of subFolders) {
        const subRelative = sub.virtual_path.slice(folder.virtualPath.length);
        const destSubPath = normalizeVirtualPath(destVirtualPath + subRelative);
        existingFolderPaths.add(destSubPath);
        foldersToEnsure.push(destSubPath);
      }

      const subFiles = stmts.selectActiveDescendantFiles.all(
        poolId,
        folderBounds.lower,
        folderBounds.upper,
        formatFolderId(poolId, folder.virtualPath)
      ) as ActiveDescendantFileRow[];

      for (const subFile of subFiles) {
        const subRelative = subFile.virtual_path.startsWith(folder.virtualPath + '/')
          ? subFile.virtual_path.slice(folder.virtualPath.length)
          : `/${subFile.name}`;
        const destSubFilePath = normalizeVirtualPath(destVirtualPath + subRelative);
        const destSubFileDir = normalizeVirtualPath(path.posix.dirname(destSubFilePath));
        existingFilePaths.add(destSubFilePath);

        fileCopyTasks.push({
          topLevelIndex: resultIndex,
          isTopLevelFile: false,
          sourceFileId: subFile.id,
          sourceVirtualPath: subFile.virtual_path,
          sourceAccountId: subFile.account_id,
          sourceDriveFileId: subFile.drive_file_id,
          sizeBytes: subFile.size_bytes,
          mimeType: subFile.mime_type,
          hash: subFile.hash,
          destVirtualPath: destSubFilePath,
          destFileName: path.posix.basename(destSubFilePath),
          destParentDir: destSubFileDir,
        });
      }

      results[resultIndex] = {
        id: destVirtualPath,
        kind: 'folder',
        type: 'folder',
        sourcePath: folder.virtualPath,
        destPath: destVirtualPath,
        success: true,
      };
    } else {
      results[resultIndex] = {
        id: item.id,
        kind: 'file',
        type: 'file',
        sourcePath: item.id,
        destPath: '',
        success: false,
        error: `Item not found or invalid kind: ${item.id}`,
      };
    }
  }

  for (const folderPath of foldersToEnsure) {
    ensureLocalFolderPath(folderPath, poolId);
  }

  if (fileCopyTasks.length > 0) {
    const nowMs = Date.now();
    try {
      const plan = await planBatchPlacement(
        fileCopyTasks.map((task) => ({
          virtualPath: task.destVirtualPath,
          sizeBytes: task.sizeBytes,
        })),
        nowMs,
        poolId
      );

      const decisionByPath = new Map<string, string>();
      for (const decision of plan.decisions) {
        decisionByPath.set(decision.virtualPath, decision.accountId);
      }

      for (const task of fileCopyTasks) {
        const accountId = decisionByPath.get(task.destVirtualPath);
        if (accountId) {
          task.targetAccountId = accountId;
        } else {
          task.error = new InsufficientStorageError().message;
        }
      }
    } catch {
      const candidates = await getEligibleAccounts(poolId, nowMs);
      const simulatedHeadrooms = new Map<string, number>();
      const simulatedBudgets = new Map<string, number>();
      for (const c of candidates) {
        simulatedHeadrooms.set(c.id, c.headroomBytes);
        simulatedBudgets.set(c.id, c.transferStats.remainingUploadBytes24h);
      }

      for (const task of fileCopyTasks) {
        if (task.sizeBytes > MAX_SINGLE_FILE_BYTES) {
          task.error = new FileExceedsCeilingError(task.sizeBytes).message;
          continue;
        }

        let bestCandidateId: string | null = null;
        let minDiff = Infinity;
        for (const c of candidates) {
          const headroom = simulatedHeadrooms.get(c.id) ?? 0;
          const budget = simulatedBudgets.get(c.id) ?? 0;
          if (headroom >= task.sizeBytes && budget >= task.sizeBytes) {
            const diff = headroom - task.sizeBytes;
            if (diff < minDiff) {
              minDiff = diff;
              bestCandidateId = c.id;
            }
          }
        }

        if (!bestCandidateId) {
          task.error = new InsufficientStorageError().message;
          continue;
        }

        simulatedHeadrooms.set(bestCandidateId, (simulatedHeadrooms.get(bestCandidateId) ?? 0) - task.sizeBytes);
        simulatedBudgets.set(bestCandidateId, (simulatedBudgets.get(bestCandidateId) ?? 0) - task.sizeBytes);
        task.targetAccountId = bestCandidateId;
      }
    }

    const accountRows = stmts.selectPoolAccountsForCopy.all(poolId) as Array<{
      id: string;
      email: string;
      root_folder_id: string | null;
    }>;
    const accountMap = new Map(accountRows.map((acc) => [acc.id, acc]));
    const remoteFolderCache = new Map<string, Promise<string>>();

    const getRemoteFolderId = (
      accountId: string,
      driveTarget: ReturnType<typeof getDriveClient>,
      rootFolderId: string,
      folderPath: string
    ): Promise<string> => {
      const key = `${accountId}:${folderPath}`;
      let pending = remoteFolderCache.get(key);
      if (!pending) {
        pending = ensureRemoteFolderHierarchy(driveTarget, rootFolderId, folderPath);
        remoteFolderCache.set(key, pending);
      }
      return pending;
    };

    const placedTasks = fileCopyTasks.filter((task) => !task.error && task.targetAccountId);

    await runBoundedConcurrency(placedTasks, 6, async (task) => {
      try {
        const targetAccountId = task.targetAccountId!;
        const targetAccount = accountMap.get(targetAccountId);
        if (!targetAccount) {
          throw new Error(`Target account ${targetAccountId} not registered`);
        }

        const driveTarget = getDriveClient(targetAccountId);
        const targetRootId = targetAccount.root_folder_id || (await getAccountRootFolderId(targetAccountId));
        const targetRemoteFolderId = await getRemoteFolderId(
          targetAccountId,
          driveTarget,
          targetRootId,
          task.destParentDir
        );

        const newFileId = randomUUID();
        const newDriveFileId = await withDriveRetry(() =>
          copyDriveFileCrossAccount({
            sourceAccountId: task.sourceAccountId,
            sourceDriveFileId: task.sourceDriveFileId,
            targetAccountId,
            targetAccountEmail: targetAccount.email,
            targetRemoteFolderId,
            destFileName: task.destFileName,
            appProperties: {
              tsubasa_managed: 'true',
              tsubasa_virtual_path: task.destVirtualPath,
              tsubasa_virtual_id: newFileId,
              tsubasa_checksum: task.hash || '',
            },
            fields: 'id, name, size',
          })
        );

        task.newFileId = newFileId;
        task.newDriveFileId = newDriveFileId;
      } catch (err) {
        task.error = err instanceof Error ? err.message : String(err);
      }
    });

    const succeededTasks = placedTasks.filter(
      (task) => !task.error && task.newFileId && task.newDriveFileId && task.targetAccountId
    );

    if (succeededTasks.length > 0) {
      const commitMs = Date.now();
      sqlite.transaction(() => {
        const bytesByAccount = new Map<string, number>();

        for (const task of succeededTasks) {
          const parentDir = path.posix.dirname(task.destVirtualPath);
          const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

          stmts.displaceAnyTrashedFileAtPath.run(
            `${task.destVirtualPath}.trashed-${commitMs}`,
            poolId,
            task.destVirtualPath
          );

          stmts.insertCopiedFile.run(
            task.newFileId!,
            poolId,
            task.destVirtualPath,
            task.destFileName,
            task.sizeBytes,
            task.mimeType,
            task.hash,
            task.targetAccountId!,
            task.newDriveFileId!,
            folderId
          );

          stmts.insertTransferLog.run(randomUUID(), task.targetAccountId!, task.sizeBytes, commitMs);
          bytesByAccount.set(
            task.targetAccountId!,
            (bytesByAccount.get(task.targetAccountId!) ?? 0) + task.sizeBytes
          );
        }

        for (const [accountId, addedBytes] of bytesByAccount) {
          if (addedBytes > 0) {
            stmts.incrementAccountQuotaUsed.run(addedBytes, accountId);
          }
        }
      }).immediate();

      invalidatePooledStorageOverview(poolId);
      bumpPoolRevision(poolId);
    }

    for (const task of fileCopyTasks) {
      const result = results[task.topLevelIndex];
      if (!result) continue;

      if (task.isTopLevelFile) {
        if (!task.error && task.newFileId) {
          result.id = task.newFileId;
          result.destPath = task.destVirtualPath;
          result.success = true;
        } else {
          result.success = false;
          result.error = task.error || 'Copy failed';
        }
      } else if (task.error && result.success) {
        result.success = false;
        result.error = task.error;
      }
    }
  } else if (foldersToEnsure.length > 0) {
    bumpPoolRevision(poolId);
  }

  return results;
}

export async function renameItem(
  kind: 'file' | 'folder',
  idOrPath: string,
  rawNewName: string,
  poolId = 1
): Promise<{ success: boolean; oldPath: string; newPath: string }> {
  const newName = validateItemName(rawNewName);

  const stmts = getStmts();

  if (kind === 'file') {
    const file = await db.query.files.findFirst({
      where: and(
        eq(files.poolId, poolId),
        or(eq(files.id, idOrPath), eq(files.virtualPath, idOrPath))
      ),
    });

    if (!file) {
      throw new ItemNotFoundError(`File not found: ${idOrPath}`);
    }

    const parentDir = path.posix.dirname(file.virtualPath);
    const newVirtualPath = normalizeVirtualPath(path.posix.join(parentDir, newName));

    if (newVirtualPath === file.virtualPath) {
      return { success: true, oldPath: file.virtualPath, newPath: newVirtualPath };
    }

    const existing = await db.query.files.findFirst({
      where: and(
        eq(files.poolId, poolId),
        eq(files.virtualPath, newVirtualPath),
        eq(files.isTrashed, false)
      ),
    });

    if (existing && existing.id !== file.id) {
      throw new ItemConflictError(`A file named "${newName}" already exists in this folder`);
    }

    const collidingFolder = await db.query.folders.findFirst({
      where: and(eq(folders.poolId, poolId), eq(folders.virtualPath, newVirtualPath)),
    });
    if (collidingFolder) {
      throw new ItemConflictError(`A folder named "${newName}" already exists in this directory`);
    }

    const validParentId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);
    if (parentDir !== '/' && parentDir !== '.') {
      ensureLocalFolderPath(parentDir, poolId);
    }

    sqlite.transaction(() => {
      sqlite.pragma('defer_foreign_keys = ON');
      stmts.displaceTrashedFileAtPath.run(
        `${newVirtualPath}.trashed-${Date.now()}`,
        poolId,
        newVirtualPath,
        file.id
      );
      stmts.renameSingleFile.run(newName, newVirtualPath, validParentId, file.id);
      enqueueDriveOutbox([
        {
          accountId: file.accountId,
          poolId,
          opType: 'file_rename',
          driveFileId: file.driveFileId,
          payload: {
            fileId: file.id,
            driveFileId: file.driveFileId,
            newName,
            newVirtualPath,
          } satisfies FileRenameOutboxPayload,
        },
      ]);
    }).immediate();

    bumpPoolRevision(poolId);
    return { success: true, oldPath: file.virtualPath, newPath: newVirtualPath };
  }

  const folder = await db.query.folders.findFirst({
    where: and(
      eq(folders.poolId, poolId),
      or(eq(folders.id, idOrPath), eq(folders.virtualPath, idOrPath))
    ),
  });

  if (!folder) {
    throw new ItemNotFoundError(`Folder not found: ${idOrPath}`);
  }

  const oldFolderPath = folder.virtualPath;
  const parentDir = path.posix.dirname(oldFolderPath);
  const newFolderPath = normalizeVirtualPath(path.posix.join(parentDir, newName));

  if (newFolderPath === oldFolderPath) {
    return { success: true, oldPath: oldFolderPath, newPath: newFolderPath };
  }

  const existing = await db.query.folders.findFirst({
    where: and(
      eq(folders.poolId, poolId),
      eq(folders.virtualPath, newFolderPath)
    ),
  });

  if (existing && existing.id !== folder.id) {
    throw new ItemConflictError(`A folder named "${newName}" already exists in this directory`);
  }

  const collidingFile = await db.query.files.findFirst({
    where: and(
      eq(files.poolId, poolId),
      eq(files.virtualPath, newFolderPath),
      eq(files.isTrashed, false)
    ),
  });
  if (collidingFile) {
    throw new ItemConflictError(`A file named "${newName}" already exists in this directory`);
  }

  const oldFolderBounds = buildDirectoryPrefixBounds(oldFolderPath);
  const allDescendantFiles = stmts.selectDescendantFiles.all(
    poolId,
    oldFolderBounds.lower,
    oldFolderBounds.upper,
    formatFolderId(poolId, oldFolderPath)
  ) as DescendantFileRow[];

  const allDescendantFolders = stmts.selectDescendantFolders.all(
    poolId,
    oldFolderBounds.lower,
    oldFolderBounds.upper
  ) as DescendantFolderRow[];

  sqlite.transaction(() => {
    sqlite.pragma('defer_foreign_keys = ON');

    const parentId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);
    const newFolderId = formatFolderId(poolId, newFolderPath);
    stmts.updateFolderRename.run(newFolderId, newFolderPath, newName, parentId, folder.id);

    for (const sub of allDescendantFolders) {
      const subNewPath = newFolderPath + sub.virtual_path.slice(oldFolderPath.length);
      const subParent = path.posix.dirname(subNewPath);
      const subParentId = subParent === '/' ? null : formatFolderId(poolId, subParent);
      const subNewId = formatFolderId(poolId, subNewPath);
      stmts.updateFolderMove.run(subNewId, subNewPath, subParentId, sub.id);
    }

    const filesByAccount = new Map<
      string,
      Array<{ id: string; driveFileId: string; newVirtualPath: string }>
    >();

    for (const f of allDescendantFiles) {
      const fileNewPath = f.virtual_path.startsWith(oldFolderPath + '/')
        ? newFolderPath + f.virtual_path.slice(oldFolderPath.length)
        : path.posix.join(newFolderPath, f.name);
      const fileParent = path.posix.dirname(fileNewPath);
      const fileParentId = fileParent === '/' ? null : formatFolderId(poolId, fileParent);
      stmts.updateDescendantFilePath.run(fileNewPath, fileParentId, f.id);

      let list = filesByAccount.get(f.account_id);
      if (!list) {
        list = [];
        filesByAccount.set(f.account_id, list);
      }
      list.push({
        id: f.id,
        driveFileId: f.drive_file_id,
        newVirtualPath: fileNewPath,
      });
    }

    const relevantAccounts = getRelevantPoolAccountIds(poolId, filesByAccount.keys());
    const outboxEntries: EnqueueOutboxEntry[] = [];
    for (const accountId of relevantAccounts) {
      outboxEntries.push({
        accountId,
        poolId,
        opType: 'folder_rename_account',
        payload: {
          oldFolderPath,
          newFolderPath,
          newName,
          files: filesByAccount.get(accountId) ?? [],
        } satisfies FolderRenameAccountOutboxPayload,
      });
    }
    enqueueDriveOutbox(outboxEntries);
  }).immediate();

  bumpPoolRevision(poolId);
  return { success: true, oldPath: oldFolderPath, newPath: newFolderPath };
}

export async function trashFolder(
  virtualPath: string,
  poolId = 1
): Promise<{ trashedFilesCount: number }> {
  const stmts = getStmts();
  const normPath = normalizeVirtualPath(virtualPath);
  const folderId = formatFolderId(poolId, normPath);
  const { lower, upper } = buildDirectoryPrefixBounds(normPath);

  const descendantFiles = stmts.selectActiveDescendantFiles.all(
    poolId,
    lower,
    upper,
    folderId
  ) as ActiveDescendantFileRow[];

  sqlite.transaction(() => {
    stmts.trashFilesInFolder.run(poolId, lower, upper, folderId);
    stmts.deleteFoldersInTree.run(poolId, normPath, lower, upper);
    stmts.deleteShareLinksForFolder.run(poolId, normPath);

    const filesByAccount = new Map<string, Array<{ id: string; driveFileId: string }>>();
    for (const f of descendantFiles) {
      let list = filesByAccount.get(f.account_id);
      if (!list) {
        list = [];
        filesByAccount.set(f.account_id, list);
      }
      list.push({
        id: f.id,
        driveFileId: f.drive_file_id,
      });
    }

    const relevantAccounts = getRelevantPoolAccountIds(poolId, filesByAccount.keys());
    const outboxEntries: EnqueueOutboxEntry[] = [];
    for (const accountId of relevantAccounts) {
      outboxEntries.push({
        accountId,
        poolId,
        opType: 'folder_trash_account',
        payload: {
          normPath,
          files: filesByAccount.get(accountId) ?? [],
        } satisfies FolderTrashAccountOutboxPayload,
      });
    }
    enqueueDriveOutbox(outboxEntries);
  }).immediate();

  bumpPoolRevision(poolId);
  return { trashedFilesCount: descendantFiles.length };
}
