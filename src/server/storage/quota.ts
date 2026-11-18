import { db, sqlite, buildDirectoryPrefixBounds, chunkArray } from '../db/index.js';
import { accounts, files, pools, transferLogs } from '../db/schema.js';
import { eq, and, gte, lt, or, sql, asc, inArray } from 'drizzle-orm';
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
  poolId: number;
  canSwitchPool: boolean;
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
  poolId: number;
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

function buildAccountTransferStatsFromAggregates(
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

  if (activeTransferCount24h > 0 && oldestTransferTimestamp !== null && latestTransferTimestamp !== null) {
    // Time remaining until the earliest transfer falls outside the 24h sliding window
    nextResetMs = Math.max(0, oldestTransferTimestamp + ROLLING_WINDOW_MS - nowMs);
    // Time remaining until all currently recorded transfers fall outside the sliding window
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

function buildEmptyTransferStats(accountId: string): AccountTransferStats {
  return buildAccountTransferStatsFromAggregates(accountId, 0, 0, null, null, null, 0, 0);
}

function getTransferStatsByAccountMapSync(
  accountIds: string[],
  nowMs = Date.now()
): Map<string, AccountTransferStats> {
  const result = new Map<string, AccountTransferStats>();
  const uniqueAccountIds = Array.from(new Set(accountIds));
  if (uniqueAccountIds.length === 0) {
    return result;
  }

  const windowStart = nowMs - ROLLING_WINDOW_MS;
  const uploadByAccount = new Map<
    string,
    {
      uploadedBytes24h: number;
      activeTransferCount24h: number;
      oldestTransferTimestamp: number | null;
      latestTransferTimestamp: number | null;
    }
  >();

  const expiringPairs = [];
  for (const idChunk of chunkArray(uniqueAccountIds, 400)) {
    const uploadAggregates = db
      .select({
        accountId: transferLogs.accountId,
        uploadedBytes24h: sql<number>`coalesce(sum(${transferLogs.byteCount}), 0)`,
        activeTransferCount24h: sql<number>`count(*)`,
        oldestTransferTimestamp: sql<number | null>`min(${transferLogs.timestamp})`,
        latestTransferTimestamp: sql<number | null>`max(${transferLogs.timestamp})`,
      })
      .from(transferLogs)
      .where(
        and(
          inArray(transferLogs.accountId, idChunk),
          eq(transferLogs.transferType, 'upload'),
          gte(transferLogs.timestamp, windowStart)
        )
      )
      .groupBy(transferLogs.accountId)
      .all();

    for (const row of uploadAggregates) {
      const count = Number(row.activeTransferCount24h || 0);
      const oldestTs = row.oldestTransferTimestamp !== null ? Number(row.oldestTransferTimestamp) : null;
      const latestTs = row.latestTransferTimestamp !== null ? Number(row.latestTransferTimestamp) : null;
      uploadByAccount.set(row.accountId, {
        uploadedBytes24h: Number(row.uploadedBytes24h || 0),
        activeTransferCount24h: count,
        oldestTransferTimestamp: oldestTs,
        latestTransferTimestamp: latestTs,
      });
      if (count > 0 && oldestTs !== null) {
        expiringPairs.push(and(eq(transferLogs.accountId, row.accountId), eq(transferLogs.timestamp, oldestTs)));
      }
    }
  }

  const expiringByAccount = new Map<string, number>();
  for (const pairChunk of chunkArray(expiringPairs, 400)) {
    const expiringRows = db
      .select({
        accountId: transferLogs.accountId,
        nextExpiringBytes: sql<number>`coalesce(sum(${transferLogs.byteCount}), 0)`,
      })
      .from(transferLogs)
      .where(and(eq(transferLogs.transferType, 'upload'), or(...pairChunk)))
      .groupBy(transferLogs.accountId)
      .all();

    for (const row of expiringRows) {
      expiringByAccount.set(row.accountId, Number(row.nextExpiringBytes || 0));
    }
  }

  const downloadsByAccount = new Map<string, number>();
  for (const idChunk of chunkArray(uniqueAccountIds, 400)) {
    const allDownloadTotals = db
      .select({
        accountId: transferLogs.accountId,
        totalBytes: sql<number>`coalesce(sum(${transferLogs.byteCount}), 0)`,
      })
      .from(transferLogs)
      .where(
        and(
          inArray(transferLogs.accountId, idChunk),
          eq(transferLogs.transferType, 'download'),
          gte(transferLogs.timestamp, windowStart)
        )
      )
      .groupBy(transferLogs.accountId)
      .all();

    for (const row of allDownloadTotals) {
      downloadsByAccount.set(row.accountId, Number(row.totalBytes || 0));
    }
  }

  for (const accountId of uniqueAccountIds) {
    const upload = uploadByAccount.get(accountId);
    const downloadedBytes24h = downloadsByAccount.get(accountId) ?? 0;
    if (!upload || upload.activeTransferCount24h === 0) {
      result.set(
        accountId,
        buildAccountTransferStatsFromAggregates(accountId, 0, 0, null, null, null, downloadedBytes24h, nowMs)
      );
      continue;
    }

    result.set(
      accountId,
      buildAccountTransferStatsFromAggregates(
        accountId,
        upload.uploadedBytes24h,
        upload.activeTransferCount24h,
        upload.oldestTransferTimestamp,
        upload.latestTransferTimestamp,
        expiringByAccount.get(accountId) ?? 0,
        downloadedBytes24h,
        nowMs
      )
    );
  }

  return result;
}

export async function getTransferStatsByAccountMap(
  accountIds: string[],
  nowMs = Date.now()
): Promise<Map<string, AccountTransferStats>> {
  return getTransferStatsByAccountMapSync(accountIds, nowMs);
}

export async function getAccountTransferStats(
  accountId: string,
  nowMs = Date.now()
): Promise<AccountTransferStats> {
  const statsMap = await getTransferStatsByAccountMap([accountId], nowMs);
  return statsMap.get(accountId) ?? buildEmptyTransferStats(accountId);
}

const PRUNE_COOLDOWN_MS = 600_000;
const PRUNE_INSERT_THRESHOLD = 500;
let lastPruneAtMs = 0;
let insertsSincePrune = 0;

interface CachedOverviewEntry {
  dbVersion: number;
  cachedAtMs: number;
  earliestExpiryMs: number;
  value: PooledStorageOverview;
}

const MAX_OVERVIEW_CACHE_TTL_MS = 30_000;
const overviewCache = new Map<number, CachedOverviewEntry>();
const totalChangesStmt = sqlite.prepare('SELECT total_changes() as c');

function getDbTotalChanges(): number {
  return (totalChangesStmt.get() as { c: number }).c;
}

export function invalidatePooledStorageOverview(poolId?: number): void {
  if (poolId === undefined) {
    overviewCache.clear();
  } else {
    overviewCache.delete(poolId);
  }
}

export async function pruneOldTransferLogs(nowMs = Date.now()): Promise<void> {
  const cutoff = nowMs - 7 * ROLLING_WINDOW_MS;
  await db.delete(transferLogs).where(sql`${transferLogs.timestamp} < ${cutoff}`);
}

export function recordTransferSync(
  accountId: string,
  transferType: 'upload' | 'download',
  byteCount: number,
  timestamp = Date.now(),
  poolId?: number
): void {
  if (!Number.isFinite(byteCount) || byteCount <= 0) {
    return;
  }

  db.insert(transferLogs)
    .values({
      id: randomUUID(),
      accountId,
      transferType,
      byteCount,
      timestamp,
    })
    .run();

  invalidatePooledStorageOverview(poolId);

  insertsSincePrune++;
  const nowMs = Date.now();
  if (nowMs - lastPruneAtMs >= PRUNE_COOLDOWN_MS || insertsSincePrune >= PRUNE_INSERT_THRESHOLD) {
    lastPruneAtMs = nowMs;
    insertsSincePrune = 0;
    // Prune entries older than 7 days in the background
    pruneOldTransferLogs(nowMs).catch((err) => {
      console.warn('Transfer logs pruning warning:', err instanceof Error ? err.message : String(err));
    });
  }
}

export async function recordTransfer(
  accountId: string,
  transferType: 'upload' | 'download',
  byteCount: number,
  timestamp = Date.now(),
  poolId?: number
): Promise<void> {
  recordTransferSync(accountId, transferType, byteCount, timestamp, poolId);
}

function getSystemStorageBreakdownSync(poolId = 1): SystemStorageBreakdown {
  // Snapshots, database mirrors, and manifests stored under /.tsubasa count as system storage.
  const { lower, upper } = buildDirectoryPrefixBounds('/.tsubasa');
  const systemFileRecords = db
    .select({
      count: sql<number>`count(*)`,
      totalBytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)`,
    })
    .from(files)
    .where(
      and(
        eq(files.poolId, poolId),
        eq(files.isTrashed, false),
        gte(files.virtualPath, lower),
        lt(files.virtualPath, upper)
      )
    )
    .all();

  const row = systemFileRecords[0];
  return {
    systemFilesCount: Number(row?.count || 0),
    systemBytesTotal: Number(row?.totalBytes || 0),
  };
}

export async function getSystemStorageBreakdown(poolId = 1): Promise<SystemStorageBreakdown> {
  return getSystemStorageBreakdownSync(poolId);
}

export async function getPooledStorageOverview(poolId = 1, nowMs = Date.now()): Promise<PooledStorageOverview> {
  const dbVersion = getDbTotalChanges();
  const cached = overviewCache.get(poolId);
  if (
    cached &&
    cached.dbVersion === dbVersion &&
    nowMs >= cached.cachedAtMs &&
    nowMs < cached.earliestExpiryMs
  ) {
    return cached.value;
  }

  const startDbVersion = getDbTotalChanges();
  const { allAccounts, systemStorage, activeFiles, transferStatsByAccount } = sqlite.transaction(() => {
    const accountsRows = db
      .select({
        id: accounts.id,
        email: accounts.email,
        displayName: accounts.displayName,
        avatarUrl: accounts.avatarUrl,
        poolId: accounts.poolId,
        quotaLimitBytes: accounts.quotaLimitBytes,
        quotaUsedBytes: accounts.quotaUsedBytes,
        syncState: accounts.syncState,
        isDisabled: accounts.isDisabled,
        hasFiles: sql<number>`EXISTS (SELECT 1 FROM files WHERE files.account_id = accounts.id)`,
      })
      .from(accounts)
      .where(eq(accounts.poolId, poolId))
      .orderBy(asc(accounts.email))
      .all();

    const breakdown = getSystemStorageBreakdownSync(poolId);

    const fileRows = db
      .select({
        accountId: files.accountId,
        totalBytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)`,
      })
      .from(files)
      .where(and(eq(files.poolId, poolId), eq(files.isTrashed, false)))
      .groupBy(files.accountId)
      .all();

    const statsMap = getTransferStatsByAccountMapSync(
      accountsRows.map((acc) => acc.id),
      nowMs
    );

    return {
      allAccounts: accountsRows,
      systemStorage: breakdown,
      activeFiles: fileRows,
      transferStatsByAccount: statsMap,
    };
  })();

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
  let activeAccountsCount = 0;
  let earliestExpiryMs = nowMs + MAX_OVERVIEW_CACHE_TTL_MS;

  const accountSummaries: AccountStorageSummary[] = [];

  for (const acc of allAccounts) {
    totalLimit += acc.quotaLimitBytes;
    totalUsed += acc.quotaUsedBytes;

    const usableLimit = calculateUsableLimit(acc.quotaLimitBytes);
    const headroom = calculateHeadroom(acc.quotaLimitBytes, acc.quotaUsedBytes);
    const isActiveAccount = !acc.isDisabled && acc.syncState !== 'error';

    const transferStats =
      transferStatsByAccount.get(acc.id) ?? buildEmptyTransferStats(acc.id);
    const tsubasaUsed = tsubasaUsedByAccount.get(acc.id) || 0;

    if (transferStats.oldestTransferTimestamp !== null) {
      const expiry = transferStats.oldestTransferTimestamp + ROLLING_WINDOW_MS;
      if (expiry < earliestExpiryMs) {
        earliestExpiryMs = expiry;
      }
    }

    if (isActiveAccount) {
      activeAccountsCount++;
      totalHeadroom += headroom;
      totalUploaded24h += transferStats.uploadedBytes24h;
      totalRemainingDailyTransfer += transferStats.remainingUploadBytes24h;
      if (transferStats.isUploadRateLimited) {
        rateLimitedCount++;
      }
    }

    accountSummaries.push({
      id: acc.id,
      email: acc.email,
      displayName: acc.displayName,
      avatarUrl: acc.avatarUrl,
      poolId: acc.poolId,
      canSwitchPool: !acc.hasFiles,
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

  const clusterDailyCapacity = activeAccountsCount * DAILY_UPLOAD_LIMIT_BYTES;

  const overview: PooledStorageOverview = {
    poolId,
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

  if (getDbTotalChanges() === startDbVersion) {
    overviewCache.set(poolId, {
      dbVersion: startDbVersion,
      cachedAtMs: nowMs,
      earliestExpiryMs,
      value: overview,
    });
  }

  return overview;
}

export interface EmptyShareAccount {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  currentPoolId: number;
  currentPoolName: string;
  currentPoolIsShare: boolean;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  usableLimitBytes: number;
  headroomBytes: number;
  syncState: string;
  isDisabled: boolean;
  authorized: boolean;
  transferStats: AccountTransferStats;
}

export async function getEmptyAccountsAcrossAllPools(
  nowMs = Date.now(),
  authorizedAccountIds?: ReadonlySet<string>
): Promise<EmptyShareAccount[]> {
  const emptyAccounts = await db
    .select({
      id: accounts.id,
      email: accounts.email,
      displayName: accounts.displayName,
      avatarUrl: accounts.avatarUrl,
      quotaLimitBytes: accounts.quotaLimitBytes,
      quotaUsedBytes: accounts.quotaUsedBytes,
      syncState: accounts.syncState,
      isDisabled: accounts.isDisabled,
      currentPoolId: pools.id,
      currentPoolName: pools.name,
      currentPoolIsShare: pools.isSharePool,
    })
    .from(accounts)
    .innerJoin(pools, eq(accounts.poolId, pools.id))
    .where(sql`NOT EXISTS (SELECT 1 FROM files WHERE files.account_id = accounts.id)`)
    .orderBy(asc(pools.isSharePool), asc(pools.id), asc(accounts.email));

  const transferStatsByAccount = await getTransferStatsByAccountMap(
    emptyAccounts.map((acc) => acc.id),
    nowMs
  );

  const results: EmptyShareAccount[] = [];
  for (const acc of emptyAccounts) {
    const usableLimitBytes = calculateUsableLimit(acc.quotaLimitBytes);
    const headroomBytes = calculateHeadroom(acc.quotaLimitBytes, acc.quotaUsedBytes);
    const transferStats =
      transferStatsByAccount.get(acc.id) ?? buildEmptyTransferStats(acc.id);
    const authorized = authorizedAccountIds ? authorizedAccountIds.has(acc.id) : false;

    results.push({
      id: acc.id,
      email: acc.email,
      displayName: acc.displayName,
      avatarUrl: acc.avatarUrl,
      currentPoolId: acc.currentPoolId,
      currentPoolName: acc.currentPoolName,
      currentPoolIsShare: Boolean(acc.currentPoolIsShare),
      quotaLimitBytes: acc.quotaLimitBytes,
      quotaUsedBytes: acc.quotaUsedBytes,
      usableLimitBytes,
      headroomBytes,
      syncState: acc.syncState,
      isDisabled: acc.isDisabled ?? false,
      authorized,
      transferStats,
    });
  }

  return results;
}

