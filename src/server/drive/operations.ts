import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite } from '../db/index.js';
import { accounts, files, folders, type FileRecord, type Folder } from '../db/schema.js';
import { eq, or, like, and, sql } from 'drizzle-orm';
import { getDriveClient, ensureRootFolder, resolveRemoteFolderTree } from './client.js';
import { ensureRemoteFolderHierarchy, normalizeVirtualPath, clearRemoteFolderCache } from './mirror.js';
import { ensureLocalFolderHierarchy } from './sync.js';
import {
  selectPlacementForFile,
  calculateHeadroom,
  getAccountTransferStats,
  recordTransfer,
  InsufficientStorageError,
} from '../storage/index.js';

async function getAccountRootFolderId(accountId: string): Promise<string> {
  const accountRecord = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (accountRecord?.rootFolderId) {
    return accountRecord.rootFolderId;
  }

  const drive = getDriveClient(accountId);
  const rootId = await ensureRootFolder(drive);

  await db
    .update(accounts)
    .set({ rootFolderId: rootId, updatedAt: new Date() })
    .where(eq(accounts.id, accountId));

  return rootId;
}

interface RemoteSyncFileItem {
  id: string;
  virtual_path: string;
  name: string;
  account_id: string;
  drive_file_id: string;
}

async function syncRemoteFolderRename(
  oldFolderPath: string,
  newFolderPath: string,
  newName: string,
  descendantFiles: RemoteSyncFileItem[]
): Promise<void> {
  clearRemoteFolderCache();

  const allAccounts = await db.query.accounts.findMany();
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

        for (const sub of tree.folders) {
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
      } catch (err) {
        console.warn(`Remote folder rename error on account ${acc.id}:`, err);
      }
    })
  );

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
  clearRemoteFolderCache();
}

async function syncRemoteFolderMove(
  oldFolderPath: string,
  newFolderPath: string,
  destFolder: string,
  descendantFiles: RemoteSyncFileItem[]
): Promise<void> {
  clearRemoteFolderCache();

  const allAccounts = await db.query.accounts.findMany();
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

        for (const sub of tree.folders) {
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
      } catch (err) {
        console.warn(`Remote folder move error on account ${acc.id}:`, err);
      }
    })
  );

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
  clearRemoteFolderCache();
}

export interface MoveItemInput {
  kind: 'file' | 'folder';
  id: string;
}

export interface MoveResult {
  id: string;
  kind: 'file' | 'folder';
  oldPath: string;
  newPath: string;
  success: boolean;
  error?: string;
}

export async function moveItems(
  items: MoveItemInput[],
  targetFolderPath: string
): Promise<MoveResult[]> {
  const destFolder = normalizeVirtualPath(targetFolderPath);
  if (destFolder !== '/') {
    ensureLocalFolderHierarchy(destFolder);
  }

  const results: MoveResult[] = [];

  for (const item of items) {
    if (item.kind === 'file') {
      const file = await db.query.files.findFirst({
        where: or(eq(files.id, item.id), eq(files.virtualPath, item.id)),
      });

      if (!file) {
        results.push({
          id: item.id,
          kind: 'file',
          oldPath: item.id,
          newPath: '',
          success: false,
          error: 'File not found',
        });
        continue;
      }

      const newVirtualPath = normalizeVirtualPath(path.posix.join(destFolder, file.name));
      if (newVirtualPath === file.virtualPath) {
        results.push({
          id: file.id,
          kind: 'file',
          oldPath: file.virtualPath,
          newPath: newVirtualPath,
          success: true,
        });
        continue;
      }

      const existing = await db.query.files.findFirst({
        where: and(eq(files.virtualPath, newVirtualPath), eq(files.isTrashed, false)),
      });

      if (existing && existing.id !== file.id) {
        results.push({
          id: file.id,
          kind: 'file',
          oldPath: file.virtualPath,
          newPath: newVirtualPath,
          success: false,
          error: `A file named "${file.name}" already exists in the destination folder`,
        });
        continue;
      }

      const parentDir = path.posix.dirname(newVirtualPath);
      const folderId = parentDir === '/' || parentDir === '.' ? null : parentDir;

      if (folderId) {
        ensureLocalFolderHierarchy(folderId);
      }

      sqlite.pragma('foreign_keys = OFF');
      try {
        await db
          .update(files)
          .set({
            virtualPath: newVirtualPath,
            folderId,
            updatedAt: new Date(),
          })
          .where(eq(files.id, file.id));
      } finally {
        sqlite.pragma('foreign_keys = ON');
      }

      // Synchronously update remote Google Drive parent & metadata
      try {
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
            appProperties: {
              tsubasa_managed: 'true',
              tsubasa_virtual_path: newVirtualPath,
              tsubasa_virtual_id: file.id,
            },
          },
          supportsAllDrives: false,
        });
      } catch (driveErr) {
        console.warn(`Drive remote move deferred for file ${file.id}:`, driveErr);
      }

      results.push({
        id: file.id,
        kind: 'file',
        oldPath: file.virtualPath,
        newPath: newVirtualPath,
        success: true,
      });
    } else if (item.kind === 'folder') {
      const folder = await db.query.folders.findFirst({
        where: or(eq(folders.id, item.id), eq(folders.virtualPath, item.id)),
      });

      if (!folder) {
        results.push({
          id: item.id,
          kind: 'folder',
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
          oldPath: oldFolderPath,
          newPath: newFolderPath,
          success: true,
        });
        continue;
      }

      const existingFolder = await db.query.folders.findFirst({
        where: eq(folders.virtualPath, newFolderPath),
      });

      if (existingFolder && existingFolder.id !== folder.id) {
        results.push({
          id: folder.id,
          kind: 'folder',
          oldPath: oldFolderPath,
          newPath: newFolderPath,
          success: false,
          error: `A folder named "${folder.name}" already exists in the destination folder`,
        });
        continue;
      }

      const allDescendantFiles = sqlite
        .prepare(
          'SELECT id, virtual_path, name, account_id, drive_file_id FROM files WHERE virtual_path LIKE ? OR folder_id = ?'
        )
        .all(`${oldFolderPath}/%`, oldFolderPath) as Array<{
          id: string;
          virtual_path: string;
          name: string;
          account_id: string;
          drive_file_id: string;
        }>;

      sqlite.pragma('foreign_keys = OFF');
      try {
        sqlite.transaction(() => {
          // 1. Move root folder itself
          const parentId = destFolder === '/' ? null : destFolder;
          sqlite
            .prepare(
              'UPDATE folders SET id = ?, virtual_path = ?, parent_folder_id = ?, updated_at = unixepoch() WHERE id = ?'
            )
            .run(newFolderPath, newFolderPath, parentId, folder.id);

          // 2. Move descendant folders
          const allDescendantFolders = sqlite
            .prepare('SELECT id, virtual_path, name FROM folders WHERE virtual_path LIKE ?')
            .all(`${oldFolderPath}/%`) as Array<{ id: string; virtual_path: string; name: string }>;

          for (const sub of allDescendantFolders) {
            const subNewPath = newFolderPath + sub.virtual_path.slice(oldFolderPath.length);
            const subParent = path.posix.dirname(subNewPath);
            sqlite
              .prepare(
                'UPDATE folders SET id = ?, virtual_path = ?, parent_folder_id = ?, updated_at = unixepoch() WHERE id = ?'
              )
              .run(subNewPath, subNewPath, subParent === '/' ? null : subParent, sub.id);
          }

          // 3. Move all descendant files
          for (const f of allDescendantFiles) {
            const fileNewPath = f.virtual_path.startsWith(oldFolderPath + '/')
              ? newFolderPath + f.virtual_path.slice(oldFolderPath.length)
              : f.virtual_path;
            const fileParent = path.posix.dirname(fileNewPath);
            sqlite
              .prepare(
                'UPDATE files SET virtual_path = ?, folder_id = ?, updated_at = unixepoch() WHERE id = ?'
              )
              .run(fileNewPath, fileParent === '/' ? null : fileParent, f.id);
          }
        })();
      } finally {
        sqlite.pragma('foreign_keys = ON');
      }

      await syncRemoteFolderMove(oldFolderPath, newFolderPath, destFolder, allDescendantFiles);

      results.push({
        id: folder.id,
        kind: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: true,
      });
    }
  }

  return results;
}

export interface CopyResult {
  id: string;
  kind: 'file' | 'folder';
  sourcePath: string;
  destPath: string;
  success: boolean;
  error?: string;
}

async function getAvailableCopyPath(
  targetDir: string,
  baseName: string,
  kind: 'file' | 'folder'
): Promise<string> {
  const ext = kind === 'file' ? path.extname(baseName) : '';
  const stem = kind === 'file' ? path.basename(baseName, ext) : baseName;

  let candidateName = baseName;
  let candidatePath = normalizeVirtualPath(path.posix.join(targetDir, candidateName));
  let counter = 1;

  while (true) {
    if (kind === 'file') {
      const exists = await db.query.files.findFirst({
        where: and(eq(files.virtualPath, candidatePath), eq(files.isTrashed, false)),
      });
      if (!exists) return candidatePath;
    } else {
      const exists = await db.query.folders.findFirst({
        where: eq(folders.virtualPath, candidatePath),
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
  targetFolderPath: string
): Promise<CopyResult[]> {
  const destFolder = normalizeVirtualPath(targetFolderPath);
  if (destFolder !== '/') {
    ensureLocalFolderHierarchy(destFolder);
  }

  const results: CopyResult[] = [];

  for (const item of items) {
    if (item.kind === 'file') {
      const file = await db.query.files.findFirst({
        where: or(eq(files.id, item.id), eq(files.virtualPath, item.id)),
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
        const destVirtualPath = await getAvailableCopyPath(destFolder, file.name, 'file');
        const destFileName = path.posix.basename(destVirtualPath);

        const placement = await selectPlacementForFile({
          virtualPath: destVirtualPath,
          sizeBytes: file.sizeBytes,
        });

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
        let newDriveFileId: string;

        if (targetAccountId === file.accountId) {
          // Same-account direct Drive copy
          const copyRes = await driveTarget.files.copy({
            fileId: file.driveFileId,
            requestBody: {
              name: destFileName,
              parents: [targetRemoteFolderId],
              appProperties: {
                tsubasa_managed: 'true',
                tsubasa_virtual_path: destVirtualPath,
                tsubasa_virtual_id: newFileId,
                tsubasa_checksum: file.hash || '',
              },
            },
            fields: 'id, name, size',
            supportsAllDrives: false,
          });

          if (!copyRes.data.id) {
            throw new Error('Google Drive server-side copy returned empty file ID');
          }
          newDriveFileId = copyRes.data.id;
        } else {
          // Cross-account copy via temporary reader permission
          const driveSource = getDriveClient(file.accountId);
          const shareRes = await driveSource.permissions.create({
            fileId: file.driveFileId,
            requestBody: {
              role: 'reader',
              type: 'user',
              emailAddress: targetAccount.email,
            },
            supportsAllDrives: false,
          });

          const permissionId = shareRes.data.id;
          try {
            const copyRes = await driveTarget.files.copy({
              fileId: file.driveFileId,
              requestBody: {
                name: destFileName,
                parents: [targetRemoteFolderId],
                appProperties: {
                  tsubasa_managed: 'true',
                  tsubasa_virtual_path: destVirtualPath,
                  tsubasa_virtual_id: newFileId,
                  tsubasa_checksum: file.hash || '',
                },
              },
              fields: 'id, name, size',
              supportsAllDrives: false,
            });

            if (!copyRes.data.id) {
              throw new Error('Google Drive cross-account copy returned empty file ID');
            }
            newDriveFileId = copyRes.data.id;
          } finally {
            if (permissionId) {
              driveSource.permissions
                .delete({ fileId: file.driveFileId, permissionId, supportsAllDrives: false })
                .catch(() => {});
            }
          }
        }

        const parentDir = path.posix.dirname(destVirtualPath);
        const folderId = parentDir === '/' || parentDir === '.' ? null : parentDir;

        await db.insert(files).values({
          id: newFileId,
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
          sourcePath: file.virtualPath,
          destPath: destVirtualPath,
          success: true,
        });
      } catch (err) {
        results.push({
          id: file.id,
          kind: 'file',
          sourcePath: file.virtualPath,
          destPath: '',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (item.kind === 'folder') {
      const folder = await db.query.folders.findFirst({
        where: or(eq(folders.id, item.id), eq(folders.virtualPath, item.id)),
      });

      if (!folder) {
        results.push({
          id: item.id,
          kind: 'folder',
          sourcePath: item.id,
          destPath: '',
          success: false,
          error: 'Folder not found',
        });
        continue;
      }

      try {
        const destVirtualPath = await getAvailableCopyPath(destFolder, folder.name, 'folder');
        const destFolderName = path.posix.basename(destVirtualPath);

        ensureLocalFolderHierarchy(destVirtualPath);

        const subFiles = await db.query.files.findMany({
          where: and(like(files.virtualPath, `${folder.virtualPath}/%`), eq(files.isTrashed, false)),
        });

        for (const subFile of subFiles) {
          const subRelative = subFile.virtualPath.slice(folder.virtualPath.length);
          const targetSubFileDir = normalizeVirtualPath(path.posix.dirname(destVirtualPath + subRelative));
          await copyItems([{ kind: 'file', id: subFile.id }], targetSubFileDir);
        }

        results.push({
          id: destVirtualPath,
          kind: 'folder',
          sourcePath: folder.virtualPath,
          destPath: destVirtualPath,
          success: true,
        });
      } catch (err) {
        results.push({
          id: folder.id,
          kind: 'folder',
          sourcePath: folder.virtualPath,
          destPath: '',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return results;
}

export async function renameItem(
  kind: 'file' | 'folder',
  idOrPath: string,
  rawNewName: string
): Promise<{ success: boolean; oldPath: string; newPath: string }> {
  const newName = rawNewName.trim();
  if (!newName || newName.includes('/') || newName.includes('\\')) {
    throw new Error('Invalid name: cannot be empty or contain slash characters');
  }

  if (kind === 'file') {
    const file = await db.query.files.findFirst({
      where: or(eq(files.id, idOrPath), eq(files.virtualPath, idOrPath)),
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
      where: and(eq(files.virtualPath, newVirtualPath), eq(files.isTrashed, false)),
    });

    if (existing && existing.id !== file.id) {
      throw new Error(`A file named "${newName}" already exists in this folder`);
    }

    const validParentId = parentDir === '/' || parentDir === '.' ? null : parentDir;
    if (validParentId) {
      ensureLocalFolderHierarchy(validParentId);
    }

    sqlite.pragma('foreign_keys = OFF');
    try {
      await db
        .update(files)
        .set({
          name: newName,
          virtualPath: newVirtualPath,
          folderId: validParentId,
          updatedAt: new Date(),
        })
        .where(eq(files.id, file.id));
    } finally {
      sqlite.pragma('foreign_keys = ON');
    }

    try {
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
    } catch (driveErr) {
      console.warn(`Drive remote rename deferred for file ${file.id}:`, driveErr);
    }

    return { success: true, oldPath: file.virtualPath, newPath: newVirtualPath };
  } else {
    const folder = await db.query.folders.findFirst({
      where: or(eq(folders.id, idOrPath), eq(folders.virtualPath, idOrPath)),
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
      where: eq(folders.virtualPath, newFolderPath),
    });

    if (existing && existing.id !== folder.id) {
      const hasFiles = sqlite
        .prepare('SELECT 1 FROM files WHERE virtual_path LIKE ? OR folder_id = ? LIMIT 1')
        .get(`${newFolderPath}/%`, newFolderPath);
      const hasSubfolders = sqlite
        .prepare('SELECT 1 FROM folders WHERE virtual_path LIKE ? AND id != ? LIMIT 1')
        .get(`${newFolderPath}/%`, newFolderPath);

      if (!hasFiles && !hasSubfolders) {
        sqlite.prepare('DELETE FROM folders WHERE id = ?').run(existing.id);
      } else {
        throw new Error(`A folder named "${newName}" already exists in this directory`);
      }
    }

    const allDescendantFiles = sqlite
      .prepare(
        'SELECT id, virtual_path, name, account_id, drive_file_id FROM files WHERE virtual_path LIKE ? OR folder_id = ?'
      )
      .all(`${oldFolderPath}/%`, oldFolderPath) as Array<{
        id: string;
        virtual_path: string;
        name: string;
        account_id: string;
        drive_file_id: string;
      }>;

    sqlite.pragma('foreign_keys = OFF');
    try {
      sqlite.transaction(() => {
        // 1. Rename folder itself
        const parentId = parentDir === '/' || parentDir === '.' ? null : parentDir;
        sqlite
          .prepare(
            'UPDATE folders SET id = ?, virtual_path = ?, name = ?, parent_folder_id = ?, updated_at = unixepoch() WHERE id = ?'
          )
          .run(newFolderPath, newFolderPath, newName, parentId, folder.id);

        // 2. Rename descendant folders
        const allDescendantFolders = sqlite
          .prepare('SELECT id, virtual_path FROM folders WHERE virtual_path LIKE ?')
          .all(`${oldFolderPath}/%`) as Array<{ id: string; virtual_path: string }>;

        for (const sub of allDescendantFolders) {
          const subNewPath = newFolderPath + sub.virtual_path.slice(oldFolderPath.length);
          const subParent = path.posix.dirname(subNewPath);
          sqlite
            .prepare(
              'UPDATE folders SET id = ?, virtual_path = ?, parent_folder_id = ?, updated_at = unixepoch() WHERE id = ?'
            )
            .run(subNewPath, subNewPath, subParent === '/' ? null : subParent, sub.id);
        }

        // 3. Rename descendant files
        for (const f of allDescendantFiles) {
          const fileNewPath = f.virtual_path.startsWith(oldFolderPath + '/')
            ? newFolderPath + f.virtual_path.slice(oldFolderPath.length)
            : path.posix.join(newFolderPath, f.name);
          const fileParent = path.posix.dirname(fileNewPath);
          sqlite
            .prepare(
              'UPDATE files SET virtual_path = ?, folder_id = ?, updated_at = unixepoch() WHERE id = ?'
            )
            .run(fileNewPath, fileParent === '/' ? null : fileParent, f.id);
        }
      })();
    } finally {
      sqlite.pragma('foreign_keys = ON');
    }

    await syncRemoteFolderRename(oldFolderPath, newFolderPath, newName, allDescendantFiles);

    return { success: true, oldPath: oldFolderPath, newPath: newFolderPath };
  }
}

export async function trashFolder(virtualPath: string): Promise<{ trashedFilesCount: number }> {
  const normPath = normalizeVirtualPath(virtualPath);

  const descendantFiles = await db.query.files.findMany({
    where: and(
      or(
        like(files.virtualPath, `${normPath}/%`),
        eq(files.folderId, normPath)
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
  const allAccounts = await db.query.accounts.findMany();
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
        'UPDATE files SET is_trashed = 1, trashed_at = unixepoch(), updated_at = unixepoch() WHERE virtual_path LIKE ? OR folder_id = ?'
      )
      .run(`${normPath}/%`, normPath);

    sqlite
      .prepare('DELETE FROM folders WHERE virtual_path = ? OR virtual_path LIKE ?')
      .run(normPath, `${normPath}/%`);
  })();

  return { trashedFilesCount: descendantFiles.length };
}
