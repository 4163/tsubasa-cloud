import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { drive_v3 } from 'googleapis';
import { bumpPoolRevision, buildDirectoryPrefixBounds, sqlite } from '../db/index.js';
import {
  InsufficientStorageError,
  invalidatePooledStorageOverview,
  planBatchPlacement,
  recordTransferSync,
} from '../storage/index.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import { buildTsubasaAppProperties } from './appProperties.js';
import { getDriveClient } from './client.js';
import { copyDriveFileCrossAccount } from './crossAccountCopy.js';
import { invalidateDiscrepancyCache } from './discrepancyCache.js';
import {
  getDriveErrorStatus,
  isDriveNotFoundError,
  ItemNotFoundError,
  MoveConflictError,
  runBoundedConcurrency,
  withDriveRetry,
  type MoveConflictItem,
} from './errors.js';
import { ensureRemoteFolderHierarchy } from './mirror.js';
import {
  allocateUniqueVirtualPath,
  displaceTrashedFileAtPath,
} from './operationsDb.js';
import type { MoveConflictMode } from './operationsMovePlan.js';
import { enqueueDriveOutbox } from './outbox.js';
import { deleteRemoteFileIgnoreNotFound } from './outboxExecutors.js';
import { isSharePoolId } from './poolRegistry.js';
import { getAccountRootFolderId } from './remoteTree.js';
import { ensureLocalParentFolders, formatFolderId } from './sync.js';
import { SharePoolReadOnlyError, UploadValidationError } from './transfer.js';

const MD5_HEX_RE = /^[a-f0-9]{32}$/i;
const ACL_PROPAGATION_BACKOFF_MS = [300, 800, 1_500, 2_500];
const COPY_CONCURRENCY = 4;

const activeCrossPoolMoveJobs = new Map<string, Promise<CrossPoolMoveResult>>();
const cancelledCrossPoolMoveJobs = new Set<string>();

function normalizeMd5(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return MD5_HEX_RE.test(trimmed) ? trimmed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureFolderShareForJob(params: {
  jobId: string;
  sourceAccountId: string;
  sourceFolderId: string;
  targetAccountId: string;
  targetAccountEmail: string;
}): Promise<string> {
  const { jobId, sourceAccountId, sourceFolderId, targetAccountId, targetAccountEmail } = params;

  const existing = sqlite
    .prepare(
      `SELECT permission_id as permissionId
       FROM transfer_job_shares
       WHERE job_id = ? AND source_folder_id = ? AND target_account_id = ? AND revoked_at IS NULL
       LIMIT 1`
    )
    .get(jobId, sourceFolderId, targetAccountId) as { permissionId: string } | undefined;

  if (existing) {
    return existing.permissionId;
  }

  const driveSource = getDriveClient(sourceAccountId);
  const shareRes = await withDriveRetry(() =>
    driveSource.permissions.create({
      fileId: sourceFolderId,
      sendNotificationEmail: false,
      requestBody: {
        role: 'reader',
        type: 'user',
        emailAddress: targetAccountEmail,
      },
      supportsAllDrives: false,
    })
  );

  const permissionId = shareRes.data.id;
  if (!permissionId) {
    throw new Error(`Google Drive did not return a permission ID when sharing folder ${sourceFolderId}`);
  }

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO transfer_job_shares (
        job_id, source_folder_id, target_account_id, permission_id, source_account_id, created_at
      ) VALUES (?, ?, ?, ?, ?, unixepoch())`
    )
    .run(jobId, sourceFolderId, targetAccountId, permissionId, sourceAccountId);

  return permissionId;
}

export async function revokeJobShares(jobId: string): Promise<{ revokedCount: number; failedCount: number }> {
  const shares = sqlite
    .prepare(
      `SELECT source_folder_id as sourceFolderId,
              target_account_id as targetAccountId,
              permission_id as permissionId,
              source_account_id as sourceAccountId
       FROM transfer_job_shares
       WHERE job_id = ? AND revoked_at IS NULL`
    )
    .all(jobId) as Array<{
    sourceFolderId: string;
    targetAccountId: string;
    permissionId: string;
    sourceAccountId: string | null;
  }>;

  let revokedCount = 0;
  let failedCount = 0;

  const markRevokedStmt = sqlite.prepare(
    `UPDATE transfer_job_shares
     SET revoked_at = unixepoch()
     WHERE job_id = ? AND source_folder_id = ? AND target_account_id = ? AND permission_id = ?`
  );

  for (const share of shares) {
    if (!share.sourceAccountId) {
      continue;
    }
    try {
      const driveSource = getDriveClient(share.sourceAccountId);
      await withDriveRetry(() =>
        driveSource.permissions.delete({
          fileId: share.sourceFolderId,
          permissionId: share.permissionId,
          supportsAllDrives: false,
        })
      );
      markRevokedStmt.run(jobId, share.sourceFolderId, share.targetAccountId, share.permissionId);
      revokedCount += 1;
    } catch (err) {
      if (isDriveNotFoundError(err)) {
        markRevokedStmt.run(jobId, share.sourceFolderId, share.targetAccountId, share.permissionId);
        revokedCount += 1;
      } else {
        failedCount += 1;
        console.warn(
          `Failed to revoke temporary permission ${share.permissionId} on folder ${share.sourceFolderId} (job ${jobId}):`,
          err
        );
      }
    }
  }

  return { revokedCount, failedCount };
}

export async function copyDriveFileWithAclRetry(params: {
  driveTarget: drive_v3.Drive;
  sourceDriveFileId: string;
  targetRemoteFolderId: string;
  destFileName: string;
  appProperties: Record<string, string>;
}): Promise<{ id: string; size: number | null; md5Checksum: string | null }> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= ACL_PROPAGATION_BACKOFF_MS.length; attempt += 1) {
    try {
      const res = await withDriveRetry(() =>
        params.driveTarget.files.copy({
          fileId: params.sourceDriveFileId,
          requestBody: {
            name: params.destFileName,
            parents: [params.targetRemoteFolderId],
            appProperties: params.appProperties,
          },
          fields: 'id, name, size, md5Checksum',
          supportsAllDrives: false,
        })
      );
      const id = res.data.id;
      if (!id) {
        throw new Error('Google Drive copy returned an empty file ID');
      }
      const parsedSize = res.data.size !== undefined && res.data.size !== null ? Number(res.data.size) : null;
      return {
        id,
        size: parsedSize !== null && Number.isFinite(parsedSize) ? parsedSize : null,
        md5Checksum: res.data.md5Checksum ? res.data.md5Checksum.toLowerCase() : null,
      };
    } catch (err) {
      lastErr = err;
      const status = getDriveErrorStatus(err);
      if (status === 404 && attempt < ACL_PROPAGATION_BACKOFF_MS.length) {
        await sleep(ACL_PROPAGATION_BACKOFF_MS[attempt]);
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}

export interface CrossPoolMoveTarget {
  kind?: 'file' | 'folder';
  id?: string;
  path?: string;
}

export interface CrossPoolMoveOptions {
  sourcePoolId: number;
  destPoolId: number;
  items: CrossPoolMoveTarget[];
  destDir?: string;
  destPath?: string;
  conflictMode?: MoveConflictMode;
  wait?: boolean;
}

export interface CrossPoolMoveResult {
  jobId: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  sourcePoolId: number;
  destPoolId: number;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  skippedItems: number;
  totalBytes: number;
  transferredBytes: number;
  queued: boolean;
  lastError?: string | null;
}

interface ResolvedSourceFile {
  id: string;
  virtualPath: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  accountId: string;
  driveFileId: string;
  destVirtualPath: string;
}

interface CrossPoolMoveJobMeta {
  sourceFolderPaths: string[];
  destFolderPaths: string[];
  conflictMode: MoveConflictMode;
}

function allocateCrossPoolKeepBothPath(
  destPoolId: number,
  basePath: string,
  reservedPaths: Set<string>
): string {
  const checkActiveStmt = sqlite.prepare(
    'SELECT 1 FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 LIMIT 1'
  );
  const checkFolderStmt = sqlite.prepare(
    'SELECT 1 FROM folders WHERE pool_id = ? AND virtual_path = ? LIMIT 1'
  );
  const allocated = allocateUniqueVirtualPath({
    targetDir: path.posix.dirname(basePath),
    baseName: path.posix.basename(basePath),
    kind: 'file',
    style: 'numbered',
    startCounter: 1,
    isTaken: (candidate) =>
      reservedPaths.has(candidate) ||
      Boolean(checkActiveStmt.get(destPoolId, candidate)) ||
      Boolean(checkFolderStmt.get(destPoolId, candidate)),
  });
  reservedPaths.add(allocated);
  return allocated;
}

function resolveCrossPoolSourceItems(options: CrossPoolMoveOptions): {
  filesToMove: ResolvedSourceFile[];
  sourceFolderPaths: string[];
  destFolderPaths: string[];
} {
  const { sourcePoolId, items } = options;
  const destDir = normalizeVirtualPath(options.destDir || '/');
  const explicitDestPath = options.destPath ? normalizeVirtualPath(options.destPath) : null;

  if (explicitDestPath && items.length > 1) {
    throw new UploadValidationError('destPath can only be specified when moving a single item');
  }

  const filesById = new Map<string, ResolvedSourceFile>();
  const sourceFolderPaths = new Set<string>();
  const destFolderPaths = new Set<string>();

  const getFileById = sqlite.prepare(
    `SELECT id, virtual_path as virtualPath, name, size_bytes as sizeBytes, mime_type as mimeType,
            hash, account_id as accountId, drive_file_id as driveFileId
     FROM files WHERE id = ? AND pool_id = ? AND is_trashed = 0 LIMIT 1`
  );
  const getFileByPath = sqlite.prepare(
    `SELECT id, virtual_path as virtualPath, name, size_bytes as sizeBytes, mime_type as mimeType,
            hash, account_id as accountId, drive_file_id as driveFileId
     FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 LIMIT 1`
  );
  const getFolderById = sqlite.prepare(
    `SELECT id, virtual_path as virtualPath, name FROM folders WHERE id = ? AND pool_id = ? LIMIT 1`
  );
  const getFolderByPath = sqlite.prepare(
    `SELECT id, virtual_path as virtualPath, name FROM folders WHERE pool_id = ? AND virtual_path = ? LIMIT 1`
  );

  for (const target of items) {
    let fileRow:
      | {
          id: string;
          virtualPath: string;
          name: string;
          sizeBytes: number;
          mimeType: string;
          hash: string | null;
          accountId: string;
          driveFileId: string;
        }
      | undefined;
    let folderRow: { id: string; virtualPath: string; name: string } | undefined;

    if (target.id) {
      if (target.kind !== 'folder') {
        fileRow = getFileById.get(target.id, sourcePoolId) as typeof fileRow;
      }
      if (!fileRow && target.kind !== 'file') {
        folderRow = getFolderById.get(target.id, sourcePoolId) as typeof folderRow;
      }
    } else if (target.path) {
      const normPath = normalizeVirtualPath(target.path);
      if (normPath === '/') {
        throw new UploadValidationError('Cannot move root directory "/" across pools');
      }
      if (target.kind !== 'folder') {
        fileRow = getFileByPath.get(sourcePoolId, normPath) as typeof fileRow;
      }
      if (!fileRow && target.kind !== 'file') {
        folderRow = getFolderByPath.get(sourcePoolId, normPath) as typeof folderRow;
      }
    } else {
      throw new UploadValidationError('Each cross-pool move item requires id or path');
    }

    if (fileRow) {
      const destVirtualPath = explicitDestPath
        ? explicitDestPath
        : normalizeVirtualPath(path.posix.join(destDir, fileRow.name));
      if (destVirtualPath === '/') {
        throw new UploadValidationError('Destination file path cannot be root "/"');
      }
      filesById.set(fileRow.id, { ...fileRow, destVirtualPath });
      continue;
    }

    if (folderRow) {
      const srcPrefix = normalizeVirtualPath(folderRow.virtualPath);
      const destFolderRoot = explicitDestPath
        ? explicitDestPath
        : normalizeVirtualPath(path.posix.join(destDir, folderRow.name));
      if (destFolderRoot === '/') {
        throw new UploadValidationError('Destination folder path cannot be root "/"');
      }

      sourceFolderPaths.add(srcPrefix);
      destFolderPaths.add(destFolderRoot);

      const { lower, upper } = buildDirectoryPrefixBounds(srcPrefix);
      const descendantFolders = sqlite
        .prepare(
          `SELECT virtual_path as virtualPath FROM folders
           WHERE pool_id = ? AND virtual_path >= ? AND virtual_path < ?`
        )
        .all(sourcePoolId, lower, upper) as Array<{ virtualPath: string }>;

      for (const df of descendantFolders) {
        sourceFolderPaths.add(df.virtualPath);
        const rel = df.virtualPath.slice(srcPrefix.length);
        destFolderPaths.add(normalizeVirtualPath(`${destFolderRoot}${rel}`));
      }

      const descendantFiles = sqlite
        .prepare(
          `SELECT id, virtual_path as virtualPath, name, size_bytes as sizeBytes, mime_type as mimeType,
                  hash, account_id as accountId, drive_file_id as driveFileId
           FROM files
           WHERE pool_id = ? AND is_trashed = 0 AND virtual_path >= ? AND virtual_path < ?
           ORDER BY virtual_path ASC`
        )
        .all(sourcePoolId, lower, upper) as Array<{
        id: string;
        virtualPath: string;
        name: string;
        sizeBytes: number;
        mimeType: string;
        hash: string | null;
        accountId: string;
        driveFileId: string;
      }>;

      for (const df of descendantFiles) {
        const rel = df.virtualPath.slice(srcPrefix.length);
        const mappedDest = normalizeVirtualPath(`${destFolderRoot}${rel}`);
        filesById.set(df.id, { ...df, destVirtualPath: mappedDest });
      }
      continue;
    }

    throw new ItemNotFoundError(
      `Item '${target.id ?? target.path}' not found in pool ${sourcePoolId}`
    );
  }

  return {
    filesToMove: Array.from(filesById.values()),
    sourceFolderPaths: Array.from(sourceFolderPaths),
    destFolderPaths: Array.from(destFolderPaths),
  };
}

function readCrossPoolMoveResult(jobId: string, queued = false): CrossPoolMoveResult {
  const row = sqlite
    .prepare(
      `SELECT id, status, source_pool_id as sourcePoolId, pool_id as destPoolId,
              total_items as totalItems, completed_items as completedItems,
              failed_items as failedItems, skipped_items as skippedItems,
              total_bytes as totalBytes, transferred_bytes as transferredBytes,
              last_error as lastError
       FROM transfer_jobs
       WHERE id = ? AND kind = 'cross_pool_move'
       LIMIT 1`
    )
    .get(jobId) as
    | {
        id: string;
        status: CrossPoolMoveResult['status'];
        sourcePoolId: number | null;
        destPoolId: number | null;
        totalItems: number;
        completedItems: number;
        failedItems: number;
        skippedItems: number;
        totalBytes: number;
        transferredBytes: number;
        lastError: string | null;
      }
    | undefined;

  if (!row) {
    throw new ItemNotFoundError(`Cross-pool move job '${jobId}' not found`);
  }

  return {
    jobId: row.id,
    status: row.status,
    sourcePoolId: row.sourcePoolId ?? 1,
    destPoolId: row.destPoolId ?? 1,
    totalItems: row.totalItems,
    completedItems: row.completedItems,
    failedItems: row.failedItems,
    skippedItems: row.skippedItems,
    totalBytes: row.totalBytes,
    transferredBytes: row.transferredBytes,
    queued,
    lastError: row.lastError,
  };
}

function syncJobCounters(jobId: string): {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  transferredBytes: number;
} {
  const rows = sqlite
    .prepare(
      `SELECT status, COUNT(*) as cnt, COALESCE(SUM(transferred_bytes), 0) as bytes
       FROM transfer_job_items
       WHERE job_id = ?
       GROUP BY status`
    )
    .all(jobId) as Array<{ status: string; cnt: number; bytes: number }>;

  const counts = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    transferredBytes: 0,
  };

  for (const r of rows) {
    const cnt = Number(r.cnt);
    if (r.status === 'pending') counts.pending = cnt;
    else if (r.status === 'running') counts.running = cnt;
    else if (r.status === 'completed') {
      counts.completed = cnt;
      counts.transferredBytes += Number(r.bytes);
    } else if (r.status === 'failed') counts.failed = cnt;
    else if (r.status === 'skipped') counts.skipped = cnt;
    else if (r.status === 'cancelled') counts.cancelled = cnt;
  }

  sqlite
    .prepare(
      `UPDATE transfer_jobs
       SET completed_items = ?, failed_items = ?, skipped_items = ?, transferred_bytes = ?, updated_at = unixepoch()
       WHERE id = ?`
    )
    .run(counts.completed, counts.failed, counts.skipped, counts.transferredBytes, jobId);

  return counts;
}

async function executeCrossPoolMoveJobInternal(jobId: string): Promise<CrossPoolMoveResult> {
  const job = sqlite
    .prepare(
      `SELECT id, status, source_pool_id as sourcePoolId, pool_id as destPoolId,
              conflict_policy as conflictPolicy, metadata_json as metadataJson
       FROM transfer_jobs
       WHERE id = ? AND kind = 'cross_pool_move'
       LIMIT 1`
    )
    .get(jobId) as
    | {
        id: string;
        status: string;
        sourcePoolId: number;
        destPoolId: number;
        conflictPolicy: MoveConflictMode;
        metadataJson: string | null;
      }
    | undefined;

  if (!job) {
    throw new ItemNotFoundError(`Cross-pool move job '${jobId}' not found`);
  }

  const meta: CrossPoolMoveJobMeta = job.metadataJson
    ? (JSON.parse(job.metadataJson) as CrossPoolMoveJobMeta)
    : { sourceFolderPaths: [], destFolderPaths: [], conflictMode: job.conflictPolicy };

  const pendingItems = sqlite
    .prepare(
      `SELECT id, source_account_id as sourceAccountId, target_account_id as targetAccountId,
              source_file_id as sourceFileId, source_drive_file_id as sourceDriveFileId,
              virtual_path as destVirtualPath, file_name as fileName, mime_type as mimeType,
              size_bytes as sizeBytes, expected_hash as expectedHash
       FROM transfer_job_items
       WHERE job_id = ? AND status IN ('pending', 'running')
       ORDER BY virtual_path ASC`
    )
    .all(jobId) as Array<{
    id: string;
    sourceAccountId: string;
    targetAccountId: string;
    sourceFileId: string;
    sourceDriveFileId: string;
    destVirtualPath: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    expectedHash: string | null;
  }>;

  const touchedAccounts = new Set<string>();
  const accountEmailMap = new Map<string, string>();
  const accountRows = sqlite
    .prepare('SELECT id, email FROM accounts')
    .all() as Array<{ id: string; email: string }>;
  for (const a of accountRows) {
    accountEmailMap.set(a.id, a.email);
  }

  const shareSetupPairs = new Set<string>();
  let fatalError: string | null = null;

  // Crash recovery: revoke any orphaned unrevoked shares from an interrupted previous run before starting.
  await revokeJobShares(jobId);

  try {
    // Establish folder-level temporary reader shares once per (sourceAccountId, targetAccountId) pair.
    for (const item of pendingItems) {
      if (cancelledCrossPoolMoveJobs.has(jobId)) {
        break;
      }
      if (item.sourceAccountId === item.targetAccountId) {
        continue;
      }
      const pairKey = `${item.sourceAccountId}::${item.targetAccountId}`;
      if (shareSetupPairs.has(pairKey)) {
        continue;
      }
      shareSetupPairs.add(pairKey);

      const targetEmail = accountEmailMap.get(item.targetAccountId);
      if (!targetEmail) {
        continue;
      }
      try {
        const sourceRootFolderId = await getAccountRootFolderId(item.sourceAccountId);
        await ensureFolderShareForJob({
          jobId,
          sourceAccountId: item.sourceAccountId,
          sourceFolderId: sourceRootFolderId,
          targetAccountId: item.targetAccountId,
          targetAccountEmail: targetEmail,
        });
      } catch (shareErr) {
        console.warn(
          `Folder-level temp share setup failed for ${pairKey} in job ${jobId}; will fall back to per-file copy if needed:`,
          shareErr
        );
      }
    }

    await runBoundedConcurrency(pendingItems, COPY_CONCURRENCY, async (item) => {
      if (cancelledCrossPoolMoveJobs.has(jobId)) {
        return;
      }

      sqlite
        .prepare(`UPDATE transfer_job_items SET status = 'running', attempts = attempts + 1, updated_at = unixepoch() WHERE id = ?`)
        .run(item.id);

      try {
        const currentSource = sqlite
          .prepare(
            `SELECT id, pool_id as poolId, account_id as accountId, drive_file_id as driveFileId,
                    size_bytes as sizeBytes, hash
             FROM files
             WHERE id = ? AND is_trashed = 0
             LIMIT 1`
          )
          .get(item.sourceFileId) as
          | {
              id: string;
              poolId: number;
              accountId: string;
              driveFileId: string;
              sizeBytes: number;
              hash: string | null;
            }
          | undefined;

        if (!currentSource) {
          throw new ItemNotFoundError(`Source file '${item.sourceFileId}' no longer exists`);
        }

        // Idempotent resume check: if already moved to destPoolId, mark completed.
        if (currentSource.poolId === job.destPoolId) {
          sqlite
            .prepare(
              `UPDATE transfer_job_items
               SET status = 'completed', dest_drive_file_id = ?, transferred_bytes = ?, updated_at = unixepoch()
               WHERE id = ?`
            )
            .run(currentSource.driveFileId, currentSource.sizeBytes, item.id);
          return;
        }

        const driveSource = getDriveClient(item.sourceAccountId);
        const driveTarget = getDriveClient(item.targetAccountId);
        const targetRootFolderId = await getAccountRootFolderId(item.targetAccountId);
        const destParentDir = path.posix.dirname(item.destVirtualPath);
        const destFileName = path.posix.basename(item.destVirtualPath);
        const targetRemoteFolderId = await ensureRemoteFolderHierarchy(
          driveTarget,
          targetRootFolderId,
          destParentDir
        );

        const appProperties = buildTsubasaAppProperties({
          virtualPath: item.destVirtualPath,
          virtualId: item.sourceFileId,
          checksum: currentSource.hash ?? item.expectedHash ?? undefined,
          includeChecksum: true,
        });

        let copied: { id: string; size: number | null; md5Checksum: string | null };
        try {
          copied = await copyDriveFileWithAclRetry({
            driveTarget,
            sourceDriveFileId: currentSource.driveFileId,
            targetRemoteFolderId,
            destFileName,
            appProperties,
          });
        } catch (copyErr) {
          // If folder-level share did not cover this file (e.g., outside pool root), fall back to per-file copy.
          if (isDriveNotFoundError(copyErr) && item.sourceAccountId !== item.targetAccountId) {
            const targetEmail = accountEmailMap.get(item.targetAccountId);
            const fallbackId = await copyDriveFileCrossAccount({
              sourceAccountId: item.sourceAccountId,
              sourceDriveFileId: currentSource.driveFileId,
              targetAccountId: item.targetAccountId,
              targetAccountEmail: targetEmail,
              targetRemoteFolderId,
              destFileName,
              appProperties,
              fields: 'id, name, size, md5Checksum',
            });
            const metaRes = await withDriveRetry(() =>
              driveTarget.files.get({
                fileId: fallbackId,
                fields: 'id, size, md5Checksum',
                supportsAllDrives: false,
              })
            );
            copied = {
              id: fallbackId,
              size: metaRes.data.size !== undefined && metaRes.data.size !== null ? Number(metaRes.data.size) : null,
              md5Checksum: metaRes.data.md5Checksum ? metaRes.data.md5Checksum.toLowerCase() : null,
            };
          } else {
            throw copyErr;
          }
        }

        const expectedMd5 = normalizeMd5(currentSource.hash ?? item.expectedHash);
        if (
          (expectedMd5 && copied.md5Checksum && copied.md5Checksum !== expectedMd5) ||
          (copied.size !== null && copied.size !== currentSource.sizeBytes)
        ) {
          try {
            await deleteRemoteFileIgnoreNotFound(driveTarget, copied.id);
          } catch {
            enqueueDriveOutbox([
              {
                accountId: item.targetAccountId,
                poolId: job.destPoolId,
                opType: 'file_delete',
                driveFileId: copied.id,
                payload: { fileId: item.sourceFileId, driveFileId: copied.id },
              },
            ]);
          }
          throw new Error(
            `Cross-pool copy verification failed for "${item.destVirtualPath}": expected md5=${expectedMd5} size=${currentSource.sizeBytes}, got md5=${copied.md5Checksum} size=${copied.size}`
          );
        }

        const destFolderId =
          destParentDir === '/' || destParentDir === '.' ? null : formatFolderId(job.destPoolId, destParentDir);
        ensureLocalParentFolders(item.destVirtualPath, job.destPoolId);

        sqlite.transaction(() => {
          displaceTrashedFileAtPath(job.destPoolId, item.destVirtualPath, { appendShortId: true });

          const existingDest = sqlite
            .prepare(
              `SELECT id, account_id as accountId, drive_file_id as driveFileId, size_bytes as sizeBytes
               FROM files
               WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 AND id != ?
               LIMIT 1`
            )
            .get(job.destPoolId, item.destVirtualPath, item.sourceFileId) as
            | { id: string; accountId: string; driveFileId: string; sizeBytes: number }
            | undefined;

          if (existingDest) {
            enqueueDriveOutbox([
              {
                accountId: existingDest.accountId,
                poolId: job.destPoolId,
                opType: 'file_delete',
                driveFileId: existingDest.driveFileId,
                payload: { fileId: existingDest.id, driveFileId: existingDest.driveFileId },
              },
            ]);
            sqlite.prepare('DELETE FROM files WHERE id = ?').run(existingDest.id);
            sqlite
              .prepare(
                'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
              )
              .run(existingDest.sizeBytes, existingDest.accountId);
          }

          sqlite
            .prepare(
              `UPDATE files
               SET pool_id = ?,
                   virtual_path = ?,
                   name = ?,
                   account_id = ?,
                   drive_file_id = ?,
                   folder_id = ?,
                   hash = COALESCE(?, hash),
                   updated_at = unixepoch()
               WHERE id = ?`
            )
            .run(
              job.destPoolId,
              item.destVirtualPath,
              destFileName,
              item.targetAccountId,
              copied.id,
              destFolderId,
              copied.md5Checksum,
              item.sourceFileId
            );

          sqlite
            .prepare(
              'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
            )
            .run(currentSource.sizeBytes, item.sourceAccountId);
          sqlite
            .prepare(
              'UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?'
            )
            .run(currentSource.sizeBytes, item.targetAccountId);

          recordTransferSync(item.targetAccountId, 'upload', currentSource.sizeBytes, Date.now(), job.destPoolId);

          sqlite
            .prepare(
              `UPDATE transfer_job_items
               SET status = 'completed',
                   dest_drive_file_id = ?,
                   verified_hash = ?,
                   transferred_bytes = ?,
                   last_error = NULL,
                   updated_at = unixepoch()
               WHERE id = ?`
            )
            .run(copied.id, copied.md5Checksum ?? expectedMd5, currentSource.sizeBytes, item.id);
        }).immediate();

        touchedAccounts.add(item.sourceAccountId);
        touchedAccounts.add(item.targetAccountId);

        try {
          await deleteRemoteFileIgnoreNotFound(driveSource, currentSource.driveFileId);
        } catch (delErr) {
          console.warn(`Failed to delete source Drive file ${currentSource.driveFileId} after cross-pool move:`, delErr);
          enqueueDriveOutbox([
            {
              accountId: item.sourceAccountId,
              poolId: job.sourcePoolId,
              opType: 'file_delete',
              driveFileId: currentSource.driveFileId,
              payload: { fileId: item.sourceFileId, driveFileId: currentSource.driveFileId },
            },
          ]);
        }

        syncJobCounters(jobId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fatalError = fatalError ?? msg;
        sqlite
          .prepare(`UPDATE transfer_job_items SET status = 'failed', last_error = ?, updated_at = unixepoch() WHERE id = ?`)
          .run(msg, item.id);
        syncJobCounters(jobId);
      }
    });

    // Ensure destination folders exist (including empty subfolders) and prune empty source folders.
    if (!cancelledCrossPoolMoveJobs.has(jobId)) {
      for (const destFolder of meta.destFolderPaths) {
        if (destFolder !== '/') {
          ensureLocalParentFolders(`${destFolder}/__placeholder__`, job.destPoolId);
        }
      }

      const sortedSourceFolders = [...meta.sourceFolderPaths].sort((a, b) => b.length - a.length);
      for (const srcFolder of sortedSourceFolders) {
        const { lower, upper } = buildDirectoryPrefixBounds(srcFolder);
        const remainingFile = sqlite
          .prepare(
            `SELECT 1 FROM files WHERE pool_id = ? AND virtual_path >= ? AND virtual_path < ? LIMIT 1`
          )
          .get(job.sourcePoolId, lower, upper);
        if (!remainingFile) {
          sqlite
            .prepare(`DELETE FROM folders WHERE pool_id = ? AND virtual_path = ?`)
            .run(job.sourcePoolId, srcFolder);
        }
      }
    }
  } finally {
    await revokeJobShares(jobId);

    bumpPoolRevision(job.sourcePoolId);
    bumpPoolRevision(job.destPoolId);
    invalidatePooledStorageOverview(job.sourcePoolId);
    invalidatePooledStorageOverview(job.destPoolId);
    for (const accId of touchedAccounts) {
      invalidateDiscrepancyCache(accId);
    }
  }

  const finalCounts = syncJobCounters(jobId);

  if (cancelledCrossPoolMoveJobs.has(jobId)) {
    cancelledCrossPoolMoveJobs.delete(jobId);
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE transfer_job_items SET status = 'cancelled', updated_at = unixepoch()
           WHERE job_id = ? AND status IN ('pending', 'running')`
        )
        .run(jobId);
      sqlite
        .prepare(`UPDATE transfer_jobs SET status = 'cancelled', updated_at = unixepoch() WHERE id = ?`)
        .run(jobId);
    }).immediate();
  } else if (finalCounts.failed > 0) {
    sqlite
      .prepare(`UPDATE transfer_jobs SET status = 'failed', last_error = ?, updated_at = unixepoch() WHERE id = ?`)
      .run(fatalError ?? `${finalCounts.failed} item(s) failed`, jobId);
  } else {
    sqlite
      .prepare(
        `UPDATE transfer_jobs
         SET status = 'completed', last_error = NULL, completed_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ?`
      )
      .run(jobId);
  }

  return readCrossPoolMoveResult(jobId, false);
}

export async function startCrossPoolMove(options: CrossPoolMoveOptions): Promise<CrossPoolMoveResult> {
  const { sourcePoolId, destPoolId, conflictMode = 'reject' } = options;

  if (isSharePoolId(sourcePoolId) || isSharePoolId(destPoolId)) {
    throw new SharePoolReadOnlyError('Cross-pool move cannot target or leave Share Pool');
  }
  if (sourcePoolId === destPoolId) {
    throw new UploadValidationError('Source and destination pools must be different for cross-pool move');
  }
  if (!Array.isArray(options.items) || options.items.length === 0) {
    throw new UploadValidationError('At least one item is required for cross-pool move');
  }

  const sourcePoolExists = sqlite.prepare('SELECT 1 FROM pools WHERE id = ? LIMIT 1').get(sourcePoolId);
  if (!sourcePoolExists) {
    throw new ItemNotFoundError(`Source pool ${sourcePoolId} not found`);
  }
  const destPoolExists = sqlite.prepare('SELECT 1 FROM pools WHERE id = ? LIMIT 1').get(destPoolId);
  if (!destPoolExists) {
    throw new ItemNotFoundError(`Destination pool ${destPoolId} not found`);
  }

  const { filesToMove, sourceFolderPaths, destFolderPaths } = resolveCrossPoolSourceItems(options);

  const checkDestFileStmt = sqlite.prepare(
    'SELECT id, virtual_path as virtualPath, size_bytes as sizeBytes, updated_at as updatedAt FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 LIMIT 1'
  );
  const checkDestFolderStmt = sqlite.prepare(
    'SELECT id, virtual_path as virtualPath, updated_at as updatedAt FROM folders WHERE pool_id = ? AND virtual_path = ? LIMIT 1'
  );

  const conflicts: MoveConflictItem[] = [];
  const reservedDestPaths = new Set<string>();
  const plannedEntries: Array<{
    file: ResolvedSourceFile;
    finalDestPath: string;
    skipped: boolean;
  }> = [];

  for (const file of filesToMove) {
    const existingFile = checkDestFileStmt.get(destPoolId, file.destVirtualPath) as
      | { id: string; virtualPath: string; sizeBytes: number; updatedAt: number }
      | undefined;
    const existingFolder = checkDestFolderStmt.get(destPoolId, file.destVirtualPath) as
      | { id: string; virtualPath: string; updatedAt: number }
      | undefined;

    if (existingFolder) {
      conflicts.push({
        sourceFileId: file.id,
        sourcePath: file.virtualPath,
        sourceName: file.name,
        sourceSizeBytes: file.sizeBytes,
        sourceUpdatedAt: Date.now(),
        destPath: file.destVirtualPath,
        existingFileId: existingFolder.id,
        existingUpdatedAt: existingFolder.updatedAt * 1000,
        canOverwrite: false,
      });
      continue;
    }

    if (existingFile || reservedDestPaths.has(file.destVirtualPath)) {
      if (conflictMode === 'reject') {
        conflicts.push({
          sourceFileId: file.id,
          sourcePath: file.virtualPath,
          sourceName: file.name,
          sourceSizeBytes: file.sizeBytes,
          sourceUpdatedAt: Date.now(),
          destPath: file.destVirtualPath,
          existingFileId: existingFile?.id,
          existingSizeBytes: existingFile?.sizeBytes,
          existingUpdatedAt: existingFile ? existingFile.updatedAt * 1000 : undefined,
          canOverwrite: true,
        });
        continue;
      }
      if (conflictMode === 'skip') {
        plannedEntries.push({ file, finalDestPath: file.destVirtualPath, skipped: true });
        continue;
      }
      if (conflictMode === 'keep_both') {
        const allocated = allocateCrossPoolKeepBothPath(destPoolId, file.destVirtualPath, reservedDestPaths);
        plannedEntries.push({ file, finalDestPath: allocated, skipped: false });
        continue;
      }
      // overwrite
      reservedDestPaths.add(file.destVirtualPath);
      plannedEntries.push({ file, finalDestPath: file.destVirtualPath, skipped: false });
      continue;
    }

    reservedDestPaths.add(file.destVirtualPath);
    plannedEntries.push({ file, finalDestPath: file.destVirtualPath, skipped: false });
  }

  if (conflicts.length > 0) {
    throw new MoveConflictError(conflicts, plannedEntries.length);
  }

  const activeEntries = plannedEntries.filter((e) => !e.skipped);
  const placementByPath = new Map<string, string>();
  if (activeEntries.length > 0) {
    const batchPlan = await planBatchPlacement(
      activeEntries.map((e) => ({ virtualPath: e.finalDestPath, sizeBytes: e.file.sizeBytes })),
      Date.now(),
      destPoolId
    );
    for (const decision of batchPlan.decisions) {
      placementByPath.set(decision.virtualPath, decision.accountId);
    }
  }

  const jobId = randomUUID();
  const totalBytes = activeEntries.reduce((sum, e) => sum + e.file.sizeBytes, 0);
  const skippedCount = plannedEntries.length - activeEntries.length;
  const meta: CrossPoolMoveJobMeta = {
    sourceFolderPaths,
    destFolderPaths,
    conflictMode,
  };

  sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO transfer_jobs (
          id, kind, status, pool_id, source_pool_id, conflict_policy, mode,
          total_items, completed_items, failed_items, skipped_items,
          total_bytes, transferred_bytes, metadata_json, created_at, updated_at
        ) VALUES (?, 'cross_pool_move', 'running', ?, ?, ?, 'copy', ?, 0, 0, ?, ?, 0, ?, unixepoch(), unixepoch())`
      )
      .run(
        jobId,
        destPoolId,
        sourcePoolId,
        conflictMode,
        plannedEntries.length,
        skippedCount,
        totalBytes,
        JSON.stringify(meta)
      );

    const insertItemStmt = sqlite.prepare(
      `INSERT INTO transfer_job_items (
        id, job_id, status, source_account_id, target_account_id,
        source_file_id, source_drive_file_id, virtual_path, file_name,
        mime_type, size_bytes, transferred_bytes, expected_hash, transfer_mode, skip_reason,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'copy', ?, unixepoch(), unixepoch())`
    );

    for (const entry of plannedEntries) {
      const targetAccountId = entry.skipped ? null : (placementByPath.get(entry.finalDestPath) ?? null);
      if (!entry.skipped && !targetAccountId) {
        throw new InsufficientStorageError(
          `No target account allocated in pool ${destPoolId} for ${entry.finalDestPath}`
        );
      }
      insertItemStmt.run(
        randomUUID(),
        jobId,
        entry.skipped ? 'skipped' : 'pending',
        entry.file.accountId,
        targetAccountId,
        entry.file.id,
        entry.file.driveFileId,
        entry.finalDestPath,
        path.posix.basename(entry.finalDestPath),
        entry.file.mimeType,
        entry.file.sizeBytes,
        entry.file.hash,
        entry.skipped ? 'conflict_skip' : null
      );
    }
  }).immediate();

  const shouldWait = options.wait ?? activeEntries.length <= 1;
  const runPromise = executeCrossPoolMoveJobInternal(jobId).finally(() => {
    activeCrossPoolMoveJobs.delete(jobId);
  });
  activeCrossPoolMoveJobs.set(jobId, runPromise);

  if (shouldWait) {
    return runPromise;
  }

  void runPromise.catch((err) => {
    console.error(`Cross-pool move job ${jobId} failed:`, err);
  });

  return readCrossPoolMoveResult(jobId, true);
}

export async function resumeCrossPoolMoveJob(jobId: string, wait = false): Promise<CrossPoolMoveResult> {
  const existingPromise = activeCrossPoolMoveJobs.get(jobId);
  if (existingPromise) {
    return wait ? existingPromise : readCrossPoolMoveResult(jobId, true);
  }

  const job = sqlite
    .prepare(`SELECT id, status FROM transfer_jobs WHERE id = ? AND kind = 'cross_pool_move' LIMIT 1`)
    .get(jobId) as { id: string; status: string } | undefined;
  if (!job) {
    throw new ItemNotFoundError(`Cross-pool move job '${jobId}' not found`);
  }
  if (job.status === 'completed') {
    return readCrossPoolMoveResult(jobId, false);
  }

  cancelledCrossPoolMoveJobs.delete(jobId);
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE transfer_job_items SET status = 'pending', last_error = NULL, updated_at = unixepoch()
         WHERE job_id = ? AND status IN ('failed', 'paused', 'running')`
      )
      .run(jobId);
    sqlite
      .prepare(`UPDATE transfer_jobs SET status = 'running', pause_reason = NULL, last_error = NULL, updated_at = unixepoch() WHERE id = ?`)
      .run(jobId);
  }).immediate();

  const runPromise = executeCrossPoolMoveJobInternal(jobId).finally(() => {
    activeCrossPoolMoveJobs.delete(jobId);
  });
  activeCrossPoolMoveJobs.set(jobId, runPromise);

  if (wait) {
    return runPromise;
  }
  void runPromise.catch((err) => {
    console.error(`Resumed cross-pool move job ${jobId} failed:`, err);
  });
  return readCrossPoolMoveResult(jobId, true);
}

export async function cancelCrossPoolMoveJob(jobId: string): Promise<CrossPoolMoveResult> {
  const job = sqlite
    .prepare(`SELECT id, status FROM transfer_jobs WHERE id = ? AND kind = 'cross_pool_move' LIMIT 1`)
    .get(jobId) as { id: string; status: string } | undefined;
  if (!job) {
    throw new ItemNotFoundError(`Cross-pool move job '${jobId}' not found`);
  }

  cancelledCrossPoolMoveJobs.add(jobId);
  await revokeJobShares(jobId);

  if (!activeCrossPoolMoveJobs.has(jobId) && job.status !== 'completed') {
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE transfer_job_items SET status = 'cancelled', updated_at = unixepoch()
           WHERE job_id = ? AND status NOT IN ('completed', 'skipped')`
        )
        .run(jobId);
      sqlite
        .prepare(`UPDATE transfer_jobs SET status = 'cancelled', pause_reason = NULL, updated_at = unixepoch() WHERE id = ?`)
        .run(jobId);
    }).immediate();
  }

  return readCrossPoolMoveResult(jobId, false);
}
