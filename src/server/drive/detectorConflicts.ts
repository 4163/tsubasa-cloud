import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import {
  getDriveClient,
  refreshAccountLiveQuota,
} from './client.js';
import { CLEARED_TSUBASA_APP_PROPERTIES, buildTsubasaAppProperties } from './appProperties.js';
import { resolveRemoteParentPath } from './remoteTree.js';
import { ItemConflictError, withDriveRetry, runBoundedConcurrency } from './errors.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import { FileExceedsCeilingError, MAX_SINGLE_FILE_BYTES } from '../storage/index.js';
import { allocateUniqueVirtualPath, getAvailableCopyPath } from './operationsDb.js';
import {
  bumpScanGeneration,
  removeDriveIdFromCachedReport,
  findCachedDiscrepancyItem,
} from './discrepancyCache.js';
import {
  commitIndexedFileTx,
  upsertIndexedFileInCurrentTx,
  performEjectFileToDriveRoot,
  DRIVE_BATCH_CONCURRENCY,
} from './detectorScan.js';

export type ConflictResolutionAction = 'keep_both' | 'deduplicate' | 'replace_existing' | 'eject';

export interface PreScannedBatchItem {
  driveFileId: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType?: string;
  hash?: string | null;
}

export async function resolvePathConflict(
  accountId: string,
  driveFileId: string,
  resolution: ConflictResolutionAction,
  targetVirtualPath?: string
): Promise<{
  resolution: ConflictResolutionAction;
  accountId: string;
  driveFileId: string;
  virtualPath?: string;
  file?: FileRecord;
}> {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  if (!account) {
    throw new Error(`Account ${accountId} not registered`);
  }
  const poolId = account.poolId ?? 1;

  if (resolution === 'eject') {
    await performEjectFileToDriveRoot(accountId, driveFileId);
    return { resolution: 'eject', accountId, driveFileId };
  }

  if (resolution === 'deduplicate') {
    const drive = getDriveClient(accountId);
    await withDriveRetry(() =>
      drive.files.update({
        fileId: driveFileId,
        requestBody: {
          trashed: true,
          appProperties: CLEARED_TSUBASA_APP_PROPERTIES as any,
        },
        supportsAllDrives: false,
      })
    );
    await db.delete(files).where(and(eq(files.driveFileId, driveFileId), eq(files.accountId, accountId)));
    await refreshAccountLiveQuota(accountId).catch(() => {});
    removeDriveIdFromCachedReport(accountId, driveFileId);
    bumpScanGeneration(accountId);
    return { resolution: 'deduplicate', accountId, driveFileId };
  }

  const drive = getDriveClient(accountId);
  const fileRes = await withDriveRetry(() =>
    drive.files.get({
      fileId: driveFileId,
      fields: 'id, name, size, mimeType, md5Checksum, sha256Checksum, parents, appProperties',
      supportsAllDrives: false,
    })
  );

  const remote = fileRes.data;
  if (!remote.id || !remote.name) {
    throw new Error(`File ${driveFileId} not found in Google Drive`);
  }
  const remoteId = remote.id;

  let rawPath = targetVirtualPath || remote.appProperties?.tsubasa_virtual_path;
  if (!rawPath) {
    if (account.rootFolderId && remote.parents?.length) {
      const parentCache = new Map<string, string | null>();
      const parentResult = await resolveRemoteParentPath(
        drive,
        account.rootFolderId,
        remote.parents[0],
        parentCache
      );
      const parentFolderPath = parentResult.isInsidePool ? parentResult.path : '/';
      rawPath = parentFolderPath === '/' ? `/${remote.name}` : `${parentFolderPath}/${remote.name}`;
    } else {
      rawPath = `/${remote.name}`;
    }
  }

  const baseVirtualPath = normalizeVirtualPath(rawPath);
  const sizeBytes = Number(remote.size || 0);
  if (sizeBytes > MAX_SINGLE_FILE_BYTES) {
    throw new FileExceedsCeilingError(sizeBytes);
  }
  const checksum = remote.appProperties?.tsubasa_checksum || remote.md5Checksum || remote.sha256Checksum || null;
  const mimeType = remote.mimeType || 'application/octet-stream';

  const resolveNonCollidingFileId = (): string => {
    const candidateId = remote.appProperties?.tsubasa_virtual_id;
    if (!candidateId) return randomUUID();
    const idCollision = sqlite
      .prepare('SELECT id, drive_file_id, account_id FROM files WHERE id = ? LIMIT 1')
      .get(candidateId) as { id: string; drive_file_id: string; account_id: string } | undefined;
    if (!idCollision || (idCollision.drive_file_id === remoteId && idCollision.account_id === accountId)) {
      return candidateId;
    }
    return randomUUID();
  };

  if (resolution === 'keep_both') {
    const parentDir = path.posix.dirname(baseVirtualPath);
    const baseName = path.posix.basename(baseVirtualPath);
    const newVirtualPath = await getAvailableCopyPath(parentDir, baseName, 'file', poolId);
    const newFileName = path.posix.basename(newVirtualPath);
    const fileId = resolveNonCollidingFileId();

    await withDriveRetry(() =>
      drive.files.update({
        fileId: remoteId,
        requestBody: {
          name: newFileName,
          appProperties: buildTsubasaAppProperties({
            virtualPath: newVirtualPath,
            virtualId: fileId,
            checksum,
          }),
        },
        supportsAllDrives: false,
      })
    );

    commitIndexedFileTx({
      poolId,
      accountId,
      driveFileId: remoteId,
      virtualPath: newVirtualPath,
      fileName: newFileName,
      sizeBytes,
      mimeType,
      hash: checksum,
      resolvedFileId: fileId,
    });

    removeDriveIdFromCachedReport(accountId, driveFileId);
    bumpScanGeneration(accountId);
    const inserted = await db.query.files.findFirst({ where: eq(files.id, fileId) });
    return {
      resolution: 'keep_both',
      accountId,
      driveFileId,
      virtualPath: newVirtualPath,
      file: inserted,
    };
  }

  const existingActive = await db.query.files.findFirst({
    where: and(eq(files.poolId, poolId), eq(files.virtualPath, baseVirtualPath), eq(files.isTrashed, false)),
  });

  let trashReplacedFailed = false;
  if (existingActive && existingActive.driveFileId !== remoteId) {
    try {
      const prevDrive = getDriveClient(existingActive.accountId);
      await withDriveRetry(() =>
        prevDrive.files.update({
          fileId: existingActive.driveFileId,
          requestBody: {
            trashed: true,
            appProperties: CLEARED_TSUBASA_APP_PROPERTIES as any,
          },
          supportsAllDrives: false,
        })
      );
      await refreshAccountLiveQuota(existingActive.accountId).catch(() => {});
    } catch (err) {
      trashReplacedFailed = true;
      console.warn(
        `Failed to trash replaced Drive file ${existingActive.driveFileId} on ${existingActive.accountId}:`,
        err
      );
    }
  }

  const fileId = resolveNonCollidingFileId();
  const fileName = path.posix.basename(baseVirtualPath);

  await withDriveRetry(() =>
    drive.files.update({
      fileId: remoteId,
      requestBody: {
        name: fileName,
        appProperties: buildTsubasaAppProperties({
          virtualPath: baseVirtualPath,
          virtualId: fileId,
          checksum,
        }),
      },
      supportsAllDrives: false,
    })
  );

  commitIndexedFileTx({
    poolId,
    accountId,
    driveFileId: remoteId,
    virtualPath: baseVirtualPath,
    fileName,
    sizeBytes,
    mimeType,
    hash: checksum,
    resolvedFileId: fileId,
    replacedActiveFile: existingActive
      ? { id: existingActive.id, accountId: existingActive.accountId, driveFileId: existingActive.driveFileId }
      : null,
    enqueueTrashForReplaced: trashReplacedFailed,
  });

  removeDriveIdFromCachedReport(accountId, driveFileId);
  bumpScanGeneration(accountId);
  const inserted = await db.query.files.findFirst({ where: eq(files.id, fileId) });
  return {
    resolution: 'replace_existing',
    accountId,
    driveFileId,
    virtualPath: baseVirtualPath,
    file: inserted,
  };
}

function reserveAvailableCopyPath(targetDir: string, baseName: string, occupiedPaths: Set<string>): string {
  const candidatePath = allocateUniqueVirtualPath({
    targetDir,
    baseName,
    kind: 'file',
    style: 'copy',
    startCounter: 1,
    isTaken: (pathCandidate) => occupiedPaths.has(pathCandidate),
  });
  occupiedPaths.add(candidatePath);
  return candidatePath;
}

export async function resolvePathConflictsBatch(
  accountId: string,
  items: Array<{ driveFileId: string; targetVirtualPath?: string }>,
  resolution: 'keep_both' | 'deduplicate'
): Promise<{
  resolvedCount: number;
  failedCount: number;
  results: Array<{
    driveFileId: string;
    success: boolean;
    virtualPath?: string;
    error?: string;
  }>;
}> {
  if (items.length === 0) {
    return { resolvedCount: 0, failedCount: 0, results: [] };
  }

  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  if (!account) {
    throw new Error(`Account ${accountId} not registered`);
  }
  const poolId = account.poolId ?? 1;
  const drive = getDriveClient(accountId);

  const results: Array<{
    driveFileId: string;
    success: boolean;
    virtualPath?: string;
    error?: string;
  }> = new Array(items.length);

  if (resolution === 'keep_both') {
    const activeRows = sqlite
      .prepare('SELECT virtual_path FROM files WHERE pool_id = ? AND is_trashed = 0')
      .all(poolId) as Array<{ virtual_path: string }>;
    const occupiedPaths = new Set(activeRows.map((r) => r.virtual_path));

    interface ResolvedKeepBothMeta {
      index: number;
      driveFileId: string;
      baseVirtualPath: string;
      sizeBytes: number;
      mimeType: string;
      checksum: string | null;
      candidateId?: string;
    }

    const resolvedMetas: ResolvedKeepBothMeta[] = [];
    const needDriveFetch: Array<{ index: number; driveFileId: string; targetVirtualPath?: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const cached = findCachedDiscrepancyItem(accountId, item.driveFileId);
      const rawPath = item.targetVirtualPath || cached?.virtualPath;
      if (cached && rawPath) {
        if (cached.sizeBytes > MAX_SINGLE_FILE_BYTES) {
          results[i] = {
            driveFileId: item.driveFileId,
            success: false,
            error: new FileExceedsCeilingError(cached.sizeBytes).message,
          };
          continue;
        }
        resolvedMetas.push({
          index: i,
          driveFileId: item.driveFileId,
          baseVirtualPath: normalizeVirtualPath(rawPath),
          sizeBytes: cached.sizeBytes,
          mimeType: cached.mimeType,
          checksum: cached.hash,
        });
      } else {
        needDriveFetch.push({ index: i, driveFileId: item.driveFileId, targetVirtualPath: item.targetVirtualPath });
      }
    }

    if (needDriveFetch.length > 0) {
      const parentCache = new Map<string, string | null>();
      await runBoundedConcurrency(needDriveFetch, DRIVE_BATCH_CONCURRENCY, async (entry) => {
        try {
          const fileRes = await withDriveRetry(() =>
            drive.files.get({
              fileId: entry.driveFileId,
              fields: 'id, name, size, mimeType, md5Checksum, sha256Checksum, parents, appProperties',
              supportsAllDrives: false,
            })
          );
          const remote = fileRes.data;
          if (!remote.id || !remote.name) {
            throw new Error(`File ${entry.driveFileId} not found in Google Drive`);
          }

          let rawPath = entry.targetVirtualPath || remote.appProperties?.tsubasa_virtual_path;
          if (!rawPath) {
            if (account.rootFolderId && remote.parents?.length) {
              const parentResult = await resolveRemoteParentPath(
                drive,
                account.rootFolderId,
                remote.parents[0],
                parentCache
              );
              const parentFolderPath = parentResult.isInsidePool ? parentResult.path : '/';
              rawPath = parentFolderPath === '/' ? `/${remote.name}` : `${parentFolderPath}/${remote.name}`;
            } else {
              rawPath = `/${remote.name}`;
            }
          }

          const remoteSizeBytes = Number(remote.size || 0);
          if (remoteSizeBytes > MAX_SINGLE_FILE_BYTES) {
            throw new FileExceedsCeilingError(remoteSizeBytes);
          }

          resolvedMetas.push({
            index: entry.index,
            driveFileId: remote.id,
            baseVirtualPath: normalizeVirtualPath(rawPath),
            sizeBytes: remoteSizeBytes,
            mimeType: remote.mimeType || 'application/octet-stream',
            checksum: remote.appProperties?.tsubasa_checksum || remote.md5Checksum || remote.sha256Checksum || null,
            candidateId: remote.appProperties?.tsubasa_virtual_id || undefined,
          });
        } catch (err) {
          results[entry.index] = {
            driveFileId: entry.driveFileId,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });
    }

    interface PreparedKeepBothItem {
      index: number;
      driveFileId: string;
      fileId: string;
      newVirtualPath: string;
      newFileName: string;
      sizeBytes: number;
      mimeType: string;
      checksum: string | null;
    }

    const selectIdCollisionStmt = sqlite.prepare(
      'SELECT id, drive_file_id, account_id FROM files WHERE id = ? LIMIT 1'
    );
    const reservedFileIds = new Set<string>();
    const preparedItems: PreparedKeepBothItem[] = [];

    for (const meta of resolvedMetas) {
      const parentDir = path.posix.dirname(meta.baseVirtualPath);
      const baseName = path.posix.basename(meta.baseVirtualPath);
      const newVirtualPath = reserveAvailableCopyPath(parentDir, baseName, occupiedPaths);
      const newFileName = path.posix.basename(newVirtualPath);

      let fileId = meta.candidateId || randomUUID();
      if (meta.candidateId) {
        const collision = selectIdCollisionStmt.get(meta.candidateId) as
          | { id: string; drive_file_id: string; account_id: string }
          | undefined;
        if (
          reservedFileIds.has(meta.candidateId) ||
          (collision && (collision.drive_file_id !== meta.driveFileId || collision.account_id !== accountId))
        ) {
          fileId = randomUUID();
        }
      }
      reservedFileIds.add(fileId);

      preparedItems.push({
        index: meta.index,
        driveFileId: meta.driveFileId,
        fileId,
        newVirtualPath,
        newFileName,
        sizeBytes: meta.sizeBytes,
        mimeType: meta.mimeType,
        checksum: meta.checksum,
      });
    }

    const succeededItems: PreparedKeepBothItem[] = [];
    await runBoundedConcurrency(preparedItems, DRIVE_BATCH_CONCURRENCY, async (item) => {
      try {
        await withDriveRetry(() =>
          drive.files.update({
            fileId: item.driveFileId,
            requestBody: {
              name: item.newFileName,
              appProperties: buildTsubasaAppProperties({
                virtualPath: item.newVirtualPath,
                virtualId: item.fileId,
                checksum: item.checksum,
              }),
            },
            supportsAllDrives: false,
          })
        );
        succeededItems.push(item);
        results[item.index] = {
          driveFileId: item.driveFileId,
          success: true,
          virtualPath: item.newVirtualPath,
        };
      } catch (err) {
        results[item.index] = {
          driveFileId: item.driveFileId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    if (succeededItems.length > 0) {
      const ensuredFolders = new Set<string>();
      const trashSuffix = `.trashed-${Date.now()}`;
      const committedItems: PreparedKeepBothItem[] = [];

      sqlite.transaction(() => {
        for (const item of succeededItems) {
          try {
            upsertIndexedFileInCurrentTx({
              poolId,
              accountId,
              driveFileId: item.driveFileId,
              virtualPath: item.newVirtualPath,
              fileName: item.newFileName,
              sizeBytes: item.sizeBytes,
              mimeType: item.mimeType,
              hash: item.checksum,
              resolvedFileId: item.fileId,
              trashSuffix,
              ensuredFolders,
            });
            committedItems.push(item);
          } catch (err) {
            if (err instanceof ItemConflictError) {
              results[item.index] = {
                driveFileId: item.driveFileId,
                success: false,
                error: err.message,
              };
              continue;
            }
            throw err;
          }
        }
      })();

      for (const item of committedItems) {
        removeDriveIdFromCachedReport(accountId, item.driveFileId);
      }
      if (committedItems.length > 0) {
        bumpScanGeneration(accountId);
      }
    }
  } else {
    const indexedItems = items.map((item, index) => ({ index, driveFileId: item.driveFileId }));
    const succeededDriveIds: string[] = [];

    await runBoundedConcurrency(indexedItems, DRIVE_BATCH_CONCURRENCY, async ({ index, driveFileId }) => {
      try {
        await withDriveRetry(() =>
          drive.files.update({
            fileId: driveFileId,
            requestBody: {
              trashed: true,
              appProperties: CLEARED_TSUBASA_APP_PROPERTIES as any,
            },
            supportsAllDrives: false,
          })
        );
        succeededDriveIds.push(driveFileId);
        results[index] = { driveFileId, success: true };
      } catch (err) {
        results[index] = {
          driveFileId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    if (succeededDriveIds.length > 0) {
      const deleteByDriveIdStmt = sqlite.prepare('DELETE FROM files WHERE drive_file_id = ? AND account_id = ?');
      sqlite.transaction(() => {
        for (const driveFileId of succeededDriveIds) {
          deleteByDriveIdStmt.run(driveFileId, accountId);
        }
      })();

      for (const driveFileId of succeededDriveIds) {
        removeDriveIdFromCachedReport(accountId, driveFileId);
      }
      bumpScanGeneration(accountId);
      await refreshAccountLiveQuota(accountId).catch(() => {});
    }
  }

  let resolvedCount = 0;
  let failedCount = 0;
  for (const r of results) {
    if (r.success) resolvedCount++;
    else failedCount++;
  }

  return { resolvedCount, failedCount, results };
}
