import type { InferResponseType } from 'hono/client';
import { client } from '../api.js';
import type { ClientFileRecord, ClientFolder } from '../components/FileTable.js';
import type { DiscrepancyReport } from '../components/ExternalChangesDrawer.js';
import type { AccountTransferStats } from '../components/Sidebar.js';

export type { DiscrepancyReport };

export type StoredShareLink = InferResponseType<typeof client.api.share.links.$get, 200>['links'][number];

export interface AccountSummary {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  usableLimitBytes: number;
  headroomBytes: number;
  tsubasaUsedBytes?: number;
  syncState: string;
  isDisabled?: boolean;
  transferStats?: AccountTransferStats;
  poolId?: number;
  canSwitchPool?: boolean;
}

export interface StorageOverview {
  totalAccounts: number;
  totalLimitBytes: number;
  totalUsedBytes: number;
  totalHeadroomBytes: number;
  totalTsubasaUsedBytes?: number;
  systemStorage?: {
    systemFilesCount: number;
    systemBytesTotal: number;
  };
  clusterTransfer?: {
    totalUploadedBytes24h: number;
    totalRemainingUploadBytes24h: number;
    dailyUploadLimitBytes: number;
    rateLimitedAccountsCount: number;
  };
  accounts: AccountSummary[];
}

export interface DiscoveredAccount {
  accountId: string;
  clientId: string;
  authorized: boolean;
  sourceFile: string;
  isDisabled?: boolean;
  mtimeMs?: number;
  poolId?: number;
  canSwitchPool?: boolean;
}

export interface PoolCacheEntry {
  files: ClientFileRecord[];
  folders: ClientFolder[];
  trashedFiles: ClientFileRecord[];
  storage: StorageOverview | null;
  discovered: DiscoveredAccount[];
  shareLinksByBatch: Record<string, StoredShareLink[]>;
  pendingDiscrepancies: Record<string, boolean>;
  loadedFilesPoolId: number | null;
  loadedTrashPoolId: number | null;
  shareLinksPoolId: number | null;
  trashStale: boolean;
  updatedAt: number;
}

export type PoolCachePatch = Partial<Omit<PoolCacheEntry, 'updatedAt'>>;

const YIELD_BUDGET_MS = 50;
const MAX_POOL_CACHE_ENTRIES = 16;
const MAX_DISCREPANCY_CACHE_ENTRIES = 64;
const DEFAULT_DISCREPANCY_TTL_MS = 60_000;

const poolCache = new Map<number, PoolCacheEntry>();
const discrepancyCache = new Map<string, { report: DiscrepancyReport; updatedAt: number }>();
const inFlightReads = new Map<string, Promise<unknown>>();

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Yield control back to the browser event loop so urgent input and paint work can run.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Execute an array of async tasks with bounded concurrency, yielding to the main thread
 * whenever cumulative work exceeds the 50ms frame budget.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const workerCount = Math.min(Math.max(1, Math.floor(concurrency) || 1), items.length);
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let lastYieldAt = nowMs();

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);

      if (nextIndex < items.length && nowMs() - lastYieldAt >= YIELD_BUDGET_MS) {
        lastYieldAt = nowMs();
        await yieldToMain();
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function createEmptyPoolCacheEntry(): PoolCacheEntry {
  return {
    files: [],
    folders: [],
    trashedFiles: [],
    storage: null,
    discovered: [],
    shareLinksByBatch: {},
    pendingDiscrepancies: {},
    loadedFilesPoolId: null,
    loadedTrashPoolId: null,
    shareLinksPoolId: null,
    trashStale: false,
    updatedAt: Date.now(),
  };
}

export function getPoolCache(poolId: number): PoolCacheEntry | undefined {
  const existing = poolCache.get(poolId);
  if (!existing) return undefined;

  // Refresh insertion order for LRU eviction.
  poolCache.delete(poolId);
  poolCache.set(poolId, existing);
  return existing;
}

export function setPoolCache(poolId: number, patch: PoolCachePatch): PoolCacheEntry {
  const previous = poolCache.get(poolId) ?? createEmptyPoolCacheEntry();
  const next: PoolCacheEntry = {
    ...previous,
    ...patch,
    updatedAt: Date.now(),
  };

  poolCache.delete(poolId);
  poolCache.set(poolId, next);

  while (poolCache.size > MAX_POOL_CACHE_ENTRIES) {
    const oldestKey = poolCache.keys().next().value;
    if (oldestKey === undefined) break;
    poolCache.delete(oldestKey);
  }

  return next;
}

export function markPoolTrashStale(poolId: number): void {
  const existing = poolCache.get(poolId);
  if (!existing) return;
  existing.trashStale = true;
}

export function clearPoolCache(poolId?: number): void {
  if (typeof poolId === 'number') {
    poolCache.delete(poolId);
    return;
  }
  poolCache.clear();
}

export function getDiscrepancyReportCache(
  accountId: string,
  maxAgeMs: number = DEFAULT_DISCREPANCY_TTL_MS
): DiscrepancyReport | null {
  const entry = discrepancyCache.get(accountId);
  if (!entry) return null;

  if (Date.now() - entry.updatedAt > maxAgeMs) {
    discrepancyCache.delete(accountId);
    return null;
  }

  discrepancyCache.delete(accountId);
  discrepancyCache.set(accountId, entry);
  return entry.report;
}

export function setDiscrepancyReportCache(accountId: string, report: DiscrepancyReport): void {
  discrepancyCache.delete(accountId);
  discrepancyCache.set(accountId, {
    report,
    updatedAt: Date.now(),
  });

  while (discrepancyCache.size > MAX_DISCREPANCY_CACHE_ENTRIES) {
    const oldestKey = discrepancyCache.keys().next().value;
    if (oldestKey === undefined) break;
    discrepancyCache.delete(oldestKey);
  }
}

export function invalidateDiscrepancyReportCache(accountId?: string): void {
  if (typeof accountId === 'string') {
    discrepancyCache.delete(accountId);
    return;
  }
  discrepancyCache.clear();
}

/**
 * Deduplicate concurrent identical reads by sharing a single in-flight promise.
 * If an AbortSignal aborts the initiator, evict the entry immediately so future callers never join a canceled promise.
 */
export function dedupeInFlight<T>(
  key: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }

  const existing = inFlightReads.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  let promise: Promise<T>;
  try {
    promise = fn();
  } catch (err) {
    return Promise.reject(err);
  }

  let cleanupAbort: (() => void) | null = null;
  const tracked = promise.finally(() => {
    cleanupAbort?.();
    if (inFlightReads.get(key) === tracked) {
      inFlightReads.delete(key);
    }
  });

  if (signal) {
    const onAbort = () => {
      if (inFlightReads.get(key) === tracked) {
        inFlightReads.delete(key);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    cleanupAbort = () => signal.removeEventListener('abort', onAbort);
  }

  inFlightReads.set(key, tracked);
  return tracked;
}
