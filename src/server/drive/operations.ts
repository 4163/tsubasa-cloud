import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite, buildDirectoryPrefixBounds, bumpPoolRevision } from '../db/index.js';
import { accounts, files, folders } from '../db/schema.js';
import { eq, or, and } from 'drizzle-orm';
import {
  getDriveClient,
  getAccountRootFolderId,
  runBoundedConcurrency,
  withDriveRetry,
} from './client.js';
import { copyDriveFileCrossAccount } from './transfer.js';
import { ensureRemoteFolderHierarchy, normalizeVirtualPath } from './mirror.js';
import { ensureLocalFolderPath, formatFolderId } from './sync.js';
import {
  enqueueDriveOutbox,
  type EnqueueOutboxEntry,
  type FileMoveOutboxPayload,
  type FileRenameOutboxPayload,
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

let cachedStmts: {
  selectPoolAccountsWithRoot: SqliteStmt;
  selectPoolAccountsForCopy: SqliteStmt;
  displaceTrashedFileAtPath: SqliteStmt;
  displaceAnyTrashedFileAtPath: SqliteStmt;
  updateMovedFile: SqliteStmt;
  selectDescendantFiles: SqliteStmt;
  selectActiveDescendantFiles: SqliteStmt;
  selectDescendantFolders: SqliteStmt;
  updateFolderMove: SqliteStmt;
  updateFolderRename: SqliteStmt;
  updateDescendantFilePath: SqliteStmt;
  renameSingleFile: SqliteStmt;
  hasFilesInFolder: SqliteStmt;
  hasSubfoldersInFolder: SqliteStmt;
  deleteFolderById: SqliteStmt;
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
    selectDescendantFiles: sqlite.prepare(
      'SELECT id, virtual_path, name, account_id, drive_file_id FROM files WHERE pool_id = ? AND ((virtual_path >= ? AND virtual_path < ?) OR folder_id = ?)'
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
    hasFilesInFolder: sqlite.prepare(
      'SELECT 1 FROM files WHERE pool_id = ? AND ((virtual_path >= ? AND virtual_path < ?) OR folder_id = ?) LIMIT 1'
    ),
    hasSubfoldersInFolder: sqlite.prepare(
      'SELECT 1 FROM folders WHERE pool_id = ? AND virtual_path >= ? AND virtual_path < ? AND id != ? LIMIT 1'
    ),
    deleteFolderById: sqlite.prepare('DELETE FROM folders WHERE id = ?'),
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
  error?: string;
}

type PlannedMoveOp =
  | {
      kind: 'file';
      fileId: string;
      accountId: string;
      driveFileId: string;
      newVirtualPath: string;
      folderId: string | null;
      wasTrashed: boolean;
    }
  | {
      kind: 'folder';
      folderId: string;
      oldFolderPath: string;
      newFolderPath: string;
      parentId: string | null;
      newFolderId: string;
      descendantFolders: DescendantFolderRow[];
      descendantFiles: DescendantFileRow[];
    };

export async function moveItems(
  items: MoveItemInput[],
  targetFolderPath: string,
  poolId = 1
): Promise<MoveResult[]> {
  const destFolder = normalizeVirtualPath(targetFolderPath);
  if (destFolder !== '/') {
    ensureLocalFolderPath(destFolder, poolId);
  }

  const stmts = getStmts();
  const results: MoveResult[] = [];
  const plannedOps: PlannedMoveOp[] = [];
  const claimedFilePaths = new Set<string>();
  const claimedFolderPaths = new Set<string>();

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
        results.push({
          id: item.id,
          kind: 'file',
          type: 'file',
          oldPath: item.id,
          newPath: '',
          success: false,
          error: 'File not found',
        });
        continue;
      }

      const wasTrashed = Boolean(file.isTrashed);
      const newVirtualPath = normalizeVirtualPath(path.posix.join(destFolder, file.name));
      if (newVirtualPath === file.virtualPath && !wasTrashed) {
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          oldPath: file.virtualPath,
          newPath: newVirtualPath,
          success: true,
        });
        continue;
      }

      const existing = await db.query.files.findFirst({
        where: and(
          eq(files.poolId, poolId),
          eq(files.virtualPath, newVirtualPath),
          eq(files.isTrashed, false)
        ),
      });

      if ((existing && existing.id !== file.id) || claimedFilePaths.has(newVirtualPath)) {
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          oldPath: file.virtualPath,
          newPath: newVirtualPath,
          success: false,
          error: `A file named "${file.name}" already exists in the destination folder`,
        });
        continue;
      }

      claimedFilePaths.add(newVirtualPath);

      const parentDir = path.posix.dirname(newVirtualPath);
      const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);
      if (parentDir !== '/' && parentDir !== '.') {
        ensureLocalFolderPath(parentDir, poolId);
      }

      plannedOps.push({
        kind: 'file',
        fileId: file.id,
        accountId: file.accountId,
        driveFileId: file.driveFileId,
        newVirtualPath,
        folderId,
        wasTrashed,
      });

      results.push({
        id: file.id,
        kind: 'file',
        type: 'file',
        oldPath: file.virtualPath,
        newPath: newVirtualPath,
        success: true,
      });
    } else if (resolvedKind === 'folder') {
      const folder = await db.query.folders.findFirst({
        where: and(
          eq(folders.poolId, poolId),
          or(eq(folders.id, item.id), eq(folders.virtualPath, item.id))
        ),
      });

      if (!folder) {
        results.push({
          id: item.id,
          kind: 'folder',
          type: 'folder',
          oldPath: item.id,
          newPath: '',
          success: false,
          error: 'Folder not found',
        });
        continue;
      }

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

      const existingFolder = await db.query.folders.findFirst({
        where: and(eq(folders.poolId, poolId), eq(folders.virtualPath, newFolderPath)),
      });

      if ((existingFolder && existingFolder.id !== folder.id) || claimedFolderPaths.has(newFolderPath)) {
        results.push({
          id: folder.id,
          kind: 'folder',
          type: 'folder',
          oldPath: oldFolderPath,
          newPath: newFolderPath,
          success: false,
          error: `A folder named "${folder.name}" already exists in the destination folder`,
        });
        continue;
      }

      claimedFolderPaths.add(newFolderPath);

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
    } else {
      results.push({
        id: item.id,
        kind: 'file',
        type: 'file',
        oldPath: item.id,
        newPath: '',
        success: false,
        error: `Item not found or invalid kind: ${item.id}`,
      });
    }
  }

  if (plannedOps.length > 0) {
    sqlite.transaction(() => {
      sqlite.pragma('defer_foreign_keys = ON');
      const outboxEntries: EnqueueOutboxEntry[] = [];

      for (const op of plannedOps) {
        if (op.kind === 'file') {
          stmts.displaceTrashedFileAtPath.run(
            `${op.newVirtualPath}.trashed-${Date.now()}`,
            poolId,
            op.newVirtualPath,
            op.fileId
          );
          stmts.updateMovedFile.run(op.newVirtualPath, op.folderId, op.fileId);

          outboxEntries.push({
            accountId: op.accountId,
            poolId,
            opType: 'file_move',
            driveFileId: op.driveFileId,
            payload: {
              fileId: op.fileId,
              driveFileId: op.driveFileId,
              newVirtualPath: op.newVirtualPath,
              destFolder,
              wasTrashed: op.wasTrashed,
            } satisfies FileMoveOutboxPayload,
          });
        } else {
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
        }
      }

      enqueueDriveOutbox(outboxEntries);
    }).immediate();

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

  const results: CopyResult[] = new Array(items.length);
  const fileCopyTasks: CopyFileTask[] = [];
  const foldersToEnsure: string[] = [];

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

    if (resolvedKind === 'file') {
      const file = await db.query.files.findFirst({
        where: and(
          eq(files.poolId, poolId),
          or(eq(files.id, item.id), eq(files.virtualPath, item.id))
        ),
      });

      if (!file) {
        results[i] = {
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
        topLevelIndex: i,
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

      results[i] = {
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
        results[i] = {
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
          topLevelIndex: i,
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

      results[i] = {
        id: destVirtualPath,
        kind: 'folder',
        type: 'folder',
        sourcePath: folder.virtualPath,
        destPath: destVirtualPath,
        success: true,
      };
    } else {
      results[i] = {
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
  const newName = rawNewName.trim();
  if (!newName || newName.includes('/') || newName.includes('\\')) {
    throw new Error('Invalid name: cannot be empty or contain slash characters');
  }

  const stmts = getStmts();

  if (kind === 'file') {
    const file = await db.query.files.findFirst({
      where: and(
        eq(files.poolId, poolId),
        or(eq(files.id, idOrPath), eq(files.virtualPath, idOrPath))
      ),
    });

    if (!file) {
      throw new Error(`File not found: ${idOrPath}`);
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
      throw new Error(`A file named "${newName}" already exists in this folder`);
    }

    const validParentId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);
    if (parentDir !== '/' && parentDir !== '.') {
      ensureLocalFolderPath(parentDir, poolId);
    }

    sqlite.transaction(() => {
      sqlite.pragma('defer_foreign_keys = ON');
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
    throw new Error(`Folder not found: ${idOrPath}`);
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

  let emptyExistingIdToDelete: string | null = null;
  if (existing && existing.id !== folder.id) {
    const newFolderBounds = buildDirectoryPrefixBounds(newFolderPath);
    const targetFolderId = formatFolderId(poolId, newFolderPath);
    const hasFiles = stmts.hasFilesInFolder.get(
      poolId,
      newFolderBounds.lower,
      newFolderBounds.upper,
      targetFolderId
    );
    const hasSubfolders = stmts.hasSubfoldersInFolder.get(
      poolId,
      newFolderBounds.lower,
      newFolderBounds.upper,
      targetFolderId
    );

    if (!hasFiles && !hasSubfolders) {
      emptyExistingIdToDelete = existing.id;
    } else {
      throw new Error(`A folder named "${newName}" already exists in this directory`);
    }
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

    if (emptyExistingIdToDelete) {
      stmts.deleteFolderById.run(emptyExistingIdToDelete);
    }

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
