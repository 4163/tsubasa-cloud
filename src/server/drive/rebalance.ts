import path from 'node:path';
import { db } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { getDriveClient } from './client.js';
import { ensureRemoteFolderHierarchy } from './mirror.js';
import {
  calculateHeadroom,
  MAX_SINGLE_FILE_BYTES,
  InsufficientStorageError,
} from '../storage/index.js';

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

  const targetHeadroom = calculateHeadroom(
    targetAccount.quotaLimitBytes,
    targetAccount.quotaUsedBytes
  );

  if (targetHeadroom < file.sizeBytes) {
    throw new InsufficientStorageError(
      `Target account ${targetAccountId} does not have enough headroom for ${file.sizeBytes} bytes`
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
  const targetCandidates = allAccounts.filter((a) => a.id !== sourceAccountId);

  let remainingExcess = plan.excessBytes;
  const results: RebalanceOperationResult[] = [];

  for (const candidateFile of plan.candidateFiles) {
    if (remainingExcess <= 0) break;

    // Pick target account with largest headroom
    let bestTarget = targetCandidates[0];
    let maxHeadroom = calculateHeadroom(bestTarget.quotaLimitBytes, bestTarget.quotaUsedBytes);

    for (const cand of targetCandidates) {
      const hr = calculateHeadroom(cand.quotaLimitBytes, cand.quotaUsedBytes);
      if (hr > maxHeadroom) {
        maxHeadroom = hr;
        bestTarget = cand;
      }
    }

    if (maxHeadroom >= candidateFile.sizeBytes) {
      const res = await rebalanceFile(candidateFile.id, bestTarget.id);
      results.push(res);
      remainingExcess -= candidateFile.sizeBytes;
      bestTarget.quotaUsedBytes += candidateFile.sizeBytes;
    }
  }

  return results;
}

