import path from 'node:path';
import { getDriveClient } from './client.js';
import { normalizeVirtualPath } from './mirror.js';
import {
  runColdReconciliation,
  extractFolderPaths,
  insertFolderRecord,
  upsertFileRecord,
  deleteFileStmt,
  trashFileStmt,
} from './sync.js';
import { db, sqlite } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface DeltaSyncReport {
  accountId: string;
  changesProcessed: number;
  filesUpdated: number;
  filesRemoved: number;
  newToken: string | null;
}

async function resolveRemoteParentPath(
  drive: ReturnType<typeof getDriveClient>,
  rootFolderId: string,
  parentFolderId: string,
  cache: Map<string, string | null>,
  expectedPath?: string,
  poolId = 1
): Promise<{ isInsidePool: boolean; path: string }> {
  if (parentFolderId === rootFolderId) {
    return { isInsidePool: true, path: '/' };
  }

  if (cache.has(parentFolderId)) {
    const cached = cache.get(parentFolderId);
    return cached != null
      ? { isInsidePool: true, path: cached }
      : { isInsidePool: false, path: '' };
  }

  // 1. Check local SQLite folders table first
  if (expectedPath) {
    const normExpected = normalizeVirtualPath(expectedPath);
    if (normExpected === '/') {
      cache.set(parentFolderId, '/');
      return { isInsidePool: true, path: '/' };
    }
    const localFolder = sqlite
      .prepare('SELECT virtual_path FROM folders WHERE pool_id = ? AND (virtual_path = ? OR id = ?)')
      .get(poolId, normExpected, parentFolderId) as { virtual_path: string } | undefined;

    if (localFolder) {
      cache.set(parentFolderId, localFolder.virtual_path);
      return { isInsidePool: true, path: localFolder.virtual_path };
    }
  }

  const localById = sqlite
    .prepare('SELECT virtual_path FROM folders WHERE pool_id = ? AND id = ?')
    .get(poolId, parentFolderId) as { virtual_path: string } | undefined;

  if (localById) {
    cache.set(parentFolderId, localById.virtual_path);
    return { isInsidePool: true, path: localById.virtual_path };
  }

  // 2. Query Google Drive only when parent folder ID is unknown locally
  try {
    const res = await drive.files.get({
      fileId: parentFolderId,
      fields: 'id, name, parents, appProperties, trashed',
      supportsAllDrives: false,
    });

    const folder = res.data;
    if (folder.trashed || !folder.parents || folder.parents.length === 0) {
      cache.set(parentFolderId, null);
      return { isInsidePool: false, path: '' };
    }

    if (folder.parents.includes(rootFolderId)) {
      const computedPath = folder.appProperties?.tsubasa_folder_path || `/${folder.name}`;
      insertFolderRecord(computedPath, poolId);
      cache.set(parentFolderId, computedPath);
      return { isInsidePool: true, path: computedPath };
    }

    const grandParentId = folder.parents[0];
    const parentResult = await resolveRemoteParentPath(
      drive,
      rootFolderId,
      grandParentId,
      cache,
      undefined,
      poolId
    );

    if (!parentResult.isInsidePool) {
      cache.set(parentFolderId, null);
      return { isInsidePool: false, path: '' };
    }

    const computedPath =
      folder.appProperties?.tsubasa_folder_path ||
      (parentResult.path === '/'
        ? `/${folder.name}`
        : `${parentResult.path}/${folder.name}`);

    insertFolderRecord(computedPath, poolId);
    cache.set(parentFolderId, computedPath);
    return { isInsidePool: true, path: computedPath };
  } catch {
    cache.set(parentFolderId, null);
    return { isInsidePool: false, path: '' };
  }
}

export async function runIncrementalSync(accountId: string): Promise<DeltaSyncReport> {
  const accountRecord = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!accountRecord) {
    throw new Error(`Account ${accountId} not found in database`);
  }

  if (!accountRecord.lastSyncToken) {
    const coldReport = await runColdReconciliation(accountId);
    const refreshed = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
    });

    return {
      accountId,
      changesProcessed: coldReport.filesIndexed,
      filesUpdated: coldReport.filesIndexed,
      filesRemoved: 0,
      newToken: refreshed?.lastSyncToken || null,
    };
  }

  const drive = getDriveClient(accountId);
  await db.update(accounts).set({ syncState: 'syncing' }).where(eq(accounts.id, accountId));

  try {
    const rootFolderId = accountRecord.rootFolderId;
    if (!rootFolderId) {
      throw new Error(`Account ${accountId} does not have a registered root folder`);
    }

    const poolId = accountRecord.poolId ?? 1;
    const folderPathCache = new Map<string, string | null>([[rootFolderId, '/']]);

    let pageToken: string | undefined = accountRecord.lastSyncToken;
    let newStartToken: string | null = null;
    let changesCount = 0;
    let updatedCount = 0;
    let removedCount = 0;

    while (pageToken) {
      const res: any = await drive.changes.list({
        pageToken,
        fields: 'nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, size, mimeType, trashed, parents, appProperties, md5Checksum, sha256Checksum))',
        spaces: 'drive',
        supportsAllDrives: false,
        includeItemsFromAllDrives: false,
      });

      const batch = res.data.changes || [];
      changesCount += batch.length;

      const batchFolderPaths = new Set<string>();
      const batchOperations: Array<() => void> = [];

      for (const change of batch) {
        if (!change.fileId) continue;

        if (change.removed) {
          batchOperations.push(() => {
            deleteFileStmt.run(change.fileId, accountId);
          });
          removedCount++;
          continue;
        }

        const file = change.file;
        if (!file) continue;

        if (file.mimeType === 'application/vnd.google-apps.folder') {
          if (!file.trashed && file.parents && file.parents.length > 0) {
            const parentId = file.parents[0];
            const parentRes = await resolveRemoteParentPath(
              drive,
              rootFolderId,
              parentId,
              folderPathCache,
              file.appProperties?.tsubasa_folder_path
                ? path.posix.dirname(file.appProperties.tsubasa_folder_path)
                : undefined,
              poolId
            );
            if (parentRes.isInsidePool) {
              const folderPath =
                file.appProperties?.tsubasa_folder_path ||
                (parentRes.path === '/'
                  ? `/${file.name}`
                  : `${parentRes.path}/${file.name}`);
              batchFolderPaths.add(folderPath);
              folderPathCache.set(change.fileId, folderPath);
            }
          }
          continue;
        }

        if (file.trashed) {
          batchOperations.push(() => {
            trashFileStmt.run(change.fileId, accountId);
          });
          updatedCount++;
          continue;
        }

        let isInsidePool = false;
        let parentFolderPath = '/';

        if (file.parents && file.parents.length > 0) {
          const expectedParent = file.appProperties?.tsubasa_virtual_path
            ? path.posix.dirname(file.appProperties.tsubasa_virtual_path)
            : undefined;

          for (const parentId of file.parents) {
            const res = await resolveRemoteParentPath(
              drive,
              rootFolderId,
              parentId,
              folderPathCache,
              expectedParent,
              poolId
            );
            if (res.isInsidePool) {
              isInsidePool = true;
              parentFolderPath = res.path;
              break;
            }
          }
        }

        if (!isInsidePool) {
          batchOperations.push(() => {
            deleteFileStmt.run(change.fileId, accountId);
          });
          removedCount++;

          if (file.appProperties?.tsubasa_managed === 'true') {
            drive.files
              .update({
                fileId: change.fileId,
                requestBody: {
                  appProperties: {
                    tsubasa_managed: null,
                    tsubasa_virtual_path: null,
                    tsubasa_virtual_id: null,
                  } as any,
                },
                supportsAllDrives: false,
              })
              .catch(() => {});
          }
          continue;
        }

        if (file.appProperties?.tsubasa_managed === 'true') {
          const computedPath =
            parentFolderPath === '/' ? `/${file.name}` : `${parentFolderPath}/${file.name}`;
          const virtualPath = file.appProperties.tsubasa_virtual_path || computedPath;
          const fileId = file.appProperties.tsubasa_virtual_id || file.id || change.fileId;
          const hash =
            file.appProperties.tsubasa_checksum || file.md5Checksum || file.sha256Checksum || null;

          for (const folder of extractFolderPaths(virtualPath)) {
            batchFolderPaths.add(folder);
          }

          batchOperations.push(() => {
            upsertFileRecord({
              id: fileId,
              virtualPath,
              name: file.name || 'unnamed',
              sizeBytes: Number(file.size || 0),
              mimeType: file.mimeType || 'application/octet-stream',
              hash,
              accountId,
              driveFileId: file.id || change.fileId,
              isTrashed: false,
              poolId,
            });
          });
          updatedCount++;
        }
      }

      sqlite.transaction(() => {
        for (const op of batchOperations) {
          op();
        }
        for (const folder of batchFolderPaths) {
          insertFolderRecord(folder, poolId);
        }
      })();

      if (res.data.newStartPageToken) {
        newStartToken = res.data.newStartPageToken;
        break;
      }

      pageToken = res.data.nextPageToken || undefined;
    }

    const aboutRes = await drive.about.get({ fields: 'storageQuota' });
    const usageBytes = Number(aboutRes.data.storageQuota?.usage || 0);

    await db
      .update(accounts)
      .set({
        syncState: 'idle',
        lastSyncToken: newStartToken || accountRecord.lastSyncToken,
        quotaUsedBytes: usageBytes,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));

    return {
      accountId,
      changesProcessed: changesCount,
      filesUpdated: updatedCount,
      filesRemoved: removedCount,
      newToken: newStartToken || accountRecord.lastSyncToken,
    };
  } catch (err) {
    await db.update(accounts).set({ syncState: 'error' }).where(eq(accounts.id, accountId));
    throw err;
  }
}
