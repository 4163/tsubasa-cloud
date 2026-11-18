import path from 'node:path';
import {
  getDriveClient,
  markAccountQuotaDecreased,
} from './client.js';
import {
  buildTsubasaAppProperties,
  CLEARED_TSUBASA_APP_PROPERTIES,
} from './appProperties.js';
import { getAccountRootFolderId, resolveRemoteFolderTree } from './remoteTree.js';
import { isDriveNotFoundError, runBoundedConcurrency, withDriveRetry } from './errors.js';
import { clearRemoteFolderCache, ensureRemoteFolderHierarchy } from './mirror.js';
import {
  getStmts,
  ITEM_BATCH_CONCURRENCY,
  type ClearShareAccountOutboxPayload,
  type FileDeleteOutboxPayload,
  type FileMoveOutboxPayload,
  type FileRenameOutboxPayload,
  type FileRestoreOutboxPayload,
  type FileTrashOutboxPayload,
  type FolderMergeAccountOutboxPayload,
  type FolderMoveAccountOutboxPayload,
  type FolderRenameAccountOutboxPayload,
  type FolderTrashAccountOutboxPayload,
  type OutboxRow,
} from './outboxQueue.js';

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
  fileId: string,
  clearAppProperties = false
): Promise<void> {
  try {
    await withDriveRetry(() =>
      drive.files.update({
        fileId,
        requestBody: {
          trashed: true,
          ...(clearAppProperties
            ? { appProperties: CLEARED_TSUBASA_APP_PROPERTIES as unknown as Record<string, string> }
            : {}),
        },
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
          appProperties: buildTsubasaAppProperties({
            virtualPath: f.newVirtualPath,
            virtualId: f.id,
          }),
        },
        supportsAllDrives: false,
      })
    );
  });
}

export async function executeOutboxItem(row: OutboxRow): Promise<void> {
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
              appProperties: buildTsubasaAppProperties({
                virtualPath: p.newVirtualPath,
                virtualId: p.fileId,
              }),
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
              appProperties: buildTsubasaAppProperties({
                virtualPath: p.newVirtualPath,
                virtualId: p.fileId,
              }),
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
      await trashDriveFileIgnoreNotFound(drive, p.driveFileId, Boolean(p.clearAppProperties));
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
                    appProperties: buildTsubasaAppProperties({
                      virtualPath: targetPath,
                      virtualId: p.fileId,
                    }),
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
              appProperties: buildTsubasaAppProperties({
                virtualPath: f.newVirtualPath,
                virtualId: f.id,
              }),
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
      const isScoped = p.batchFolderIds !== undefined || p.batchFolderNames !== undefined;
      const idSet = new Set(p.batchFolderIds ?? []);
      const nameSet = new Set(p.batchFolderNames ?? []);

      if (rootFolderId && (!isScoped || idSet.size > 0 || nameSet.size > 0)) {
        const itemIds: string[] = [];
        let pageToken: string | undefined = undefined;

        do {
          const listRes: any = await withDriveRetry(() =>
            drive.files.list({
              q: `'${rootFolderId}' in parents`,
              fields: isScoped ? 'nextPageToken, files(id, name)' : 'nextPageToken, files(id)',
              pageSize: 100,
              pageToken,
              spaces: 'drive',
              supportsAllDrives: false,
            })
          );

          for (const item of listRes.data.files || []) {
            if (!item.id) continue;
            if (!isScoped || idSet.has(item.id) || (item.name && nameSet.has(item.name))) {
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
