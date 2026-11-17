import path from 'node:path';
import { bumpPoolRevision, db, sqlite } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { getDriveClient, runBoundedConcurrency, withDriveRetry } from './client.js';
import { copyDriveFileCrossAccount } from './transfer.js';
import { deleteRemoteFileIgnoreNotFound, enqueueDriveOutbox } from './outbox.js';
import { clearRemoteFolderCache, ensureRemoteFolderHierarchy, normalizeVirtualPath } from './mirror.js';
import { authPool } from './auth.js';
import { invalidateDiscrepancyCache } from './detector.js';
import {
  calculateHeadroom,
  calculateUsableLimit,
  getAccountTransferStats,
  recordTransferSync,
  InsufficientStorageError,
  type AccountTransferStats,
} from '../storage/index.js';
import { getTransferStatsByAccountMap } from '../storage/quota.js';
import { buildPoolFolderAffinityMap } from '../storage/placement.js';

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
        appProperties: {
          tsubasa_managed: 'true',
          tsubasa_virtual_path: file.virtualPath,
          tsubasa_virtual_id: file.id,
          tsubasa_checksum: file.hash || '',
        },
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

  // Pre-fetch initial headroom and 24h transfer quotas for all target candidate accounts
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

    // Filter candidate target accounts that have BOTH sufficient headroom AND daily transfer quota
    const eligibleTargets = targetStates.filter(
      (t) => t.headroomBytes >= candidateFile.sizeBytes && t.remainingDailyBytes >= candidateFile.sizeBytes
    );

    if (eligibleTargets.length === 0) {
      console.warn(
        `Auto-rebalance: No candidate account has both headroom and daily transfer quota for ${candidateFile.virtualPath} (${candidateFile.sizeBytes} bytes)`
      );
      continue;
    }

    // Pick target account with largest headroom among eligible
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

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export interface EvacuationResult {
  sourceAccountId: string;
  filesMoved: number;
  bytesMoved: number;
  transfers: RebalanceOperationResult[];
}

export async function evacuateAccountFiles(sourceAccountId: string): Promise<EvacuationResult> {
  const sourceAccount = await db.query.accounts.findFirst({
    where: eq(accounts.id, sourceAccountId),
  });

  if (!sourceAccount) {
    throw new Error(`Account ${sourceAccountId} not found`);
  }

  const accountFiles = await db.query.files.findMany({
    where: eq(files.accountId, sourceAccountId),
  });

  if (accountFiles.length === 0) {
    return {
      sourceAccountId,
      filesMoved: 0,
      bytesMoved: 0,
      transfers: [],
    };
  }

  const allAccounts = await db.query.accounts.findMany();
  const candidateAccounts = allAccounts.filter(
    (a) =>
      a.poolId === sourceAccount.poolId &&
      a.id !== sourceAccountId &&
      !a.isDisabled &&
      a.syncState !== 'error'
  );

  if (candidateAccounts.length === 0) {
    throw new InsufficientStorageError(
      'Cannot disable or remove drive: no other active accounts available in the storage pool to receive files.'
    );
  }

  const nowMs = Date.now();
  interface TargetState {
    account: typeof allAccounts[0];
    headroomBytes: number;
    remainingDailyBytes: number;
    transferStats: AccountTransferStats;
  }

  const transferStatsByAccount = await getTransferStatsByAccountMap(
    candidateAccounts.map((cand) => cand.id),
    nowMs
  );
  const targetStates: TargetState[] = candidateAccounts.map((cand) => {
    const transferStats = transferStatsByAccount.get(cand.id)!;
    return {
      account: cand,
      headroomBytes: calculateHeadroom(cand.quotaLimitBytes, cand.quotaUsedBytes),
      remainingDailyBytes: transferStats.remainingUploadBytes24h,
      transferStats,
    };
  });

  const totalBytesToMove = accountFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
  const totalAvailableHeadroom = targetStates.reduce((sum, t) => sum + t.headroomBytes, 0);
  const totalAvailableDailyBudget = targetStates.reduce((sum, t) => sum + t.remainingDailyBytes, 0);

  if (totalAvailableHeadroom < totalBytesToMove) {
    throw new InsufficientStorageError(
      `Cannot disable or remove drive: insufficient pool headroom. Evacuating files requires ${formatBytes(totalBytesToMove)}, but remaining active accounts only have ${formatBytes(totalAvailableHeadroom)} free headroom.`
    );
  }

  if (totalAvailableDailyBudget < totalBytesToMove) {
    const activeResets = targetStates
      .map((t) => t.transferStats.nextResetMs)
      .filter((ms): ms is number => typeof ms === 'number' && ms > 0);
    const minResetMs = activeResets.length > 0 ? Math.min(...activeResets) : null;
    const graceMsg = minResetMs ? ` Quota frees in ${formatCountdown(minResetMs)}.` : '';
    throw new InsufficientStorageError(
      `Cannot disable or remove drive: 24-hour transfer quota limit exceeded. Evacuating files requires ${formatBytes(totalBytesToMove)}, but remaining active accounts only have ${formatBytes(totalAvailableDailyBudget)} daily transfer quota remaining.${graceMsg}`
    );
  }

  // Pre-flight simulation using Folder-Cohesion Best-Fit
  const simulatedHeadrooms = new Map<string, number>(
    targetStates.map((t) => [t.account.id, t.headroomBytes])
  );
  const simulatedBudgets = new Map<string, number>(
    targetStates.map((t) => [t.account.id, t.remainingDailyBytes])
  );

  const plan: Array<{ file: FileRecord; targetAccountId: string }> = [];
  const sortedFiles = [...accountFiles].sort((a, b) => b.sizeBytes - a.sizeBytes);
  const affinityMap = await buildPoolFolderAffinityMap(sourceAccount.poolId);

  for (const file of sortedFiles) {
    const normalizedPath = normalizeVirtualPath(file.virtualPath);

    const eligible = targetStates.filter((t) => {
      const h = simulatedHeadrooms.get(t.account.id) ?? 0;
      const b = simulatedBudgets.get(t.account.id) ?? 0;
      return h >= file.sizeBytes && b >= file.sizeBytes;
    });

    if (eligible.length === 0) {
      const hasHeadroomCandidate = targetStates.some(
        (t) => (simulatedHeadrooms.get(t.account.id) ?? 0) >= file.sizeBytes
      );

      if (hasHeadroomCandidate) {
        const activeResets = targetStates
          .map((t) => t.transferStats.nextResetMs)
          .filter((ms): ms is number => typeof ms === 'number' && ms > 0);
        const minResetMs = activeResets.length > 0 ? Math.min(...activeResets) : null;
        const graceMsg = minResetMs ? ` Quota frees in ${formatCountdown(minResetMs)}.` : '';
        throw new InsufficientStorageError(
          `Cannot disable or remove drive: daily transfer quota limit exceeded for "${file.name}" (${formatBytes(file.sizeBytes)}).${graceMsg}`
        );
      }

      throw new InsufficientStorageError(
        `Cannot disable or remove drive: no individual active account has enough free headroom to hold "${file.name}" (${formatBytes(file.sizeBytes)}).`
      );
    }

    const affinityAccountIds = affinityMap.getAffinityAccounts(normalizedPath);
    let chosenTarget = eligible.find((t) => affinityAccountIds.includes(t.account.id));

    if (!chosenTarget) {
      chosenTarget = eligible[0];
      let minDiff = (simulatedHeadrooms.get(chosenTarget.account.id) ?? 0) - file.sizeBytes;
      for (let i = 1; i < eligible.length; i++) {
        const diff = (simulatedHeadrooms.get(eligible[i].account.id) ?? 0) - file.sizeBytes;
        if (diff < minDiff) {
          minDiff = diff;
          chosenTarget = eligible[i];
        }
      }
    }

    affinityMap.recordAssignment(normalizedPath, chosenTarget.account.id);

    const curHeadroom = simulatedHeadrooms.get(chosenTarget.account.id) ?? 0;
    const curBudget = simulatedBudgets.get(chosenTarget.account.id) ?? 0;
    simulatedHeadrooms.set(chosenTarget.account.id, curHeadroom - file.sizeBytes);
    simulatedBudgets.set(chosenTarget.account.id, curBudget - file.sizeBytes);

    plan.push({ file, targetAccountId: chosenTarget.account.id });
  }

  // Pre-flight passed: execute all transfers grouped by target account
  const groupedByTarget = new Map<string, string[]>();
  for (const step of plan) {
    const existing = groupedByTarget.get(step.targetAccountId);
    if (existing) {
      existing.push(step.file.id);
    } else {
      groupedByTarget.set(step.targetAccountId, [step.file.id]);
    }
  }

  const transfers: RebalanceOperationResult[] = [];
  let bytesMoved = 0;

  for (const [targetAccountId, fileIds] of groupedByTarget) {
    const batchResult = await rebalanceFilesBatch(fileIds, targetAccountId);
    transfers.push(...batchResult.results);
    bytesMoved += batchResult.totalBytesMoved;
  }

  return {
    sourceAccountId,
    filesMoved: transfers.length,
    bytesMoved,
    transfers,
  };
}

export async function disableDriveAccount(accountId: string): Promise<{ success: boolean; accountId: string }> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  await db
    .update(accounts)
    .set({
      isDisabled: true,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));

  return { success: true, accountId };
}

export async function enableDriveAccount(accountId: string): Promise<{ success: boolean; accountId: string }> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  await db
    .update(accounts)
    .set({
      isDisabled: false,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));

  return { success: true, accountId };
}

export async function removeDriveAccount(
  accountId: string
): Promise<EvacuationResult & { removed: boolean }> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  let evacuationResult: EvacuationResult = {
    sourceAccountId: accountId,
    filesMoved: 0,
    bytesMoved: 0,
    transfers: [],
  };

  if (account) {
    if (!account.isDisabled) {
      await db
        .update(accounts)
        .set({
          isDisabled: true,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId));
    }

    evacuationResult = await evacuateAccountFiles(accountId);

    const deleteAccountIfEmpty = sqlite.transaction(() => {
      const row = sqlite
        .prepare<[string], { cnt: number }>('SELECT COUNT(*) AS cnt FROM files WHERE account_id = ?')
        .get(accountId);
      const cnt = row?.cnt ?? 0;
      if (cnt > 0) {
        throw new Error(`Cannot remove account ${accountId}: ${cnt} file(s) still remain on account`);
      }
      sqlite.prepare<[string]>('DELETE FROM accounts WHERE id = ?').run(accountId);
    });
    deleteAccountIfEmpty.immediate();

    bumpPoolRevision(account.poolId);
    invalidateDiscrepancyCache(accountId);
    if (account.rootFolderId) {
      clearRemoteFolderCache(account.rootFolderId);
    }
  }

  authPool.removeAccount(accountId);

  return {
    ...evacuationResult,
    removed: true,
  };
}

