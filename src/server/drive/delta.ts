import { getDriveClient, getDescendantFolderIds } from './client.js';
import {
  runColdReconciliation,
  extractFolderPaths,
  insertFolderRecord,
  upsertFileRecord,
  deleteFileStmt,
  trashFileStmt,
} from './sync.js';
import { db, sqlite } from '../db/index.js';
import { accounts, files } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

export interface DeltaSyncReport {
  accountId: string;
  changesProcessed: number;
  filesUpdated: number;
  filesRemoved: number;
  newToken: string | null;
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

    const validFolderIds = await getDescendantFolderIds(drive, rootFolderId);

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

      sqlite.transaction(() => {
        const batchFolderPaths = new Set<string>();

        for (const change of batch) {
          if (!change.fileId) continue;

          if (change.removed) {
            deleteFileStmt.run(change.fileId, accountId);
            removedCount++;
            continue;
          }

          const file = change.file;
          if (!file) continue;

          if (file.trashed) {
            trashFileStmt.run(change.fileId, accountId);
            updatedCount++;
            continue;
          }

          const isInsidePool = Boolean(file.parents?.some((p: string) => validFolderIds.has(p)));

          if (!isInsidePool) {
            deleteFileStmt.run(change.fileId, accountId);
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
            const virtualPath = file.appProperties.tsubasa_virtual_path || `/${file.name}`;
            const fileId = file.appProperties.tsubasa_virtual_id || file.id || change.fileId;
            const hash = file.appProperties.tsubasa_checksum || file.md5Checksum || file.sha256Checksum || null;

            for (const folder of extractFolderPaths(virtualPath)) {
              batchFolderPaths.add(folder);
            }

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
            });
            updatedCount++;
          }
        }

        for (const folder of batchFolderPaths) {
          insertFolderRecord(folder);
        }
      })();

      if (res.data.newStartPageToken) {
        newStartToken = res.data.newStartPageToken;
        break;
      }

      pageToken = res.data.nextPageToken || undefined;
    }

    // Reconcile untrashed managed files against the valid folder hierarchy
    // to catch any desynced files whose change events were already passed or bypassed
    let managedPageToken: string | undefined = undefined;
    const activeRemoteDriveIds = new Set<string>();

    do {
      const remoteRes: any = await drive.files.list({
        q: "appProperties has { key='tsubasa_managed' and value='true' } and trashed = false",
        fields: 'nextPageToken, files(id, name, parents, appProperties)',
        pageSize: 1000,
        pageToken: managedPageToken,
        spaces: 'drive',
        supportsAllDrives: false,
      });

      for (const remoteFile of remoteRes.data.files || []) {
        if (!remoteFile.id) continue;
        const isInside = Boolean(remoteFile.parents?.some((p: string) => validFolderIds.has(p)));
        if (!isInside) {
          deleteFileStmt.run(remoteFile.id, accountId);
          removedCount++;

          await drive.files
            .update({
              fileId: remoteFile.id,
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
        } else {
          activeRemoteDriveIds.add(remoteFile.id);
        }
      }

      managedPageToken = remoteRes.data.nextPageToken || undefined;
    } while (managedPageToken);

    // Check all untrashed local SQLite files for this account.
    // If a local file's driveFileId is no longer an active remote managed file inside the pool, prune it.
    const localFiles = await db.query.files.findMany({
      where: and(eq(files.accountId, accountId), eq(files.isTrashed, false)),
    });

    for (const lf of localFiles) {
      if (!activeRemoteDriveIds.has(lf.driveFileId)) {
        deleteFileStmt.run(lf.driveFileId, accountId);
        removedCount++;
      }
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
