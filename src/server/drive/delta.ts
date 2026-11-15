import {
  getDriveClient,
  refreshAccountLiveQuota,
  resolveRemoteParentPath,
  runBoundedConcurrency,
  withDriveRetry,
} from './client.js';
import {
  runColdReconciliation,
  extractFolderPaths,
  insertFolderRecord,
  upsertFileRecord,
  deleteFileStmt,
  trashFileStmt,
} from './sync.js';
import { invalidateDiscrepancyCache } from './detector.js';
import { db, sqlite, bumpPoolRevision } from '../db/index.js';
import { getPendingOutboxDeleteDriveIds, getPendingOutboxDriveIds } from './outbox.js';
import { accounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface DeltaSyncReport {
  accountId: string;
  changesProcessed: number;
  filesUpdated: number;
  filesRemoved: number;
  newToken: string | null;
}

const inFlightIncrementalSyncs = new Map<string, Promise<DeltaSyncReport>>();

function isExpiredTokenError(err: unknown): boolean {
  const e = err as { status?: number; code?: number; response?: { status?: number } } | null;
  return e?.status === 410 || e?.code === 410 || e?.response?.status === 410;
}

async function fallbackToColdSync(accountId: string): Promise<DeltaSyncReport> {
  const coldReport = await runColdReconciliation(accountId);
  invalidateDiscrepancyCache(accountId);
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

export function runIncrementalSync(accountId: string): Promise<DeltaSyncReport> {
  const existing = inFlightIncrementalSyncs.get(accountId);
  if (existing) {
    return existing;
  }

  const promise = executeIncrementalSync(accountId).finally(() => {
    inFlightIncrementalSyncs.delete(accountId);
  });
  inFlightIncrementalSyncs.set(accountId, promise);
  return promise;
}

async function executeIncrementalSync(accountId: string): Promise<DeltaSyncReport> {
  const accountRecord = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!accountRecord) {
    throw new Error(`Account ${accountId} not found in database`);
  }

  if (!accountRecord.lastSyncToken) {
    return fallbackToColdSync(accountId);
  }

  const drive = getDriveClient(accountId);
  await db.update(accounts).set({ syncState: 'syncing' }).where(eq(accounts.id, accountId));

  let report: DeltaSyncReport;

  try {
    const rootFolderId = accountRecord.rootFolderId;
    if (!rootFolderId) {
      throw new Error(`Account ${accountId} does not have a registered root folder`);
    }

    const poolId = accountRecord.poolId ?? 1;
    const folderPathCache = new Map<string, string | null>([[rootFolderId, '/']]);
    const orphanDriveIds: string[] = [];

    let pageToken: string | undefined = accountRecord.lastSyncToken;
    let newStartToken: string | null = null;
    let changesCount = 0;
    let updatedCount = 0;
    let removedCount = 0;

    while (pageToken) {
      const res: any = await withDriveRetry(() =>
        drive.changes.list({
          pageToken,
          pageSize: 1000,
          fields: 'nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, size, mimeType, trashed, parents, appProperties, md5Checksum, sha256Checksum))',
          spaces: 'drive',
          supportsAllDrives: false,
          includeItemsFromAllDrives: false,
        })
      );

      const batch = res.data.changes || [];
      changesCount += batch.length;

      const pendingOutboxDeleteIds = getPendingOutboxDeleteDriveIds(accountId);
      const pendingOutboxDriveIds = getPendingOutboxDriveIds(accountId);
      const batchFolderPaths = new Set<string>();
      const batchOperations: Array<() => void> = [];

      for (const change of batch) {
        if (!change.fileId) continue;
        if (pendingOutboxDeleteIds.has(change.fileId) || pendingOutboxDriveIds.has(change.fileId)) {
          continue;
        }

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
              {
                onResolvedFolder: (virtualPath) => batchFolderPaths.add(virtualPath),
              }
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
          for (const parentId of file.parents) {
            const res = await resolveRemoteParentPath(
              drive,
              rootFolderId,
              parentId,
              folderPathCache,
              {
                onResolvedFolder: (virtualPath) => batchFolderPaths.add(virtualPath),
              }
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
            orphanDriveIds.push(change.fileId);
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

    await runBoundedConcurrency(orphanDriveIds, 5, async (orphanId) => {
      await withDriveRetry(() =>
        drive.files.update({
          fileId: orphanId,
          requestBody: {
            appProperties: {
              tsubasa_managed: null,
              tsubasa_virtual_path: null,
              tsubasa_virtual_id: null,
            } as any,
          },
          supportsAllDrives: false,
        })
      ).catch(() => {});
    });

    const finalToken = newStartToken || accountRecord.lastSyncToken;

    await db
      .update(accounts)
      .set({
        syncState: 'idle',
        lastSyncToken: finalToken,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));

    if (updatedCount > 0 || removedCount > 0) {
      invalidateDiscrepancyCache(accountId);
      bumpPoolRevision(poolId);
    }

    report = {
      accountId,
      changesProcessed: changesCount,
      filesUpdated: updatedCount,
      filesRemoved: removedCount,
      newToken: finalToken,
    };
  } catch (err) {
    if (isExpiredTokenError(err)) {
      await db
        .update(accounts)
        .set({ lastSyncToken: null })
        .where(eq(accounts.id, accountId));
      return fallbackToColdSync(accountId);
    }

    await db.update(accounts).set({ syncState: 'error' }).where(eq(accounts.id, accountId));
    throw err;
  }

  // Refresh quota outside the error-marking try/catch so an about.get failure doesn't flip syncState to 'error'.
  await refreshAccountLiveQuota(accountId).catch((err) => {
    console.warn(`[delta-sync] Failed to refresh live quota for ${accountId}:`, err);
  });

  return report;
}
