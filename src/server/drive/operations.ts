import path from 'node:path';
import { db, sqlite, buildDirectoryPrefixBounds, bumpPoolRevision } from '../db/index.js';
import { files, folders } from '../db/schema.js';
import { eq, or, and } from 'drizzle-orm';
import { normalizeVirtualPath } from '../virtualPath.js';
import {
  ItemConflictError,
  ItemNotFoundError,
  validateItemName,
} from './errors.js';
import { ensureLocalFolderPath, formatFolderId } from './sync.js';
import { enqueueDriveOutbox } from './outbox.js';
import type {
  FileRenameOutboxPayload,
  FolderRenameAccountOutboxPayload,
  FolderTrashAccountOutboxPayload,
} from './outboxQueue.js';
import {
  displaceTrashedFileAtPath,
  enqueuePoolAccountOutbox,
  getStmts,
  type ActiveDescendantFileRow,
  type DescendantFileRow,
  type DescendantFolderRow,
} from './operationsDb.js';

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
      displaceTrashedFileAtPath(poolId, newVirtualPath, { excludeFileId: file.id });
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
      displaceTrashedFileAtPath(poolId, fileNewPath, { excludeFileId: f.id });
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

    enqueuePoolAccountOutbox(
      poolId,
      'folder_rename_account',
      filesByAccount,
      (filesForAccount): FolderRenameAccountOutboxPayload => ({
        oldFolderPath,
        newFolderPath,
        newName,
        files: filesForAccount,
      })
    );
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
    const remainingFiles =
      (stmts.countAllFilesInSubtree.get(poolId, lower, upper, folderId) as { cnt: number } | undefined)?.cnt ?? 0;
    if (remainingFiles === 0) {
      stmts.deleteShareLinksForFolder.run(poolId, normPath);
    }

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

    enqueuePoolAccountOutbox(
      poolId,
      'folder_trash_account',
      filesByAccount,
      (filesForAccount): FolderTrashAccountOutboxPayload => ({
        normPath,
        files: filesForAccount,
      })
    );
  }).immediate();

  bumpPoolRevision(poolId);
  return { trashedFilesCount: descendantFiles.length };
}
