import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite } from '../db/index.js';
import { accounts, files, type Account, type FileRecord } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getDriveClient, resolveRemoteFolderTree, refreshAccountLiveQuota, resolvePoolDriveFolderName } from './client.js';
import { normalizeVirtualPath } from './mirror.js';
import { MAX_SINGLE_FILE_BYTES } from '../storage/index.js';
import {
  ensureLocalFolderHierarchy,
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

function normalizeHash(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/^(sha256-|md5-)/, '');
  return cleaned || null;
}

function isExactDuplicateMatch(
  remoteSize: number,
  remoteHashes: Array<string | null | undefined>,
  localSize: number,
  localHash: string | null
): boolean {
  if (remoteSize !== localSize) return false;

  const normLocal = normalizeHash(localHash);
  const remoteSet = new Set<string>();
  for (const h of remoteHashes) {
    const nh = normalizeHash(h);
    if (nh) remoteSet.add(nh);
  }

  if (remoteSize === 0 && !normLocal && remoteSet.size === 0) {
    return true;
  }

  if (normLocal && remoteSet.has(normLocal)) {
    return true;
  }

  return false;
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
  }

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

    // Sync discovered remote folders into SQLite folders table in one transaction
    if (folderTree.folders.length > 0) {
      sqlite.transaction(() => {
        for (const folder of folderTree.folders) {
          insertFolderRecord(folder.virtualPath, poolId);
        }
      })();
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
            const listRes: any = await drive.files.list({
              q: `(${parentQuery}) and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
              fields: 'nextPageToken, files(id, name, size, mimeType, md5Checksum, sha256Checksum, modifiedTime, parents, appProperties)',
              pageSize: 1000,
              pageToken,
              spaces: 'drive',
              supportsAllDrives: false,
            });

            for (const remote of listRes.data.files || []) {
              if (!remote.id || !remote.name) continue;
              foundRemoteIds.add(remote.id);

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
                const isExactDuplicate = isExactDuplicateMatch(
                  sizeBytes,
                  [remote.appProperties?.tsubasa_checksum, remote.md5Checksum, remote.sha256Checksum],
                  occupantAtPath.sizeBytes,
                  occupantAtPath.hash
                );

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
              } else if (existing.sizeBytes !== sizeBytes || existing.virtualPath !== virtualPath) {
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

    discrepancyCache.set(accountId, {
      report,
      expiresAt: Date.now() + DISCREPANCY_CACHE_TTL_MS,
    });

    return report;
  })();

  if (!forceRefresh) {
    inFlightScans.set(accountId, scanPromise);
  }

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

      ensureLocalFolderHierarchy(virtualPath, poolId);
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
    })();

    pendingAppPropertyDriveIds.add(driveFileId);
    void stampAcceptedAppProperties(accountId, [
      { driveFileId, virtualPath, fileId: committedFileId },
    ]);
    removeDriveIdFromCachedReport(accountId, driveFileId);

    const inserted = await db.query.files.findFirst({ where: eq(files.id, committedFileId) });
    if (!inserted) {
      throw new Error(`Failed to load accepted file ${committedFileId}`);
    }
    return inserted;
  }

  const drive = getDriveClient(accountId);
  const fileRes = await drive.files.get({
    fileId: driveFileId,
    fields: 'id, name, size, mimeType, md5Checksum, parents, appProperties',
    supportsAllDrives: false,
  });

  const remote = fileRes.data;
  if (!remote.id || !remote.name) {
    throw new Error(`File ${driveFileId} not found in Google Drive`);
  }

  let finalVirtualPath = targetVirtualPath || remote.appProperties?.tsubasa_virtual_path;
  if (!finalVirtualPath) {
    if (account?.rootFolderId) {
      const folderTree = await resolveRemoteFolderTree(drive, account.rootFolderId);
      const parentFolderPath = remote.parents?.map((p: string) => folderTree.folderPathById.get(p)).find(Boolean) || '/';
      finalVirtualPath = parentFolderPath === '/' ? `/${remote.name}` : `${parentFolderPath}/${remote.name}`;
    } else {
      finalVirtualPath = `/${remote.name}`;
    }
  }

  const sizeBytes = Number(remote.size || 0);
  const virtualPath = normalizeVirtualPath(finalVirtualPath);
  const fileName = path.posix.basename(virtualPath);

  sqlite
    .prepare('UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1')
    .run(`${virtualPath}.trashed-${Date.now()}`, poolId, virtualPath);

  const candidateId = remote.appProperties?.tsubasa_virtual_id || remote.id;
  const idCollision = sqlite
    .prepare('SELECT id, drive_file_id, account_id FROM files WHERE id = ? LIMIT 1')
    .get(candidateId) as { id: string; drive_file_id: string; account_id: string } | undefined;
  const fileId =
    idCollision && (idCollision.drive_file_id !== remote.id || idCollision.account_id !== accountId)
      ? randomUUID()
      : candidateId;

  ensureLocalFolderHierarchy(virtualPath, poolId);
  const parentDir = path.posix.dirname(virtualPath);
  const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

  pendingAppPropertyDriveIds.add(remote.id);
  void stampAcceptedAppProperties(accountId, [{ driveFileId: remote.id, virtualPath, fileId }]);

  const inserted = await db
    .insert(files)
    .values({
      id: fileId,
      poolId,
      virtualPath,
      name: fileName,
      sizeBytes,
      mimeType: remote.mimeType || 'application/octet-stream',
      hash: remote.md5Checksum || null,
      accountId,
      driveFileId: remote.id,
      folderId,
      isTrashed: false,
    })
    .onConflictDoUpdate({
      target: [files.poolId, files.virtualPath],
      set: {
        name: fileName,
        sizeBytes,
        mimeType: remote.mimeType || 'application/octet-stream',
        hash: remote.md5Checksum || null,
        accountId,
        driveFileId: remote.id,
        folderId,
        isTrashed: false,
        updatedAt: new Date(),
      },
    })
    .returning();

  removeDriveIdFromCachedReport(accountId, driveFileId);
  return inserted[0];
}

interface AppPropertyStamp {
  driveFileId: string;
  virtualPath: string;
  fileId: string;
}

const DRIVE_BATCH_CONCURRENCY = 10;

async function runWithConcurrency<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const lanes = Array.from({ length: Math.min(DRIVE_BATCH_CONCURRENCY, items.length) }, async () => {
    while (nextIndex < items.length) {
      await worker(items[nextIndex++]);
    }
  });
  await Promise.all(lanes);
}

async function stampAcceptedAppProperties(accountId: string, stamps: AppPropertyStamp[]): Promise<void> {
  try {
    const drive = getDriveClient(accountId);
    await runWithConcurrency(stamps, async (stamp) => {
      try {
        await drive.files.update({
          fileId: stamp.driveFileId,
          requestBody: {
            appProperties: {
              tsubasa_managed: 'true',
              tsubasa_virtual_path: stamp.virtualPath,
              tsubasa_virtual_id: stamp.fileId,
            },
          },
          supportsAllDrives: false,
        });
      } catch (err) {
        console.warn(`Failed to stamp appProperties on ${stamp.driveFileId} (${accountId}):`, err);
      } finally {
        pendingAppPropertyDriveIds.delete(stamp.driveFileId);
      }
    });
  } catch (err) {
    console.warn(`Failed to initialize Drive client for appProperties stamp (${accountId}):`, err);
    for (const stamp of stamps) {
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

  await runWithConcurrency(items, async (item) => {
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

  void stampAcceptedAppProperties(accountId, stamps);

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
    await drive.files.update({
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
    });
    await db.delete(files).where(and(eq(files.driveFileId, driveFileId), eq(files.accountId, accountId)));
    await refreshAccountLiveQuota(accountId).catch(() => {});
    removeDriveIdFromCachedReport(accountId, driveFileId);
    return { resolution: 'deduplicate', accountId, driveFileId };
  }

  const drive = getDriveClient(accountId);
  const fileRes = await drive.files.get({
    fileId: driveFileId,
    fields: 'id, name, size, mimeType, md5Checksum, sha256Checksum, parents, appProperties',
    supportsAllDrives: false,
  });

  const remote = fileRes.data;
  if (!remote.id || !remote.name) {
    throw new Error(`File ${driveFileId} not found in Google Drive`);
  }

  let rawPath = targetVirtualPath || remote.appProperties?.tsubasa_virtual_path;
  if (!rawPath) {
    if (account.rootFolderId) {
      const folderTree = await resolveRemoteFolderTree(drive, account.rootFolderId);
      const parentFolderPath =
        remote.parents?.map((p: string) => folderTree.folderPathById.get(p)).find(Boolean) || '/';
      rawPath = parentFolderPath === '/' ? `/${remote.name}` : `${parentFolderPath}/${remote.name}`;
    } else {
      rawPath = `/${remote.name}`;
    }
  }

  const baseVirtualPath = normalizeVirtualPath(rawPath);
  const sizeBytes = Number(remote.size || 0);
  const checksum = remote.appProperties?.tsubasa_checksum || remote.md5Checksum || remote.sha256Checksum || null;

  const resolveNonCollidingFileId = (): string => {
    const candidateId = remote.appProperties?.tsubasa_virtual_id;
    if (!candidateId) return randomUUID();
    const idCollision = sqlite
      .prepare('SELECT id, drive_file_id, account_id FROM files WHERE id = ? LIMIT 1')
      .get(candidateId) as { id: string; drive_file_id: string; account_id: string } | undefined;
    if (!idCollision || (idCollision.drive_file_id === remote.id && idCollision.account_id === accountId)) {
      return candidateId;
    }
    return randomUUID();
  };

  if (resolution === 'keep_both') {
    const parentDir = path.posix.dirname(baseVirtualPath);
    const baseName = path.posix.basename(baseVirtualPath);
    const newVirtualPath = await getAvailableCopyPath(parentDir, baseName, 'file', poolId);
    const newFileName = path.posix.basename(newVirtualPath);

    await db.delete(files).where(and(eq(files.driveFileId, remote.id), eq(files.accountId, accountId)));
    const fileId = resolveNonCollidingFileId();

    await drive.files.update({
      fileId: remote.id,
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
    });

    ensureLocalFolderHierarchy(newVirtualPath, poolId);
    const newParentDir = path.posix.dirname(newVirtualPath);
    const folderId = newParentDir === '/' || newParentDir === '.' ? null : formatFolderId(poolId, newParentDir);

    sqlite
      .prepare('UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1')
      .run(`${newVirtualPath}.trashed-${Date.now()}`, poolId, newVirtualPath);

    const inserted = await db
      .insert(files)
      .values({
        id: fileId,
        poolId,
        virtualPath: newVirtualPath,
        name: newFileName,
        sizeBytes,
        mimeType: remote.mimeType || 'application/octet-stream',
        hash: checksum,
        accountId,
        driveFileId: remote.id,
        folderId,
        isTrashed: false,
      })
      .returning();

    removeDriveIdFromCachedReport(accountId, driveFileId);
    return {
      resolution: 'keep_both',
      accountId,
      driveFileId,
      virtualPath: newVirtualPath,
      file: inserted[0],
    };
  }

  // replace_existing
  const existingActive = await db.query.files.findFirst({
    where: and(eq(files.poolId, poolId), eq(files.virtualPath, baseVirtualPath), eq(files.isTrashed, false)),
  });

  if (existingActive && existingActive.driveFileId !== remote.id) {
    try {
      const prevDrive = getDriveClient(existingActive.accountId);
      await prevDrive.files.update({
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
      });
      await refreshAccountLiveQuota(existingActive.accountId).catch(() => {});
    } catch (err) {
      console.warn(
        `Failed to trash replaced Drive file ${existingActive.driveFileId} on ${existingActive.accountId}:`,
        err
      );
    }
    await db.delete(files).where(eq(files.id, existingActive.id));
  }

  await db.delete(files).where(and(eq(files.driveFileId, remote.id), eq(files.accountId, accountId)));
  const fileId = resolveNonCollidingFileId();

  sqlite
    .prepare('UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1')
    .run(`${baseVirtualPath}.trashed-${Date.now()}`, poolId, baseVirtualPath);

  const fileName = path.posix.basename(baseVirtualPath);
  ensureLocalFolderHierarchy(baseVirtualPath, poolId);
  const parentDir = path.posix.dirname(baseVirtualPath);
  const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

  await drive.files.update({
    fileId: remote.id,
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
  });

  const inserted = await db
    .insert(files)
    .values({
      id: fileId,
      poolId,
      virtualPath: baseVirtualPath,
      name: fileName,
      sizeBytes,
      mimeType: remote.mimeType || 'application/octet-stream',
      hash: checksum,
      accountId,
      driveFileId: remote.id,
      folderId,
      isTrashed: false,
    })
    .onConflictDoUpdate({
      target: [files.poolId, files.virtualPath],
      set: {
        name: fileName,
        sizeBytes,
        mimeType: remote.mimeType || 'application/octet-stream',
        hash: checksum,
        accountId,
        driveFileId: remote.id,
        folderId,
        isTrashed: false,
        updatedAt: new Date(),
      },
    })
    .returning();

  removeDriveIdFromCachedReport(accountId, driveFileId);
  return {
    resolution: 'replace_existing',
    accountId,
    driveFileId,
    virtualPath: baseVirtualPath,
    file: inserted[0],
  };
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

  const results: Array<{
    driveFileId: string;
    success: boolean;
    virtualPath?: string;
    error?: string;
  }> = new Array(items.length);

  if (resolution === 'keep_both') {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const res = await resolvePathConflict(accountId, item.driveFileId, 'keep_both', item.targetVirtualPath);
        results[i] = {
          driveFileId: item.driveFileId,
          success: true,
          virtualPath: res.virtualPath,
        };
      } catch (err) {
        results[i] = {
          driveFileId: item.driveFileId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  } else {
    let nextIndex = 0;
    const workerCount = Math.min(DRIVE_BATCH_CONCURRENCY, items.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
          const i = nextIndex++;
          const item = items[i];
          try {
            const res = await resolvePathConflict(
              accountId,
              item.driveFileId,
              'deduplicate',
              item.targetVirtualPath
            );
            results[i] = {
              driveFileId: item.driveFileId,
              success: true,
              virtualPath: res.virtualPath,
            };
          } catch (err) {
            results[i] = {
              driveFileId: item.driveFileId,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      })
    );
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

  const fileRes = await drive.files.get({
    fileId: driveFileId,
    fields: 'parents',
    supportsAllDrives: false,
  });

  const parentsToRemove = (fileRes.data.parents || []).join(',');

  await drive.files.update({
    fileId: driveFileId,
    addParents: 'root',
    removeParents: parentsToRemove || account.rootFolderId,
    requestBody: {
      appProperties: {
        tsubasa_managed: null,
        tsubasa_virtual_path: null,
        tsubasa_virtual_id: null,
      } as any,
    },
    supportsAllDrives: false,
  });

  await db.delete(files).where(and(eq(files.driveFileId, driveFileId), eq(files.accountId, accountId)));
  removeDriveIdFromCachedReport(accountId, driveFileId);
}

export async function removeMissingFile(accountId: string, driveFileId: string): Promise<void> {
  await db.delete(files).where(and(eq(files.driveFileId, driveFileId), eq(files.accountId, accountId)));
  removeDriveIdFromCachedReport(accountId, driveFileId);

  try {
    const drive = getDriveClient(accountId);
    void drive.files
      .update({
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
      .catch(() => {
        // Non-fatal if the file was deleted from Drive entirely
      });
  } catch {
    // Non-fatal if the account is unavailable
  }
}


