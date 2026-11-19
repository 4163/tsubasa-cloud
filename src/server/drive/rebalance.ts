import path from 'node:path';
import { bumpPoolRevision, db, sqlite } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { getDriveClient } from './client.js';
import { runBoundedConcurrency, withDriveRetry } from './errors.js';
import { buildTsubasaAppProperties } from './appProperties.js';
import { copyDriveFileCrossAccount } from './crossAccountCopy.js';
import { deleteRemoteFileIgnoreNotFound } from './outboxExecutors.js';
import { enqueueDriveOutbox } from './outbox.js';
import { ensureRemoteFolderHierarchy } from './mirror.js';
import { invalidateDiscrepancyCache } from './discrepancyCache.js';
import {
  calculateHeadroom,
  calculateUsableLimit,
  getAccountTransferStats,
  recordTransferSync,
  InsufficientStorageError,
} from '../storage/index.js';
import { getTransferStatsByAccountMap } from '../storage/quota.js';

export class RebalanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RebalanceValidationError';
  }
}

export interface RebalanceOperationResult {
  fileId: string;
  virtualPath: string;
  sourceAccountId: string;
  targetAccountId: string;
  newDriveFileId: string;
  bytesMoved: number;
}

export interface BatchRebalanceResult {
  sourceAccountId: string;
  targetAccountId: string;
  totalFiles: number;
  totalBytesMoved: number;
  results: RebalanceOperationResult[];
}

export interface AccountRebalancePlan {
  sourceAccountId: string;
  excessBytes: number;
  candidateFiles: FileRecord[];
}

export async function rebalanceFile(
  fileId: string,
  targetAccountId: string
): Promise<RebalanceOperationResult> {
  const batch = await rebalanceFilesBatch([fileId], targetAccountId);
  const result = batch.results[0];
  if (!result) {
    throw new Error(`Failed to rebalance file ${fileId}`);
  }
  return result;
}

function prepareRebalanceCommitStmts() {
  return {
    updateFile: sqlite.prepare<[string, string, string]>(
      'UPDATE files SET account_id = ?, drive_file_id = ?, updated_at = unixepoch() WHERE id = ?'
    ),
    decrementSourceQuota: sqlite.prepare<[number, string]>(
      'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
    ),
    incrementTargetQuota: sqlite.prepare<[number, string]>(
      'UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?'
    ),
  };
}

let _rebalanceCommitStmts: ReturnType<typeof prepareRebalanceCommitStmts> | null = null;

function getRebalanceCommitStmts() {
  if (!_rebalanceCommitStmts) {
    _rebalanceCommitStmts = prepareRebalanceCommitStmts();
  }
  return _rebalanceCommitStmts;
}

export async function rebalanceFilesBatch(
  fileIds: string[],
  targetAccountId: string
): Promise<BatchRebalanceResult> {
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    throw new RebalanceValidationError('fileIds must be a non-empty array');
  }

  const uniqueFileIds = Array.from(new Set(fileIds));

  const batchFiles = await db.query.files.findMany({
    where: inArray(files.id, uniqueFileIds),
  });

  if (batchFiles.length !== uniqueFileIds.length) {
    const foundIds = new Set(batchFiles.map((f) => f.id));
    const missing = uniqueFileIds.filter((id) => !foundIds.has(id));
    if (uniqueFileIds.length === 1 && missing.length === 1) {
      throw new RebalanceValidationError(`File ${missing[0]} not found`);
    }
    throw new RebalanceValidationError(`Files not found: ${missing.join(', ')}`);
  }

  const sourceAccountId = batchFiles[0].accountId;
  const hasMultipleSources = batchFiles.some((f) => f.accountId !== sourceAccountId);
  if (hasMultipleSources) {
    throw new RebalanceValidationError('All files in a single batch rebalance must belong to the same source account');
  }

  if (sourceAccountId === targetAccountId) {
    throw new RebalanceValidationError('Target account must be different from source account');
  }

  const sourceAccount = await db.query.accounts.findFirst({
    where: eq(accounts.id, sourceAccountId),
  });

  if (!sourceAccount) {
    throw new RebalanceValidationError(`Source account ${sourceAccountId} not registered`);
  }

  const targetAccount = await db.query.accounts.findFirst({
    where: eq(accounts.id, targetAccountId),
  });

  if (!targetAccount || !targetAccount.rootFolderId) {
    throw new RebalanceValidationError(`Target account ${targetAccountId} not registered or missing root folder`);
  }

  if (targetAccount.poolId !== sourceAccount.poolId) {
    throw new RebalanceValidationError('Cannot rebalance files across different storage pools');
  }

  if (targetAccount.isDisabled) {
    throw new RebalanceValidationError(`Target account ${targetAccountId} is disabled`);
  }

  const totalBytes = batchFiles.reduce((sum, f) => sum + f.sizeBytes, 0);

  const targetHeadroom = calculateHeadroom(
    targetAccount.quotaLimitBytes,
    targetAccount.quotaUsedBytes
  );

  if (targetHeadroom < totalBytes) {
    throw new InsufficientStorageError(
      `Target account ${targetAccountId} does not have enough headroom for batch of ${totalBytes} bytes`
    );
  }

  const targetTransferStats = await getAccountTransferStats(targetAccountId);
  if (targetTransferStats.remainingUploadBytes24h < totalBytes) {
    throw new InsufficientStorageError(
      `Target account ${targetAccountId} has insufficient Google 750 GB daily transfer quota (${targetTransferStats.remainingUploadBytes24h} bytes remaining, requires ${totalBytes} bytes)`
    );
  }

  const driveSource = getDriveClient(sourceAccountId);
  const driveTarget = getDriveClient(targetAccountId);
  const targetRootFolderId = targetAccount.rootFolderId;
  const results: RebalanceOperationResult[] = [];
  let totalBytesMoved = 0;

  try {
    await runBoundedConcurrency(batchFiles, 5, async (file) => {
      const parentDir = path.posix.dirname(file.virtualPath);
      const targetFolderId = await ensureRemoteFolderHierarchy(
        driveTarget,
        targetRootFolderId,
        parentDir
      );

      const newDriveFileId = await copyDriveFileCrossAccount({
        sourceAccountId,
        sourceDriveFileId: file.driveFileId,
        targetAccountId,
        targetAccountEmail: targetAccount.email,
        targetRemoteFolderId: targetFolderId,
        destFileName: file.name,
        appProperties: buildTsubasaAppProperties({
          virtualPath: file.virtualPath,
          virtualId: file.id,
          checksum: file.hash,
          includeChecksum: true,
        }),
        fields: 'id, name, size, mimeType, md5Checksum',
      });

      if (file.isTrashed) {
        try {
          await withDriveRetry(() =>
            driveTarget.files.update({
              fileId: newDriveFileId,
              requestBody: { trashed: true },
              supportsAllDrives: false,
            })
          );
        } catch (err) {
          console.warn(`Failed to preserve trashed state on copied file ${newDriveFileId}:`, err);
          enqueueDriveOutbox([
            {
              accountId: targetAccountId,
              poolId: targetAccount.poolId,
              opType: 'file_trash',
              driveFileId: newDriveFileId,
              payload: { fileId: file.id, driveFileId: newDriveFileId },
            },
          ]);
        }
      }

      const stmts = getRebalanceCommitStmts();
      sqlite.transaction(() => {
        stmts.updateFile.run(targetAccountId, newDriveFileId, file.id);
        stmts.decrementSourceQuota.run(file.sizeBytes, sourceAccountId);
        stmts.incrementTargetQuota.run(file.sizeBytes, targetAccountId);
        recordTransferSync(targetAccountId, 'upload', file.sizeBytes, Date.now(), sourceAccount.poolId);
      }).immediate();

      try {
        await deleteRemoteFileIgnoreNotFound(driveSource, file.driveFileId);
      } catch (err) {
        console.warn(`Failed to delete source Drive file ${file.driveFileId} after rebalance:`, err);
        enqueueDriveOutbox([
          {
            accountId: sourceAccountId,
            poolId: sourceAccount.poolId,
            opType: 'file_delete',
            driveFileId: file.driveFileId,
            payload: { fileId: file.id, driveFileId: file.driveFileId },
          },
        ]);
      }

      totalBytesMoved += file.sizeBytes;
      results.push({
        fileId: file.id,
        virtualPath: file.virtualPath,
        sourceAccountId,
        targetAccountId,
        newDriveFileId,
        bytesMoved: file.sizeBytes,
      });
    });
  } finally {
    if (results.length > 0) {
      bumpPoolRevision(sourceAccount.poolId);
      invalidateDiscrepancyCache(sourceAccountId);
      invalidateDiscrepancyCache(targetAccountId);
    }
  }

  return {
    sourceAccountId,
    targetAccountId,
    totalFiles: results.length,
    totalBytesMoved,
    results,
  };
}

export async function planAccountRebalance(
  sourceAccountId: string
): Promise<AccountRebalancePlan | null> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, sourceAccountId),
  });

  if (!account) {
    throw new Error(`Account ${sourceAccountId} not found`);
  }

  const usable = calculateUsableLimit(account.quotaLimitBytes);
  if (account.quotaUsedBytes <= usable) {
    return null;
  }

  const excessBytes = account.quotaUsedBytes - usable;
  const candidateFiles = await db.query.files.findMany({
    where: eq(files.accountId, sourceAccountId),
    orderBy: (files, { desc }) => [desc(files.sizeBytes)],
  });

  return {
    sourceAccountId,
    excessBytes,
    candidateFiles,
  };
}

export async function executeAutoRebalance(
  sourceAccountId: string
): Promise<RebalanceOperationResult[]> {
  const sourceAccount = await db.query.accounts.findFirst({
    where: eq(accounts.id, sourceAccountId),
  });

  if (!sourceAccount) {
    throw new Error(`Source account ${sourceAccountId} not found`);
  }

  const plan = await planAccountRebalance(sourceAccountId);
  if (!plan || plan.candidateFiles.length === 0) {
    return [];
  }

  const allAccounts = await db.query.accounts.findMany();
  const targetCandidates = allAccounts.filter(
    (a) => a.poolId === sourceAccount.poolId && a.id !== sourceAccountId && !a.isDisabled
  );

  const transferStatsByAccount = await getTransferStatsByAccountMap(
    targetCandidates.map((cand) => cand.id)
  );
  const targetStates = targetCandidates.map((cand) => ({
    id: cand.id,
    headroomBytes: calculateHeadroom(cand.quotaLimitBytes, cand.quotaUsedBytes),
    remainingDailyBytes: transferStatsByAccount.get(cand.id)!.remainingUploadBytes24h,
  }));

  let remainingExcess = plan.excessBytes;
  const groupedByTarget = new Map<string, string[]>();

  for (const candidateFile of plan.candidateFiles) {
    if (remainingExcess <= 0) break;

    const eligibleTargets = targetStates.filter(
      (t) => t.headroomBytes >= candidateFile.sizeBytes && t.remainingDailyBytes >= candidateFile.sizeBytes
    );

    if (eligibleTargets.length === 0) {
      console.warn(
        `Auto-rebalance: No candidate account has both headroom and daily transfer quota for ${candidateFile.virtualPath} (${candidateFile.sizeBytes} bytes)`
      );
      continue;
    }

    eligibleTargets.sort((a, b) => b.headroomBytes - a.headroomBytes);
    const chosenTarget = eligibleTargets[0];

    const existing = groupedByTarget.get(chosenTarget.id);
    if (existing) {
      existing.push(candidateFile.id);
    } else {
      groupedByTarget.set(chosenTarget.id, [candidateFile.id]);
    }

    remainingExcess -= candidateFile.sizeBytes;
    chosenTarget.headroomBytes -= candidateFile.sizeBytes;
    chosenTarget.remainingDailyBytes -= candidateFile.sizeBytes;
  }

  const results: RebalanceOperationResult[] = [];
  const batchErrors: unknown[] = [];
  for (const [targetAccountId, fileIds] of groupedByTarget) {
    try {
      const batchResult = await rebalanceFilesBatch(fileIds, targetAccountId);
      results.push(...batchResult.results);
    } catch (err) {
      console.error(`Auto-rebalance failed for target ${targetAccountId}:`, err);
      batchErrors.push(err);
    }
  }

  if (batchErrors.length > 0) {
    if (batchErrors.length === 1) {
      throw batchErrors[0];
    }
    throw new AggregateError(
      batchErrors,
      `Auto-rebalance failed for ${batchErrors.length} target account(s)`
    );
  }

  return results;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(2)} ${sizes[i]}`;
}

