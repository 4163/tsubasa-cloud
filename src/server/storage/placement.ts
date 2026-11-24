import path from 'node:path';
import { db, buildDirectoryPrefixBounds, chunkArray } from '../db/index.js';
import { accounts, files } from '../db/schema.js';
import { eq, and, gte, lt, sql, not, inArray } from 'drizzle-orm';
import {
  calculateHeadroom,
  calculateUsableLimit,
  getAccountTransferStats,
  getTransferStatsByAccountMap,
  MAX_SINGLE_FILE_BYTES,
  type AccountTransferStats,
} from './quota.js';
import { normalizeVirtualPath } from '../virtualPath.js';

export class FileExceedsCeilingError extends Error {
  constructor(sizeBytes: number) {
    const sizeGb = (sizeBytes / (1024 * 1024 * 1024)).toFixed(2);
    super(`File size (${sizeGb} GB) exceeds single-account ceiling of 14.25 GB`);
    this.name = 'FileExceedsCeilingError';
  }
}

export class InsufficientStorageError extends Error {
  constructor(message = 'No account in pool has sufficient headroom or daily transfer quota') {
    super(message);
    this.name = 'InsufficientStorageError';
  }
}

export interface CandidateAccount {
  id: string;
  email: string;
  headroomBytes: number;
  transferStats: AccountTransferStats;
  isOverCeiling?: boolean;
}

export interface PlacementDecision {
  accountId: string;
  virtualPath: string;
  sizeBytes: number;
  reason: 'folder_affinity' | 'best_fit';
  headroomBeforeBytes: number;
  headroomAfterBytes: number;
}

export interface BatchPlacementPlan {
  totalFiles: number;
  totalBytes: number;
  decisions: PlacementDecision[];
  accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }>;
}

export interface PlacementItem {
  virtualPath: string;
  sizeBytes: number;
}

export type UploadConflictAction = 'skip' | 'replace' | 'keep_both';

export interface UploadPlacementRequestItem extends PlacementItem {
  conflictAction?: UploadConflictAction;
}

export interface ExistingPoolFileSummary {
  id: string;
  virtualPath: string;
  name: string;
  sizeBytes: number;
  hash: string | null;
  accountId: string;
  updatedAt: number;
}

export interface UploadBatchPlacementPlan extends BatchPlacementPlan {
  replacedBytes: number;
  netStorageDeltaBytes: number;
  conflicts: Record<string, ExistingPoolFileSummary>;
}

const inFlightAccountReservations = new Map<string, number>();

export function assertValidFileSize(sizeBytes: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Invalid file size: ${sizeBytes}`);
  }
  if (sizeBytes > MAX_SINGLE_FILE_BYTES) {
    throw new FileExceedsCeilingError(sizeBytes);
  }
}

export function reserveAccountCapacity(accountId: string, bytes: number): () => void {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return () => {};
  }

  inFlightAccountReservations.set(accountId, (inFlightAccountReservations.get(accountId) ?? 0) + bytes);
  let released = false;

  return () => {
    if (released) return;
    released = true;
    const current = inFlightAccountReservations.get(accountId) ?? 0;
    const next = current - bytes;
    if (next <= 0) {
      inFlightAccountReservations.delete(accountId);
    } else {
      inFlightAccountReservations.set(accountId, next);
    }
  };
}

function applyInFlightReservation(
  accountId: string,
  rawHeadroom: number,
  rawTransferStats: AccountTransferStats
): { headroomBytes: number; transferStats: AccountTransferStats } {
  const reserved = inFlightAccountReservations.get(accountId) ?? 0;
  if (reserved <= 0) {
    return { headroomBytes: rawHeadroom, transferStats: rawTransferStats };
  }

  const headroomBytes = Math.max(0, rawHeadroom - reserved);
  const remainingUploadBytes24h = Math.max(0, rawTransferStats.remainingUploadBytes24h - reserved);
  return {
    headroomBytes,
    transferStats: {
      ...rawTransferStats,
      remainingUploadBytes24h,
      isUploadRateLimited: remainingUploadBytes24h <= 0,
    },
  };
}

/**
 * Returns candidate accounts with their current headroom and 24h upload stats.
 */
export async function getEligibleAccounts(
  poolId = 1,
  nowMs = Date.now()
): Promise<CandidateAccount[]> {
  const allAccounts = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.poolId, poolId),
        not(eq(accounts.syncState, 'error')),
        eq(accounts.isDisabled, false)
      )
    );

  const transferStatsByAccount = await getTransferStatsByAccountMap(
    allAccounts.map((acc) => acc.id),
    nowMs
  );

  const candidates: CandidateAccount[] = [];

  for (const acc of allAccounts) {
    const rawHeadroom = calculateHeadroom(acc.quotaLimitBytes, acc.quotaUsedBytes);
    const rawTransferStats = transferStatsByAccount.get(acc.id)!;
    const { headroomBytes, transferStats } = applyInFlightReservation(
      acc.id,
      rawHeadroom,
      rawTransferStats
    );
    const isOverCeiling =
      acc.quotaUsedBytes >= acc.quotaLimitBytes ||
      acc.quotaUsedBytes > calculateUsableLimit(acc.quotaLimitBytes);

    candidates.push({
      id: acc.id,
      email: acc.email,
      headroomBytes,
      transferStats,
      isOverCeiling,
    });
  }

  return candidates;
}

export interface PoolFolderAffinityMap {
  getAffinityAccounts(normalizedPath: string): string[];
  getAffinityAccountsForDirectory(dirPath: string): string[];
  recordAssignment(virtualPath: string, accountId: string): void;
}

function normalizeAffinityDirectory(startDir: string): string {
  if (!startDir || startDir === '.') return '';
  return startDir.replace(/\/+$/, '') || '/';
}

function getAffinityAccountsForDirectory(
  dirCounts: Map<string, Map<string, number>>,
  startDir: string
): string[] {
  let currentDir = normalizeAffinityDirectory(startDir);
  // Stop before '/' so root-level files and new top-level folders fall back to Best-Fit.
  while (currentDir && currentDir !== '.' && currentDir !== '/') {
    const accountCounts = dirCounts.get(currentDir);
    if (accountCounts && accountCounts.size > 0) {
      return Array.from(accountCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([accountId]) => accountId);
    }
    currentDir = path.posix.dirname(currentDir);
  }
  return [];
}

function incrementDirectoryCounts(
  dirCounts: Map<string, Map<string, number>>,
  virtualPath: string,
  accountId: string
): void {
  let currentDir = path.posix.dirname(virtualPath);
  while (currentDir && currentDir !== '.' && currentDir !== '/') {
    let accountCounts = dirCounts.get(currentDir);
    if (!accountCounts) {
      accountCounts = new Map<string, number>();
      dirCounts.set(currentDir, accountCounts);
    }
    accountCounts.set(accountId, (accountCounts.get(accountId) ?? 0) + 1);

    currentDir = path.posix.dirname(currentDir);
  }
}

export async function buildPoolFolderAffinityMap(poolId: number): Promise<PoolFolderAffinityMap> {
  const dirCounts = new Map<string, Map<string, number>>();
  const rows = await db
    .select({
      virtualPath: files.virtualPath,
      accountId: files.accountId,
    })
    .from(files)
    .where(and(eq(files.poolId, poolId), eq(files.isTrashed, false)));

  for (const row of rows) {
    incrementDirectoryCounts(dirCounts, row.virtualPath, row.accountId);
  }

  return {
    getAffinityAccounts(normalizedPath: string): string[] {
      return getAffinityAccountsForDirectory(dirCounts, path.posix.dirname(normalizedPath));
    },
    getAffinityAccountsForDirectory(dirPath: string): string[] {
      return getAffinityAccountsForDirectory(dirCounts, dirPath);
    },
    recordAssignment(virtualPath: string, accountId: string): void {
      incrementDirectoryCounts(dirCounts, virtualPath, accountId);
    },
  };
}

export async function findFolderAffinityAccountsForDirectory(
  startDir: string,
  poolId = 1
): Promise<string[]> {
  let currentDir = normalizeAffinityDirectory(startDir);

  // Stop before '/' to avoid full-pool prefix scans and keep root/new top-level folders on Best-Fit.
  while (currentDir && currentDir !== '.' && currentDir !== '/') {
    const { lower, upper } = buildDirectoryPrefixBounds(currentDir);

    const affinityRows = await db
      .select({
        accountId: files.accountId,
        fileCount: sql<number>`count(*)`,
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
      .groupBy(files.accountId)
      .orderBy(sql`count(*) DESC`);

    if (affinityRows.length > 0) {
      return affinityRows.map((r) => r.accountId);
    }

    currentDir = path.posix.dirname(currentDir);
  }

  return [];
}

/**
 * Finds accounts holding files in parent or ancestor paths of the virtual target.
 * Returns accounts ordered by number of co-located files descending.
 */
export async function findFolderAffinityAccounts(normalizedPath: string, poolId = 1): Promise<string[]> {
  return findFolderAffinityAccountsForDirectory(path.posix.dirname(normalizedPath), poolId);
}

function pickBestFitCandidate(
  eligible: CandidateAccount[],
  requiredBytes: number,
  getEffectiveHeadroom: (accId: string, baseHeadroom: number) => number
): CandidateAccount {
  let bestCandidate = eligible[0];
  let minDifference = getEffectiveHeadroom(bestCandidate.id, bestCandidate.headroomBytes) - requiredBytes;

  for (let i = 1; i < eligible.length; i++) {
    const cand = eligible[i];
    const diff = getEffectiveHeadroom(cand.id, cand.headroomBytes) - requiredBytes;
    if (diff < minDifference) {
      minDifference = diff;
      bestCandidate = cand;
    }
  }

  return bestCandidate;
}

function commitCandidateDecision(
  account: CandidateAccount,
  virtualPath: string,
  sizeBytes: number,
  reason: 'folder_affinity' | 'best_fit',
  getEffectiveHeadroom: (accId: string, baseHeadroom: number) => number,
  getEffectiveBudget: (accId: string, baseBudget: number) => number,
  simulatedHeadrooms?: Map<string, number>,
  simulatedTransferBudgets?: Map<string, number>
): PlacementDecision {
  const before = getEffectiveHeadroom(account.id, account.headroomBytes);
  const after = before - sizeBytes;
  if (simulatedHeadrooms) {
    simulatedHeadrooms.set(account.id, after);
  }
  if (simulatedTransferBudgets) {
    const curBudget = getEffectiveBudget(account.id, account.transferStats.remainingUploadBytes24h);
    simulatedTransferBudgets.set(account.id, curBudget - sizeBytes);
  }

  return {
    accountId: account.id,
    virtualPath,
    sizeBytes,
    reason,
    headroomBeforeBytes: before,
    headroomAfterBytes: after,
  };
}

async function selectPlacementFromCandidates(
  item: PlacementItem,
  candidates: CandidateAccount[],
  simulatedHeadrooms?: Map<string, number>,
  simulatedTransferBudgets?: Map<string, number>,
  poolId?: number,
  affinityMap?: PoolFolderAffinityMap
): Promise<PlacementDecision> {
  assertValidFileSize(item.sizeBytes);
  const normalizedPath = normalizeVirtualPath(item.virtualPath);

  const getEffectiveHeadroom = (accId: string, baseHeadroom: number) => {
    if (simulatedHeadrooms && simulatedHeadrooms.has(accId)) {
      return simulatedHeadrooms.get(accId)!;
    }
    return baseHeadroom;
  };

  const getEffectiveBudget = (accId: string, baseBudget: number) => {
    if (simulatedTransferBudgets && simulatedTransferBudgets.has(accId)) {
      return simulatedTransferBudgets.get(accId)!;
    }
    return baseBudget;
  };

  const eligible = candidates.filter((cand) => {
    if (cand.isOverCeiling) return false;
    const effectiveHeadroom = getEffectiveHeadroom(cand.id, cand.headroomBytes);
    const effectiveBudget = getEffectiveBudget(cand.id, cand.transferStats.remainingUploadBytes24h);
    const hasHeadroom = effectiveHeadroom >= item.sizeBytes;
    const hasDailyBudget = effectiveBudget >= item.sizeBytes;
    return hasHeadroom && hasDailyBudget;
  });

  if (eligible.length === 0) {
    const hasSpaceAccount = candidates.some(
      (c) => !c.isOverCeiling && getEffectiveHeadroom(c.id, c.headroomBytes) >= item.sizeBytes
    );
    if (hasSpaceAccount) {
      throw new InsufficientStorageError(
        `All accounts with available headroom have exhausted their Google 750 GB daily transfer quota for ${item.virtualPath} (${item.sizeBytes} bytes)`
      );
    }
    throw new InsufficientStorageError(
      `No account has sufficient headroom or daily transfer quota for ${item.virtualPath} (${item.sizeBytes} bytes)`
    );
  }

  // Check 1: Folder Affinity (Existing path priority, restricted to provided candidates)
  // Skip affinity lookup when only one candidate is eligible since it cannot change the selection.
  const affinityAccountIds =
    eligible.length > 1
      ? affinityMap
        ? affinityMap.getAffinityAccounts(normalizedPath)
        : poolId !== undefined
          ? await findFolderAffinityAccounts(normalizedPath, poolId)
          : []
      : [];
  for (const affId of affinityAccountIds) {
    const match = eligible.find((cand) => cand.id === affId);
    if (match) {
      return commitCandidateDecision(
        match,
        normalizedPath,
        item.sizeBytes,
        'folder_affinity',
        getEffectiveHeadroom,
        getEffectiveBudget,
        simulatedHeadrooms,
        simulatedTransferBudgets
      );
    }
  }

  // Check 2: Best-Fit (Minimize headroom - sizeBytes among eligible accounts)
  const bestCandidate = pickBestFitCandidate(eligible, item.sizeBytes, getEffectiveHeadroom);
  return commitCandidateDecision(
    bestCandidate,
    normalizedPath,
    item.sizeBytes,
    'best_fit',
    getEffectiveHeadroom,
    getEffectiveBudget,
    simulatedHeadrooms,
    simulatedTransferBudgets
  );
}

/**
 * Selects an account for a single file upload using Folder-Cohesion Best-Fit.
 */
export async function selectPlacementForFile(
  item: PlacementItem,
  simulatedHeadrooms?: Map<string, number>,
  nowMs = Date.now(),
  simulatedTransferBudgets?: Map<string, number>,
  poolId = 1
): Promise<PlacementDecision> {
  assertValidFileSize(item.sizeBytes);

  const candidates = await getEligibleAccounts(poolId, nowMs);
  return selectPlacementFromCandidates(
    item,
    candidates,
    simulatedHeadrooms,
    simulatedTransferBudgets,
    poolId
  );
}

interface TreeNode {
  name: string;
  fullPath: string;
  files: PlacementItem[];
  subdirs: Map<string, TreeNode>;
  totalBranchBytes: number;
}

function buildDirectoryTree(items: PlacementItem[]): TreeNode {
  const root: TreeNode = {
    name: '/',
    fullPath: '/',
    files: [],
    subdirs: new Map(),
    totalBranchBytes: 0,
  };

  for (const item of items) {
    const norm = normalizeVirtualPath(item.virtualPath);
    const dir = path.posix.dirname(norm);
    const segments = dir === '/' ? [] : dir.split('/').filter(Boolean);

    let current = root;
    let accumulated = '';

    for (const seg of segments) {
      accumulated += `/${seg}`;
      if (!current.subdirs.has(seg)) {
        current.subdirs.set(seg, {
          name: seg,
          fullPath: accumulated,
          files: [],
          subdirs: new Map(),
          totalBranchBytes: 0,
        });
      }
      current = current.subdirs.get(seg)!;
    }

    current.files.push({ ...item, virtualPath: norm });
  }

  // Calculate bottom-up branch sizes
  function computeBranchSize(node: TreeNode): number {
    let size = 0;
    for (const f of node.files) {
      size += f.sizeBytes;
    }
    for (const child of node.subdirs.values()) {
      size += computeBranchSize(child);
    }
    node.totalBranchBytes = size;
    return size;
  }

  computeBranchSize(root);
  return root;
}

/**
 * Simulates batch upload placements against an explicit candidate list
 * using bottom-up branch sizing and Folder-Cohesion Best-Fit.
 */
export async function simulateBatchPlacement(
  items: PlacementItem[],
  candidates: CandidateAccount[],
  poolId?: number
): Promise<BatchPlacementPlan> {
  for (const item of items) {
    assertValidFileSize(item.sizeBytes);
  }

  const simulatedHeadrooms = new Map<string, number>();
  const simulatedTransferBudgets = new Map<string, number>();
  for (const c of candidates) {
    simulatedHeadrooms.set(c.id, c.headroomBytes);
    simulatedTransferBudgets.set(c.id, c.transferStats.remainingUploadBytes24h);
  }

  const getEffectiveHeadroom = (accId: string, baseHeadroom: number) =>
    simulatedHeadrooms.get(accId) ?? baseHeadroom;
  const getEffectiveBudget = (accId: string, baseBudget: number) =>
    simulatedTransferBudgets.get(accId) ?? baseBudget;

  const affinityMap =
    poolId !== undefined && candidates.length > 1 ? await buildPoolFolderAffinityMap(poolId) : undefined;

  const decisions: PlacementDecision[] = [];
  const accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }> = {};

  const recordDecision = (decision: PlacementDecision) => {
    decisions.push(decision);
    if (!accountAllocations[decision.accountId]) {
      accountAllocations[decision.accountId] = { filesCount: 0, bytesAllocated: 0 };
    }
    accountAllocations[decision.accountId].filesCount++;
    accountAllocations[decision.accountId].bytesAllocated += decision.sizeBytes;
    affinityMap?.recordAssignment(decision.virtualPath, decision.accountId);
  };

  const tree = buildDirectoryTree(items);

  async function placeNode(node: TreeNode): Promise<void> {
    function collectFiles(n: TreeNode): PlacementItem[] {
      const list = [...n.files];
      for (const child of n.subdirs.values()) {
        list.push(...collectFiles(child));
      }
      return list;
    }

    const branchFiles = collectFiles(node);
    if (branchFiles.length === 0) return;

    const eligibleForBranch = candidates.filter((cand) => {
      if (cand.isOverCeiling) return false;
      const effectiveHeadroom = getEffectiveHeadroom(cand.id, cand.headroomBytes);
      const effectiveBudget = getEffectiveBudget(cand.id, cand.transferStats.remainingUploadBytes24h);
      return effectiveHeadroom >= node.totalBranchBytes && effectiveBudget >= node.totalBranchBytes;
    });

    if (eligibleForBranch.length > 0 && node.fullPath !== '/') {
      // Find affinity or best-fit for the branch as a whole (restricted to provided candidates)
      const affinityIds =
        eligibleForBranch.length > 1
          ? affinityMap
            ? affinityMap.getAffinityAccountsForDirectory(node.fullPath)
            : poolId !== undefined
              ? await findFolderAffinityAccountsForDirectory(node.fullPath, poolId)
              : []
          : [];
      let targetAccount: CandidateAccount | undefined;
      for (const affId of affinityIds) {
        const match = eligibleForBranch.find((cand) => cand.id === affId);
        if (match) {
          targetAccount = match;
          break;
        }
      }
      let reason: 'folder_affinity' | 'best_fit' = 'folder_affinity';

      if (!targetAccount) {
        reason = 'best_fit';
        targetAccount = pickBestFitCandidate(
          eligibleForBranch,
          node.totalBranchBytes,
          getEffectiveHeadroom
        );
      }

      for (const f of branchFiles) {
        recordDecision(
          commitCandidateDecision(
            targetAccount,
            f.virtualPath,
            f.sizeBytes,
            reason,
            getEffectiveHeadroom,
            getEffectiveBudget,
            simulatedHeadrooms,
            simulatedTransferBudgets
          )
        );
      }
      return;
    }

    // Branch exceeds single account headroom or is root: split at subfolder boundaries
    for (const child of node.subdirs.values()) {
      await placeNode(child);
    }

    for (const f of node.files) {
      const decision = await selectPlacementFromCandidates(
        f,
        candidates,
        simulatedHeadrooms,
        simulatedTransferBudgets,
        poolId,
        affinityMap
      );
      recordDecision(decision);
    }
  }

  await placeNode(tree);

  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);

  return {
    totalFiles: items.length,
    totalBytes,
    decisions,
    accountAllocations,
  };
}

/**
 * Plans batch upload placements using bottom-up branch sizing.
 * Subfolder branches fitting into an account are placed together.
 * Oversized branches split at subfolder boundaries.
 */
export async function planBatchPlacement(
  items: PlacementItem[],
  nowMs = Date.now(),
  poolId = 1
): Promise<BatchPlacementPlan> {
  const candidates = await getEligibleAccounts(poolId, nowMs);
  return simulateBatchPlacement(items, candidates, poolId);
}

/**
 * Looks up active (non-trashed) pool files matching the given virtual paths.
 */
export async function findExistingActiveFilesByPaths(
  poolId: number,
  virtualPaths: string[]
): Promise<Map<string, ExistingPoolFileSummary>> {
  const result = new Map<string, ExistingPoolFileSummary>();
  if (virtualPaths.length === 0) {
    return result;
  }

  const uniquePaths = Array.from(new Set(virtualPaths.map((p) => normalizeVirtualPath(p))));

  for (const chunk of chunkArray(uniquePaths, 400)) {
    const rows = await db
      .select({
        id: files.id,
        virtualPath: files.virtualPath,
        name: files.name,
        sizeBytes: files.sizeBytes,
        hash: files.hash,
        accountId: files.accountId,
        updatedAt: files.updatedAt,
      })
      .from(files)
      .where(and(eq(files.poolId, poolId), eq(files.isTrashed, false), inArray(files.virtualPath, chunk)));

    for (const row of rows) {
      const updatedMs =
        row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt) * 1000;
      result.set(row.virtualPath, {
        id: row.id,
        virtualPath: row.virtualPath,
        name: row.name,
        sizeBytes: row.sizeBytes,
        hash: row.hash,
        accountId: row.accountId,
        updatedAt: Number.isFinite(updatedMs) ? updatedMs : 0,
      });
    }
  }

  return result;
}

/**
 * Detects path collisions against active pool files and plans placement
 * for non-skipped items against real in-flight headroom, while reporting net storage delta.
 */
export async function planUploadBatchWithConflicts(
  items: UploadPlacementRequestItem[],
  nowMs = Date.now(),
  poolId = 1
): Promise<UploadBatchPlacementPlan> {
  for (const item of items) {
    assertValidFileSize(item.sizeBytes);
  }

  const existingByPath = await findExistingActiveFilesByPaths(
    poolId,
    items.map((item) => item.virtualPath)
  );

  const conflicts: Record<string, ExistingPoolFileSummary> = {};
  const itemsToPlace: PlacementItem[] = [];
  let replacedBytes = 0;

  for (const item of items) {
    const normPath = normalizeVirtualPath(item.virtualPath);
    const existing = existingByPath.get(normPath);

    if (existing) {
      conflicts[normPath] = existing;
      if (item.conflictAction === 'replace') {
        replacedBytes += existing.sizeBytes;
        itemsToPlace.push({ virtualPath: normPath, sizeBytes: item.sizeBytes });
      } else if (item.conflictAction === 'keep_both') {
        itemsToPlace.push({ virtualPath: normPath, sizeBytes: item.sizeBytes });
      }
      // Conflicts with action 'skip' or unset default to skip and are excluded from allocation.
      continue;
    }

    itemsToPlace.push({ virtualPath: normPath, sizeBytes: item.sizeBytes });
  }

  if (itemsToPlace.length === 0) {
    return {
      totalFiles: 0,
      totalBytes: 0,
      replacedBytes: 0,
      netStorageDeltaBytes: 0,
      decisions: [],
      accountAllocations: {},
      conflicts,
    };
  }

  const candidates = await getEligibleAccounts(poolId, nowMs);
  const plan = await simulateBatchPlacement(itemsToPlace, candidates, poolId);
  return {
    ...plan,
    replacedBytes,
    netStorageDeltaBytes: plan.totalBytes - replacedBytes,
    conflicts,
  };
}

/**
 * Validates whether a specific target account can accept a file of sizeBytes.
 * Enforces the strict 750 MB reserve ceiling and 24-hour rolling transfer window.
 */
export async function validateTargetPlacement(
  accountId: string,
  sizeBytes: number,
  nowMs = Date.now(),
  expectedPoolId?: number
): Promise<CandidateAccount> {
  assertValidFileSize(sizeBytes);

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!account) {
    throw new Error(`Target account ${accountId} not found in database`);
  }

  if (expectedPoolId !== undefined && account.poolId !== expectedPoolId) {
    throw new InsufficientStorageError(`Drive "${account.displayName || accountId}" does not belong to Pool ${expectedPoolId}`);
  }

  if (account.isDisabled) {
    throw new InsufficientStorageError(
      `Drive "${account.displayName || accountId}" is disabled and cannot accept uploads`
    );
  }

  if (account.syncState === 'error') {
    throw new InsufficientStorageError(
      `Drive "${account.displayName || accountId}" is in an error state`
    );
  }

  if (
    account.quotaUsedBytes >= account.quotaLimitBytes ||
    account.quotaUsedBytes > calculateUsableLimit(account.quotaLimitBytes)
  ) {
    throw new InsufficientStorageError(
      `Drive "${account.displayName || accountId}" has exceeded its usable storage ceiling`
    );
  }

  const rawHeadroom = calculateHeadroom(account.quotaLimitBytes, account.quotaUsedBytes);
  const rawTransferStats = await getAccountTransferStats(accountId, nowMs);
  const { headroomBytes: headroom, transferStats } = applyInFlightReservation(
    accountId,
    rawHeadroom,
    rawTransferStats
  );

  if (headroom < sizeBytes) {
    throw new InsufficientStorageError(
      `Drive "${account.displayName || accountId}" has insufficient headroom (${(headroom / (1024 * 1024 * 1024)).toFixed(2)} GB available, needs ${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB to preserve 750 MB reserve ceiling)`
    );
  }

  if (transferStats.remainingUploadBytes24h < sizeBytes) {
    throw new InsufficientStorageError(
      `Drive "${account.displayName || accountId}" has exhausted its Google 750 GB daily transfer quota (${(transferStats.remainingUploadBytes24h / (1024 * 1024 * 1024)).toFixed(2)} GB remaining)`
    );
  }

  return {
    id: account.id,
    email: account.email,
    headroomBytes: headroom,
    transferStats,
  };
}


