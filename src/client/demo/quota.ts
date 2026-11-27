import type { AccountStorageSummary, EmptyShareAccount } from '../../server/storage/quota.js';
import type { AccountTransferStats, StorageOverview } from '../types.js';
import type {
  DemoAccountRecord,
  DemoFileRecord,
  DemoPoolRecord,
  DemoTransferLogRecord,
} from './db.js';

export const DEFAULT_ACCOUNT_QUOTA_BYTES = 15 * 1024 * 1024 * 1024; // 15 GB
export const SAFETY_BUFFER_BYTES = 750 * 1024 * 1024; // 750 MB
export const MAX_SINGLE_FILE_BYTES = 14.25 * 1024 * 1024 * 1024; // 14.25 GB
export const DAILY_UPLOAD_LIMIT_BYTES = 750 * 1024 * 1024 * 1024; // 750 GB
export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function calculateUsableLimit(quotaLimitBytes: number): number {
  return Math.max(0, quotaLimitBytes - SAFETY_BUFFER_BYTES);
}

export function calculateHeadroom(quotaLimitBytes: number, quotaUsedBytes: number): number {
  const usable = calculateUsableLimit(quotaLimitBytes);
  return Math.max(0, usable - quotaUsedBytes);
}

function buildTransferStatsFromAggregates(
  accountId: string,
  uploadedBytes24h: number,
  activeTransferCount24h: number,
  oldestTransferTimestamp: number | null,
  latestTransferTimestamp: number | null,
  nextExpiringBytes: number | null,
  downloadedBytes24h: number,
  nowMs: number
): AccountTransferStats {
  const remainingUploadBytes24h = Math.max(0, DAILY_UPLOAD_LIMIT_BYTES - uploadedBytes24h);
  const isUploadRateLimited = remainingUploadBytes24h <= 0;

  let nextResetMs: number | null = null;
  let fullResetMs: number | null = null;

  if (
    activeTransferCount24h > 0 &&
    oldestTransferTimestamp !== null &&
    latestTransferTimestamp !== null
  ) {
    nextResetMs = Math.max(0, oldestTransferTimestamp + ROLLING_WINDOW_MS - nowMs);
    fullResetMs = Math.max(0, latestTransferTimestamp + ROLLING_WINDOW_MS - nowMs);
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
    nextExpiringBytes: activeTransferCount24h > 0 ? nextExpiringBytes : null,
    activeTransferCount24h,
  };
}

export function buildEmptyTransferStats(accountId: string): AccountTransferStats {
  return buildTransferStatsFromAggregates(accountId, 0, 0, null, null, null, 0, 0);
}

export function computeTransferStatsByAccount(
  accountIds: string[],
  transferLogs: DemoTransferLogRecord[],
  nowMs = Date.now()
): Map<string, AccountTransferStats> {
  const result = new Map<string, AccountTransferStats>();
  const uniqueIds = Array.from(new Set(accountIds));
  if (uniqueIds.length === 0) {
    return result;
  }

  const wanted = new Set(uniqueIds);
  const windowStart = nowMs - ROLLING_WINDOW_MS;

  const uploadAggs = new Map<
    string,
    {
      uploadedBytes24h: number;
      activeTransferCount24h: number;
      oldestTs: number;
      latestTs: number;
      oldestBytes: number;
    }
  >();
  const downloadsByAccount = new Map<string, number>();

  for (const log of transferLogs) {
    if (!wanted.has(log.accountId) || log.timestamp < windowStart) continue;

    if (log.transferType === 'download') {
      downloadsByAccount.set(
        log.accountId,
        (downloadsByAccount.get(log.accountId) ?? 0) + log.byteCount
      );
      continue;
    }

    const existing = uploadAggs.get(log.accountId);
    if (!existing) {
      uploadAggs.set(log.accountId, {
        uploadedBytes24h: log.byteCount,
        activeTransferCount24h: 1,
        oldestTs: log.timestamp,
        latestTs: log.timestamp,
        oldestBytes: log.byteCount,
      });
      continue;
    }

    existing.uploadedBytes24h += log.byteCount;
    existing.activeTransferCount24h += 1;
    if (log.timestamp < existing.oldestTs) {
      existing.oldestTs = log.timestamp;
      existing.oldestBytes = log.byteCount;
    } else if (log.timestamp === existing.oldestTs) {
      existing.oldestBytes += log.byteCount;
    }
    if (log.timestamp > existing.latestTs) {
      existing.latestTs = log.timestamp;
    }
  }

  for (const accountId of uniqueIds) {
    const upload = uploadAggs.get(accountId);
    const downloadedBytes24h = downloadsByAccount.get(accountId) ?? 0;
    if (!upload || upload.activeTransferCount24h === 0) {
      result.set(
        accountId,
        buildTransferStatsFromAggregates(accountId, 0, 0, null, null, null, downloadedBytes24h, nowMs)
      );
      continue;
    }

    result.set(
      accountId,
      buildTransferStatsFromAggregates(
        accountId,
        upload.uploadedBytes24h,
        upload.activeTransferCount24h,
        upload.oldestTs,
        upload.latestTs,
        upload.oldestBytes,
        downloadedBytes24h,
        nowMs
      )
    );
  }

  return result;
}

export function buildPooledStorageOverview(
  poolId: number,
  allAccounts: DemoAccountRecord[],
  allFiles: DemoFileRecord[],
  transferLogs: DemoTransferLogRecord[],
  nowMs = Date.now()
): StorageOverview & { poolId: number; accounts: AccountStorageSummary[] } {
  // Match server behavior: only hydrated (authorized) accounts appear in storage overview.
  const poolAccounts = allAccounts
    .filter((acc) => acc.poolId === poolId && acc.authorized)
    .sort((a, b) => a.email.localeCompare(b.email));

  const accountsWithAnyFiles = new Set<string>();
  const tsubasaUsedByAccount = new Map<string, number>();
  let totalTsubasaUsed = 0;
  let systemFilesCount = 0;
  let systemBytesTotal = 0;

  for (const f of allFiles) {
    accountsWithAnyFiles.add(f.accountId);
    if (f.poolId === poolId && !f.isTrashed) {
      tsubasaUsedByAccount.set(f.accountId, (tsubasaUsedByAccount.get(f.accountId) ?? 0) + f.sizeBytes);
      totalTsubasaUsed += f.sizeBytes;
      if (f.virtualPath === '/.tsubasa' || f.virtualPath.startsWith('/.tsubasa/')) {
        systemFilesCount += 1;
        systemBytesTotal += f.sizeBytes;
      }
    }
  }

  const statsMap = computeTransferStatsByAccount(
    poolAccounts.map((a) => a.id),
    transferLogs,
    nowMs
  );

  let totalLimit = 0;
  let totalUsed = 0;
  let totalHeadroom = 0;
  let totalUploaded24h = 0;
  let totalRemainingDailyTransfer = 0;
  let rateLimitedCount = 0;
  let activeAccountsCount = 0;

  const accountSummaries: AccountStorageSummary[] = [];

  for (const acc of poolAccounts) {
    totalLimit += acc.quotaLimitBytes;
    totalUsed += acc.quotaUsedBytes;

    const usableLimit = calculateUsableLimit(acc.quotaLimitBytes);
    const headroom = calculateHeadroom(acc.quotaLimitBytes, acc.quotaUsedBytes);
    const isActiveAccount = !acc.isDisabled && acc.syncState !== 'error';
    const transferStats = statsMap.get(acc.id) ?? buildEmptyTransferStats(acc.id);
    const tsubasaUsed = tsubasaUsedByAccount.get(acc.id) ?? 0;

    if (isActiveAccount) {
      activeAccountsCount += 1;
      totalHeadroom += headroom;
      totalUploaded24h += transferStats.uploadedBytes24h;
      totalRemainingDailyTransfer += transferStats.remainingUploadBytes24h;
      if (transferStats.isUploadRateLimited) {
        rateLimitedCount += 1;
      }
    }

    accountSummaries.push({
      id: acc.id,
      email: acc.email,
      displayName: acc.displayName,
      avatarUrl: acc.avatarUrl,
      poolId: acc.poolId,
      canSwitchPool: !accountsWithAnyFiles.has(acc.id),
      quotaLimitBytes: acc.quotaLimitBytes,
      quotaUsedBytes: acc.quotaUsedBytes,
      usableLimitBytes: usableLimit,
      headroomBytes: headroom,
      tsubasaUsedBytes: tsubasaUsed,
      syncState: acc.syncState,
      isDisabled: acc.isDisabled,
      transferStats,
    });
  }

  return {
    poolId,
    totalAccounts: poolAccounts.length,
    totalLimitBytes: totalLimit,
    totalUsedBytes: totalUsed,
    totalHeadroomBytes: totalHeadroom,
    totalTsubasaUsedBytes: totalTsubasaUsed,
    systemStorage: {
      systemFilesCount,
      systemBytesTotal,
    },
    clusterTransfer: {
      totalUploadedBytes24h: totalUploaded24h,
      totalRemainingUploadBytes24h: totalRemainingDailyTransfer,
      dailyUploadLimitBytes: activeAccountsCount * DAILY_UPLOAD_LIMIT_BYTES,
      rateLimitedAccountsCount: rateLimitedCount,
    },
    accounts: accountSummaries,
  };
}

export function buildEmptyAccountsAcrossAllPools(
  pools: DemoPoolRecord[],
  allAccounts: DemoAccountRecord[],
  allFiles: DemoFileRecord[],
  transferLogs: DemoTransferLogRecord[],
  nowMs = Date.now()
): EmptyShareAccount[] {
  const poolById = new Map<number, DemoPoolRecord>(pools.map((p) => [p.id, p]));
  const accountsWithFiles = new Set<string>(allFiles.map((f) => f.accountId));

  const emptyAccounts = allAccounts.filter(
    (acc) => acc.authorized && !accountsWithFiles.has(acc.id) && poolById.has(acc.poolId)
  );

  emptyAccounts.sort((a, b) => {
    const poolA = poolById.get(a.poolId)!;
    const poolB = poolById.get(b.poolId)!;
    if (poolA.isSharePool !== poolB.isSharePool) {
      return poolA.isSharePool ? 1 : -1;
    }
    if (poolA.sortOrder !== poolB.sortOrder) {
      return poolA.sortOrder - poolB.sortOrder;
    }
    if (poolA.id !== poolB.id) {
      return poolA.id - poolB.id;
    }
    return a.email.localeCompare(b.email);
  });

  const statsMap = computeTransferStatsByAccount(
    emptyAccounts.map((a) => a.id),
    transferLogs,
    nowMs
  );

  return emptyAccounts.map((acc) => {
    const pool = poolById.get(acc.poolId)!;
    const usableLimitBytes = calculateUsableLimit(acc.quotaLimitBytes);
    const headroomBytes = calculateHeadroom(acc.quotaLimitBytes, acc.quotaUsedBytes);
    const transferStats = statsMap.get(acc.id) ?? buildEmptyTransferStats(acc.id);

    return {
      id: acc.id,
      email: acc.email,
      displayName: acc.displayName,
      avatarUrl: acc.avatarUrl,
      currentPoolId: pool.id,
      currentPoolName: pool.name,
      currentPoolIsShare: pool.isSharePool,
      quotaLimitBytes: acc.quotaLimitBytes,
      quotaUsedBytes: acc.quotaUsedBytes,
      usableLimitBytes,
      headroomBytes,
      syncState: acc.syncState,
      isDisabled: acc.isDisabled,
      authorized: acc.authorized,
      transferStats,
    };
  });
}
