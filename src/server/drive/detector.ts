import path from 'node:path';
import { db, sqlite } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import {
  getDriveClient,
  refreshAccountLiveQuota,
} from './client.js';
import { CLEARED_TSUBASA_APP_PROPERTIES } from './appProperties.js';
import { resolveRemoteParentPath } from './remoteTree.js';
import { withDriveRetry, runBoundedConcurrency } from './errors.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import { FileExceedsCeilingError, MAX_SINGLE_FILE_BYTES } from '../storage/index.js';
import { pendingAppPropertyDriveIds } from './sync.js';
import {
  bumpScanGeneration,
  getCachedDiscrepancyReport,
  removeDriveIdFromCachedReport,
  findCachedDiscrepancyItem,
} from './discrepancyCache.js';
import {
  scanAccountDiscrepancies,
  stampAcceptedAppProperties,
  commitIndexedFileTx,
  upsertIndexedFileInCurrentTx,
  performEjectFileToDriveRoot,
  DRIVE_BATCH_CONCURRENCY,
  type PreScannedExternalFile,
  type AppPropertyStamp,
} from './detectorScan.js';
import type { PreScannedBatchItem } from './detectorConflicts.js';

export async function acceptExternalFile(
  accountId: string,
  driveFileId: string,
  targetVirtualPath?: string,
  preScanned?: PreScannedExternalFile
): Promise<FileRecord> {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  const poolId = account?.poolId ?? 1;

  const cachedItem = findCachedDiscrepancyItem(accountId, driveFileId);
  const fastVirtualPath = targetVirtualPath ?? cachedItem?.virtualPath;
  const fastSizeBytes = preScanned?.sizeBytes ?? cachedItem?.sizeBytes;

  if (fastVirtualPath && fastSizeBytes !== undefined && Number.isFinite(fastSizeBytes)) {
    if (fastSizeBytes > MAX_SINGLE_FILE_BYTES) {
      throw new FileExceedsCeilingError(fastSizeBytes);
    }
    const virtualPath = normalizeVirtualPath(fastVirtualPath);
    const fileName = path.posix.basename(virtualPath);
    const mimeType = preScanned?.mimeType ?? cachedItem?.mimeType ?? 'application/octet-stream';
    const hash = preScanned?.hash !== undefined ? preScanned.hash : (cachedItem?.hash ?? null);

    const committedFileId = commitIndexedFileTx({
      poolId,
      accountId,
      driveFileId,
      virtualPath,
      fileName,
      sizeBytes: fastSizeBytes,
      mimeType,
      hash,
      markPendingDriveSync: true,
    });

    pendingAppPropertyDriveIds.add(driveFileId);
    void stampAcceptedAppProperties(accountId, [
      { driveFileId, virtualPath, fileId: committedFileId },
    ]);
    removeDriveIdFromCachedReport(accountId, driveFileId);
    bumpScanGeneration(accountId);

    const inserted = await db.query.files.findFirst({ where: eq(files.id, committedFileId) });
    if (!inserted) {
      throw new Error(`Failed to load accepted file ${committedFileId}`);
    }
    return inserted;
  }

  const drive = getDriveClient(accountId);
  const fileRes = await withDriveRetry(() =>
    drive.files.get({
      fileId: driveFileId,
      fields: 'id, name, size, mimeType, md5Checksum, parents, appProperties',
      supportsAllDrives: false,
    })
  );

  const remote = fileRes.data;
  if (!remote.id || !remote.name) {
    throw new Error(`File ${driveFileId} not found in Google Drive`);
  }
  const remoteId = remote.id;

  let finalVirtualPath = targetVirtualPath || remote.appProperties?.tsubasa_virtual_path;
  if (!finalVirtualPath) {
    if (account?.rootFolderId && remote.parents?.length) {
      const parentCache = new Map<string, string | null>();
      const parentResult = await resolveRemoteParentPath(
        drive,
        account.rootFolderId,
        remote.parents[0],
        parentCache
      );
      const parentFolderPath = parentResult.isInsidePool ? parentResult.path : '/';
      finalVirtualPath = parentFolderPath === '/' ? `/${remote.name}` : `${parentFolderPath}/${remote.name}`;
    } else {
      finalVirtualPath = `/${remote.name}`;
    }
  }

  const sizeBytes = Number(remote.size || 0);
  if (sizeBytes > MAX_SINGLE_FILE_BYTES) {
    throw new FileExceedsCeilingError(sizeBytes);
  }
  const virtualPath = normalizeVirtualPath(finalVirtualPath);
  const fileName = path.posix.basename(virtualPath);
  const mimeType = remote.mimeType || 'application/octet-stream';
  const hash = remote.md5Checksum || null;

  const committedFileId = commitIndexedFileTx({
    poolId,
    accountId,
    driveFileId: remoteId,
    virtualPath,
    fileName,
    sizeBytes,
    mimeType,
    hash,
    preferredFileId: remote.appProperties?.tsubasa_virtual_id || undefined,
    markPendingDriveSync: true,
  });

  pendingAppPropertyDriveIds.add(remoteId);
  void stampAcceptedAppProperties(accountId, [{ driveFileId: remoteId, virtualPath, fileId: committedFileId }]);
  removeDriveIdFromCachedReport(accountId, driveFileId);
  bumpScanGeneration(accountId);

  const inserted = await db.query.files.findFirst({ where: eq(files.id, committedFileId) });
  if (!inserted) {
    throw new Error(`Failed to load accepted file ${committedFileId}`);
  }
  return inserted;
}

/**
 * Ejects every unindexed and modified file under the account's pool folder to the Drive root.
 * Awaits the Drive moves so a follow-up scan no longer sees the files inside the pool folder.
 */
export async function ejectAllExternalFiles(
  accountId: string
): Promise<{ ejectedCount: number; failedCount: number }> {
  const report = await scanAccountDiscrepancies(accountId);
  const items = [...report.unindexed, ...report.modified];
  let failedCount = 0;

  await runBoundedConcurrency(items, DRIVE_BATCH_CONCURRENCY, async (item) => {
    try {
      await ejectFileToDriveRoot(accountId, item.driveFileId);
    } catch (err) {
      failedCount++;
      console.warn(`Failed to eject ${item.driveFileId} (${accountId}):`, err);
    }
  });

  return { ejectedCount: items.length - failedCount, failedCount };
}

/**
 * Accepts every unindexed and modified file under the account's pool folder in one pass.
 * SQLite is updated in a single transaction so the UI reflects the result immediately;
 * Drive appProperties are stamped afterwards in the background.
 */
export async function acceptAllExternalFiles(
  accountId: string,
  preScannedItems?: PreScannedBatchItem[]
): Promise<{ acceptedCount: number }> {
  let items: Array<{
    driveFileId: string;
    virtualPath: string;
    sizeBytes: number;
    mimeType: string;
    hash: string | null;
  }>;

  if (preScannedItems && preScannedItems.length > 0) {
    items = preScannedItems.map((item) => ({
      driveFileId: item.driveFileId,
      virtualPath: item.virtualPath,
      sizeBytes: item.sizeBytes,
      mimeType: item.mimeType || 'application/octet-stream',
      hash: item.hash ?? null,
    }));
  } else {
    const cached = getCachedDiscrepancyReport(accountId);
    const report = cached ?? (await scanAccountDiscrepancies(accountId));
    items = [...report.unindexed, ...report.modified];
  }

  if (items.length === 0) {
    return { acceptedCount: 0 };
  }

  for (const item of items) {
    if (item.sizeBytes > MAX_SINGLE_FILE_BYTES) {
      throw new FileExceedsCeilingError(item.sizeBytes);
    }
  }

  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  const poolId = account?.poolId ?? 1;

  const stamps: AppPropertyStamp[] = [];
  const ensuredFolders = new Set<string>();

  const applyAccept = sqlite.transaction(() => {
    const trashSuffix = `.trashed-${Date.now()}`;
    for (const item of items) {
      const virtualPath = normalizeVirtualPath(item.virtualPath);
      const fileId = upsertIndexedFileInCurrentTx({
        poolId,
        accountId,
        driveFileId: item.driveFileId,
        virtualPath,
        sizeBytes: item.sizeBytes,
        mimeType: item.mimeType,
        hash: item.hash,
        trashSuffix,
        ensuredFolders,
        markPendingDriveSync: true,
      });

      stamps.push({ driveFileId: item.driveFileId, virtualPath, fileId });
    }
  });

  applyAccept();
  for (const stamp of stamps) {
    pendingAppPropertyDriveIds.add(stamp.driveFileId);
  }

  const cachedReport = getCachedDiscrepancyReport(accountId);
  if (cachedReport) {
    const acceptedSet = new Set(items.map((item) => item.driveFileId));
    cachedReport.unindexed = cachedReport.unindexed.filter((item) => !acceptedSet.has(item.driveFileId));
    cachedReport.modified = cachedReport.modified.filter((item) => !acceptedSet.has(item.driveFileId));
    cachedReport.conflicts = cachedReport.conflicts.filter((item) => !acceptedSet.has(item.driveFileId));
    cachedReport.overCeiling = cachedReport.overCeiling.filter((item) => !acceptedSet.has(item.driveFileId));
    cachedReport.missingRemote = cachedReport.missingRemote.filter((item) => !acceptedSet.has(item.driveFileId));
  }
  bumpScanGeneration(accountId);

  void stampAcceptedAppProperties(accountId, stamps);
  void refreshAccountLiveQuota(accountId).catch(() => {});

  return { acceptedCount: items.length };
}

export async function ejectFileToDriveRoot(accountId: string, driveFileId: string): Promise<void> {
  return performEjectFileToDriveRoot(accountId, driveFileId);
}

export async function removeMissingFile(accountId: string, driveFileId: string): Promise<void> {
  await db.delete(files).where(and(eq(files.driveFileId, driveFileId), eq(files.accountId, accountId)));
  removeDriveIdFromCachedReport(accountId, driveFileId);
  bumpScanGeneration(accountId);

  try {
    const drive = getDriveClient(accountId);
    void withDriveRetry(() =>
      drive.files.update({
        fileId: driveFileId,
        requestBody: {
          appProperties: CLEARED_TSUBASA_APP_PROPERTIES as any,
        },
        supportsAllDrives: false,
      })
    ).catch(() => {
      // Non-fatal if the file was deleted from Drive entirely
    });
  } catch {
    // Non-fatal if the account is unavailable
  }
}
