import { db } from '../db/index.js';
import { accounts, files, transferLogs } from '../db/schema.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

// Safety reserve strictly set aside to protect Gmail, Google Photos, and system metadata
export const SAFETY_BUFFER_BYTES = 750 * 1024 * 1024; // 750 MB

// Hard single-file upload ceiling per account
export const MAX_SINGLE_FILE_BYTES = 14.25 * 1024 * 1024 * 1024; // 14.25 GB

// Google Drive per-account rolling 24-hour upload limit
export const DAILY_UPLOAD_LIMIT_BYTES = 750 * 1024 * 1024 * 1024; // 750 GB

export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AccountTransferStats {
  accountId: string;
  rollingWindowMs: number;
  uploadedBytes24h: number;
  remainingUploadBytes24h: number;
  dailyUploadLimitBytes: number;
  isUploadRateLimited: boolean;
  downloadedBytes24h: number;
  oldestTransferTimestamp: number | null;
  latestTransferTimestamp: number | null;
  nextResetMs: number | null;
  fullResetMs: number | null;
  nextExpiringBytes: number | null;
  activeTransferCount24h: number;
}

export interface ClusterTransferOverview {
  totalUploadedBytes24h: number;
  totalRemainingUploadBytes24h: number;
  dailyUploadLimitBytes: number;
  rateLimitedAccountsCount: number;
}

export interface AccountStorageSummary {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  usableLimitBytes: number;
  headroomBytes: number;
  tsubasaUsedBytes: number;
  syncState: string;
  isDisabled: boolean;
  transferStats: AccountTransferStats;
}

export interface SystemStorageBreakdown {
  systemFilesCount: number;
  systemBytesTotal: number;
}

export interface PooledStorageOverview {
  totalAccounts: number;
  totalLimitBytes: number;
  totalUsedBytes: number;
  totalHeadroomBytes: number;
  totalTsubasaUsedBytes: number;
  systemStorage: SystemStorageBreakdown;
  clusterTransfer?: ClusterTransferOverview;
  accounts: AccountStorageSummary[];
}

export function calculateUsableLimit(quotaLimitBytes: number): number {
  return Math.max(0, quotaLimitBytes - SAFETY_BUFFER_BYTES);
}

export function calculateHeadroom(quotaLimitBytes: number, quotaUsedBytes: number): number {
  const usable = calculateUsableLimit(quotaLimitBytes);
  return Math.max(0, usable - quotaUsedBytes);
}

export async function getAccountTransferStats(
  accountId: string,
  nowMs = Date.now()
): Promise<AccountTransferStats> {
  const windowStart = nowMs - ROLLING_WINDOW_MS;

  // Query active upload transfers within the rolling 24-hour window, ordered chronologically
  const activeUploads = await db
    .select({
      byteCount: transferLogs.byteCount,
      timestamp: transferLogs.timestamp,
    })
    .from(transferLogs)
    .where(
      and(
        eq(transferLogs.accountId, accountId),
        eq(transferLogs.transferType, 'upload'),
        gte(transferLogs.timestamp, windowStart)
      )
    )
    .orderBy(transferLogs.timestamp);

  // Query downloads within the rolling 24-hour window
  const downloadResult = await db
    .select({
      totalBytes: sql<number>`coalesce(sum(${transferLogs.byteCount}), 0)`,
    })
    .from(transferLogs)
    .where(
      and(
        eq(transferLogs.accountId, accountId),
        eq(transferLogs.transferType, 'download'),
        gte(transferLogs.timestamp, windowStart)
      )
    );

  const downloadedBytes24h = Number(downloadResult[0]?.totalBytes || 0);

  let uploadedBytes24h = 0;
  for (const row of activeUploads) {
    uploadedBytes24h += row.byteCount;
  }

  const remainingUploadBytes24h = Math.max(0, DAILY_UPLOAD_LIMIT_BYTES - uploadedBytes24h);
  const isUploadRateLimited = remainingUploadBytes24h <= 0;

  const activeTransferCount24h = activeUploads.length;
  let oldestTransferTimestamp: number | null = null;
  let latestTransferTimestamp: number | null = null;
  let nextResetMs: number | null = null;
  let fullResetMs: number | null = null;
  let nextExpiringBytes: number | null = null;

  if (activeUploads.length > 0) {
    oldestTransferTimestamp = activeUploads[0].timestamp;
    latestTransferTimestamp = activeUploads[activeUploads.length - 1].timestamp;

    // Time remaining until the earliest transfer falls outside the 24h sliding window
    nextResetMs = Math.max(0, oldestTransferTimestamp + ROLLING_WINDOW_MS - nowMs);
    // Time remaining until all currently recorded transfers fall outside the sliding window
    fullResetMs = Math.max(0, latestTransferTimestamp + ROLLING_WINDOW_MS - nowMs);

    // Sum byte count for all transfers matching the oldest timestamp (e.g. parallel batch chunk)
    nextExpiringBytes = activeUploads
      .filter((u) => u.timestamp === oldestTransferTimestamp)
      .reduce((sum, u) => sum + u.byteCount, 0);
  }

  return {
    accountId,
    rollingWindowMs: ROLLING_WINDOW_MS,
    uploadedBytes24h,
    remainingUploadBytes24h,
    dailyUploadLimitBytes: DAILY_UPLOAD_LIMIT_BYTES,
    isUploadRateLimited,
    downloadedBytes24h,
    oldestTransferTimestamp,
    latestTransferTimestamp,
    nextResetMs,
    fullResetMs,
    nextExpiringBytes,
    activeTransferCount24h,
  };
}

export async function pruneOldTransferLogs(nowMs = Date.now()): Promise<void> {
  const cutoff = nowMs - 7 * ROLLING_WINDOW_MS;
  await db.delete(transferLogs).where(sql`${transferLogs.timestamp} < ${cutoff}`);
}

export async function recordTransfer(
  accountId: string,
  transferType: 'upload' | 'download',
  byteCount: number,
  timestamp = Date.now()
): Promise<void> {
  await db.insert(transferLogs).values({
    id: randomUUID(),
    accountId,
    transferType,
    byteCount,
    timestamp,
  });

  // Prune entries older than 7 days in the background
  pruneOldTransferLogs(timestamp).catch((err) => {
    console.warn('Transfer logs pruning warning:', err instanceof Error ? err.message : String(err));
  });
}

export async function getSystemStorageBreakdown(): Promise<SystemStorageBreakdown> {
  // Roadmaps classify snapshots, database mirrors, and manifests as system storage
  const systemFileRecords = await db
    .select({
      count: sql<number>`count(*)`,
      totalBytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)`,
    })
    .from(files)
    .where(
      and(
        eq(files.isTrashed, false),
        sql`${files.virtualPath} LIKE '/.tsubasa/%'`
      )
    );

  const row = systemFileRecords[0];
  return {
    systemFilesCount: Number(row?.count || 0),
    systemBytesTotal: Number(row?.totalBytes || 0),
  };
}

export async function getPooledStorageOverview(nowMs = Date.now()): Promise<PooledStorageOverview> {
  const allAccounts = await db.select().from(accounts);
  const systemStorage = await getSystemStorageBreakdown();

  const activeFiles = await db
    .select({
      accountId: files.accountId,
      totalBytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)`,
    })
    .from(files)
    .where(eq(files.isTrashed, false))
    .groupBy(files.accountId);

  const tsubasaUsedByAccount = new Map<string, number>();
  let totalTsubasaUsed = 0;
  for (const row of activeFiles) {
    const bytes = Number(row.totalBytes || 0);
    tsubasaUsedByAccount.set(row.accountId, bytes);
    totalTsubasaUsed += bytes;
  }

  let totalLimit = 0;
  let totalUsed = 0;
  let totalHeadroom = 0;
  let totalUploaded24h = 0;
  let totalRemainingDailyTransfer = 0;
  let rateLimitedCount = 0;

  const accountSummaries: AccountStorageSummary[] = [];

  for (const acc of allAccounts) {
    totalLimit += acc.quotaLimitBytes;
    totalUsed += acc.quotaUsedBytes;

    const usableLimit = calculateUsableLimit(acc.quotaLimitBytes);
    const headroom = calculateHeadroom(acc.quotaLimitBytes, acc.quotaUsedBytes);
    if (!acc.isDisabled && acc.syncState !== 'error') {
      totalHeadroom += headroom;
    }

    const transferStats = await getAccountTransferStats(acc.id, nowMs);
    const tsubasaUsed = tsubasaUsedByAccount.get(acc.id) || 0;

    totalUploaded24h += transferStats.uploadedBytes24h;
    totalRemainingDailyTransfer += transferStats.remainingUploadBytes24h;
    if (transferStats.isUploadRateLimited) {
      rateLimitedCount++;
    }

    accountSummaries.push({
      id: acc.id,
      email: acc.email,
      displayName: acc.displayName,
      avatarUrl: acc.avatarUrl,
      quotaLimitBytes: acc.quotaLimitBytes,
      quotaUsedBytes: acc.quotaUsedBytes,
      usableLimitBytes: usableLimit,
      headroomBytes: headroom,
      tsubasaUsedBytes: tsubasaUsed,
      syncState: acc.syncState,
      isDisabled: acc.isDisabled ?? false,
      transferStats,
    });
  }

  const clusterDailyCapacity = allAccounts.length * DAILY_UPLOAD_LIMIT_BYTES;

  return {
    totalAccounts: allAccounts.length,
    totalLimitBytes: totalLimit,
    totalUsedBytes: totalUsed,
    totalHeadroomBytes: totalHeadroom,
    totalTsubasaUsedBytes: totalTsubasaUsed,
    systemStorage,
    clusterTransfer: {
      totalUploadedBytes24h: totalUploaded24h,
      totalRemainingUploadBytes24h: totalRemainingDailyTransfer,
      dailyUploadLimitBytes: clusterDailyCapacity,
      rateLimitedAccountsCount: rateLimitedCount,
    },
    accounts: accountSummaries,
  };
}

