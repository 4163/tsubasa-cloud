import { google, type drive_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { authPool } from './auth.js';
import { isAuthInvalidError, withDriveRetry } from './errors.js';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const driveClientCache = new WeakMap<OAuth2Client, drive_v3.Drive>();

export async function markAccountSyncError(accountId: string): Promise<void> {
  await db
    .update(accounts)
    .set({ syncState: 'error', updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
}

const RECENT_DELETION_COOLDOWN_MS = 15_000;
const recentDeletionUntilMs = new Map<string, number>();

export function markAccountQuotaDecreased(
  accountId: string,
  cooldownMs = RECENT_DELETION_COOLDOWN_MS
): void {
  recentDeletionUntilMs.set(accountId, Date.now() + cooldownMs);
}

export async function refreshAccountLiveQuota(accountId: string): Promise<number | null> {
  if (!authPool.getRecord(accountId)?.authorized) {
    return null;
  }

  const drive = getDriveClient(accountId);
  let aboutRes: { data: drive_v3.Schema$About };
  try {
    aboutRes = await withDriveRetry(() => drive.about.get({ fields: 'storageQuota' }));
  } catch (err) {
    if (isAuthInvalidError(err)) {
      await markAccountSyncError(accountId);
    }
    throw err;
  }
  const storage = aboutRes.data.storageQuota;

  const liveUsage = Number(storage?.usage ?? NaN);
  if (!Number.isFinite(liveUsage)) {
    return null;
  }

  const existing = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });
  if (!existing) {
    return null;
  }

  const untilMs = recentDeletionUntilMs.get(accountId) ?? 0;
  let nextUsage: number;
  if (Date.now() < untilMs) {
    // Clamp against stale pre-deletion Drive quota while Google's backend settles.
    nextUsage = Math.min(existing.quotaUsedBytes, liveUsage);
  } else {
    if (untilMs > 0) {
      recentDeletionUntilMs.delete(accountId);
    }
    nextUsage = liveUsage;
  }

  const liveLimit = storage?.limit ? Number(storage.limit) : NaN;
  const nextLimit =
    Number.isFinite(liveLimit) && liveLimit > 0 ? liveLimit : existing.quotaLimitBytes;

  await db
    .update(accounts)
    .set({
      quotaUsedBytes: nextUsage,
      quotaLimitBytes: nextLimit,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));

  return nextUsage;
}

export function getDriveClient(clientOrId: string | OAuth2Client): drive_v3.Drive {
  const authClient =
    typeof clientOrId === 'string' ? authPool.getClient(clientOrId) : clientOrId;

  if (!authClient) {
    throw new Error(`Account ${String(clientOrId)} not found in auth pool`);
  }

  let cached = driveClientCache.get(authClient);
  if (!cached) {
    cached = google.drive({ version: 'v3', auth: authClient });
    driveClientCache.set(authClient, cached);
  }
  return cached;
}

export async function getAccessToken(accountId: string): Promise<string> {
  const authClient = authPool.getClient(accountId);
  if (!authClient) {
    throw new Error(`Account ${accountId} not registered in auth pool`);
  }
  const tokenInfo = await authClient.getAccessToken();
  if (!tokenInfo.token) {
    throw new Error(`Failed to acquire Google access token for account ${accountId}`);
  }
  return tokenInfo.token;
}
