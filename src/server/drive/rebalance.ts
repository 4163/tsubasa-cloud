import path from 'node:path';
import { db } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { getDriveClient } from './client.js';
import { ensureRemoteFolderHierarchy, normalizeVirtualPath } from './mirror.js';
import { authPool } from './auth.js';
import {
  calculateHeadroom,
  getAccountTransferStats,
  recordTransfer,
  MAX_SINGLE_FILE_BYTES,
  InsufficientStorageError,
  type AccountTransferStats,
} from '../storage/index.js';
import { findFolderAffinityAccounts } from '../storage/placement.js';

export interface RebalanceOperationResult {
  fileId: string;
  virtualPath: string;
  sourceAccountId: string;
  targetAccountId: string;
  newDriveFileId: string;
  bytesMoved: number;
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
  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!file) {
    throw new Error(`File ${fileId} not found`);
  }

  const sourceAccountId = file.accountId;
  if (sourceAccountId === targetAccountId) {
    throw new Error('Target account must be different from source account');
  }

  const targetAccount = await db.query.accounts.findFirst({
    where: eq(accounts.id, targetAccountId),
  });

  if (!targetAccount || !targetAccount.rootFolderId) {
    throw new Error(`Target account ${targetAccountId} not registered or missing root folder`);
  }

  if (targetAccount.isDisabled) {
    throw new Error(`Target account ${targetAccountId} is disabled`);
  }

  const targetHeadroom = calculateHeadroom(
    targetAccount.quotaLimitBytes,
    targetAccount.quotaUsedBytes
  );

  if (targetHeadroom < file.sizeBytes) {
    throw new InsufficientStorageError(
      `Target account ${targetAccountId} does not have enough headroom for ${file.sizeBytes} bytes`
    );
  }

  // Google Drive server-side copy consumes target account's 750 GB daily upload limit
  const targetTransferStats = await getAccountTransferStats(targetAccountId);
  if (targetTransferStats.remainingUploadBytes24h < file.sizeBytes) {
    throw new InsufficientStorageError(
      `Target account ${targetAccountId} has insufficient Google 750 GB daily transfer quota (${targetTransferStats.remainingUploadBytes24h} bytes remaining, requires ${file.sizeBytes} bytes)`
    );
  }

  const driveSource = getDriveClient(sourceAccountId);
  const driveTarget = getDriveClient(targetAccountId);

  // Share source file with target account to allow server-side copy
  const shareRes = await driveSource.permissions.create({
    fileId: file.driveFileId,
    requestBody: {
      role: 'reader',
      type: 'user',
      emailAddress: targetAccount.email,
    },
    supportsAllDrives: false,
  });

  const permissionId = shareRes.data.id;

  try {
    const parentDir = path.posix.dirname(file.virtualPath);
    const targetFolderId = await ensureRemoteFolderHierarchy(
      driveTarget,
      targetAccount.rootFolderId,
      parentDir
    );

    // Google server-side copy creates copy without downloading to local disk
    const copyRes = await driveTarget.files.copy({
      fileId: file.driveFileId,
      requestBody: {
        name: file.name,
        parents: [targetFolderId],
        appProperties: {
          tsubasa_managed: 'true',
          tsubasa_virtual_path: file.virtualPath,
          tsubasa_virtual_id: file.id,
          tsubasa_checksum: file.hash || '',
        },
      },
      fields: 'id, name, size, mimeType, md5Checksum',
      supportsAllDrives: false,
    });

    const newDriveFileId = copyRes.data.id;
    if (!newDriveFileId) {
      throw new Error('Google Drive server-side copy failed to return new file ID');
    }

    if (file.isTrashed) {
      try {
        await driveTarget.files.update({
          fileId: newDriveFileId,
          requestBody: { trashed: true },
          supportsAllDrives: false,
        });
      } catch (err) {
        console.warn(`Failed to preserve trashed state on copied file ${newDriveFileId}:`, err);
      }
    }

    // Delete original file from source account
    await driveSource.files.delete({
      fileId: file.driveFileId,
      supportsAllDrives: false,
    });

    // Update SQLite index and accounts quota usage
    await db
      .update(files)
      .set({
        accountId: targetAccountId,
        driveFileId: newDriveFileId,
        updatedAt: new Date(),
      })
      .where(eq(files.id, file.id));

    await db
      .update(accounts)
      .set({
        quotaUsedBytes: sql`MAX(0, ${accounts.quotaUsedBytes} - ${file.sizeBytes})`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, sourceAccountId));

    await db
      .update(accounts)
      .set({
        quotaUsedBytes: sql`${accounts.quotaUsedBytes} + ${file.sizeBytes}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, targetAccountId));

    // Server-side copy consumes target account's 750 GB daily upload/copy limit
    await recordTransfer(targetAccountId, 'upload', file.sizeBytes);

    return {
      fileId: file.id,
      virtualPath: file.virtualPath,
      sourceAccountId,
      targetAccountId,
      newDriveFileId,
      bytesMoved: file.sizeBytes,
    };
  } finally {
    // Clean up temporary permission if file still exists on source
    if (permissionId) {
      try {
        await driveSource.permissions.delete({
          fileId: file.driveFileId,
          permissionId,
          supportsAllDrives: false,
        });
      } catch {
        // Ignored if source file was already deleted
      }
    }
  }
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

  const usable = account.quotaLimitBytes - 750 * 1024 * 1024;
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
  const plan = await planAccountRebalance(sourceAccountId);
  if (!plan || plan.candidateFiles.length === 0) {
    return [];
  }

  const allAccounts = await db.query.accounts.findMany();
  const targetCandidates = allAccounts.filter((a) => a.id !== sourceAccountId && !a.isDisabled);

  // Pre-fetch initial headroom and 24h transfer quotas for all target candidate accounts
  const targetStates: Array<{
    id: string;
    headroomBytes: number;
    remainingDailyBytes: number;
  }> = [];

  for (const cand of targetCandidates) {
    const headroom = calculateHeadroom(cand.quotaLimitBytes, cand.quotaUsedBytes);
    const transferStats = await getAccountTransferStats(cand.id);
    targetStates.push({
      id: cand.id,
      headroomBytes: headroom,
      remainingDailyBytes: transferStats.remainingUploadBytes24h,
    });
  }

  let remainingExcess = plan.excessBytes;
  const results: RebalanceOperationResult[] = [];

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

    try {
      const res = await rebalanceFile(candidateFile.id, chosenTarget.id);
      results.push(res);
      remainingExcess -= candidateFile.sizeBytes;

      // Update simulated headroom and daily transfer budget for subsequent files
      chosenTarget.headroomBytes -= candidateFile.sizeBytes;
      chosenTarget.remainingDailyBytes -= candidateFile.sizeBytes;
    } catch (err) {
      console.error(`Auto-rebalance failed for file ${candidateFile.id} onto target ${chosenTarget.id}:`, err);
    }
  }

  return results;
}

function formatBytes(bytes: number): string {
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
    (a) => a.id !== sourceAccountId && !a.isDisabled && a.syncState !== 'error'
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

  const targetStates: TargetState[] = [];
  for (const cand of candidateAccounts) {
    const headroom = calculateHeadroom(cand.quotaLimitBytes, cand.quotaUsedBytes);
    const transferStats = await getAccountTransferStats(cand.id, nowMs);
    targetStates.push({
      account: cand,
      headroomBytes: headroom,
      remainingDailyBytes: transferStats.remainingUploadBytes24h,
      transferStats,
    });
  }

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

    const affinityAccountIds = await findFolderAffinityAccounts(normalizedPath);
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

    const curHeadroom = simulatedHeadrooms.get(chosenTarget.account.id) ?? 0;
    const curBudget = simulatedBudgets.get(chosenTarget.account.id) ?? 0;
    simulatedHeadrooms.set(chosenTarget.account.id, curHeadroom - file.sizeBytes);
    simulatedBudgets.set(chosenTarget.account.id, curBudget - file.sizeBytes);

    plan.push({ file, targetAccountId: chosenTarget.account.id });
  }

  // Pre-flight passed: execute all transfers
  const transfers: RebalanceOperationResult[] = [];
  let bytesMoved = 0;

  for (const step of plan) {
    const res = await rebalanceFile(step.file.id, step.targetAccountId);
    transfers.push(res);
    bytesMoved += step.file.sizeBytes;
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
    evacuationResult = await evacuateAccountFiles(accountId);
    await db.delete(accounts).where(eq(accounts.id, accountId));
  }

  authPool.removeAccount(accountId);

  return {
    ...evacuationResult,
    removed: true,
  };
}

