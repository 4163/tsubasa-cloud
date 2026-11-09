import path from 'node:path';
import { db } from '../db/index.js';
import { accounts, files } from '../db/schema.js';
import { eq, and, sql, not } from 'drizzle-orm';
import {
  calculateHeadroom,
  getAccountTransferStats,
  MAX_SINGLE_FILE_BYTES,
  type AccountTransferStats,
} from './quota.js';
import { normalizeVirtualPath } from '../drive/mirror.js';

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

/**
 * Returns candidate accounts with their current headroom and 24h upload stats.
 */
export async function getEligibleAccounts(nowMs = Date.now()): Promise<CandidateAccount[]> {
  const allAccounts = await db
    .select()
    .from(accounts)
    .where(and(not(eq(accounts.syncState, 'error')), eq(accounts.isDisabled, false)));

  const candidates: CandidateAccount[] = [];

  for (const acc of allAccounts) {
    const headroom = calculateHeadroom(acc.quotaLimitBytes, acc.quotaUsedBytes);
    const transferStats = await getAccountTransferStats(acc.id, nowMs);

    candidates.push({
      id: acc.id,
      email: acc.email,
      headroomBytes: headroom,
      transferStats,
    });
  }

  return candidates;
}

/**
 * Finds accounts holding files in parent or ancestor paths of the virtual target.
 * Returns accounts ordered by number of co-located files descending.
 */
export async function findFolderAffinityAccounts(normalizedPath: string): Promise<string[]> {
  let currentDir = path.posix.dirname(normalizedPath);

  while (currentDir && currentDir !== '.') {
    const pathPrefix = currentDir === '/' ? '/' : `${currentDir}/`;

    const affinityRows = await db
      .select({
        accountId: files.accountId,
        fileCount: sql<number>`count(*)`,
      })
      .from(files)
      .where(
        and(
          eq(files.isTrashed, false),
          sql`${files.virtualPath} LIKE ${pathPrefix + '%'}`
        )
      )
      .groupBy(files.accountId)
      .orderBy(sql`count(*) DESC`);

    if (affinityRows.length > 0) {
      return affinityRows.map((r) => r.accountId);
    }

    if (currentDir === '/') break;
    currentDir = path.posix.dirname(currentDir);
  }

  return [];
}

/**
 * Selects an account for a single file upload using Folder-Cohesion Best-Fit.
 */
export async function selectPlacementForFile(
  item: PlacementItem,
  simulatedHeadrooms?: Map<string, number>,
  nowMs = Date.now(),
  simulatedTransferBudgets?: Map<string, number>
): Promise<PlacementDecision> {
  const normalizedPath = normalizeVirtualPath(item.virtualPath);

  if (item.sizeBytes > MAX_SINGLE_FILE_BYTES) {
    throw new FileExceedsCeilingError(item.sizeBytes);
  }

  const candidates = await getEligibleAccounts(nowMs);

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

  // Filter candidates with sufficient effective headroom and daily transfer budget
  const eligible = candidates.filter((cand) => {
    const effectiveHeadroom = getEffectiveHeadroom(cand.id, cand.headroomBytes);
    const effectiveBudget = getEffectiveBudget(cand.id, cand.transferStats.remainingUploadBytes24h);
    const hasHeadroom = effectiveHeadroom >= item.sizeBytes;
    const hasDailyBudget = effectiveBudget >= item.sizeBytes;
    return hasHeadroom && hasDailyBudget;
  });

  if (eligible.length === 0) {
    const hasSpaceAccount = candidates.some((c) => getEffectiveHeadroom(c.id, c.headroomBytes) >= item.sizeBytes);
    if (hasSpaceAccount) {
      throw new InsufficientStorageError(
        `All accounts with available headroom have exhausted their Google 750 GB daily transfer quota for ${item.virtualPath} (${item.sizeBytes} bytes)`
      );
    }
    throw new InsufficientStorageError(
      `No account has sufficient headroom or daily transfer quota for ${item.virtualPath} (${item.sizeBytes} bytes)`
    );
  }

  // Check 1: Folder Affinity (Existing path priority)
  const affinityAccountIds = await findFolderAffinityAccounts(normalizedPath);
  for (const affId of affinityAccountIds) {
    const match = eligible.find((cand) => cand.id === affId);
    if (match) {
      const before = getEffectiveHeadroom(match.id, match.headroomBytes);
      const after = before - item.sizeBytes;
      if (simulatedHeadrooms) simulatedHeadrooms.set(match.id, after);

      if (simulatedTransferBudgets) {
        const curBudget = getEffectiveBudget(match.id, match.transferStats.remainingUploadBytes24h);
        simulatedTransferBudgets.set(match.id, curBudget - item.sizeBytes);
      }

      return {
        accountId: match.id,
        virtualPath: normalizedPath,
        sizeBytes: item.sizeBytes,
        reason: 'folder_affinity',
        headroomBeforeBytes: before,
        headroomAfterBytes: after,
      };
    }
  }

  // Check 2: Best-Fit (Minimize headroom - sizeBytes among eligible accounts)
  let bestCandidate = eligible[0];
  let minDifference = getEffectiveHeadroom(bestCandidate.id, bestCandidate.headroomBytes) - item.sizeBytes;

  for (let i = 1; i < eligible.length; i++) {
    const cand = eligible[i];
    const diff = getEffectiveHeadroom(cand.id, cand.headroomBytes) - item.sizeBytes;
    if (diff < minDifference) {
      minDifference = diff;
      bestCandidate = cand;
    }
  }

  const before = getEffectiveHeadroom(bestCandidate.id, bestCandidate.headroomBytes);
  const after = before - item.sizeBytes;
  if (simulatedHeadrooms) simulatedHeadrooms.set(bestCandidate.id, after);

  if (simulatedTransferBudgets) {
    const curBudget = getEffectiveBudget(bestCandidate.id, bestCandidate.transferStats.remainingUploadBytes24h);
    simulatedTransferBudgets.set(bestCandidate.id, curBudget - item.sizeBytes);
  }

  return {
    accountId: bestCandidate.id,
    virtualPath: normalizedPath,
    sizeBytes: item.sizeBytes,
    reason: 'best_fit',
    headroomBeforeBytes: before,
    headroomAfterBytes: after,
  };
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
 * Plans batch upload placements using bottom-up branch sizing.
 * Subfolder branches fitting into an account are placed together.
 * Oversized branches split at subfolder boundaries.
 */
export async function planBatchPlacement(
  items: PlacementItem[],
  nowMs = Date.now()
): Promise<BatchPlacementPlan> {
  for (const item of items) {
    if (item.sizeBytes > MAX_SINGLE_FILE_BYTES) {
      throw new FileExceedsCeilingError(item.sizeBytes);
    }
  }

  const simulatedHeadrooms = new Map<string, number>();
  const simulatedTransferBudgets = new Map<string, number>();
  const candidates = await getEligibleAccounts(nowMs);
  for (const c of candidates) {
    simulatedHeadrooms.set(c.id, c.headroomBytes);
    simulatedTransferBudgets.set(c.id, c.transferStats.remainingUploadBytes24h);
  }

  const decisions: PlacementDecision[] = [];
  const accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }> = {};

  const recordDecision = (decision: PlacementDecision) => {
    decisions.push(decision);
    if (!accountAllocations[decision.accountId]) {
      accountAllocations[decision.accountId] = { filesCount: 0, bytesAllocated: 0 };
    }
    accountAllocations[decision.accountId].filesCount++;
    accountAllocations[decision.accountId].bytesAllocated += decision.sizeBytes;
  };

  const tree = buildDirectoryTree(items);

  async function placeNode(node: TreeNode): Promise<void> {
    // Collect all descendant files in this branch
    function collectFiles(n: TreeNode): PlacementItem[] {
      const list = [...n.files];
      for (const child of n.subdirs.values()) {
        list.push(...collectFiles(child));
      }
      return list;
    }

    const branchFiles = collectFiles(node);
    if (branchFiles.length === 0) return;

    // Check if entire branch fits into a single account's effective headroom and transfer budget
    const eligibleForBranch = candidates.filter((cand) => {
      const effectiveHeadroom = simulatedHeadrooms.get(cand.id) ?? cand.headroomBytes;
      const effectiveBudget = simulatedTransferBudgets.get(cand.id) ?? cand.transferStats.remainingUploadBytes24h;
      return effectiveHeadroom >= node.totalBranchBytes && effectiveBudget >= node.totalBranchBytes;
    });

    if (eligibleForBranch.length > 0 && node.fullPath !== '/') {
      // Find affinity or best-fit for the branch as a whole
      const affinityIds = await findFolderAffinityAccounts(node.fullPath);
      let targetAccount = eligibleForBranch.find((cand) => affinityIds.includes(cand.id));
      let reason: 'folder_affinity' | 'best_fit' = 'folder_affinity';

      if (!targetAccount) {
        reason = 'best_fit';
        targetAccount = eligibleForBranch[0];
        let minDiff = (simulatedHeadrooms.get(targetAccount.id) ?? targetAccount.headroomBytes) - node.totalBranchBytes;
        for (let i = 1; i < eligibleForBranch.length; i++) {
          const cand = eligibleForBranch[i];
          const diff = (simulatedHeadrooms.get(cand.id) ?? cand.headroomBytes) - node.totalBranchBytes;
          if (diff < minDiff) {
            minDiff = diff;
            targetAccount = cand;
          }
        }
      }

      // Assign all files in branch to targetAccount
      for (const f of branchFiles) {
        const before = simulatedHeadrooms.get(targetAccount.id) ?? targetAccount.headroomBytes;
        const after = before - f.sizeBytes;
        simulatedHeadrooms.set(targetAccount.id, after);

        const currentBudget = simulatedTransferBudgets.get(targetAccount.id) ?? targetAccount.transferStats.remainingUploadBytes24h;
        simulatedTransferBudgets.set(targetAccount.id, currentBudget - f.sizeBytes);

        recordDecision({
          accountId: targetAccount.id,
          virtualPath: f.virtualPath,
          sizeBytes: f.sizeBytes,
          reason,
          headroomBeforeBytes: before,
          headroomAfterBytes: after,
        });
      }
      return;
    }

    // Branch exceeds single account headroom or is root: split at subfolder boundaries
    for (const child of node.subdirs.values()) {
      await placeNode(child);
    }

    // Place remaining direct files in this node individually
    for (const f of node.files) {
      const decision = await selectPlacementForFile(f, simulatedHeadrooms, nowMs, simulatedTransferBudgets);
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
 * Validates whether a specific target account can accept a file of sizeBytes.
 * Enforces the strict 750 MB reserve ceiling and 24-hour rolling transfer window.
 */
export async function validateTargetPlacement(
  accountId: string,
  sizeBytes: number,
  nowMs = Date.now()
): Promise<CandidateAccount> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!account) {
    throw new Error(`Target account ${accountId} not found in database`);
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

  const headroom = calculateHeadroom(account.quotaLimitBytes, account.quotaUsedBytes);
  if (headroom < sizeBytes) {
    throw new InsufficientStorageError(
      `Drive "${account.displayName || accountId}" has insufficient headroom (${(headroom / (1024 * 1024 * 1024)).toFixed(2)} GB available, needs ${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB to preserve 750 MB reserve ceiling)`
    );
  }

  const transferStats = await getAccountTransferStats(accountId, nowMs);
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


