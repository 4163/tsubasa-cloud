import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite } from '../db/index.js';
import { accounts, files, type Account, type FileRecord } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getDriveClient } from './client.js';
import { resolvePoolDriveFolderName } from './poolRegistry.js';
import { CLEARED_TSUBASA_APP_PROPERTIES, buildTsubasaAppProperties } from './appProperties.js';
import { resolveRemoteFolderTree } from './remoteTree.js';
import {
  evaluateFileContentMatch,
  ItemConflictError,
  withDriveRetry,
  runBoundedConcurrency,
} from './errors.js';
import { displaceTrashedFileAtPath } from './operationsDb.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import { MAX_SINGLE_FILE_BYTES } from '../storage/index.js';
import {
  ensureLocalParentFolders,
  insertFolderRecord,
  formatFolderId,
  extractFolderPaths,
  upsertFileStmt,
  pendingAppPropertyDriveIds,
} from './sync.js';
import { enqueueDriveOutbox, scheduleOutboxDrain } from './outbox.js';
import {
  DISCREPANCY_CACHE_TTL_MS,
  discrepancyCache,
  inFlightScans,
  scanGenerationByAccount,
  driveFileParentsCache,
  bumpScanGeneration,
  getCachedDiscrepancyReport,
  removeDriveIdFromCachedReport,
} from './discrepancyCache.js';

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

export interface AppPropertyStamp {
  driveFileId: string;
  virtualPath: string;
  fileId: string;
}

export interface CommitIndexedFileParams {
  poolId: number;
  accountId: string;
  driveFileId: string;
  virtualPath: string;
  fileName?: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  preferredFileId?: string;
  resolvedFileId?: string;
  trashSuffix?: string;
  ensuredFolders?: Set<string>;
  markPendingDriveSync?: boolean;
  replacedActiveFile?: { id: string; accountId: string; driveFileId: string } | null;
  enqueueTrashForReplaced?: boolean;
}

const SCAN_CHUNK_CONCURRENCY = 5;
export const DRIVE_BATCH_CONCURRENCY = 10;
const PENDING_SYNC_RETRY_DELAY_MS = 60_000;

let _upsertPendingDriveSyncStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getUpsertPendingDriveSyncStmt() {
  if (!_upsertPendingDriveSyncStmt) {
    _upsertPendingDriveSyncStmt = sqlite.prepare(`
      INSERT INTO pending_drive_sync (account_id, drive_file_id, virtual_path, file_id, attempts, last_error, next_retry_at)
      VALUES (?, ?, ?, ?, 0, NULL, ?)
      ON CONFLICT(account_id, drive_file_id) DO UPDATE SET
        virtual_path = excluded.virtual_path,
        file_id = excluded.file_id,
        attempts = 0,
        last_error = NULL,
        next_retry_at = excluded.next_retry_at
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

let _selectActiveByPathStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getSelectActiveByPathStmt() {
  if (!_selectActiveByPathStmt) {
    _selectActiveByPathStmt = sqlite.prepare(
      'SELECT id, account_id, drive_file_id FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 LIMIT 1'
    );
  }
  return _selectActiveByPathStmt as any;
}

let _selectIdByDriveIdStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getSelectIdByDriveIdStmt() {
  if (!_selectIdByDriveIdStmt) {
    _selectIdByDriveIdStmt = sqlite.prepare(
      'SELECT id FROM files WHERE drive_file_id = ? AND account_id = ? LIMIT 1'
    );
  }
  return _selectIdByDriveIdStmt as any;
}

let _deleteByDriveIdStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getDeleteByDriveIdStmt() {
  if (!_deleteByDriveIdStmt) {
    _deleteByDriveIdStmt = sqlite.prepare('DELETE FROM files WHERE drive_file_id = ? AND account_id = ?');
  }
  return _deleteByDriveIdStmt as any;
}

let _deleteByIdStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getDeleteByIdStmt() {
  if (!_deleteByIdStmt) {
    _deleteByIdStmt = sqlite.prepare('DELETE FROM files WHERE id = ?');
  }
  return _deleteByIdStmt as any;
}

let _selectIdOwnerStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getSelectIdOwnerStmt() {
  if (!_selectIdOwnerStmt) {
    _selectIdOwnerStmt = sqlite.prepare('SELECT id, drive_file_id, account_id FROM files WHERE id = ? LIMIT 1');
  }
  return _selectIdOwnerStmt as any;
}

export function upsertIndexedFileInCurrentTx(params: CommitIndexedFileParams): string {
  const {
    poolId,
    accountId,
    driveFileId,
    virtualPath,
    fileName,
    sizeBytes,
    mimeType,
    hash,
    preferredFileId,
    resolvedFileId,
    trashSuffix,
    ensuredFolders,
    markPendingDriveSync,
    replacedActiveFile,
    enqueueTrashForReplaced,
  } = params;

  if (replacedActiveFile && replacedActiveFile.driveFileId !== driveFileId) {
    getDeleteByIdStmt().run(replacedActiveFile.id);
    if (enqueueTrashForReplaced) {
      enqueueDriveOutbox([
        {
          accountId: replacedActiveFile.accountId,
          poolId,
          opType: 'file_trash',
          driveFileId: replacedActiveFile.driveFileId,
          payload: {
            fileId: replacedActiveFile.id,
            driveFileId: replacedActiveFile.driveFileId,
            clearAppProperties: true,
          },
        },
      ]);
    }
  }

  const activeOccupant = getSelectActiveByPathStmt().get(poolId, virtualPath) as
    | { id: string; account_id: string; drive_file_id: string }
    | undefined;
  if (
    activeOccupant &&
    (activeOccupant.account_id !== accountId || activeOccupant.drive_file_id !== driveFileId)
  ) {
    throw new ItemConflictError(`An active file already exists at "${virtualPath}"`);
  }

  const existingByDrive = resolvedFileId
    ? undefined
    : (getSelectIdByDriveIdStmt().get(driveFileId, accountId) as { id: string } | undefined);

  getDeleteByDriveIdStmt().run(driveFileId, accountId);
  displaceTrashedFileAtPath(poolId, virtualPath, { suffix: trashSuffix });

  if (ensuredFolders) {
    const folderPaths = extractFolderPaths(virtualPath);
    for (let i = folderPaths.length - 1; i >= 0; i--) {
      if (ensuredFolders.has(folderPaths[i])) continue;
      insertFolderRecord(folderPaths[i], poolId);
      ensuredFolders.add(folderPaths[i]);
    }
  } else {
    ensureLocalParentFolders(virtualPath, poolId);
  }

  let fileId = resolvedFileId;
  if (!fileId) {
    const candidateId = preferredFileId || existingByDrive?.id || driveFileId;
    const idCollision = getSelectIdOwnerStmt().get(candidateId) as
      | { id: string; drive_file_id: string; account_id: string }
      | undefined;
    fileId =
      idCollision && (idCollision.drive_file_id !== driveFileId || idCollision.account_id !== accountId)
        ? randomUUID()
        : candidateId;
  }

  const parentDir = path.posix.dirname(virtualPath);
  const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

  upsertFileStmt.run(
    fileId,
    poolId,
    virtualPath,
    fileName ?? path.posix.basename(virtualPath),
    sizeBytes,
    mimeType,
    hash,
    accountId,
    driveFileId,
    folderId,
    0
  );

  if (markPendingDriveSync) {
    // Grace window avoids racing the immediate background stampAcceptedAppProperties call.
    getUpsertPendingDriveSyncStmt().run(accountId, driveFileId, virtualPath, fileId, Date.now() + 30_000);
  }

  return fileId;
}

export function commitIndexedFileTx(params: CommitIndexedFileParams): string {
  return sqlite.transaction(() => upsertIndexedFileInCurrentTx(params))();
}

export async function stampAcceptedAppProperties(accountId: string, stamps: AppPropertyStamp[]): Promise<void> {
  let anyFailed = false;
  try {
    const drive = getDriveClient(accountId);
    await runBoundedConcurrency(stamps, DRIVE_BATCH_CONCURRENCY, async (stamp) => {
      try {
        await withDriveRetry(() =>
          drive.files.update({
            fileId: stamp.driveFileId,
            requestBody: {
              appProperties: buildTsubasaAppProperties({
                virtualPath: stamp.virtualPath,
                virtualId: stamp.fileId,
              }),
            },
            supportsAllDrives: false,
          })
        );
        getDeletePendingDriveSyncStmt().run(accountId, stamp.driveFileId);
      } catch (err) {
        anyFailed = true;
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
    if (anyFailed) {
      scheduleOutboxDrain(PENDING_SYNC_RETRY_DELAY_MS);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const nextRetryAt = Date.now() + PENDING_SYNC_RETRY_DELAY_MS;
    console.warn(`Failed to initialize Drive client for appProperties stamp (${accountId}):`, err);
    for (const stamp of stamps) {
      getMarkPendingDriveSyncFailedStmt().run(message, nextRetryAt, accountId, stamp.driveFileId);
      pendingAppPropertyDriveIds.delete(stamp.driveFileId);
    }
    if (stamps.length > 0) {
      scheduleOutboxDrain(PENDING_SYNC_RETRY_DELAY_MS);
    }
  }
}

export async function performEjectFileToDriveRoot(accountId: string, driveFileId: string): Promise<void> {
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
        appProperties: CLEARED_TSUBASA_APP_PROPERTIES as any,
      },
      supportsAllDrives: false,
    })
  );

  await db.delete(files).where(and(eq(files.driveFileId, driveFileId), eq(files.accountId, accountId)));
  removeDriveIdFromCachedReport(accountId, driveFileId);
  bumpScanGeneration(accountId);
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
                !pendingDriveIdsForAccount.has(remote.id) &&
                (existing.sizeBytes !== sizeBytes ||
                  existing.virtualPath !== virtualPath ||
                  evaluateFileContentMatch(
                    sizeBytes,
                    [remote.appProperties?.tsubasa_checksum, remote.md5Checksum, remote.sha256Checksum],
                    existing.sizeBytes,
                    existing.hash
                  ) === 'different')
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
