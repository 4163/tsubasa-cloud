import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { bumpPoolRevision, sqlite } from '../db/index.js';
import {
  FileExceedsCeilingError,
  getEligibleAccounts,
  InsufficientStorageError,
  invalidatePooledStorageOverview,
  recordTransferSync,
  simulateBatchPlacement,
} from '../storage/index.js';
import { buildTsubasaAppProperties } from './appProperties.js';
import { authPool } from './auth.js';
import { getDriveClient } from './client.js';
import { copyDriveFileCrossAccount } from './crossAccountCopy.js';
import {
  copyDriveFileWithAclRetry,
  ensureFolderShareForJob,
  revokeJobShares,
} from './crossPoolMove.js';
import { invalidateDiscrepancyCache } from './discrepancyCache.js';
import {
  isDriveNotFoundError,
  ItemNotFoundError,
  runBoundedConcurrency,
  withDriveRetry,
} from './errors.js';
import { clearRemoteFolderCache, ensureRemoteFolderHierarchy } from './mirror.js';
import { enqueueDriveOutbox } from './outbox.js';
import { deleteRemoteFileIgnoreNotFound } from './outboxExecutors.js';
import { getAccountRootFolderId } from './remoteTree.js';

const MD5_HEX_RE = /^[a-f0-9]{32}$/i;
const EVACUATE_CONCURRENCY = 4;

const activeEvacuationJobs = new Map<string, Promise<AccountEvacuationResult>>();
const cancelledEvacuationJobs = new Set<string>();

export class EvacuationInProgressError extends Error {
  readonly code = 'EVACUATION_IN_PROGRESS' as const;
  readonly jobId: string;

  constructor(jobId: string, message = 'Account evacuation is already in progress') {
    super(message);
    this.name = 'EvacuationInProgressError';
    this.jobId = jobId;
  }
}

export interface StartAccountEvacuationOptions {
  removeAfterEvacuate?: boolean;
  wait?: boolean;
}

export interface AccountEvacuationResult {
  jobId: string | null;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  sourceAccountId: string;
  poolId: number;
  totalItems: number;
  filesMoved: number;
  failedItems: number;
  totalBytes: number;
  bytesMoved: number;
  removed: boolean;
  queued: boolean;
  lastError?: string | null;
}

interface EvacuationJobMetadata {
  sourceAccountId: string;
  removeAfterEvacuate: boolean;
}

function normalizeMd5(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return MD5_HEX_RE.test(trimmed) ? trimmed : null;
}

export function findActiveAccountEvacuationJob(accountId: string): { id: string; status: string } | null {
  const row = sqlite
    .prepare(
      `SELECT id, status
       FROM transfer_jobs
       WHERE kind = 'account_evacuate' AND account_id = ? AND status IN ('pending', 'running')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(accountId) as { id: string; status: string } | undefined;
  return row ?? null;
}

function removeEmptyAccountFromSystem(accountId: string, poolId: number, rootFolderId: string | null): void {
  sqlite.transaction(() => {
    const remaining = sqlite
      .prepare('SELECT COUNT(*) as cnt FROM files WHERE account_id = ?')
      .get(accountId) as { cnt: number } | undefined;
    const cnt = Number(remaining?.cnt ?? 0);
    if (cnt > 0) {
      throw new Error(`Cannot remove account ${accountId}: ${cnt} file(s) still remain on account`);
    }
    sqlite.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
  }).immediate();

  bumpPoolRevision(poolId);
  invalidatePooledStorageOverview(poolId);
  invalidateDiscrepancyCache(accountId);
  if (rootFolderId) {
    clearRemoteFolderCache(rootFolderId);
  }
  authPool.removeAccount(accountId);
}

function syncEvacuationCounters(jobId: string): {
  pending: number;
  running: number;
  completed: number;
  failed: number;
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
  }

  sqlite
    .prepare(
      `UPDATE transfer_jobs
       SET completed_items = ?, failed_items = ?, transferred_bytes = ?, updated_at = unixepoch()
       WHERE id = ?`
    )
    .run(counts.completed, counts.failed, counts.transferredBytes, jobId);

  return counts;
}

function readEvacuationJobResult(jobId: string, queued = false, removed = false): AccountEvacuationResult {
  const row = sqlite
    .prepare(
      `SELECT id, status, pool_id as poolId, account_id as accountId,
              total_items as totalItems, completed_items as completedItems,
              failed_items as failedItems, total_bytes as totalBytes,
              transferred_bytes as transferredBytes, last_error as lastError,
              metadata_json as metadataJson
       FROM transfer_jobs
       WHERE id = ? AND kind = 'account_evacuate'
       LIMIT 1`
    )
    .get(jobId) as
    | {
        id: string;
        status: AccountEvacuationResult['status'];
        poolId: number | null;
        accountId: string | null;
        totalItems: number;
        completedItems: number;
        failedItems: number;
        totalBytes: number;
        transferredBytes: number;
        lastError: string | null;
        metadataJson: string | null;
      }
    | undefined;

  if (!row) {
    throw new ItemNotFoundError(`Account evacuation job '${jobId}' not found`);
  }

  let sourceAccountId = row.accountId ?? '';
  if (!sourceAccountId && row.metadataJson) {
    try {
      const meta = JSON.parse(row.metadataJson) as Partial<EvacuationJobMetadata>;
      sourceAccountId = meta.sourceAccountId ?? '';
    } catch {
      sourceAccountId = '';
    }
  }

  return {
    jobId: row.id,
    status: row.status,
    sourceAccountId,
    poolId: row.poolId ?? 1,
    totalItems: row.totalItems,
    filesMoved: row.completedItems,
    failedItems: row.failedItems,
    totalBytes: row.totalBytes,
    bytesMoved: row.transferredBytes,
    removed,
    queued,
    lastError: row.lastError,
  };
}

async function executeAccountEvacuationJobInternal(jobId: string): Promise<AccountEvacuationResult> {
  const job = sqlite
    .prepare(
      `SELECT id, status, pool_id as poolId, account_id as accountId, metadata_json as metadataJson
       FROM transfer_jobs
       WHERE id = ? AND kind = 'account_evacuate'
       LIMIT 1`
    )
    .get(jobId) as
    | {
        id: string;
        status: string;
        poolId: number | null;
        accountId: string | null;
        metadataJson: string | null;
      }
    | undefined;

  if (!job) {
    throw new ItemNotFoundError(`Account evacuation job '${jobId}' not found`);
  }

  const meta: EvacuationJobMetadata = job.metadataJson
    ? (JSON.parse(job.metadataJson) as EvacuationJobMetadata)
    : { sourceAccountId: job.accountId ?? '', removeAfterEvacuate: false };
  const sourceAccountId = job.accountId || meta.sourceAccountId;
  const poolId = job.poolId ?? 1;

  const sourceAccountRow = sqlite
    .prepare('SELECT id, root_folder_id as rootFolderId FROM accounts WHERE id = ? LIMIT 1')
    .get(sourceAccountId) as { id: string; rootFolderId: string | null } | undefined;

  const pendingItems = sqlite
    .prepare(
      `SELECT id, source_account_id as sourceAccountId, target_account_id as targetAccountId,
              source_file_id as sourceFileId, source_drive_file_id as sourceDriveFileId,
              virtual_path as virtualPath, file_name as fileName, size_bytes as sizeBytes,
              expected_hash as expectedHash
       FROM transfer_job_items
       WHERE job_id = ? AND status IN ('pending', 'running')
       ORDER BY size_bytes DESC, virtual_path ASC`
    )
    .all(jobId) as Array<{
    id: string;
    sourceAccountId: string;
    targetAccountId: string;
    sourceFileId: string;
    sourceDriveFileId: string;
    virtualPath: string;
    fileName: string;
    sizeBytes: number;
    expectedHash: string | null;
  }>;

  const accountEmailMap = new Map<string, string>();
  const allAccRows = sqlite.prepare('SELECT id, email FROM accounts').all() as Array<{ id: string; email: string }>;
  for (const a of allAccRows) {
    accountEmailMap.set(a.id, a.email);
  }

  const touchedAccounts = new Set<string>([sourceAccountId]);
  const sharedTargets = new Set<string>();
  let fatalError: string | null = null;
  let removed = false;

  // Crash recovery: revoke any orphaned unrevoked shares from an interrupted previous run before starting.
  await revokeJobShares(jobId);

  try {
    if (sourceAccountRow && pendingItems.length > 0) {
      let sourceRootFolderId: string | null = sourceAccountRow.rootFolderId;
      if (!sourceRootFolderId) {
        try {
          sourceRootFolderId = await getAccountRootFolderId(sourceAccountId);
        } catch {
          sourceRootFolderId = null;
        }
      }

      if (sourceRootFolderId) {
        for (const item of pendingItems) {
          if (cancelledEvacuationJobs.has(jobId)) {
            break;
          }
          if (sharedTargets.has(item.targetAccountId)) {
            continue;
          }
          sharedTargets.add(item.targetAccountId);
          const targetEmail = accountEmailMap.get(item.targetAccountId);
          if (!targetEmail) {
            continue;
          }
          try {
            await ensureFolderShareForJob({
              jobId,
              sourceAccountId,
              sourceFolderId: sourceRootFolderId,
              targetAccountId: item.targetAccountId,
              targetAccountEmail: targetEmail,
            });
          } catch (shareErr) {
            console.warn(
              `Folder-level temp share setup failed for evacuation ${jobId} (${sourceAccountId} -> ${item.targetAccountId}):`,
              shareErr
            );
          }
        }
      }
    }

    await runBoundedConcurrency(pendingItems, EVACUATE_CONCURRENCY, async (item) => {
      if (cancelledEvacuationJobs.has(jobId)) {
        return;
      }

      sqlite
        .prepare(`UPDATE transfer_job_items SET status = 'running', attempts = attempts + 1, updated_at = unixepoch() WHERE id = ?`)
        .run(item.id);

      try {
        const currentFile = sqlite
          .prepare(
            `SELECT id, pool_id as poolId, virtual_path as virtualPath, name, size_bytes as sizeBytes,
                    hash, account_id as accountId, drive_file_id as driveFileId, is_trashed as isTrashed
             FROM files
             WHERE id = ?
             LIMIT 1`
          )
          .get(item.sourceFileId) as
          | {
              id: string;
              poolId: number;
              virtualPath: string;
              name: string;
              sizeBytes: number;
              hash: string | null;
              accountId: string;
              driveFileId: string;
              isTrashed: number;
            }
          | undefined;

        if (!currentFile || currentFile.accountId !== sourceAccountId) {
          // File was already moved or removed before resume.
          sqlite
            .prepare(
              `UPDATE transfer_job_items
               SET status = 'completed', transferred_bytes = ?, updated_at = unixepoch()
               WHERE id = ?`
            )
            .run(item.sizeBytes, item.id);
          return;
        }

        const driveSource = getDriveClient(sourceAccountId);
        const driveTarget = getDriveClient(item.targetAccountId);
        const targetRootFolderId = await getAccountRootFolderId(item.targetAccountId);
        const parentDir = path.posix.dirname(currentFile.virtualPath);
        const targetRemoteFolderId = await ensureRemoteFolderHierarchy(
          driveTarget,
          targetRootFolderId,
          parentDir
        );

        const appProperties = buildTsubasaAppProperties({
          virtualPath: currentFile.virtualPath,
          virtualId: currentFile.id,
          checksum: currentFile.hash,
          includeChecksum: true,
        });

        let copied: { id: string; size: number | null; md5Checksum: string | null };
        try {
          copied = await copyDriveFileWithAclRetry({
            driveTarget,
            sourceDriveFileId: currentFile.driveFileId,
            targetRemoteFolderId,
            destFileName: currentFile.name,
            appProperties,
          });
        } catch (copyErr) {
          if (isDriveNotFoundError(copyErr)) {
            const targetEmail = accountEmailMap.get(item.targetAccountId);
            const fallbackId = await copyDriveFileCrossAccount({
              sourceAccountId,
              sourceDriveFileId: currentFile.driveFileId,
              targetAccountId: item.targetAccountId,
              targetAccountEmail: targetEmail,
              targetRemoteFolderId,
              destFileName: currentFile.name,
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

        const expectedMd5 = normalizeMd5(currentFile.hash ?? item.expectedHash);
        if (
          (expectedMd5 && copied.md5Checksum && copied.md5Checksum !== expectedMd5) ||
          (copied.size !== null && copied.size !== currentFile.sizeBytes)
        ) {
          try {
            await deleteRemoteFileIgnoreNotFound(driveTarget, copied.id);
          } catch {
            enqueueDriveOutbox([
              {
                accountId: item.targetAccountId,
                poolId,
                opType: 'file_delete',
                driveFileId: copied.id,
                payload: { fileId: currentFile.id, driveFileId: copied.id },
              },
            ]);
          }
          throw new Error(
            `Evacuation verification failed for "${currentFile.virtualPath}": expected md5=${expectedMd5} size=${currentFile.sizeBytes}, got md5=${copied.md5Checksum} size=${copied.size}`
          );
        }

        if (Boolean(currentFile.isTrashed)) {
          try {
            await withDriveRetry(() =>
              driveTarget.files.update({
                fileId: copied.id,
                requestBody: { trashed: true },
                supportsAllDrives: false,
              })
            );
          } catch (trashErr) {
            console.warn(`Failed to preserve trashed state on evacuated file ${copied.id}:`, trashErr);
            enqueueDriveOutbox([
              {
                accountId: item.targetAccountId,
                poolId,
                opType: 'file_trash',
                driveFileId: copied.id,
                payload: { fileId: currentFile.id, driveFileId: copied.id },
              },
            ]);
          }
        }

        sqlite.transaction(() => {
          sqlite
            .prepare(
              `UPDATE files
               SET account_id = ?, drive_file_id = ?, hash = COALESCE(?, hash), updated_at = unixepoch()
               WHERE id = ?`
            )
            .run(item.targetAccountId, copied.id, copied.md5Checksum, currentFile.id);

          sqlite
            .prepare(
              'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
            )
            .run(currentFile.sizeBytes, sourceAccountId);
          sqlite
            .prepare(
              'UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?'
            )
            .run(currentFile.sizeBytes, item.targetAccountId);

          recordTransferSync(item.targetAccountId, 'upload', currentFile.sizeBytes, Date.now(), poolId);

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
            .run(copied.id, copied.md5Checksum ?? expectedMd5, currentFile.sizeBytes, item.id);
        }).immediate();

        touchedAccounts.add(item.targetAccountId);

        try {
          await deleteRemoteFileIgnoreNotFound(driveSource, currentFile.driveFileId);
        } catch (delErr) {
          console.warn(`Failed to delete source Drive file ${currentFile.driveFileId} during evacuation:`, delErr);
          enqueueDriveOutbox([
            {
              accountId: sourceAccountId,
              poolId,
              opType: 'file_delete',
              driveFileId: currentFile.driveFileId,
              payload: { fileId: currentFile.id, driveFileId: currentFile.driveFileId },
            },
          ]);
        }

        syncEvacuationCounters(jobId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fatalError = fatalError ?? msg;
        sqlite
          .prepare(`UPDATE transfer_job_items SET status = 'failed', last_error = ?, updated_at = unixepoch() WHERE id = ?`)
          .run(msg, item.id);
        syncEvacuationCounters(jobId);
      }
    });
  } finally {
    await revokeJobShares(jobId);
    bumpPoolRevision(poolId);
    invalidatePooledStorageOverview(poolId);
    for (const accId of touchedAccounts) {
      invalidateDiscrepancyCache(accId);
    }
  }

  const finalCounts = syncEvacuationCounters(jobId);

  if (cancelledEvacuationJobs.has(jobId)) {
    cancelledEvacuationJobs.delete(jobId);
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
      .run(fatalError ?? `${finalCounts.failed} file(s) failed to evacuate`, jobId);
  } else {
    if (meta.removeAfterEvacuate) {
      try {
        removeEmptyAccountFromSystem(sourceAccountId, poolId, sourceAccountRow?.rootFolderId ?? null);
        removed = true;
      } catch (rmErr) {
        const msg = rmErr instanceof Error ? rmErr.message : String(rmErr);
        sqlite
          .prepare(`UPDATE transfer_jobs SET status = 'failed', last_error = ?, updated_at = unixepoch() WHERE id = ?`)
          .run(msg, jobId);
        return readEvacuationJobResult(jobId, false, false);
      }
    }

    sqlite
      .prepare(
        `UPDATE transfer_jobs
         SET status = 'completed', last_error = NULL, completed_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ?`
      )
      .run(jobId);
  }

  return readEvacuationJobResult(jobId, false, removed);
}

export async function startAccountEvacuation(
  accountId: string,
  options: StartAccountEvacuationOptions = {}
): Promise<AccountEvacuationResult> {
  const { removeAfterEvacuate = false, wait = false } = options;

  const existingActive = findActiveAccountEvacuationJob(accountId);
  if (existingActive) {
    throw new EvacuationInProgressError(existingActive.id);
  }

  const account = sqlite
    .prepare(
      `SELECT id, pool_id as poolId, is_disabled as isDisabled, root_folder_id as rootFolderId
       FROM accounts WHERE id = ? LIMIT 1`
    )
    .get(accountId) as
    | { id: string; poolId: number; isDisabled: number; rootFolderId: string | null }
    | undefined;

  if (!account) {
    if (removeAfterEvacuate) {
      authPool.removeAccount(accountId);
      return {
        jobId: null,
        status: 'completed',
        sourceAccountId: accountId,
        poolId: 1,
        totalItems: 0,
        filesMoved: 0,
        failedItems: 0,
        totalBytes: 0,
        bytesMoved: 0,
        removed: true,
        queued: false,
      };
    }
    throw new ItemNotFoundError(`Account '${accountId}' not found`);
  }

  const accountFiles = sqlite
    .prepare(
      `SELECT id, virtual_path as virtualPath, name, size_bytes as sizeBytes, mime_type as mimeType,
              hash, drive_file_id as driveFileId
       FROM files
       WHERE account_id = ?
       ORDER BY size_bytes DESC, virtual_path ASC`
    )
    .all(accountId) as Array<{
    id: string;
    virtualPath: string;
    name: string;
    sizeBytes: number;
    mimeType: string;
    hash: string | null;
    driveFileId: string;
  }>;

  if (accountFiles.length === 0) {
    if (removeAfterEvacuate) {
      removeEmptyAccountFromSystem(accountId, account.poolId, account.rootFolderId);
    } else if (!account.isDisabled) {
      sqlite
        .prepare('UPDATE accounts SET is_disabled = 1, updated_at = unixepoch() WHERE id = ?')
        .run(accountId);
    }

    return {
      jobId: null,
      status: 'completed',
      sourceAccountId: accountId,
      poolId: account.poolId,
      totalItems: 0,
      filesMoved: 0,
      failedItems: 0,
      totalBytes: 0,
      bytesMoved: 0,
      removed: removeAfterEvacuate,
      queued: false,
    };
  }

  const otherEligible = (await getEligibleAccounts(account.poolId)).filter((c) => c.id !== accountId);
  if (otherEligible.length === 0) {
    throw new InsufficientStorageError(
      'No other active account available in this pool to evacuate files to'
    );
  }

  const plan = await simulateBatchPlacement(
    accountFiles.map((f) => ({ virtualPath: f.virtualPath, sizeBytes: f.sizeBytes })),
    otherEligible,
    account.poolId
  );

  // Map decisions back to files (preserving duplicates if any via queue by virtualPath)
  const targetQueueByPath = new Map<string, string[]>();
  for (const decision of plan.decisions) {
    const queue = targetQueueByPath.get(decision.virtualPath) ?? [];
    queue.push(decision.accountId);
    targetQueueByPath.set(decision.virtualPath, queue);
  }

  const jobId = randomUUID();
  const totalBytes = accountFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
  const meta: EvacuationJobMetadata = {
    sourceAccountId: accountId,
    removeAfterEvacuate,
  };

  sqlite.transaction(() => {
    if (!account.isDisabled) {
      sqlite
        .prepare('UPDATE accounts SET is_disabled = 1, updated_at = unixepoch() WHERE id = ?')
        .run(accountId);
    }

    sqlite
      .prepare(
        `INSERT INTO transfer_jobs (
          id, kind, status, pool_id, account_id, conflict_policy, mode,
          total_items, completed_items, failed_items, skipped_items,
          total_bytes, transferred_bytes, metadata_json, created_at, updated_at
        ) VALUES (?, 'account_evacuate', 'running', ?, ?, 'replace', 'copy', ?, 0, 0, 0, ?, 0, ?, unixepoch(), unixepoch())`
      )
      .run(jobId, account.poolId, accountId, accountFiles.length, totalBytes, JSON.stringify(meta));

    const insertItemStmt = sqlite.prepare(
      `INSERT INTO transfer_job_items (
        id, job_id, status, source_account_id, target_account_id,
        source_file_id, source_drive_file_id, virtual_path, file_name,
        mime_type, size_bytes, transferred_bytes, expected_hash, transfer_mode,
        created_at, updated_at
      ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'copy', unixepoch(), unixepoch())`
    );

    for (const file of accountFiles) {
      const queue = targetQueueByPath.get(file.virtualPath);
      const targetAccountId = queue?.shift();
      if (!targetAccountId) {
        throw new InsufficientStorageError(
          `Failed to assign evacuation destination account for "${file.virtualPath}"`
        );
      }
      insertItemStmt.run(
        randomUUID(),
        jobId,
        accountId,
        targetAccountId,
        file.id,
        file.driveFileId,
        file.virtualPath,
        file.name,
        file.mimeType,
        file.sizeBytes,
        file.hash
      );
    }
  }).immediate();

  const runPromise = executeAccountEvacuationJobInternal(jobId).finally(() => {
    activeEvacuationJobs.delete(jobId);
  });
  activeEvacuationJobs.set(jobId, runPromise);

  if (wait) {
    return runPromise;
  }

  void runPromise.catch((err) => {
    if (!(err instanceof InsufficientStorageError) && !(err instanceof FileExceedsCeilingError)) {
      console.error(`Account evacuation job ${jobId} for ${accountId} failed:`, err);
    }
  });

  return readEvacuationJobResult(jobId, true, false);
}

export async function resumeAccountEvacuationJob(
  jobId: string,
  wait = false
): Promise<AccountEvacuationResult> {
  const existingPromise = activeEvacuationJobs.get(jobId);
  if (existingPromise) {
    return wait ? existingPromise : readEvacuationJobResult(jobId, true, false);
  }

  const job = sqlite
    .prepare(
      `SELECT id, status, pool_id as poolId, account_id as accountId
       FROM transfer_jobs
       WHERE id = ? AND kind = 'account_evacuate'
       LIMIT 1`
    )
    .get(jobId) as { id: string; status: string; poolId: number | null; accountId: string | null } | undefined;

  if (!job) {
    throw new ItemNotFoundError(`Account evacuation job '${jobId}' not found`);
  }
  if (job.status === 'completed') {
    return readEvacuationJobResult(jobId, false, false);
  }

  cancelledEvacuationJobs.delete(jobId);
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE transfer_job_items SET status = 'pending', last_error = NULL, updated_at = unixepoch()
         WHERE job_id = ? AND status IN ('failed', 'paused', 'running')`
      )
      .run(jobId);
    sqlite
      .prepare(
        `UPDATE transfer_jobs SET status = 'running', pause_reason = NULL, last_error = NULL, updated_at = unixepoch()
         WHERE id = ?`
      )
      .run(jobId);
  }).immediate();

  const runPromise = executeAccountEvacuationJobInternal(jobId).finally(() => {
    activeEvacuationJobs.delete(jobId);
  });
  activeEvacuationJobs.set(jobId, runPromise);

  if (wait) {
    return runPromise;
  }
  void runPromise.catch((err) => {
    console.error(`Resumed evacuation job ${jobId} failed:`, err);
  });
  return readEvacuationJobResult(jobId, true, false);
}

export async function cancelAccountEvacuationJob(jobId: string): Promise<AccountEvacuationResult> {
  const job = sqlite
    .prepare(`SELECT id, status FROM transfer_jobs WHERE id = ? AND kind = 'account_evacuate' LIMIT 1`)
    .get(jobId) as { id: string; status: string } | undefined;

  if (!job) {
    throw new ItemNotFoundError(`Account evacuation job '${jobId}' not found`);
  }

  cancelledEvacuationJobs.add(jobId);
  await revokeJobShares(jobId);

  if (!activeEvacuationJobs.has(jobId) && job.status !== 'completed') {
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

  return readEvacuationJobResult(jobId, false, false);
}
