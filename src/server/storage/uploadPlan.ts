import { sqlite } from '../db/index.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import {
  buildPoolFolderAffinityMap,
  getEligibleAccounts,
  InsufficientStorageError,
  simulateBatchPlacement,
  type CandidateAccount,
} from './placement.js';
import { MAX_SINGLE_FILE_BYTES } from './quota.js';

export type UploadPlanConflictPolicy = 'reject' | 'replace' | 'keep_both' | 'skip';

export type UploadPlanDecisionStatus =
  | 'ok'
  | 'skip'
  | 'reject_ceiling'
  | 'reject_headroom'
  | 'reject_quota_24h'
  | 'conflict';

export interface UploadPlanCandidateItem {
  relativePath: string;
  virtualPath: string;
  sizeBytes: number;
  conflict?: UploadPlanConflictPolicy;
}

export interface UploadPlanFileDecision {
  relativePath: string;
  virtualPath: string;
  sizeBytes: number;
  status: UploadPlanDecisionStatus;
  accountId: string | null;
  reason: string;
  existingFileId?: string;
  existingSizeBytes?: number;
  headroomBeforeBytes?: number;
  headroomAfterBytes?: number;
}

export interface UploadPlanSummary {
  poolId: number;
  canProceed: boolean;
  totalFiles: number;
  plannedFiles: number;
  skippedFiles: number;
  rejectedFiles: number;
  conflictFiles: number;
  totalBytes: number;
  plannedBytes: number;
  replacedBytes: number;
  netStorageDeltaBytes: number;
  accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }>;
  items: UploadPlanFileDecision[];
}

interface ExistingFileRow {
  id: string;
  virtualPath: string;
  sizeBytes: number;
  accountId: string;
}

function loadExistingFilesMap(
  poolId: number,
  virtualPaths: readonly string[]
): Map<string, ExistingFileRow> {
  const result = new Map<string, ExistingFileRow>();
  const uniquePaths = Array.from(new Set(virtualPaths));
  const chunkSize = 400;

  for (let i = 0; i < uniquePaths.length; i += chunkSize) {
    const chunk = uniquePaths.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = sqlite
      .prepare(
        `SELECT id, virtual_path as virtualPath, size_bytes as sizeBytes, account_id as accountId
         FROM files
         WHERE pool_id = ? AND is_trashed = 0 AND virtual_path IN (${placeholders})`
      )
      .all(poolId, ...chunk) as ExistingFileRow[];

    for (const row of rows) {
      result.set(row.virtualPath, row);
    }
  }

  return result;
}

function pickBestFit(
  candidates: readonly CandidateAccount[],
  sizeBytes: number,
  headroomMap: ReadonlyMap<string, number>
): CandidateAccount {
  let best = candidates[0];
  let bestSlack = (headroomMap.get(best.id) ?? 0) - sizeBytes;

  for (let i = 1; i < candidates.length; i += 1) {
    const cand = candidates[i];
    const slack = (headroomMap.get(cand.id) ?? 0) - sizeBytes;
    if (slack < bestSlack) {
      best = cand;
      bestSlack = slack;
    }
  }

  return best;
}

export async function planDryRunUpload(
  poolId: number,
  rawItems: readonly UploadPlanCandidateItem[],
  options: { defaultConflict?: UploadPlanConflictPolicy; nowMs?: number } = {}
): Promise<UploadPlanSummary> {
  const nowMs = options.nowMs ?? Date.now();
  const defaultConflict: UploadPlanConflictPolicy = options.defaultConflict ?? 'reject';

  const normalizedItems = rawItems.map((item) => ({
    ...item,
    virtualPath: normalizeVirtualPath(item.virtualPath),
  }));

  const existingByPath = loadExistingFilesMap(
    poolId,
    normalizedItems.map((item) => item.virtualPath)
  );
  const candidates = await getEligibleAccounts(poolId, nowMs);

  const decisions: Array<UploadPlanFileDecision | null> = new Array(normalizedItems.length).fill(null);
  const accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }> = {};

  interface PendingPlacement {
    index: number;
    item: (typeof normalizedItems)[number];
    existing?: ExistingFileRow;
  }

  const pendingPlacements: PendingPlacement[] = [];
  let plannedFiles = 0;
  let skippedFiles = 0;
  let rejectedFiles = 0;
  let conflictFiles = 0;
  let totalBytes = 0;
  let plannedBytes = 0;
  let replacedBytes = 0;

  for (let i = 0; i < normalizedItems.length; i += 1) {
    const item = normalizedItems[i];
    totalBytes += item.sizeBytes;
    const conflictPolicy = item.conflict ?? defaultConflict;
    const existing = existingByPath.get(item.virtualPath);

    if (item.sizeBytes > MAX_SINGLE_FILE_BYTES) {
      rejectedFiles += 1;
      decisions[i] = {
        relativePath: item.relativePath,
        virtualPath: item.virtualPath,
        sizeBytes: item.sizeBytes,
        status: 'reject_ceiling',
        accountId: null,
        reason: `File exceeds 14.25 GB single-file ceiling (${item.sizeBytes} bytes).`,
      };
      continue;
    }

    if (existing) {
      if (conflictPolicy === 'skip') {
        skippedFiles += 1;
        decisions[i] = {
          relativePath: item.relativePath,
          virtualPath: item.virtualPath,
          sizeBytes: item.sizeBytes,
          status: 'skip',
          accountId: existing.accountId,
          reason: 'Existing file at target path skipped per conflict policy.',
          existingFileId: existing.id,
          existingSizeBytes: existing.sizeBytes,
        };
        continue;
      }

      if (conflictPolicy === 'reject') {
        conflictFiles += 1;
        decisions[i] = {
          relativePath: item.relativePath,
          virtualPath: item.virtualPath,
          sizeBytes: item.sizeBytes,
          status: 'conflict',
          accountId: null,
          reason: 'Target path already exists.',
          existingFileId: existing.id,
          existingSizeBytes: existing.sizeBytes,
        };
        continue;
      }

      // Do not credit existing.sizeBytes back to headroom: real uploads hold both old and
      // new objects on Drive until async post-commit deletion completes.
      if (conflictPolicy === 'replace') {
        replacedBytes += existing.sizeBytes;
      }
    }

    pendingPlacements.push({ index: i, item, existing });
  }

  if (pendingPlacements.length > 0) {
    // Reuse placement.ts bottom-up branch sizing so dry runs match real uploads.
    let batchSucceeded = false;
    try {
      const batchPlan = await simulateBatchPlacement(
        pendingPlacements.map((p) => ({ virtualPath: p.item.virtualPath, sizeBytes: p.item.sizeBytes })),
        candidates,
        poolId
      );

      const decisionQueueByPath = new Map<string, (typeof batchPlan.decisions)[number][]>();
      for (const decision of batchPlan.decisions) {
        const list = decisionQueueByPath.get(decision.virtualPath) ?? [];
        list.push(decision);
        decisionQueueByPath.set(decision.virtualPath, list);
      }

      for (const pending of pendingPlacements) {
        const matched = decisionQueueByPath.get(pending.item.virtualPath)?.shift();
        if (!matched) {
          throw new InsufficientStorageError(`Missing placement decision for ${pending.item.virtualPath}`);
        }

        plannedFiles += 1;
        plannedBytes += pending.item.sizeBytes;
        const alloc = accountAllocations[matched.accountId] ?? { filesCount: 0, bytesAllocated: 0 };
        alloc.filesCount += 1;
        alloc.bytesAllocated += pending.item.sizeBytes;
        accountAllocations[matched.accountId] = alloc;

        decisions[pending.index] = {
          relativePath: pending.item.relativePath,
          virtualPath: pending.item.virtualPath,
          sizeBytes: pending.item.sizeBytes,
          status: 'ok',
          accountId: matched.accountId,
          reason: matched.reason,
          existingFileId: pending.existing?.id,
          existingSizeBytes: pending.existing?.sizeBytes,
          headroomBeforeBytes: matched.headroomBeforeBytes,
          headroomAfterBytes: matched.headroomAfterBytes,
        };
      }
      batchSucceeded = true;
    } catch (err) {
      if (!(err instanceof InsufficientStorageError)) {
        throw err;
      }
    }

    // When the full batch cannot fit, diagnose each item individually without crediting replaced bytes.
    if (!batchSucceeded) {
      const affinityMap = await buildPoolFolderAffinityMap(poolId);
      const headroomMap = new Map<string, number>();
      const remaining24hMap = new Map<string, number>();
      const candidateById = new Map<string, CandidateAccount>();

      for (const cand of candidates) {
        headroomMap.set(cand.id, cand.headroomBytes);
        remaining24hMap.set(cand.id, cand.transferStats.remainingUploadBytes24h);
        candidateById.set(cand.id, cand);
      }

      for (const pending of pendingPlacements) {
        const { index, item, existing } = pending;
        const headroomEligible = candidates.filter(
          (cand) => !cand.isOverCeiling && (headroomMap.get(cand.id) ?? 0) >= item.sizeBytes
        );
        if (headroomEligible.length === 0) {
          rejectedFiles += 1;
          decisions[index] = {
            relativePath: item.relativePath,
            virtualPath: item.virtualPath,
            sizeBytes: item.sizeBytes,
            status: 'reject_headroom',
            accountId: null,
            reason: 'No eligible account has sufficient 750 MB reserve headroom.',
            existingFileId: existing?.id,
            existingSizeBytes: existing?.sizeBytes,
          };
          continue;
        }

        const fullyEligible = headroomEligible.filter(
          (cand) => (remaining24hMap.get(cand.id) ?? 0) >= item.sizeBytes
        );
        if (fullyEligible.length === 0) {
          rejectedFiles += 1;
          decisions[index] = {
            relativePath: item.relativePath,
            virtualPath: item.virtualPath,
            sizeBytes: item.sizeBytes,
            status: 'reject_quota_24h',
            accountId: null,
            reason: 'Eligible accounts reached the 750 GB rolling 24-hour upload cap.',
            existingFileId: existing?.id,
            existingSizeBytes: existing?.sizeBytes,
          };
          continue;
        }

        const fullyEligibleIds = new Set(fullyEligible.map((cand) => cand.id));
        const affinityAccounts = affinityMap
          .getAffinityAccounts(item.virtualPath)
          .filter((id) => fullyEligibleIds.has(id));

        let chosen: CandidateAccount;
        let placementReason: string;
        if (affinityAccounts.length > 0) {
          chosen = candidateById.get(affinityAccounts[0])!;
          placementReason = 'folder_affinity';
        } else {
          chosen = pickBestFit(fullyEligible, item.sizeBytes, headroomMap);
          placementReason = 'best_fit';
        }

        const headroomBefore = headroomMap.get(chosen.id) ?? 0;
        const headroomAfter = Math.max(0, headroomBefore - item.sizeBytes);
        const quota24hBefore = remaining24hMap.get(chosen.id) ?? 0;

        headroomMap.set(chosen.id, headroomAfter);
        remaining24hMap.set(chosen.id, Math.max(0, quota24hBefore - item.sizeBytes));
        affinityMap.recordAssignment(item.virtualPath, chosen.id);

        plannedFiles += 1;
        plannedBytes += item.sizeBytes;
        const alloc = accountAllocations[chosen.id] ?? { filesCount: 0, bytesAllocated: 0 };
        alloc.filesCount += 1;
        alloc.bytesAllocated += item.sizeBytes;
        accountAllocations[chosen.id] = alloc;

        decisions[index] = {
          relativePath: item.relativePath,
          virtualPath: item.virtualPath,
          sizeBytes: item.sizeBytes,
          status: 'ok',
          accountId: chosen.id,
          reason: placementReason,
          existingFileId: existing?.id,
          existingSizeBytes: existing?.sizeBytes,
          headroomBeforeBytes: headroomBefore,
          headroomAfterBytes: headroomAfter,
        };
      }
    }
  }

  return {
    poolId,
    canProceed: rejectedFiles === 0 && conflictFiles === 0,
    totalFiles: normalizedItems.length,
    plannedFiles,
    skippedFiles,
    rejectedFiles,
    conflictFiles,
    totalBytes,
    plannedBytes,
    replacedBytes,
    netStorageDeltaBytes: plannedBytes - replacedBytes,
    accountAllocations,
    items: decisions.filter((d): d is UploadPlanFileDecision => d !== null),
  };
}
