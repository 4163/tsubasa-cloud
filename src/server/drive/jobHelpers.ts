import type { drive_v3 } from 'googleapis';
import { sqlite } from '../db/index.js';
import { getDriveClient } from './client.js';
import { copyDriveFileCrossAccount } from './crossAccountCopy.js';
import { getDriveErrorStatus, isDriveNotFoundError, withDriveRetry } from './errors.js';
import { enqueueDriveOutbox } from './outbox.js';
import { deleteRemoteFileIgnoreNotFound } from './outboxExecutors.js';

const MD5_HEX_RE = /^[a-f0-9]{32}$/i;
const ACL_PROPAGATION_BACKOFF_MS = [300, 800, 1_500, 2_500];

export function normalizeMd5(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return MD5_HEX_RE.test(trimmed) ? trimmed : null;
}

export function sleepMs(ms: number): Promise<void> {
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
        await sleepMs(ACL_PROPAGATION_BACKOFF_MS[attempt]);
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}

/**
 * Shared internal cross-account copy with ACL-propagation retry, per-file share fallback,
 * MD5 + byte-size verification, and remote cleanup on verification mismatch.
 */
export async function copyInternalFileWithFallbackAndVerify(params: {
  sourceAccountId: string;
  sourceDriveFileId: string;
  sourceFileId: string;
  expectedSizeBytes: number;
  expectedHash: string | null;
  targetAccountId: string;
  targetAccountEmail?: string;
  targetPoolId: number;
  targetRemoteFolderId: string;
  destFileName: string;
  destVirtualPath: string;
  appProperties: Record<string, string>;
  contextLabel: string;
}): Promise<{ id: string; size: number | null; md5Checksum: string | null }> {
  const driveTarget = getDriveClient(params.targetAccountId);
  let copied: { id: string; size: number | null; md5Checksum: string | null };

  try {
    copied = await copyDriveFileWithAclRetry({
      driveTarget,
      sourceDriveFileId: params.sourceDriveFileId,
      targetRemoteFolderId: params.targetRemoteFolderId,
      destFileName: params.destFileName,
      appProperties: params.appProperties,
    });
  } catch (copyErr) {
    if (isDriveNotFoundError(copyErr) && params.sourceAccountId !== params.targetAccountId) {
      const fallbackId = await copyDriveFileCrossAccount({
        sourceAccountId: params.sourceAccountId,
        sourceDriveFileId: params.sourceDriveFileId,
        targetAccountId: params.targetAccountId,
        targetAccountEmail: params.targetAccountEmail,
        targetRemoteFolderId: params.targetRemoteFolderId,
        destFileName: params.destFileName,
        appProperties: params.appProperties,
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

  const expectedMd5 = normalizeMd5(params.expectedHash);
  if (
    (expectedMd5 && copied.md5Checksum && copied.md5Checksum !== expectedMd5) ||
    (copied.size !== null && copied.size !== params.expectedSizeBytes)
  ) {
    await deleteDriveFileWithOutboxFallback(driveTarget, {
      accountId: params.targetAccountId,
      poolId: params.targetPoolId,
      fileId: params.sourceFileId,
      driveFileId: copied.id,
      contextLabel: `${params.contextLabel} verification cleanup`,
    });
    throw new Error(
      `${params.contextLabel} verification failed for "${params.destVirtualPath}": expected md5=${expectedMd5} size=${params.expectedSizeBytes}, got md5=${copied.md5Checksum} size=${copied.size}`
    );
  }

  return copied;
}

export async function deleteDriveFileWithOutboxFallback(
  drive: drive_v3.Drive,
  params: {
    accountId: string;
    poolId: number;
    fileId: string;
    driveFileId: string;
    contextLabel: string;
  }
): Promise<void> {
  try {
    await deleteRemoteFileIgnoreNotFound(drive, params.driveFileId);
  } catch (err) {
    console.warn(`Failed to delete Drive file ${params.driveFileId} (${params.contextLabel}):`, err);
    enqueueDriveOutbox([
      {
        accountId: params.accountId,
        poolId: params.poolId,
        opType: 'file_delete',
        driveFileId: params.driveFileId,
        payload: { fileId: params.fileId, driveFileId: params.driveFileId },
      },
    ]);
  }
}

/**
 * O(1) incremental counter update for transfer_jobs instead of per-item GROUP BY scans.
 */
export function incrementTransferJobProgress(
  jobId: string,
  delta: {
    completedDelta?: number;
    failedDelta?: number;
    skippedDelta?: number;
    bytesDelta?: number;
  }
): void {
  sqlite
    .prepare(
      `UPDATE transfer_jobs
       SET completed_items = MAX(0, completed_items + ?),
           failed_items = MAX(0, failed_items + ?),
           skipped_items = MAX(0, skipped_items + ?),
           transferred_bytes = MAX(0, transferred_bytes + ?),
           updated_at = unixepoch()
       WHERE id = ?`
    )
    .run(
      delta.completedDelta ?? 0,
      delta.failedDelta ?? 0,
      delta.skippedDelta ?? 0,
      delta.bytesDelta ?? 0,
      jobId
    );
}

/**
 * Reconciles transfer_jobs summary columns once at job end or resume.
 */
export function reconcileTransferJobCounters(jobId: string): {
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
