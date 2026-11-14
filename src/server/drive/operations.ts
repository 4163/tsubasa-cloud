import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite } from '../db/index.js';
import { accounts, files, folders, type FileRecord, type Folder } from '../db/schema.js';
import { eq, or, like, and, sql } from 'drizzle-orm';
import { getDriveClient, getAccountRootFolderId, resolveRemoteFolderTree } from './client.js';
import { copyDriveFileCrossAccount } from './transfer.js';
import { ensureRemoteFolderHierarchy, normalizeVirtualPath, clearRemoteFolderCache } from './mirror.js';
import { ensureLocalFolderHierarchy, formatFolderId } from './sync.js';
import {
  selectPlacementForFile,
  calculateHeadroom,
  getAccountTransferStats,
  recordTransfer,
  InsufficientStorageError,
} from '../storage/index.js';

interface RemoteSyncFileItem {
  id: string;
  virtual_path: string;
  name: string;
  account_id: string;
  drive_file_id: string;
}

async function syncDescendantFolderPropertiesOnDrive(
  drive: ReturnType<typeof getDriveClient>,
  folders: Array<{ id: string; virtualPath: string }>,
  oldFolderPath: string,
  newFolderPath: string
): Promise<void> {
  for (const sub of folders) {
    if (sub.virtualPath.startsWith(oldFolderPath + '/')) {
      const subNewPath = newFolderPath + sub.virtualPath.slice(oldFolderPath.length);
      await drive.files.update({
        fileId: sub.id,
        requestBody: {
          appProperties: {
            tsubasa_managed: 'true',
            tsubasa_folder_path: subNewPath,
          },
        },
        supportsAllDrives: false,
      });
    }
  }
}

async function syncDescendantFilePathsOnDrive(
  oldFolderPath: string,
  newFolderPath: string,
  descendantFiles: RemoteSyncFileItem[]
): Promise<void> {
  const CONCURRENCY = 10;
  let fileIndex = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, descendantFiles.length) }, async () => {
    while (fileIndex < descendantFiles.length) {
      const f = descendantFiles[fileIndex++];
      if (!f || !f.drive_file_id || !f.account_id) continue;
      const fileNewPath = f.virtual_path.startsWith(oldFolderPath + '/')
        ? newFolderPath + f.virtual_path.slice(oldFolderPath.length)
        : path.posix.join(newFolderPath, f.name);

      try {
        const drive = getDriveClient(f.account_id);
        await drive.files.update({
          fileId: f.drive_file_id,
          requestBody: {
            appProperties: {
              tsubasa_managed: 'true',
              tsubasa_virtual_path: fileNewPath,
            },
          },
          supportsAllDrives: false,
        });
      } catch (err) {
        console.warn(`Remote file path update error for file ${f.id} (${f.drive_file_id}):`, err);
      }
    }
  });

  await Promise.all(workers);
}

async function syncRemoteFolderRename(
  oldFolderPath: string,
  newFolderPath: string,
  newName: string,
  descendantFiles: RemoteSyncFileItem[],
  poolId = 1
): Promise<void> {
  clearRemoteFolderCache();

  const allAccounts = await db.query.accounts.findMany({
    where: eq(accounts.poolId, poolId),
  });
  await Promise.all(
    allAccounts.map(async (acc) => {
      try {
        if (!acc.rootFolderId) return;
        const drive = getDriveClient(acc.id);
        const tree = await resolveRemoteFolderTree(drive, acc.rootFolderId);

        const remoteFolderId = tree.folderIdByPath.get(oldFolderPath);
        if (remoteFolderId) {
          await drive.files.update({
            fileId: remoteFolderId,
            requestBody: {
              name: newName,
              appProperties: {
                tsubasa_managed: 'true',
                tsubasa_folder_path: newFolderPath,
              },
            },
            supportsAllDrives: false,
          });
        }

        await syncDescendantFolderPropertiesOnDrive(drive, tree.folders, oldFolderPath, newFolderPath);
      } catch (err) {
        console.warn(`Remote folder rename error on account ${acc.id}:`, err);
      }
    })
  );

  await syncDescendantFilePathsOnDrive(oldFolderPath, newFolderPath, descendantFiles);
  clearRemoteFolderCache();
}

async function syncRemoteFolderMove(
  oldFolderPath: string,
  newFolderPath: string,
  destFolder: string,
  descendantFiles: RemoteSyncFileItem[],
  poolId = 1
): Promise<void> {
  clearRemoteFolderCache();

  const allAccounts = await db.query.accounts.findMany({
    where: eq(accounts.poolId, poolId),
  });
  await Promise.all(
    allAccounts.map(async (acc) => {
      try {
        if (!acc.rootFolderId) return;
        const drive = getDriveClient(acc.id);
        const tree = await resolveRemoteFolderTree(drive, acc.rootFolderId);

        const remoteFolderId = tree.folderIdByPath.get(oldFolderPath);
        if (remoteFolderId) {
          const targetRemoteParentId = await ensureRemoteFolderHierarchy(
            drive,
            acc.rootFolderId,
            destFolder
          );

          const folderRes = await drive.files.get({
            fileId: remoteFolderId,
            fields: 'parents',
            supportsAllDrives: false,
          });
          const prevParents = (folderRes.data.parents || []).join(',');

          await drive.files.update({
            fileId: remoteFolderId,
            addParents: targetRemoteParentId,
            removeParents: prevParents,
            requestBody: {
              appProperties: {
                tsubasa_managed: 'true',
                tsubasa_folder_path: newFolderPath,
              },
            },
            supportsAllDrives: false,
          });
        }

        await syncDescendantFolderPropertiesOnDrive(drive, tree.folders, oldFolderPath, newFolderPath);
      } catch (err) {
        console.warn(`Remote folder move error on account ${acc.id}:`, err);
      }
    })
  );

  await syncDescendantFilePathsOnDrive(oldFolderPath, newFolderPath, descendantFiles);
  clearRemoteFolderCache();
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

export async function moveItems(
  items: MoveItemInput[],
  targetFolderPath: string,
  poolId = 1
): Promise<MoveResult[]> {
  const destFolder = normalizeVirtualPath(targetFolderPath);
  if (destFolder !== '/') {
    ensureLocalFolderHierarchy(destFolder, poolId);
  }

  const results: MoveResult[] = [];

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

      if (existing && existing.id !== file.id) {
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

      const parentDir = path.posix.dirname(newVirtualPath);
      const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

      if (parentDir !== '/' && parentDir !== '.') {
        ensureLocalFolderHierarchy(parentDir, poolId);
      }

      sqlite.transaction(() => {
        sqlite.pragma('defer_foreign_keys = ON');
        sqlite
          .prepare(
            'UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1 AND id != ?'
          )
          .run(`${newVirtualPath}.trashed-${Date.now()}`, poolId, newVirtualPath, file.id);
        sqlite
          .prepare(
            'UPDATE files SET virtual_path = ?, folder_id = ?, is_trashed = 0, trashed_at = NULL, updated_at = unixepoch() WHERE id = ?'
          )
          .run(newVirtualPath, folderId, file.id);
      })();

      // Asynchronously update remote Google Drive parent & metadata in the background
      (async () => {
        const drive = getDriveClient(file.accountId);
        const rootFolderId = await getAccountRootFolderId(file.accountId);
        const targetRemoteFolderId = await ensureRemoteFolderHierarchy(
          drive,
          rootFolderId,
          destFolder
        );

        const fileRes = await drive.files.get({
          fileId: file.driveFileId,
          fields: 'parents',
          supportsAllDrives: false,
        });

        const prevParents = (fileRes.data.parents || []).join(',');

        await drive.files.update({
          fileId: file.driveFileId,
          addParents: targetRemoteFolderId,
          removeParents: prevParents,
          requestBody: {
            ...(wasTrashed ? { trashed: false } : {}),
            appProperties: {
              tsubasa_managed: 'true',
              tsubasa_virtual_path: newVirtualPath,
              tsubasa_virtual_id: file.id,
            },
          },
          supportsAllDrives: false,
        });
      })().catch((driveErr) => {
        console.error(`Background Drive remote move failed for file ${file.id}:`, driveErr);
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

      if (existingFolder && existingFolder.id !== folder.id) {
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

      const allDescendantFiles = sqlite
        .prepare(
          'SELECT id, virtual_path, name, account_id, drive_file_id FROM files WHERE pool_id = ? AND (virtual_path LIKE ? OR folder_id = ?)'
        )
        .all(poolId, `${oldFolderPath}/%`, formatFolderId(poolId, oldFolderPath)) as Array<{
          id: string;
          virtual_path: string;
          name: string;
          account_id: string;
          drive_file_id: string;
        }>;

      sqlite.transaction(() => {
        sqlite.pragma('defer_foreign_keys = ON');

        // 1. Move root folder itself
        const parentId = destFolder === '/' ? null : formatFolderId(poolId, destFolder);
        const newFolderId = formatFolderId(poolId, newFolderPath);
        sqlite
          .prepare(
            'UPDATE folders SET id = ?, virtual_path = ?, parent_folder_id = ?, updated_at = unixepoch() WHERE id = ?'
          )
          .run(newFolderId, newFolderPath, parentId, folder.id);

        // 2. Move descendant folders
        const allDescendantFolders = sqlite
          .prepare('SELECT id, virtual_path, name FROM folders WHERE pool_id = ? AND virtual_path LIKE ?')
          .all(poolId, `${oldFolderPath}/%`) as Array<{ id: string; virtual_path: string; name: string }>;

        for (const sub of allDescendantFolders) {
          const subNewPath = newFolderPath + sub.virtual_path.slice(oldFolderPath.length);
          const subParent = path.posix.dirname(subNewPath);
          const subParentId = subParent === '/' ? null : formatFolderId(poolId, subParent);
          const subNewId = formatFolderId(poolId, subNewPath);
          sqlite
            .prepare(
              'UPDATE folders SET id = ?, virtual_path = ?, parent_folder_id = ?, updated_at = unixepoch() WHERE id = ?'
            )
            .run(subNewId, subNewPath, subParentId, sub.id);
        }

        // 3. Move all descendant files
        for (const f of allDescendantFiles) {
          const fileNewPath = f.virtual_path.startsWith(oldFolderPath + '/')
            ? newFolderPath + f.virtual_path.slice(oldFolderPath.length)
            : f.virtual_path;
          const fileParent = path.posix.dirname(fileNewPath);
          const fileParentId = fileParent === '/' ? null : formatFolderId(poolId, fileParent);
          sqlite
            .prepare(
              'UPDATE files SET virtual_path = ?, folder_id = ?, updated_at = unixepoch() WHERE id = ?'
            )
            .run(fileNewPath, fileParentId, f.id);
        }
      })();

      // Asynchronously update remote Google Drive hierarchy in the background
      syncRemoteFolderMove(oldFolderPath, newFolderPath, destFolder, allDescendantFiles, poolId).catch((err) => {
        console.error('Background syncRemoteFolderMove failed:', err);
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

async function getAvailableCopyPath(
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

export async function copyItems(
  items: MoveItemInput[],
  targetFolderPath: string,
  poolId = 1
): Promise<CopyResult[]> {
  const destFolder = normalizeVirtualPath(targetFolderPath);
  if (destFolder !== '/') {
    ensureLocalFolderHierarchy(destFolder, poolId);
  }

  const results: CopyResult[] = [];

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
          sourcePath: item.id,
          destPath: '',
          success: false,
          error: 'File not found',
        });
        continue;
      }

      try {
        const destVirtualPath = await getAvailableCopyPath(destFolder, file.name, 'file', poolId);
        const destFileName = path.posix.basename(destVirtualPath);

        const placement = await selectPlacementForFile(
          {
            virtualPath: destVirtualPath,
            sizeBytes: file.sizeBytes,
          },
          undefined,
          Date.now(),
          undefined,
          poolId
        );

        const targetAccountId = placement.accountId;
        const targetAccount = await db.query.accounts.findFirst({
          where: eq(accounts.id, targetAccountId),
        });

        if (!targetAccount) {
          throw new Error(`Target account ${targetAccountId} not registered`);
        }

        const driveTarget = getDriveClient(targetAccountId);
        const targetRootId = await getAccountRootFolderId(targetAccountId);
        const targetRemoteFolderId = await ensureRemoteFolderHierarchy(
          driveTarget,
          targetRootId,
          destFolder
        );

        const newFileId = randomUUID();
        const newDriveFileId = await copyDriveFileCrossAccount({
          sourceAccountId: file.accountId,
          sourceDriveFileId: file.driveFileId,
          targetAccountId,
          targetAccountEmail: targetAccount.email,
          targetRemoteFolderId,
          destFileName,
          appProperties: {
            tsubasa_managed: 'true',
            tsubasa_virtual_path: destVirtualPath,
            tsubasa_virtual_id: newFileId,
            tsubasa_checksum: file.hash || '',
          },
          fields: 'id, name, size',
        });

        const parentDir = path.posix.dirname(destVirtualPath);
        const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

        await db.insert(files).values({
          id: newFileId,
          poolId,
          virtualPath: destVirtualPath,
          name: destFileName,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
          hash: file.hash,
          accountId: targetAccountId,
          driveFileId: newDriveFileId,
          folderId,
          isTrashed: false,
        });

        await recordTransfer(targetAccountId, 'upload', file.sizeBytes);

        await db
          .update(accounts)
          .set({
            quotaUsedBytes: sql`${accounts.quotaUsedBytes} + ${file.sizeBytes}`,
            updatedAt: new Date(),
          })
          .where(eq(accounts.id, targetAccountId));

        results.push({
          id: newFileId,
          kind: 'file',
          type: 'file',
          sourcePath: file.virtualPath,
          destPath: destVirtualPath,
          success: true,
        });
      } catch (err) {
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          sourcePath: file.virtualPath,
          destPath: '',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
          sourcePath: item.id,
          destPath: '',
          success: false,
          error: 'Folder not found',
        });
        continue;
      }

      try {
        const destVirtualPath = await getAvailableCopyPath(destFolder, folder.name, 'folder', poolId);
        ensureLocalFolderHierarchy(destVirtualPath, poolId);

        const subFiles = await db.query.files.findMany({
          where: and(
            eq(files.poolId, poolId),
            like(files.virtualPath, `${folder.virtualPath}/%`),
            eq(files.isTrashed, false)
          ),
        });

        for (const subFile of subFiles) {
          const subRelative = subFile.virtualPath.slice(folder.virtualPath.length);
          const targetSubFileDir = normalizeVirtualPath(path.posix.dirname(destVirtualPath + subRelative));
          await copyItems([{ kind: 'file', type: 'file', id: subFile.id }], targetSubFileDir, poolId);
        }

        results.push({
          id: destVirtualPath,
          kind: 'folder',
          type: 'folder',
          sourcePath: folder.virtualPath,
          destPath: destVirtualPath,
          success: true,
        });
      } catch (err) {
        results.push({
          id: folder.id,
          kind: 'folder',
          type: 'folder',
          sourcePath: folder.virtualPath,
          destPath: '',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      results.push({
        id: item.id,
        kind: 'file',
        type: 'file',
        sourcePath: item.id,
        destPath: '',
        success: false,
        error: `Item not found or invalid kind: ${item.id}`,
      });
    }
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
      ensureLocalFolderHierarchy(parentDir, poolId);
    }

    sqlite.transaction(() => {
      sqlite.pragma('defer_foreign_keys = ON');
      sqlite
        .prepare(
          'UPDATE files SET name = ?, virtual_path = ?, folder_id = ?, updated_at = unixepoch() WHERE id = ?'
        )
        .run(newName, newVirtualPath, validParentId, file.id);
    })();

    // Asynchronously update remote Google Drive metadata in the background
    (async () => {
      const drive = getDriveClient(file.accountId);
      await drive.files.update({
        fileId: file.driveFileId,
        requestBody: {
          name: newName,
          appProperties: {
            tsubasa_managed: 'true',
            tsubasa_virtual_path: newVirtualPath,
          },
        },
        supportsAllDrives: false,
      });
    })().catch((driveErr) => {
      console.error(`Background Drive remote rename failed for file ${file.id}:`, driveErr);
    });

    return { success: true, oldPath: file.virtualPath, newPath: newVirtualPath };
  } else {
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

    if (existing && existing.id !== folder.id) {
      const hasFiles = sqlite
        .prepare('SELECT 1 FROM files WHERE pool_id = ? AND (virtual_path LIKE ? OR folder_id = ?) LIMIT 1')
        .get(poolId, `${newFolderPath}/%`, formatFolderId(poolId, newFolderPath));
      const hasSubfolders = sqlite
        .prepare('SELECT 1 FROM folders WHERE pool_id = ? AND virtual_path LIKE ? AND id != ? LIMIT 1')
        .get(poolId, `${newFolderPath}/%`, formatFolderId(poolId, newFolderPath));

      if (!hasFiles && !hasSubfolders) {
        sqlite.prepare('DELETE FROM folders WHERE id = ?').run(existing.id);
      } else {
        throw new Error(`A folder named "${newName}" already exists in this directory`);
      }
    }

    const allDescendantFiles = sqlite
      .prepare(
        'SELECT id, virtual_path, name, account_id, drive_file_id FROM files WHERE pool_id = ? AND (virtual_path LIKE ? OR folder_id = ?)'
      )
      .all(poolId, `${oldFolderPath}/%`, formatFolderId(poolId, oldFolderPath)) as Array<{
        id: string;
        virtual_path: string;
        name: string;
        account_id: string;
        drive_file_id: string;
      }>;

    sqlite.transaction(() => {
      sqlite.pragma('defer_foreign_keys = ON');

      // 1. Rename folder itself
      const parentId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);
      const newFolderId = formatFolderId(poolId, newFolderPath);
      sqlite
        .prepare(
          'UPDATE folders SET id = ?, virtual_path = ?, name = ?, parent_folder_id = ?, updated_at = unixepoch() WHERE id = ?'
        )
        .run(newFolderId, newFolderPath, newName, parentId, folder.id);

      // 2. Rename descendant folders
      const allDescendantFolders = sqlite
        .prepare('SELECT id, virtual_path FROM folders WHERE pool_id = ? AND virtual_path LIKE ?')
        .all(poolId, `${oldFolderPath}/%`) as Array<{ id: string; virtual_path: string }>;

      for (const sub of allDescendantFolders) {
        const subNewPath = newFolderPath + sub.virtual_path.slice(oldFolderPath.length);
        const subParent = path.posix.dirname(subNewPath);
        const subParentId = subParent === '/' ? null : formatFolderId(poolId, subParent);
        const subNewId = formatFolderId(poolId, subNewPath);
        sqlite
          .prepare(
            'UPDATE folders SET id = ?, virtual_path = ?, parent_folder_id = ?, updated_at = unixepoch() WHERE id = ?'
          )
          .run(subNewId, subNewPath, subParentId, sub.id);
      }

      // 3. Rename descendant files
      for (const f of allDescendantFiles) {
        const fileNewPath = f.virtual_path.startsWith(oldFolderPath + '/')
          ? newFolderPath + f.virtual_path.slice(oldFolderPath.length)
          : path.posix.join(newFolderPath, f.name);
        const fileParent = path.posix.dirname(fileNewPath);
        const fileParentId = fileParent === '/' ? null : formatFolderId(poolId, fileParent);
        sqlite
          .prepare(
            'UPDATE files SET virtual_path = ?, folder_id = ?, updated_at = unixepoch() WHERE id = ?'
          )
          .run(fileNewPath, fileParentId, f.id);
      }
    })();

    // Asynchronously update remote Google Drive hierarchy in the background
    syncRemoteFolderRename(oldFolderPath, newFolderPath, newName, allDescendantFiles, poolId).catch((err) => {
      console.error('Background syncRemoteFolderRename failed:', err);
    });

    return { success: true, oldPath: oldFolderPath, newPath: newFolderPath };
  }
}

export async function trashFolder(
  virtualPath: string,
  poolId = 1
): Promise<{ trashedFilesCount: number }> {
  const normPath = normalizeVirtualPath(virtualPath);
  const folderId = formatFolderId(poolId, normPath);

  const descendantFiles = await db.query.files.findMany({
    where: and(
      eq(files.poolId, poolId),
      or(
        like(files.virtualPath, `${normPath}/%`),
        eq(files.folderId, folderId)
      ),
      eq(files.isTrashed, false)
    ),
  });

  for (const f of descendantFiles) {
    try {
      const drive = getDriveClient(f.accountId);
      await drive.files.update({
        fileId: f.driveFileId,
        requestBody: { trashed: true },
        supportsAllDrives: false,
      });
    } catch (err) {
      console.warn(`Drive trash file warning for ${f.id}:`, err);
    }
  }

  // Also trash remote folders in Google Drive so detector or delta sync does not recreate them
  const allAccounts = await db.query.accounts.findMany({
    where: eq(accounts.poolId, poolId),
  });
  await Promise.all(
    allAccounts.map(async (acc) => {
      try {
        if (!acc.rootFolderId) return;
        const drive = getDriveClient(acc.id);
        const tree = await resolveRemoteFolderTree(drive, acc.rootFolderId);
        const remoteFolderId = tree.folderIdByPath.get(normPath);
        if (remoteFolderId) {
          await drive.files.update({
            fileId: remoteFolderId,
            requestBody: { trashed: true },
            supportsAllDrives: false,
          });
        }
        for (const sub of tree.folders) {
          if (sub.virtualPath.startsWith(normPath + '/')) {
            await drive.files.update({
              fileId: sub.id,
              requestBody: { trashed: true },
              supportsAllDrives: false,
            });
          }
        }
      } catch (err) {
        console.warn(`Drive trash folder warning for account ${acc.id}:`, err);
      }
    })
  );
  clearRemoteFolderCache();

  sqlite.transaction(() => {
    sqlite
      .prepare(
        'UPDATE files SET is_trashed = 1, trashed_at = unixepoch(), updated_at = unixepoch() WHERE pool_id = ? AND (virtual_path LIKE ? OR folder_id = ?)'
      )
      .run(poolId, `${normPath}/%`, folderId);

    sqlite
      .prepare('DELETE FROM folders WHERE pool_id = ? AND (virtual_path = ? OR virtual_path LIKE ?)')
      .run(poolId, normPath, `${normPath}/%`);

    sqlite
      .prepare("DELETE FROM share_links WHERE pool_id = ? AND ('/' || batch_folder_name) = ?")
      .run(poolId, normPath);
  })();

  return { trashedFilesCount: descendantFiles.length };
}
