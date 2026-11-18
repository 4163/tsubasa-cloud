import type { drive_v3 } from 'googleapis';
import { eq } from 'drizzle-orm';
import { authPool } from './auth.js';
import {
  getDriveClient,
  markAccountSyncError,
  refreshAccountLiveQuota,
} from './client.js';
import {
  ensureSharePoolExistsInDb,
  resolvePoolDriveFolderName,
  SHARE_POOL_RESERVE_ID,
} from './poolRegistry.js';
import {
  AccountPoolLockedError,
  isAuthInvalidError,
  isDriveNotFoundError,
  withDriveRetry,
} from './errors.js';
import { drainOutboxForAccount } from './outboxQueue.js';
import {
  checkRemoteRootFolderEmpty,
  ensureRootFolder,
  retargetRemoteRootFolder,
} from './remoteTree.js';
import { bumpPoolRevision, db, sqlite } from '../db/index.js';
import { accounts } from '../db/schema.js';

export interface AccountHydrationResult {
  accountId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  poolId: number;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  rootFolderId: string;
}

export async function hydrateAccount(
  accountId: string,
  preferredPoolId?: number
): Promise<AccountHydrationResult> {
  let canonicalAccountId = accountId;
  try {
    const drive = getDriveClient(accountId);

    const aboutRes = await withDriveRetry(() =>
      drive.about.get({
        fields: 'user,storageQuota',
      })
    );

    const user = aboutRes.data.user;
    const storage = aboutRes.data.storageQuota;

    if (!user?.emailAddress) {
      throw new Error(`Failed to retrieve user profile for account ${accountId}`);
    }

    const email = user.emailAddress.toLowerCase().trim();

    if (accountId.toLowerCase() !== email) {
      authPool.renameAccount(accountId, email);
      canonicalAccountId = email;
    }

    const existingAccount = await db.query.accounts.findFirst({
      where: eq(accounts.id, canonicalAccountId),
    });

    const fileCountRow = sqlite
      .prepare('SELECT count(*) as c FROM files WHERE account_id = ?')
      .get(canonicalAccountId) as { c: number } | undefined;
    const hasLocalFiles = (fileCountRow?.c ?? 0) > 0;

    const explicitPoolId =
      preferredPoolId ??
      (authPool.hasPreferredPool(canonicalAccountId)
        ? authPool.getPreferredPool(canonicalAccountId)
        : undefined);

    const targetPoolId = existingAccount
      ? existingAccount.poolId
      : (explicitPoolId ?? 1);
    const preferTargetWhenEmpty =
      !hasLocalFiles && (existingAccount !== undefined || explicitPoolId !== undefined);

    const { rootFolderId, poolId } = await ensureRootFolder(
      drive,
      targetPoolId,
      preferTargetWhenEmpty
    );
    authPool.setPreferredPool(canonicalAccountId, poolId);

    const quotaLimit = storage?.limit ? Number(storage.limit) : 16106127360; // 15 GB fallback
    const quotaUsed = storage?.usage ? Number(storage.usage) : 0;

    await db
      .insert(accounts)
      .values({
        id: canonicalAccountId,
        email: user.emailAddress,
        displayName: user.displayName || user.emailAddress.split('@')[0],
        avatarUrl: user.photoLink || null,
        poolId,
        quotaLimitBytes: quotaLimit,
        quotaUsedBytes: quotaUsed,
        syncState: 'idle',
        rootFolderId,
      })
      .onConflictDoUpdate({
        target: accounts.id,
        set: {
          email: user.emailAddress,
          displayName: user.displayName || user.emailAddress.split('@')[0],
          avatarUrl: user.photoLink || null,
          poolId,
          quotaLimitBytes: quotaLimit,
          quotaUsedBytes: quotaUsed,
          rootFolderId,
          updatedAt: new Date(),
        },
      });

    return {
      accountId: canonicalAccountId,
      email: user.emailAddress,
      displayName: user.displayName || user.emailAddress.split('@')[0],
      avatarUrl: user.photoLink || null,
      poolId,
      quotaLimitBytes: quotaLimit,
      quotaUsedBytes: quotaUsed,
      rootFolderId,
    };
  } catch (err) {
    if (isAuthInvalidError(err)) {
      await markAccountSyncError(canonicalAccountId);
    }
    throw err;
  }
}

async function inspectRemoteRootFolder(
  drive: drive_v3.Drive,
  folderId: string | null
): Promise<{ exists: boolean; name: string | null }> {
  if (!folderId) {
    return { exists: false, name: null };
  }
  try {
    const res = await withDriveRetry(() =>
      drive.files.get({
        fileId: folderId,
        fields: 'id, name, trashed',
        supportsAllDrives: false,
      })
    );
    if (!res.data.id || res.data.trashed) {
      return { exists: false, name: null };
    }
    return { exists: true, name: res.data.name ?? null };
  } catch (err) {
    if (isDriveNotFoundError(err)) {
      return { exists: false, name: null };
    }
    throw err;
  }
}

function assertNoDeadOutboxEntries(accountId: string): void {
  const deadOutboxRow = sqlite
    .prepare("SELECT count(*) as c FROM drive_outbox WHERE account_id = ? AND status = 'dead'")
    .get(accountId) as { c: number } | undefined;
  if ((deadOutboxRow?.c ?? 0) > 0) {
    throw new AccountPoolLockedError(
      'Cannot switch pool: unresolved failed Drive operations remain in the outbox for this account.'
    );
  }
}

export async function switchAccountPool(
  accountId: string,
  targetPoolId: number
): Promise<{ accountId: string; poolId: number; rootFolderId: string | null }> {
  if (targetPoolId === SHARE_POOL_RESERVE_ID) {
    ensureSharePoolExistsInDb();
  }

  const poolRow = sqlite
    .prepare('SELECT id FROM pools WHERE id = ?')
    .get(targetPoolId) as { id: number } | undefined;
  if (!poolRow) {
    throw new Error(`Target storage pool ${targetPoolId} does not exist`);
  }

  const fileCountRow = sqlite
    .prepare('SELECT count(*) as c FROM files WHERE account_id = ?')
    .get(accountId) as { c: number } | undefined;
  if ((fileCountRow?.c ?? 0) > 0) {
    throw new AccountPoolLockedError(
      'Cannot switch pool: this account already has files linked to its current pool.'
    );
  }

  const accountRecord = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });
  const authRecord = authPool.getRecord(accountId);

  if (!accountRecord) {
    authPool.setPreferredPool(accountId, targetPoolId);
    if (authRecord?.authorized) {
      const ensured = await ensureRootFolder(getDriveClient(accountId), targetPoolId, true);
      if (ensured.poolId !== targetPoolId) {
        throw new AccountPoolLockedError(
          'Cannot switch pool: this account already has files inside its Tsubasa folder on Google Drive.'
        );
      }
      return { accountId, poolId: targetPoolId, rootFolderId: ensured.rootFolderId };
    }
    return { accountId, poolId: targetPoolId, rootFolderId: null };
  }

  let resolvedRootFolderId = accountRecord.rootFolderId;

  if (authRecord?.authorized) {
    const drive = getDriveClient(accountId);
    const expectedFolderName = resolvePoolDriveFolderName(targetPoolId);
    const remoteFolder = await inspectRemoteRootFolder(drive, resolvedRootFolderId);

    if (
      accountRecord.poolId === targetPoolId &&
      remoteFolder.exists &&
      remoteFolder.name === expectedFolderName
    ) {
      authPool.setPreferredPool(accountId, targetPoolId);
      return { accountId, poolId: targetPoolId, rootFolderId: resolvedRootFolderId };
    }

    if (!remoteFolder.exists) {
      resolvedRootFolderId = null;
    }

    await drainOutboxForAccount(accountId);
    assertNoDeadOutboxEntries(accountId);

    const emptyCheck = await checkRemoteRootFolderEmpty(drive, resolvedRootFolderId);
    if (!emptyCheck.empty) {
      throw new AccountPoolLockedError(
        emptyCheck.reason === 'managed'
          ? 'Cannot switch pool: this account already has Tsubasa files in Google Drive.'
          : 'Cannot switch pool: this account has files inside its Tsubasa folder on Google Drive.'
      );
    }

    if (resolvedRootFolderId) {
      await retargetRemoteRootFolder(drive, resolvedRootFolderId, targetPoolId);
    } else {
      const ensured = await ensureRootFolder(drive, targetPoolId, true);
      if (ensured.poolId !== targetPoolId) {
        throw new AccountPoolLockedError(
          'Cannot switch pool: this account already has files inside its Tsubasa folder on Google Drive.'
        );
      }
      resolvedRootFolderId = ensured.rootFolderId;
    }
  } else if (accountRecord.poolId === targetPoolId) {
    authPool.setPreferredPool(accountId, targetPoolId);
    return { accountId, poolId: targetPoolId, rootFolderId: accountRecord.rootFolderId };
  } else {
    assertNoDeadOutboxEntries(accountId);
  }

  await db
    .update(accounts)
    .set({ poolId: targetPoolId, rootFolderId: resolvedRootFolderId, updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
  sqlite.prepare('DELETE FROM share_links WHERE account_id = ?').run(accountId);

  if (accountRecord.poolId !== targetPoolId) {
    bumpPoolRevision(accountRecord.poolId);
  }
  bumpPoolRevision(targetPoolId);

  authPool.setPreferredPool(accountId, targetPoolId);

  if (authRecord?.authorized) {
    await refreshAccountLiveQuota(accountId).catch((err) => {
      console.warn(`Quota refresh warning for ${accountId} during pool switch:`, err);
    });
  }

  return { accountId, poolId: targetPoolId, rootFolderId: resolvedRootFolderId };
}
