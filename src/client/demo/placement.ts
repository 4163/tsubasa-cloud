import type { AccountTransferStats, ExistingPoolFile, UploadConflictAction } from '../types.js';
import { getParentDir, normalizeVirtualPath } from '../utils/virtualPath.js';
import type { DemoAccountRecord, DemoFileRecord, DemoTransferLogRecord } from './db.js';
import {
  buildEmptyTransferStats,
  calculateHeadroom,
  calculateUsableLimit,
  computeTransferStatsByAccount,
  MAX_SINGLE_FILE_BYTES,
} from './quota.js';

export class DemoFileExceedsCeilingError extends Error {
  readonly code = 'EXCEEDS_CEILING' as const;
  readonly status = 400 as const;

  constructor(sizeBytes: number) {
    const sizeGb = (sizeBytes / (1024 * 1024 * 1024)).toFixed(2);
    super(`File size (${sizeGb} GB) exceeds single-account ceiling of 14.25 GB`);
    this.name = 'DemoFileExceedsCeilingError';
  }
}

export class DemoInsufficientStorageError extends Error {
  readonly code = 'INSUFFICIENT_STORAGE' as const;
  readonly status = 507 as const;

  constructor(message = 'No account in pool has sufficient headroom or daily transfer quota') {
    super(message);
    this.name = 'DemoInsufficientStorageError';
  }
}

export interface DemoCandidateAccount {
  id: string;
  email: string;
  headroomBytes: number;
  transferStats: AccountTransferStats;
  isOverCeiling: boolean;
}

export interface DemoPlacementItem {
  virtualPath: string;
  sizeBytes: number;
}

export interface DemoUploadPlacementRequestItem extends DemoPlacementItem {
  conflictAction?: UploadConflictAction;
}

export interface DemoPlacementDecision {
  accountId: string;
  virtualPath: string;
  sizeBytes: number;
  reason: 'folder_affinity' | 'best_fit';
  headroomBeforeBytes: number;
  headroomAfterBytes: number;
}

export interface DemoBatchPlacementPlan {
  totalFiles: number;
  totalBytes: number;
  decisions: DemoPlacementDecision[];
  accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }>;
}

export interface DemoUploadBatchPlacementPlan extends DemoBatchPlacementPlan {
  replacedBytes: number;
  netStorageDeltaBytes: number;
  conflicts: Record<string, ExistingPoolFile>;
}

export interface DemoFolderAffinityMap {
  getAffinityAccounts(normalizedPath: string): string[];
  getAffinityAccountsForDirectory(dirPath: string): string[];
  recordAssignment(virtualPath: string, accountId: string): void;
}

export function assertValidDemoFileSize(sizeBytes: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Invalid file size: ${sizeBytes}`);
  }
  if (sizeBytes > MAX_SINGLE_FILE_BYTES) {
    throw new DemoFileExceedsCeilingError(sizeBytes);
  }
}

export function getEligibleDemoCandidates(
  poolId: number,
  allAccounts: DemoAccountRecord[],
  transferLogs: DemoTransferLogRecord[],
  nowMs = Date.now()
): DemoCandidateAccount[] {
  const activeAccounts = allAccounts.filter(
    (acc) => acc.poolId === poolId && acc.authorized && !acc.isDisabled && acc.syncState !== 'error'
  );
  const statsMap = computeTransferStatsByAccount(
    activeAccounts.map((a) => a.id),
    transferLogs,
    nowMs
  );

  return activeAccounts.map((acc) => {
    const headroomBytes = calculateHeadroom(acc.quotaLimitBytes, acc.quotaUsedBytes);
    const transferStats = statsMap.get(acc.id) ?? buildEmptyTransferStats(acc.id);
    const isOverCeiling =
      acc.quotaUsedBytes >= acc.quotaLimitBytes ||
      acc.quotaUsedBytes > calculateUsableLimit(acc.quotaLimitBytes);

    return {
      id: acc.id,
      email: acc.email,
      headroomBytes,
      transferStats,
      isOverCeiling,
    };
  });
}

function normalizeAffinityDir(startDir: string): string {
  if (!startDir || startDir === '.') return '';
  return startDir.replace(/\/+$/, '') || '/';
}

function incrementDirCounts(
  dirCounts: Map<string, Map<string, number>>,
  virtualPath: string,
  accountId: string
): void {
  let currentDir = getParentDir(normalizeVirtualPath(virtualPath));
  while (currentDir && currentDir !== '.' && currentDir !== '/') {
    let counts = dirCounts.get(currentDir);
    if (!counts) {
      counts = new Map<string, number>();
      dirCounts.set(currentDir, counts);
    }
    counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
    currentDir = getParentDir(currentDir);
  }
}

function lookupAffinityAccounts(
  dirCounts: Map<string, Map<string, number>>,
  startDir: string
): string[] {
  let currentDir = normalizeAffinityDir(startDir);
  // Stop before '/' so root-level files and new top-level folders fall back to Best-Fit.
  while (currentDir && currentDir !== '.' && currentDir !== '/') {
    const counts = dirCounts.get(currentDir);
    if (counts && counts.size > 0) {
      return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([accountId]) => accountId);
    }
    currentDir = getParentDir(currentDir);
  }
  return [];
}

export function buildDemoFolderAffinityMap(
  poolId: number,
  allFiles: DemoFileRecord[]
): DemoFolderAffinityMap {
  const dirCounts = new Map<string, Map<string, number>>();
  for (const file of allFiles) {
    if (file.poolId === poolId && !file.isTrashed) {
      incrementDirCounts(dirCounts, file.virtualPath, file.accountId);
    }
  }

  return {
    getAffinityAccounts(normalizedPath: string): string[] {
      return lookupAffinityAccounts(dirCounts, getParentDir(normalizedPath));
    },
    getAffinityAccountsForDirectory(dirPath: string): string[] {
      return lookupAffinityAccounts(dirCounts, dirPath);
    },
    recordAssignment(virtualPath: string, accountId: string): void {
      incrementDirCounts(dirCounts, virtualPath, accountId);
    },
  };
}

function pickBestFitCandidate(
  eligible: DemoCandidateAccount[],
  requiredBytes: number,
  getEffectiveHeadroom: (accId: string, base: number) => number
): DemoCandidateAccount {
  let best = eligible[0];
  let minDiff = getEffectiveHeadroom(best.id, best.headroomBytes) - requiredBytes;

  for (let i = 1; i < eligible.length; i++) {
    const cand = eligible[i];
    const diff = getEffectiveHeadroom(cand.id, cand.headroomBytes) - requiredBytes;
    if (diff < minDiff) {
      minDiff = diff;
      best = cand;
    }
  }
  return best;
}

function commitDecision(
  account: DemoCandidateAccount,
  virtualPath: string,
  sizeBytes: number,
  reason: 'folder_affinity' | 'best_fit',
  getEffectiveHeadroom: (accId: string, base: number) => number,
  getEffectiveBudget: (accId: string, base: number) => number,
  simulatedHeadrooms?: Map<string, number>,
  simulatedBudgets?: Map<string, number>
): DemoPlacementDecision {
  const before = getEffectiveHeadroom(account.id, account.headroomBytes);
  const after = before - sizeBytes;
  if (simulatedHeadrooms) {
    simulatedHeadrooms.set(account.id, after);
  }
  if (simulatedBudgets) {
    const curBudget = getEffectiveBudget(account.id, account.transferStats.remainingUploadBytes24h);
    simulatedBudgets.set(account.id, curBudget - sizeBytes);
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

function selectPlacementFromCandidates(
  item: DemoPlacementItem,
  candidates: DemoCandidateAccount[],
  simulatedHeadrooms?: Map<string, number>,
  simulatedBudgets?: Map<string, number>,
  affinityMap?: DemoFolderAffinityMap
): DemoPlacementDecision {
  assertValidDemoFileSize(item.sizeBytes);
  const normalizedPath = normalizeVirtualPath(item.virtualPath);

  const getEffectiveHeadroom = (accId: string, base: number) =>
    simulatedHeadrooms?.has(accId) ? simulatedHeadrooms.get(accId)! : base;
  const getEffectiveBudget = (accId: string, base: number) =>
    simulatedBudgets?.has(accId) ? simulatedBudgets.get(accId)! : base;

  const eligible = candidates.filter((cand) => {
    if (cand.isOverCeiling) return false;
    return (
      getEffectiveHeadroom(cand.id, cand.headroomBytes) >= item.sizeBytes &&
      getEffectiveBudget(cand.id, cand.transferStats.remainingUploadBytes24h) >= item.sizeBytes
    );
  });

  if (eligible.length === 0) {
    const hasSpaceAccount = candidates.some(
      (c) => !c.isOverCeiling && getEffectiveHeadroom(c.id, c.headroomBytes) >= item.sizeBytes
    );
    if (hasSpaceAccount) {
      throw new DemoInsufficientStorageError(
        `All accounts with available headroom have exhausted their Google 750 GB daily transfer quota for ${item.virtualPath} (${item.sizeBytes} bytes)`
      );
    }
    throw new DemoInsufficientStorageError(
      `No account has sufficient headroom or daily transfer quota for ${item.virtualPath} (${item.sizeBytes} bytes)`
    );
  }

  const affinityIds =
    eligible.length > 1 && affinityMap ? affinityMap.getAffinityAccounts(normalizedPath) : [];
  for (const affId of affinityIds) {
    const match = eligible.find((cand) => cand.id === affId);
    if (match) {
      return commitDecision(
        match,
        normalizedPath,
        item.sizeBytes,
        'folder_affinity',
        getEffectiveHeadroom,
        getEffectiveBudget,
        simulatedHeadrooms,
        simulatedBudgets
      );
    }
  }

  const best = pickBestFitCandidate(eligible, item.sizeBytes, getEffectiveHeadroom);
  return commitDecision(
    best,
    normalizedPath,
    item.sizeBytes,
    'best_fit',
    getEffectiveHeadroom,
    getEffectiveBudget,
    simulatedHeadrooms,
    simulatedBudgets
  );
}

interface TreeNode {
  name: string;
  fullPath: string;
  files: DemoPlacementItem[];
  subdirs: Map<string, TreeNode>;
  totalBranchBytes: number;
}

function buildDirectoryTree(items: DemoPlacementItem[]): TreeNode {
  const root: TreeNode = {
    name: '/',
    fullPath: '/',
    files: [],
    subdirs: new Map(),
    totalBranchBytes: 0,
  };

  for (const item of items) {
    const norm = normalizeVirtualPath(item.virtualPath);
    const dir = getParentDir(norm);
    const segments = dir === '/' ? [] : dir.split('/').filter(Boolean);

    let current = root;
    let accumulated = '';
    for (const seg of segments) {
      accumulated += `/${seg}`;
      let next = current.subdirs.get(seg);
      if (!next) {
        next = {
          name: seg,
          fullPath: accumulated,
          files: [],
          subdirs: new Map(),
          totalBranchBytes: 0,
        };
        current.subdirs.set(seg, next);
      }
      current = next;
    }

    current.files.push({ ...item, virtualPath: norm });
  }

  function computeBranchSize(node: TreeNode): number {
    let total = 0;
    for (const f of node.files) total += f.sizeBytes;
    for (const child of node.subdirs.values()) total += computeBranchSize(child);
    node.totalBranchBytes = total;
    return total;
  }

  computeBranchSize(root);
  return root;
}

export function simulateDemoBatchPlacement(
  items: DemoPlacementItem[],
  candidates: DemoCandidateAccount[],
  affinityMap?: DemoFolderAffinityMap
): DemoBatchPlacementPlan {
  for (const item of items) {
    assertValidDemoFileSize(item.sizeBytes);
  }

  const simulatedHeadrooms = new Map<string, number>();
  const simulatedBudgets = new Map<string, number>();
  for (const c of candidates) {
    simulatedHeadrooms.set(c.id, c.headroomBytes);
    simulatedBudgets.set(c.id, c.transferStats.remainingUploadBytes24h);
  }

  const getEffectiveHeadroom = (accId: string, base: number) =>
    simulatedHeadrooms.get(accId) ?? base;
  const getEffectiveBudget = (accId: string, base: number) =>
    simulatedBudgets.get(accId) ?? base;

  const decisions: DemoPlacementDecision[] = [];
  const accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }> = {};

  const recordDecision = (decision: DemoPlacementDecision) => {
    decisions.push(decision);
    if (!accountAllocations[decision.accountId]) {
      accountAllocations[decision.accountId] = { filesCount: 0, bytesAllocated: 0 };
    }
    accountAllocations[decision.accountId].filesCount += 1;
    accountAllocations[decision.accountId].bytesAllocated += decision.sizeBytes;
    affinityMap?.recordAssignment(decision.virtualPath, decision.accountId);
  };

  const tree = buildDirectoryTree(items);

  function collectFiles(node: TreeNode): DemoPlacementItem[] {
    const out = [...node.files];
    for (const child of node.subdirs.values()) {
      out.push(...collectFiles(child));
    }
    return out;
  }

  function placeNode(node: TreeNode): void {
    const branchFiles = collectFiles(node);
    if (branchFiles.length === 0) return;

    const eligibleForBranch = candidates.filter((cand) => {
      if (cand.isOverCeiling) return false;
      return (
        getEffectiveHeadroom(cand.id, cand.headroomBytes) >= node.totalBranchBytes &&
        getEffectiveBudget(cand.id, cand.transferStats.remainingUploadBytes24h) >= node.totalBranchBytes
      );
    });

    if (eligibleForBranch.length > 0 && node.fullPath !== '/') {
      const affinityIds =
        eligibleForBranch.length > 1 && affinityMap
          ? affinityMap.getAffinityAccountsForDirectory(node.fullPath)
          : [];

      let target: DemoCandidateAccount | undefined;
      for (const affId of affinityIds) {
        const match = eligibleForBranch.find((c) => c.id === affId);
        if (match) {
          target = match;
          break;
        }
      }

      let reason: 'folder_affinity' | 'best_fit' = 'folder_affinity';
      if (!target) {
        reason = 'best_fit';
        target = pickBestFitCandidate(eligibleForBranch, node.totalBranchBytes, getEffectiveHeadroom);
      }

      for (const f of branchFiles) {
        recordDecision(
          commitDecision(
            target,
            f.virtualPath,
            f.sizeBytes,
            reason,
            getEffectiveHeadroom,
            getEffectiveBudget,
            simulatedHeadrooms,
            simulatedBudgets
          )
        );
      }
      return;
    }

    for (const child of node.subdirs.values()) {
      placeNode(child);
    }

    for (const f of node.files) {
      const decision = selectPlacementFromCandidates(
        f,
        candidates,
        simulatedHeadrooms,
        simulatedBudgets,
        affinityMap
      );
      recordDecision(decision);
    }
  }

  placeNode(tree);

  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  return {
    totalFiles: items.length,
    totalBytes,
    decisions,
    accountAllocations,
  };
}

export function selectDemoPlacementForFile(
  item: DemoPlacementItem,
  poolId: number,
  allAccounts: DemoAccountRecord[],
  allFiles: DemoFileRecord[],
  transferLogs: DemoTransferLogRecord[],
  nowMs = Date.now()
): DemoPlacementDecision {
  assertValidDemoFileSize(item.sizeBytes);
  const candidates = getEligibleDemoCandidates(poolId, allAccounts, transferLogs, nowMs);
  const affinityMap = candidates.length > 1 ? buildDemoFolderAffinityMap(poolId, allFiles) : undefined;
  return selectPlacementFromCandidates(item, candidates, undefined, undefined, affinityMap);
}

export function planDemoUploadBatchWithConflicts(
  items: DemoUploadPlacementRequestItem[],
  poolId: number,
  allAccounts: DemoAccountRecord[],
  allFiles: DemoFileRecord[],
  transferLogs: DemoTransferLogRecord[],
  nowMs = Date.now()
): DemoUploadBatchPlacementPlan {
  for (const item of items) {
    assertValidDemoFileSize(item.sizeBytes);
  }

  const activeByPath = new Map<string, DemoFileRecord>();
  for (const f of allFiles) {
    if (f.poolId === poolId && !f.isTrashed) {
      activeByPath.set(normalizeVirtualPath(f.virtualPath), f);
    }
  }

  const conflicts: Record<string, ExistingPoolFile> = {};
  const itemsToPlace: DemoPlacementItem[] = [];
  let replacedBytes = 0;

  for (const item of items) {
    const normPath = normalizeVirtualPath(item.virtualPath);
    const existing = activeByPath.get(normPath);

    if (existing) {
      const parsedMs = Date.parse(existing.updatedAt);
      conflicts[normPath] = {
        id: existing.id,
        virtualPath: existing.virtualPath,
        name: existing.name,
        sizeBytes: existing.sizeBytes,
        hash: existing.hash,
        accountId: existing.accountId,
        updatedAt: Number.isFinite(parsedMs) ? parsedMs : 0,
      };
      if (item.conflictAction === 'replace') {
        replacedBytes += existing.sizeBytes;
        itemsToPlace.push({ virtualPath: normPath, sizeBytes: item.sizeBytes });
      } else if (item.conflictAction === 'keep_both') {
        itemsToPlace.push({ virtualPath: normPath, sizeBytes: item.sizeBytes });
      }
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

  const candidates = getEligibleDemoCandidates(poolId, allAccounts, transferLogs, nowMs);
  const affinityMap = candidates.length > 1 ? buildDemoFolderAffinityMap(poolId, allFiles) : undefined;
  const plan = simulateDemoBatchPlacement(itemsToPlace, candidates, affinityMap);

  return {
    ...plan,
    replacedBytes,
    netStorageDeltaBytes: plan.totalBytes - replacedBytes,
    conflicts,
  };
}

export function validateDemoTargetPlacement(
  accountId: string,
  sizeBytes: number,
  expectedPoolId: number | undefined,
  allAccounts: DemoAccountRecord[],
  transferLogs: DemoTransferLogRecord[],
  nowMs = Date.now()
): DemoCandidateAccount {
  assertValidDemoFileSize(sizeBytes);

  const account = allAccounts.find((a) => a.id === accountId);
  if (!account || !account.authorized) {
    throw new Error(`Target account ${accountId} not found`);
  }
  if (expectedPoolId !== undefined && account.poolId !== expectedPoolId) {
    throw new Error(`Target account ${accountId} does not belong to Pool ${expectedPoolId}`);
  }
  if (account.isDisabled) {
    throw new DemoInsufficientStorageError(`Target account ${accountId} is disabled`);
  }
  if (account.syncState === 'error') {
    throw new DemoInsufficientStorageError(`Target account ${accountId} is in an error sync state`);
  }

  const usable = calculateUsableLimit(account.quotaLimitBytes);
  const headroomBytes = calculateHeadroom(account.quotaLimitBytes, account.quotaUsedBytes);
  const isOverCeiling =
    account.quotaUsedBytes >= account.quotaLimitBytes || account.quotaUsedBytes > usable;

  if (isOverCeiling || headroomBytes < sizeBytes) {
    throw new DemoInsufficientStorageError(
      `Account ${account.email} lacks sufficient headroom (${headroomBytes} bytes available, requires ${sizeBytes} bytes)`
    );
  }

  const statsMap = computeTransferStatsByAccount([account.id], transferLogs, nowMs);
  const transferStats = statsMap.get(account.id) ?? buildEmptyTransferStats(account.id);
  if (transferStats.remainingUploadBytes24h < sizeBytes) {
    throw new DemoInsufficientStorageError(
      `Account ${account.email} has insufficient Google 750 GB daily transfer quota`
    );
  }

  return {
    id: account.id,
    email: account.email,
    headroomBytes,
    transferStats,
    isOverCeiling,
  };
}
