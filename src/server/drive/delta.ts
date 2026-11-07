import { getDriveClient } from './client.js';
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
    let pageToken: string | undefined = accountRecord.lastSyncToken;
    let newStartToken: string | null = null;
    let changesCount = 0;
    let updatedCount = 0;
    let removedCount = 0;

    while (pageToken) {
      const res: any = await drive.changes.list({
        pageToken,
        fields: 'nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, size, mimeType, trashed, appProperties, md5Checksum, sha256Checksum))',
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
