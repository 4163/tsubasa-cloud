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

  const result = await db
    .select({
      transferType: transferLogs.transferType,
      totalBytes: sql<number>`coalesce(sum(${transferLogs.byteCount}), 0)`,
    })
    .from(transferLogs)
    .where(
      and(
        eq(transferLogs.accountId, accountId),
        gte(transferLogs.timestamp, windowStart)
      )
    )
    .groupBy(transferLogs.transferType);

  let uploadedBytes24h = 0;
  let downloadedBytes24h = 0;

  for (const row of result) {
    if (row.transferType === 'upload') {
      uploadedBytes24h = Number(row.totalBytes || 0);
    } else if (row.transferType === 'download') {
      downloadedBytes24h = Number(row.totalBytes || 0);
    }
  }

  const remainingUploadBytes24h = Math.max(0, DAILY_UPLOAD_LIMIT_BYTES - uploadedBytes24h);
  const isUploadRateLimited = remainingUploadBytes24h <= 0;

  return {
    accountId,
    rollingWindowMs: ROLLING_WINDOW_MS,
    uploadedBytes24h,
    remainingUploadBytes24h,
    dailyUploadLimitBytes: DAILY_UPLOAD_LIMIT_BYTES,
    isUploadRateLimited,
    downloadedBytes24h,
  };
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

  const accountSummaries: AccountStorageSummary[] = [];

  for (const acc of allAccounts) {
    totalLimit += acc.quotaLimitBytes;
    totalUsed += acc.quotaUsedBytes;

    const usableLimit = calculateUsableLimit(acc.quotaLimitBytes);
    const headroom = calculateHeadroom(acc.quotaLimitBytes, acc.quotaUsedBytes);
    totalHeadroom += headroom;

    const transferStats = await getAccountTransferStats(acc.id, nowMs);
    const tsubasaUsed = tsubasaUsedByAccount.get(acc.id) || 0;

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
      transferStats,
    });
  }

  return {
    totalAccounts: allAccounts.length,
    totalLimitBytes: totalLimit,
    totalUsedBytes: totalUsed,
    totalHeadroomBytes: totalHeadroom,
    totalTsubasaUsedBytes: totalTsubasaUsed,
    systemStorage,
    accounts: accountSummaries,
  };
}

