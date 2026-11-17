import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite } from '../db/index.js';
import { accounts, files, type Account, type FileRecord } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import {
  getDriveClient,
  resolveRemoteFolderTree,
  resolveRemoteParentPath,
  refreshAccountLiveQuota,
  resolvePoolDriveFolderName,
  withDriveRetry,
  runBoundedConcurrency,
  evaluateFileContentMatch,
} from './client.js';
import { normalizeVirtualPath } from './mirror.js';
import { MAX_SINGLE_FILE_BYTES } from '../storage/index.js';
import {
  ensureLocalParentFolders,
  insertFolderRecord,
  formatFolderId,
  extractFolderPaths,
  upsertFileStmt,
  pendingAppPropertyDriveIds,
} from './sync.js';
import { getAvailableCopyPath } from './operations.js';

export type ConflictResolutionAction = 'keep_both' | 'deduplicate' | 'replace_existing' | 'eject';

export interface ExternalFileDiscrepancy {
  driveFileId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  accountId: string;
  discrepancyType: 'unindexed' | 'modified' | 'over_ceiling';
}

export interface PathConflictDiscrepancy {
  driveFileId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  modifiedTime: string | null;
  accountId: string;
  accountEmail: string;
  accountDisplayName: string;
  discrepancyType: 'conflict';
  isExactDuplicate: boolean;
  existingFile: {
    fileId: string;
    driveFileId: string;
    accountId: string;
    accountEmail: string;
    accountDisplayName: string;
    sizeBytes: number;
    hash: string | null;
    updatedAt: string | null;
  };
}

export interface MissingFileDiscrepancy {
  fileId: string;
  driveFileId: string;
  virtualPath: string;
  accountId: string;
}

export interface DiscrepancyReport {
  accountId: string;
  poolFolderName: string;
  scannedFiles: number;
  conflicts: PathConflictDiscrepancy[];
  unindexed: ExternalFileDiscrepancy[];
  modified: ExternalFileDiscrepancy[];
  overCeiling: ExternalFileDiscrepancy[];
  missingRemote: MissingFileDiscrepancy[];
}

export interface PreScannedExternalFile {
  name?: string;
  sizeBytes?: number;
  mimeType?: string;
  hash?: string | null;
}

export interface PreScannedBatchItem {
  driveFileId: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType?: string;
  hash?: string | null;
}

const DISCREPANCY_CACHE_TTL_MS = 30_000;
const SCAN_CHUNK_CONCURRENCY = 5;

const discrepancyCache = new Map<string, { report: DiscrepancyReport; expiresAt: number }>();
const inFlightScans = new Map<string, Promise<DiscrepancyReport>>();
const scanGenerationByAccount = new Map<string, number>();
const driveFileParentsCache = new Map<string, string[]>();

function bumpScanGeneration(accountId?: string): void {
  if (accountId) {
    scanGenerationByAccount.set(accountId, (scanGenerationByAccount.get(accountId) ?? 0) + 1);
    return;
  }
  const allAccountIds = new Set([
    ...scanGenerationByAccount.keys(),
    ...discrepancyCache.keys(),
    ...inFlightScans.keys(),
  ]);
  for (const id of allAccountIds) {
    scanGenerationByAccount.set(id, (scanGenerationByAccount.get(id) ?? 0) + 1);
  }
}

export function invalidateDiscrepancyCache(accountId?: string): void {
  if (accountId) {
    discrepancyCache.delete(accountId);
  } else {
    discrepancyCache.clear();
  }
  bumpScanGeneration(accountId);
}

let _upsertPendingDriveSyncStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getUpsertPendingDriveSyncStmt() {
  if (!_upsertPendingDriveSyncStmt) {
    _upsertPendingDriveSyncStmt = sqlite.prepare(`
      INSERT INTO pending_drive_sync (account_id, drive_file_id, virtual_path, file_id, attempts, last_error, next_retry_at)
      VALUES (?, ?, ?, ?, 0, NULL, 0)
      ON CONFLICT(account_id, drive_file_id) DO UPDATE SET
        virtual_path = excluded.virtual_path,
        file_id = excluded.file_id,
        attempts = 0,
        last_error = NULL,
        next_retry_at = 0
    `);
  }
  return _upsertPendingDriveSyncStmt as any;
}

let _deletePendingDriveSyncStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getDeletePendingDriveSyncStmt() {
  if (!_deletePendingDriveSyncStmt) {
    _deletePendingDriveSyncStmt = sqlite.prepare(
      'DELETE FROM pending_drive_sync WHERE account_id = ? AND drive_file_id = ?'
    );
  }
  return _deletePendingDriveSyncStmt as any;
}

let _markPendingDriveSyncFailedStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getMarkPendingDriveSyncFailedStmt() {
  if (!_markPendingDriveSyncFailedStmt) {
    _markPendingDriveSyncFailedStmt = sqlite.prepare(`
      UPDATE pending_drive_sync
      SET attempts = attempts + 1, last_error = ?, next_retry_at = ?
      WHERE account_id = ? AND drive_file_id = ?
    `);
  }
  return _markPendingDriveSyncFailedStmt as any;
}

function getCachedDiscrepancyReport(accountId: string): DiscrepancyReport | null {
  const entry = discrepancyCache.get(accountId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    discrepancyCache.delete(accountId);
    return null;
  }
  return entry.report;
}

function removeDriveIdFromCachedReport(accountId: string, driveFileId: string): void {
  const report = getCachedDiscrepancyReport(accountId);
  if (!report) return;
  report.unindexed = report.unindexed.filter((item) => item.driveFileId !== driveFileId);
  report.modified = report.modified.filter((item) => item.driveFileId !== driveFileId);
  report.conflicts = report.conflicts.filter((item) => item.driveFileId !== driveFileId);
  report.overCeiling = report.overCeiling.filter((item) => item.driveFileId !== driveFileId);
  report.missingRemote = report.missingRemote.filter((item) => item.driveFileId !== driveFileId);
}

function findCachedDiscrepancyItem(
  accountId: string,
  driveFileId: string
): { virtualPath: string; sizeBytes: number; mimeType: string; hash: string | null } | null {
  const report = getCachedDiscrepancyReport(accountId);
  if (!report) return null;
  const match =
    report.unindexed.find((i) => i.driveFileId === driveFileId) ||
    report.modified.find((i) => i.driveFileId === driveFileId) ||
    report.overCeiling.find((i) => i.driveFileId === driveFileId) ||
    report.conflicts.find((i) => i.driveFileId === driveFileId);
  if (!match) return null;
  return {
    virtualPath: match.virtualPath,
    sizeBytes: match.sizeBytes,
    mimeType: match.mimeType,
    hash: match.hash,
  };
}

export async function scanAccountDiscrepancies(
  accountId: string,
  forceRefresh = false
): Promise<DiscrepancyReport> {
  if (!forceRefresh) {
    const cached = getCachedDiscrepancyReport(accountId);
    if (cached) {
      return cached;
    }
    const pending = inFlightScans.get(accountId);
    if (pending) {
      return pending;
    }
  } else {
    bumpScanGeneration(accountId);
  }

  const startGen = scanGenerationByAccount.get(accountId) ?? 0;

  const scanPromise = (async (): Promise<DiscrepancyReport> => {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
    });

    if (!account || !account.rootFolderId) {
      throw new Error(`Account ${accountId} not registered or missing root folder`);
    }

    const drive = getDriveClient(accountId);
    const poolId = account.poolId ?? 1;

    const [folderTree, poolAccounts, allPoolActiveFiles] = await Promise.all([
      resolveRemoteFolderTree(drive, account.rootFolderId),
      db.query.accounts.findMany({ where: eq(accounts.poolId, poolId) }),
      db.query.files.findMany({
        where: and(eq(files.poolId, poolId), eq(files.isTrashed, false)),
      }),
    ]);

    const validFolderIds = folderTree.folderIds;

    // Sync only missing remote folders into SQLite folders table
    if (folderTree.folders.length > 0) {
      const existingFolderRows = sqlite
        .prepare('SELECT virtual_path FROM folders WHERE pool_id = ?')
        .all(poolId) as Array<{ virtual_path: string }>;
      const existingFolderPaths = new Set(existingFolderRows.map((r) => r.virtual_path));
      const missingFolders = folderTree.folders.filter((f) => !existingFolderPaths.has(f.virtualPath));
      if (missingFolders.length > 0) {
        sqlite.transaction(() => {
          for (const folder of missingFolders) {
            insertFolderRecord(folder.virtualPath, poolId);
          }
        })();
      }
    }

    const pendingRows = sqlite
      .prepare('SELECT drive_file_id FROM pending_drive_sync WHERE account_id = ?')
      .all(accountId) as Array<{ drive_file_id: string }>;
    const pendingDriveIdsForAccount = new Set<string>(pendingAppPropertyDriveIds);
    for (const row of pendingRows) {
      pendingDriveIdsForAccount.add(row.drive_file_id);
    }

    const accountMap = new Map<string, Account>(poolAccounts.map((a) => [a.id, a]));

    const knownFiles = allPoolActiveFiles.filter((f) => f.accountId === accountId);
    const knownMapByDriveId = new Map<string, FileRecord>();
    for (const kf of knownFiles) {
      knownMapByDriveId.set(kf.driveFileId, kf);
    }

    const activeFileByPath = new Map<string, FileRecord>();
    for (const pf of allPoolActiveFiles) {
      const existing = activeFileByPath.get(pf.virtualPath);
      if (!existing || (existing.accountId === accountId && pf.accountId !== accountId)) {
        activeFileByPath.set(pf.virtualPath, pf);
      }
    }

    const foundRemoteIds = new Set<string>();
    const conflicts: PathConflictDiscrepancy[] = [];
    const unindexed: ExternalFileDiscrepancy[] = [];
    const modified: ExternalFileDiscrepancy[] = [];
    const overCeiling: ExternalFileDiscrepancy[] = [];

    const folderIdList = Array.from(validFolderIds);
    const CHUNK_SIZE = 20;
    const chunks: string[][] = [];
    for (let i = 0; i < folderIdList.length; i += CHUNK_SIZE) {
      chunks.push(folderIdList.slice(i, i + CHUNK_SIZE));
    }

    let chunkIndex = 0;
    const workerCount = Math.min(SCAN_CHUNK_CONCURRENCY, chunks.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (chunkIndex < chunks.length) {
          const chunk = chunks[chunkIndex++];
          const parentQuery = chunk.map((id) => `'${id}' in parents`).join(' or ');
          let pageToken: string | undefined = undefined;

          do {
            const listRes: any = await withDriveRetry(() =>
              drive.files.list({
                q: `(${parentQuery}) and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'nextPageToken, files(id, name, size, mimeType, md5Checksum, sha256Checksum, modifiedTime, parents, appProperties)',
                pageSize: 1000,
                pageToken,
                spaces: 'drive',
                supportsAllDrives: false,
              })
            );

            for (const remote of listRes.data.files || []) {
              if (!remote.id || !remote.name) continue;
              if (foundRemoteIds.has(remote.id)) continue;
              foundRemoteIds.add(remote.id);

              if (Array.isArray(remote.parents) && remote.parents.length > 0) {
                driveFileParentsCache.set(`${accountId}:${remote.id}`, remote.parents);
              }

              const sizeBytes = Number(remote.size || 0);
              const parentFolderPath =
                remote.parents?.map((p: string) => folderTree.folderPathById.get(p)).find(Boolean) || '/';
              const computedPath = parentFolderPath === '/' ? `/${remote.name}` : `${parentFolderPath}/${remote.name}`;
              const virtualPath = normalizeVirtualPath(
                remote.appProperties?.tsubasa_virtual_path || computedPath
              );
              const isOverCeiling = sizeBytes > MAX_SINGLE_FILE_BYTES;
              const remoteHash =
                remote.appProperties?.tsubasa_checksum || remote.md5Checksum || remote.sha256Checksum || null;

              if (isOverCeiling) {
                overCeiling.push({
                  driveFileId: remote.id,
                  name: remote.name,
                  virtualPath,
                  sizeBytes,
                  mimeType: remote.mimeType || 'application/octet-stream',
                  hash: remoteHash,
                  accountId,
                  discrepancyType: 'over_ceiling',
                });
                continue;
              }

              const occupantAtPath = activeFileByPath.get(virtualPath);
              if (occupantAtPath && occupantAtPath.driveFileId !== remote.id) {
                const ownerAcc = accountMap.get(occupantAtPath.accountId);
                const isExactDuplicate =
                  evaluateFileContentMatch(
                    sizeBytes,
                    [remote.appProperties?.tsubasa_checksum, remote.md5Checksum, remote.sha256Checksum],
                    occupantAtPath.sizeBytes,
                    occupantAtPath.hash
                  ) === 'identical';

                conflicts.push({
                  driveFileId: remote.id,
                  name: remote.name,
                  virtualPath,
                  sizeBytes,
                  mimeType: remote.mimeType || 'application/octet-stream',
                  hash: remoteHash,
                  modifiedTime: remote.modifiedTime || null,
                  accountId,
                  accountEmail: account.email,
                  accountDisplayName: account.displayName,
                  discrepancyType: 'conflict',
                  isExactDuplicate,
                  existingFile: {
                    fileId: occupantAtPath.id,
                    driveFileId: occupantAtPath.driveFileId,
                    accountId: occupantAtPath.accountId,
                    accountEmail: ownerAcc?.email || occupantAtPath.accountId,
                    accountDisplayName: ownerAcc?.displayName || occupantAtPath.accountId,
                    sizeBytes: occupantAtPath.sizeBytes,
                    hash: occupantAtPath.hash,
                    updatedAt: occupantAtPath.updatedAt ? new Date(occupantAtPath.updatedAt).toISOString() : null,
                  },
                });
                continue;
              }

              const existing = knownMapByDriveId.get(remote.id);
              if (!existing) {
                unindexed.push({
                  driveFileId: remote.id,
                  name: remote.name,
                  virtualPath,
                  sizeBytes,
                  mimeType: remote.mimeType || 'application/octet-stream',
                  hash: remoteHash,
                  accountId,
                  discrepancyType: 'unindexed',
                });
              } else if (
                (existing.sizeBytes !== sizeBytes || existing.virtualPath !== virtualPath) &&
                !pendingDriveIdsForAccount.has(remote.id)
              ) {
                modified.push({
                  driveFileId: remote.id,
                  name: remote.name,
                  virtualPath,
                  sizeBytes,
                  mimeType: remote.mimeType || 'application/octet-stream',
                  hash: remoteHash,
                  accountId,
                  discrepancyType: 'modified',
                });
              }
            }

            pageToken = listRes.data.nextPageToken || undefined;
          } while (pageToken);
        }
      })
    );

    const missingRemote: MissingFileDiscrepancy[] = [];
    for (const kf of knownFiles) {
      if (!foundRemoteIds.has(kf.driveFileId)) {
        missingRemote.push({
          fileId: kf.id,
          driveFileId: kf.driveFileId,
          virtualPath: kf.virtualPath,
          accountId,
        });
      }
    }

    const report: DiscrepancyReport = {
      accountId,
      poolFolderName: resolvePoolDriveFolderName(poolId),
      scannedFiles: foundRemoteIds.size,
      conflicts,
      unindexed,
      modified,
      overCeiling,
      missingRemote,
    };

    if ((scanGenerationByAccount.get(accountId) ?? 0) === startGen) {
      discrepancyCache.set(accountId, {
        report,
        expiresAt: Date.now() + DISCREPANCY_CACHE_TTL_MS,
      });
    }

    return report;
  })();

  inFlightScans.set(accountId, scanPromise);

  try {
    return await scanPromise;
  } finally {
    if (inFlightScans.get(accountId) === scanPromise) {
      inFlightScans.delete(accountId);
    }
  }
}

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
    const virtualPath = normalizeVirtualPath(fastVirtualPath);
    const fileName = preScanned?.name ? path.posix.basename(virtualPath) : path.posix.basename(virtualPath);
    const mimeType = preScanned?.mimeType ?? cachedItem?.mimeType ?? 'application/octet-stream';
    const hash = preScanned?.hash !== undefined ? preScanned.hash : (cachedItem?.hash ?? null);

    let committedFileId = driveFileId;

    sqlite.transaction(() => {
      const existingByDrive = sqlite
        .prepare('SELECT id FROM files WHERE drive_file_id = ? AND account_id = ? LIMIT 1')
        .get(driveFileId, accountId) as { id: string } | undefined;

      sqlite
        .prepare('DELETE FROM files WHERE drive_file_id = ? AND account_id = ?')
        .run(driveFileId, accountId);

      sqlite
        .prepare('UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1')
        .run(`${virtualPath}.trashed-${Date.now()}`, poolId, virtualPath);

      const candidateId = existingByDrive?.id ?? driveFileId;
      const idCollision = sqlite
        .prepare('SELECT id, drive_file_id, account_id FROM files WHERE id = ? LIMIT 1')
        .get(candidateId) as { id: string; drive_file_id: string; account_id: string } | undefined;

      committedFileId =
        idCollision && (idCollision.drive_file_id !== driveFileId || idCollision.account_id !== accountId)
          ? randomUUID()
          : candidateId;

      ensureLocalParentFolders(virtualPath, poolId);
      const parentDir = path.posix.dirname(virtualPath);
      const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

      upsertFileStmt.run(
        committedFileId,
        poolId,
        virtualPath,
        fileName,
        fastSizeBytes,
        mimeType,
        hash,
        accountId,
        driveFileId,
        folderId,
        0
      );

      getUpsertPendingDriveSyncStmt().run(accountId, driveFileId, virtualPath, committedFileId);
    })();

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
  const virtualPath = normalizeVirtualPath(finalVirtualPath);
  const fileName = path.posix.basename(virtualPath);
  const mimeType = remote.mimeType || 'application/octet-stream';
  const hash = remote.md5Checksum || null;

  let committedFileId = remoteId;

  sqlite.transaction(() => {
    const existingByDrive = sqlite
      .prepare('SELECT id FROM files WHERE drive_file_id = ? AND account_id = ? LIMIT 1')
      .get(remoteId, accountId) as { id: string } | undefined;

    sqlite
      .prepare('DELETE FROM files WHERE drive_file_id = ? AND account_id = ?')
      .run(remoteId, accountId);

    sqlite
      .prepare('UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1')
      .run(`${virtualPath}.trashed-${Date.now()}`, poolId, virtualPath);

    const candidateId = remote.appProperties?.tsubasa_virtual_id || existingByDrive?.id || remoteId;
    const idCollision = sqlite
      .prepare('SELECT id, drive_file_id, account_id FROM files WHERE id = ? LIMIT 1')
      .get(candidateId) as { id: string; drive_file_id: string; account_id: string } | undefined;
    committedFileId =
      idCollision && (idCollision.drive_file_id !== remoteId || idCollision.account_id !== accountId)
        ? randomUUID()
        : candidateId;

    ensureLocalParentFolders(virtualPath, poolId);
    const parentDir = path.posix.dirname(virtualPath);
    const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

    upsertFileStmt.run(
      committedFileId,
      poolId,
      virtualPath,
      fileName,
      sizeBytes,
      mimeType,
      hash,
      accountId,
      remoteId,
      folderId,
      0
    );

    getUpsertPendingDriveSyncStmt().run(accountId, remoteId, virtualPath, committedFileId);
  })();

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

interface AppPropertyStamp {
  driveFileId: string;
  virtualPath: string;
  fileId: string;
}

const DRIVE_BATCH_CONCURRENCY = 10;
const PENDING_SYNC_RETRY_DELAY_MS = 60_000;

async function stampAcceptedAppProperties(accountId: string, stamps: AppPropertyStamp[]): Promise<void> {
  try {
    const drive = getDriveClient(accountId);
    await runBoundedConcurrency(stamps, DRIVE_BATCH_CONCURRENCY, async (stamp) => {
      try {
        await withDriveRetry(() =>
          drive.files.update({
            fileId: stamp.driveFileId,
            requestBody: {
              appProperties: {
                tsubasa_managed: 'true',
                tsubasa_virtual_path: stamp.virtualPath,
                tsubasa_virtual_id: stamp.fileId,
              },
            },
            supportsAllDrives: false,
          })
        );
        getDeletePendingDriveSyncStmt().run(accountId, stamp.driveFileId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        getMarkPendingDriveSyncFailedStmt().run(
          message,
          Date.now() + PENDING_SYNC_RETRY_DELAY_MS,
          accountId,
          stamp.driveFileId
        );
        console.warn(`Failed to stamp appProperties on ${stamp.driveFileId} (${accountId}):`, err);
      } finally {
        pendingAppPropertyDriveIds.delete(stamp.driveFileId);
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const nextRetryAt = Date.now() + PENDING_SYNC_RETRY_DELAY_MS;
    console.warn(`Failed to initialize Drive client for appProperties stamp (${accountId}):`, err);
    for (const stamp of stamps) {
      getMarkPendingDriveSyncFailedStmt().run(message, nextRetryAt, accountId, stamp.driveFileId);
      pendingAppPropertyDriveIds.delete(stamp.driveFileId);
    }
  }
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

  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  const poolId = account?.poolId ?? 1;

  const selectIdByDriveIdStmt = sqlite.prepare(
    'SELECT id FROM files WHERE drive_file_id = ? AND account_id = ? LIMIT 1'
  );
  const deleteByDriveIdStmt = sqlite.prepare('DELETE FROM files WHERE drive_file_id = ? AND account_id = ?');
  const moveAsideTrashedStmt = sqlite.prepare(
    'UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1'
  );
  const selectIdOwnerStmt = sqlite.prepare('SELECT drive_file_id, account_id FROM files WHERE id = ? LIMIT 1');

  const stamps: AppPropertyStamp[] = [];
  const ensuredFolders = new Set<string>();

  const applyAccept = sqlite.transaction(() => {
    const trashSuffix = `.trashed-${Date.now()}`;
    for (const item of items) {
      const virtualPath = normalizeVirtualPath(item.virtualPath);

      const folderPaths = extractFolderPaths(virtualPath);
      for (let i = folderPaths.length - 1; i >= 0; i--) {
        if (ensuredFolders.has(folderPaths[i])) continue;
        insertFolderRecord(folderPaths[i], poolId);
        ensuredFolders.add(folderPaths[i]);
      }

      const existing = selectIdByDriveIdStmt.get(item.driveFileId, accountId) as { id: string } | undefined;
      deleteByDriveIdStmt.run(item.driveFileId, accountId);
      moveAsideTrashedStmt.run(`${virtualPath}${trashSuffix}`, poolId, virtualPath);

      let fileId = existing?.id ?? item.driveFileId;
      const owner = selectIdOwnerStmt.get(fileId) as { drive_file_id: string; account_id: string } | undefined;
      if (owner && (owner.drive_file_id !== item.driveFileId || owner.account_id !== accountId)) {
        fileId = randomUUID();
      }

      const parentDir = path.posix.dirname(virtualPath);
      const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

      upsertFileStmt.run(
        fileId,
        poolId,
        virtualPath,
        path.posix.basename(virtualPath),
        item.sizeBytes,
        item.mimeType,
        item.hash,
        accountId,
        item.driveFileId,
        folderId,
        0
      );

      getUpsertPendingDriveSyncStmt().run(accountId, item.driveFileId, virtualPath, fileId);
      pendingAppPropertyDriveIds.add(item.driveFileId);
      stamps.push({ driveFileId: item.driveFileId, virtualPath, fileId });
    }
  });

  applyAccept();

  const cachedReport = getCachedDiscrepancyReport(accountId);
  if (cachedReport) {
    cachedReport.unindexed = [];
    cachedReport.modified = [];
  }
  bumpScanGeneration(accountId);

  void stampAcceptedAppProperties(accountId, stamps);
  void refreshAccountLiveQuota(accountId).catch(() => {});

  return { acceptedCount: items.length };
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
    await ejectFileToDriveRoot(accountId, driveFileId);
    return { resolution: 'eject', accountId, driveFileId };
  }

  if (resolution === 'deduplicate') {
    const drive = getDriveClient(accountId);
    await withDriveRetry(() =>
      drive.files.update({
        fileId: driveFileId,
        requestBody: {
          trashed: true,
          appProperties: {
            tsubasa_managed: null,
            tsubasa_virtual_path: null,
            tsubasa_virtual_id: null,
          } as any,
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
          appProperties: {
            tsubasa_managed: 'true',
            tsubasa_virtual_path: newVirtualPath,
            tsubasa_virtual_id: fileId,
            tsubasa_checksum: checksum || '',
          },
        },
        supportsAllDrives: false,
      })
    );

    const newParentDir = path.posix.dirname(newVirtualPath);
    const folderId = newParentDir === '/' || newParentDir === '.' ? null : formatFolderId(poolId, newParentDir);

    sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM files WHERE drive_file_id = ? AND account_id = ?').run(remoteId, accountId);
      ensureLocalParentFolders(newVirtualPath, poolId);
      sqlite
        .prepare('UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1')
        .run(`${newVirtualPath}.trashed-${Date.now()}`, poolId, newVirtualPath);

      upsertFileStmt.run(
        fileId,
        poolId,
        newVirtualPath,
        newFileName,
        sizeBytes,
        mimeType,
        checksum,
        accountId,
        remoteId,
        folderId,
        0
      );
    })();

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

  // replace_existing
  const existingActive = await db.query.files.findFirst({
    where: and(eq(files.poolId, poolId), eq(files.virtualPath, baseVirtualPath), eq(files.isTrashed, false)),
  });

  if (existingActive && existingActive.driveFileId !== remoteId) {
    try {
      const prevDrive = getDriveClient(existingActive.accountId);
      await withDriveRetry(() =>
        prevDrive.files.update({
          fileId: existingActive.driveFileId,
          requestBody: {
            trashed: true,
            appProperties: {
              tsubasa_managed: null,
              tsubasa_virtual_path: null,
              tsubasa_virtual_id: null,
            } as any,
          },
          supportsAllDrives: false,
        })
      );
      await refreshAccountLiveQuota(existingActive.accountId).catch(() => {});
    } catch (err) {
      console.warn(
        `Failed to trash replaced Drive file ${existingActive.driveFileId} on ${existingActive.accountId}:`,
        err
      );
    }
  }

  const fileId = resolveNonCollidingFileId();
  const fileName = path.posix.basename(baseVirtualPath);
  const parentDir = path.posix.dirname(baseVirtualPath);
  const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

  await withDriveRetry(() =>
    drive.files.update({
      fileId: remoteId,
      requestBody: {
        name: fileName,
        appProperties: {
          tsubasa_managed: 'true',
          tsubasa_virtual_path: baseVirtualPath,
          tsubasa_virtual_id: fileId,
          tsubasa_checksum: checksum || '',
        },
      },
      supportsAllDrives: false,
    })
  );

  sqlite.transaction(() => {
    if (existingActive && existingActive.driveFileId !== remoteId) {
      sqlite.prepare('DELETE FROM files WHERE id = ?').run(existingActive.id);
    }
    sqlite.prepare('DELETE FROM files WHERE drive_file_id = ? AND account_id = ?').run(remoteId, accountId);
    sqlite
      .prepare('UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1')
      .run(`${baseVirtualPath}.trashed-${Date.now()}`, poolId, baseVirtualPath);
    ensureLocalParentFolders(baseVirtualPath, poolId);

    upsertFileStmt.run(
      fileId,
      poolId,
      baseVirtualPath,
      fileName,
      sizeBytes,
      mimeType,
      checksum,
      accountId,
      remoteId,
      folderId,
      0
    );
  })();

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
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);

  let candidateName = baseName;
  let candidatePath = normalizeVirtualPath(path.posix.join(targetDir, candidateName));
  let counter = 1;

  while (occupiedPaths.has(candidatePath)) {
    candidateName = counter === 1 ? `${stem} (copy)${ext}` : `${stem} (copy ${counter})${ext}`;
    candidatePath = normalizeVirtualPath(path.posix.join(targetDir, candidateName));
    counter++;
  }

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

          resolvedMetas.push({
            index: entry.index,
            driveFileId: remote.id,
            baseVirtualPath: normalizeVirtualPath(rawPath),
            sizeBytes: Number(remote.size || 0),
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
              appProperties: {
                tsubasa_managed: 'true',
                tsubasa_virtual_path: item.newVirtualPath,
                tsubasa_virtual_id: item.fileId,
                tsubasa_checksum: item.checksum || '',
              },
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
      const deleteByDriveIdStmt = sqlite.prepare('DELETE FROM files WHERE drive_file_id = ? AND account_id = ?');
      const moveAsideTrashedStmt = sqlite.prepare(
        'UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1'
      );
      const ensuredFolders = new Set<string>();
      const trashSuffix = `.trashed-${Date.now()}`;

      sqlite.transaction(() => {
        for (const item of succeededItems) {
          deleteByDriveIdStmt.run(item.driveFileId, accountId);

          const folderPaths = extractFolderPaths(item.newVirtualPath);
          for (let i = folderPaths.length - 1; i >= 0; i--) {
            if (ensuredFolders.has(folderPaths[i])) continue;
            insertFolderRecord(folderPaths[i], poolId);
            ensuredFolders.add(folderPaths[i]);
          }

          moveAsideTrashedStmt.run(`${item.newVirtualPath}${trashSuffix}`, poolId, item.newVirtualPath);

          const parentDir = path.posix.dirname(item.newVirtualPath);
          const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

          upsertFileStmt.run(
            item.fileId,
            poolId,
            item.newVirtualPath,
            item.newFileName,
            item.sizeBytes,
            item.mimeType,
            item.checksum,
            accountId,
            item.driveFileId,
            folderId,
            0
          );
        }
      })();

      for (const item of succeededItems) {
        removeDriveIdFromCachedReport(accountId, item.driveFileId);
      }
      bumpScanGeneration(accountId);
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
              appProperties: {
                tsubasa_managed: null,
                tsubasa_virtual_path: null,
                tsubasa_virtual_id: null,
              } as any,
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

export async function ejectFileToDriveRoot(accountId: string, driveFileId: string): Promise<void> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!account || !account.rootFolderId) {
    throw new Error(`Account ${accountId} does not have a registered root folder`);
  }

  const drive = getDriveClient(accountId);
  const cacheKey = `${accountId}:${driveFileId}`;
  let cachedParents = driveFileParentsCache.get(cacheKey);
  driveFileParentsCache.delete(cacheKey);

  if (!cachedParents) {
    const fileRes = await withDriveRetry(() =>
      drive.files.get({
        fileId: driveFileId,
        fields: 'parents',
        supportsAllDrives: false,
      })
    );
    cachedParents = fileRes.data.parents || [];
  }

  const parentsToRemove = cachedParents.join(',');

  await withDriveRetry(() =>
    drive.files.update({
      fileId: driveFileId,
      addParents: 'root',
      removeParents: parentsToRemove || account.rootFolderId!,
      requestBody: {
        appProperties: {
          tsubasa_managed: null,
          tsubasa_virtual_path: null,
          tsubasa_virtual_id: null,
        } as any,
      },
      supportsAllDrives: false,
    })
  );

  await db.delete(files).where(and(eq(files.driveFileId, driveFileId), eq(files.accountId, accountId)));
  removeDriveIdFromCachedReport(accountId, driveFileId);
  bumpScanGeneration(accountId);
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
          appProperties: {
            tsubasa_managed: null,
            tsubasa_virtual_path: null,
            tsubasa_virtual_id: null,
          } as any,
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


