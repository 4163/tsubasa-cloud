import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { client } from '../api.js';
import { verifyFileMatchesHash } from '../utils/fileHash.js';
import {
  CEILING_14_25_GB,
  normalizeStagedFiles,
  computePoolTransferBudgets,
  computeUploadByteStats,
  buildUploadDisplayModel,
  computeFolderSummaries,
  computeBatchFit,
  type NormalizedUploadItem,
} from '../utils/uploadQueueModel.js';
import { useUploadRunner } from './useUploadRunner.js';
import { isAbortError, readResponseError } from '../utils/workspaceHelpers.js';
import type {
  AccountItem,
  UploadConflictAction,
  UploadContentMatchStatus,
  ExistingPoolFile,
  StagedItem,
  PlacementItemPreview,
} from '../types.js';

export interface UseUploadQueueParams {
  isOpen: boolean;
  stagedFiles: Array<File | StagedItem>;
  stagedEmptyFolders: string[];
  currentPath: string;
  accounts: AccountItem[];
  poolId: number;
  onUploadComplete: () => Promise<void>;
}

export function useUploadQueue({
  isOpen,
  stagedFiles,
  stagedEmptyFolders,
  currentPath,
  accounts,
  poolId,
  onUploadComplete,
}: UseUploadQueueParams) {
  const [previews, setPreviews] = useState<PlacementItemPreview[]>([]);
  const [conflictsByPath, setConflictsByPath] = useState<Record<string, ExistingPoolFile>>({});
  const [contentMatchByKey, setContentMatchByKey] = useState<Record<string, UploadContentMatchStatus>>({});
  const [conflictActions, setConflictActions] = useState<Record<string, UploadConflictAction>>({});
  const [isPlanning, setIsPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planAttempt, setPlanAttempt] = useState(0);
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({});
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});

  const verifiedHashCacheRef = useRef<Map<string, UploadContentMatchStatus>>(new Map());

  const normalizedItems = useMemo(
    () => normalizeStagedFiles(stagedFiles, currentPath),
    [stagedFiles, currentPath]
  );

  const previewByPath = useMemo(() => {
    const map = new Map<string, PlacementItemPreview>();
    for (const p of previews) {
      map.set(p.virtualPath, p);
    }
    return map;
  }, [previews]);

  const accountById = useMemo(() => {
    const map = new Map<string, AccountItem>();
    for (const acc of accounts) {
      map.set(acc.id, acc);
    }
    return map;
  }, [accounts]);

  const {
    hasCreatedEmptyFolders,
    isUploading,
    fileProgress,
    reset: resetRunner,
    clearActiveXhrs,
    startUpload,
    retryFailed,
    handleAbortUpload,
  } = useUploadRunner({
    poolId,
    stagedEmptyFolders,
    conflictsByPath,
    conflictActions,
    selectedAccounts,
    previewByPath,
    onUploadComplete,
    onFolderError: setPlanError,
  });

  const conflictItems = useMemo(() => {
    return normalizedItems.filter(
      (it) => it.file.size <= CEILING_14_25_GB && Boolean(conflictsByPath[it.virtualPath])
    );
  }, [normalizedItems, conflictsByPath]);

  const skippedCount = useMemo(() => {
    let count = 0;
    for (const it of conflictItems) {
      if ((conflictActions[it.key] ?? 'skip') === 'skip') {
        count += 1;
      }
    }
    return count;
  }, [conflictItems, conflictActions]);

  const actionableItems = useMemo(() => {
    return normalizedItems.filter((it) => {
      if (it.file.size > CEILING_14_25_GB) return false;
      const hasConflict = Boolean(conflictsByPath[it.virtualPath]);
      if (hasConflict && (conflictActions[it.key] ?? 'skip') === 'skip') {
        return false;
      }
      return true;
    });
  }, [normalizedItems, conflictsByPath, conflictActions]);

  const unstartedActionableItems = useMemo(() => {
    return actionableItems.filter((it) => {
      const status = fileProgress[it.key]?.status;
      return !status || status === 'pending';
    });
  }, [actionableItems, fileProgress]);

  const { totalBytes, actionableBytes, replacedBytes, netDeltaBytes, allRejected } = useMemo(
    () =>
      computeUploadByteStats(
        normalizedItems,
        actionableItems,
        conflictsByPath,
        conflictActions
      ),
    [normalizedItems, actionableItems, conflictsByPath, conflictActions]
  );

  const budgets = useMemo(() => computePoolTransferBudgets(accounts), [accounts]);
  const { canHoldFile } = budgets;

  const emptyFoldersKey = useMemo(() => stagedEmptyFolders.join('\0'), [stagedEmptyFolders]);

  useEffect(() => {
    setConflictsByPath({});
    setContentMatchByKey({});
    setConflictActions({});
    setExpandedFolders({});
    verifiedHashCacheRef.current.clear();
    setSelectedAccounts({});
    resetRunner();
  }, [isOpen, normalizedItems, emptyFoldersKey, poolId, resetRunner]);

  // Skip hashing unless the file size matches the existing record.
  useEffect(() => {
    if (!isOpen || conflictItems.length === 0) {
      setContentMatchByKey({});
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    const immediate: Record<string, UploadContentMatchStatus> = {};
    const toVerify: Array<{
      item: NormalizedUploadItem;
      existing: ExistingPoolFile;
      cacheKey: string;
    }> = [];

    for (const item of conflictItems) {
      const existing = conflictsByPath[item.virtualPath];
      if (!existing) continue;
      const cacheKey = `${item.key}::${existing.id}::${existing.hash ?? ''}`;
      const cached = verifiedHashCacheRef.current.get(cacheKey);
      if (cached) {
        immediate[item.key] = cached;
      } else if (item.file.size !== existing.sizeBytes) {
        immediate[item.key] = 'different';
      } else if (!existing.hash) {
        immediate[item.key] = item.file.size === 0 ? 'identical' : 'unverified';
      } else {
        immediate[item.key] = 'checking';
        toVerify.push({ item, existing, cacheKey });
      }
    }

    setContentMatchByKey(immediate);
    if (toVerify.length === 0) return;

    void (async () => {
      for (const entry of toVerify) {
        if (signal.aborted) break;
        try {
          const result = await verifyFileMatchesHash(
            entry.item.file,
            entry.existing.sizeBytes,
            entry.existing.hash,
            signal
          );
          if (signal.aborted) break;
          verifiedHashCacheRef.current.set(entry.cacheKey, result);
          setContentMatchByKey((prev) => ({ ...prev, [entry.item.key]: result }));
        } catch (err) {
          if (signal.aborted || isAbortError(err)) break;
          setContentMatchByKey((prev) => ({ ...prev, [entry.item.key]: 'unverified' }));
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [isOpen, conflictItems, conflictsByPath]);

  useEffect(() => {
    if (!isOpen || normalizedItems.length === 0) {
      setPreviews([]);
      setPlanError(null);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    setIsPlanning(true);
    setPlanError(null);

    const items: PlacementItemPreview[] = normalizedItems.map((it) => {
      const isOverCeiling = it.file.size > CEILING_14_25_GB;
      return {
        virtualPath: it.virtualPath,
        sizeBytes: it.file.size,
        rejected: isOverCeiling,
        rejectReason: isOverCeiling ? 'Exceeds 14.25 GB single-account ceiling' : undefined,
      };
    });

    const eligibleRequestItems = normalizedItems
      .filter((it) => it.file.size <= CEILING_14_25_GB)
      .map((it) => ({
        virtualPath: it.virtualPath,
        sizeBytes: it.file.size,
        conflictAction: conflictActions[it.key],
      }));

    if (eligibleRequestItems.length === 0) {
      setPreviews(items);
      setIsPlanning(false);
      return;
    }

    client.api.storage.placement.batch
      .$post(
        {
          json: {
            items: eligibleRequestItems,
            poolId,
          },
        },
        { init: { signal } }
      )
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(await readResponseError(res, `Planning error ${res.status}`));
        }
        return res.json();
      })
      .then((planData) => {
        if (signal.aborted) return;
        const nextConflicts =
          planData &&
          typeof planData === 'object' &&
          'conflicts' in planData &&
          planData.conflicts &&
          typeof planData.conflicts === 'object'
            ? (planData.conflicts as Record<string, ExistingPoolFile>)
            : {};
        setConflictsByPath(nextConflicts);

        const decisions = Array.isArray(planData.decisions) ? planData.decisions : [];
        const decisionByPath = new Map<string, { virtualPath: string; accountId?: string }>();
        for (const d of decisions) {
          if (d && typeof d.virtualPath === 'string') {
            decisionByPath.set(d.virtualPath, d);
          }
        }

        const mapped: PlacementItemPreview[] = items.map((orig) => {
          if (orig.rejected) return orig;
          const matched = decisionByPath.get(orig.virtualPath);
          return {
            ...orig,
            targetAccountId: matched?.accountId,
          };
        });
        setPreviews(mapped);
      })
      .catch((err) => {
        if (signal.aborted || isAbortError(err)) return;
        setPlanError(err instanceof Error ? err.message : String(err));
        setPreviews(items);
      })
      .finally(() => {
        if (!signal.aborted) setIsPlanning(false);
      });

    return () => {
      controller.abort();
    };
  }, [isOpen, normalizedItems, poolId, conflictActions, planAttempt]);

  const overallProgress = useMemo(() => {
    let totalLoaded = 0;
    let completedCount = 0;
    let activeCount = 0;
    for (const it of actionableItems) {
      const p = fileProgress[it.key];
      if (p) {
        totalLoaded += p.loaded;
        if (p.status === 'complete') completedCount += 1;
        else if (p.status === 'uploading') activeCount += 1;
      }
    }
    const percent =
      actionableBytes > 0 ? Math.min(100, Math.round((totalLoaded / actionableBytes) * 100)) : 0;
    return { totalLoaded, percent, completedCount, activeCount };
  }, [actionableItems, fileProgress, actionableBytes]);

  const failedItems = useMemo(() => {
    return actionableItems.filter((it) => fileProgress[it.key]?.status === 'error');
  }, [actionableItems, fileProgress]);

  const handleStartUpload = useCallback(() => {
    startUpload(unstartedActionableItems);
  }, [startUpload, unstartedActionableItems]);

  const handleRetryFailed = useCallback(() => {
    retryFailed(failedItems);
  }, [retryFailed, failedItems]);

  const handleSelectAccount = useCallback((key: string, accountId: string) => {
    setSelectedAccounts((prev) => ({ ...prev, [key]: accountId }));
  }, []);

  const handleSelectConflictAction = useCallback((key: string, action: UploadConflictAction) => {
    setConflictActions((prev) => ({ ...prev, [key]: action }));
  }, []);

  const handleApplyBatchConflictAction = useCallback(
    (action: UploadConflictAction) => {
      setConflictActions((prev) => {
        const next = { ...prev };
        for (const it of conflictItems) {
          if (fileProgress[it.key]?.status !== 'complete') {
            next[it.key] = action;
          }
        }
        return next;
      });
    },
    [conflictItems, fileProgress]
  );

  const retryPlan = useCallback(() => {
    setPlanAttempt((n) => n + 1);
  }, []);

  const hasUnallocatedFiles = useMemo(() => {
    return unstartedActionableItems.some((it) => {
      const chosen = selectedAccounts[it.key] || previewByPath.get(it.virtualPath)?.targetAccountId;
      return !chosen;
    });
  }, [unstartedActionableItems, selectedAccounts, previewByPath]);

  const { folderGroupByKey, displayRows } = useMemo(
    () =>
      buildUploadDisplayModel(
        normalizedItems,
        stagedEmptyFolders,
        currentPath,
        expandedFolders
      ),
    [normalizedItems, stagedEmptyFolders, currentPath, expandedFolders]
  );

  const folderSummaryByKey = useMemo(
    () =>
      computeFolderSummaries({
        folderGroupByKey,
        accountsCount: accounts.length,
        accountById,
        previewByPath,
        conflictsByPath,
        conflictActions,
        fileProgress,
        contentMatchByKey,
        selectedAccounts,
        budgets,
      }),
    [
      folderGroupByKey,
      accounts.length,
      accountById,
      previewByPath,
      conflictsByPath,
      conflictActions,
      fileProgress,
      contentMatchByKey,
      selectedAccounts,
      budgets,
    ]
  );

  const handleToggleFolderExpand = useCallback((groupKey: string) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [groupKey]: !prev[groupKey],
    }));
  }, []);

  const handleApplyFolderConflictAction = useCallback(
    (groupKey: string, action: UploadConflictAction) => {
      const group = folderGroupByKey.get(groupKey);
      if (!group) return;
      setConflictActions((prev) => {
        const next = { ...prev };
        for (const it of group.items) {
          if (
            it.file.size <= CEILING_14_25_GB &&
            conflictsByPath[it.virtualPath] &&
            fileProgress[it.key]?.status !== 'complete'
          ) {
            next[it.key] = action;
          }
        }
        return next;
      });
    },
    [folderGroupByKey, conflictsByPath, fileProgress]
  );

  const batchConflictSelection = useMemo(() => {
    const editableConflicts = conflictItems.filter((it) => fileProgress[it.key]?.status !== 'complete');
    if (editableConflicts.length === 0) return null;
    const first = conflictActions[editableConflicts[0].key] ?? 'skip';
    for (let i = 1; i < editableConflicts.length; i++) {
      if ((conflictActions[editableConflicts[i].key] ?? 'skip') !== first) {
        return null;
      }
    }
    return first;
  }, [conflictItems, conflictActions, fileProgress]);

  const hasEditableConflicts = useMemo(
    () => conflictItems.some((it) => fileProgress[it.key]?.status !== 'complete'),
    [conflictItems, fileProgress]
  );

  const { batchCanFitReplace, batchCanFitKeepBoth } = useMemo(
    () =>
      computeBatchFit({
        normalizedItems,
        fileProgress,
        conflictsByPath,
        accountsCount: accounts.length,
        accountById,
        budgets,
      }),
    [
      normalizedItems,
      fileProgress,
      conflictsByPath,
      accounts.length,
      accountById,
      budgets,
    ]
  );

  const hasPendingEmptyFolders = !hasCreatedEmptyFolders && stagedEmptyFolders.length > 0;
  const allActionableComplete =
    actionableItems.length > 0 && overallProgress.completedCount === actionableItems.length;
  const allConflictsSkipped =
    !allRejected && actionableItems.length === 0 && conflictItems.length > 0;
  const startUploadDisabled =
    isUploading ||
    (isPlanning &&
      unstartedActionableItems.length > 0 &&
      !unstartedActionableItems.every((it) => selectedAccounts[it.key])) ||
    (unstartedActionableItems.length === 0 && !hasPendingEmptyFolders) ||
    hasUnallocatedFiles;
  const startUploadTitle =
    allActionableComplete && !hasPendingEmptyFolders
      ? 'All staged files are already uploaded'
      : allConflictsSkipped && !hasPendingEmptyFolders
      ? 'All staged files already exist in the destination'
      : failedItems.length > 0 && unstartedActionableItems.length === 0 && !hasPendingEmptyFolders
      ? 'Use Retry failed to re-attempt failed uploads'
      : undefined;

  return {
    normalizedItems,
    previewByPath,
    accountById,
    conflictsByPath,
    contentMatchByKey,
    conflictActions,
    isPlanning,
    planError,
    retryPlan,
    selectedAccounts,
    expandedFolders,
    hasCreatedEmptyFolders,
    isUploading,
    fileProgress,
    conflictItems,
    skippedCount,
    actionableItems,
    unstartedActionableItems,
    totalBytes,
    actionableBytes,
    replacedBytes,
    netDeltaBytes,
    allRejected,
    canHoldFile,
    overallProgress,
    failedItems,
    displayRows,
    folderSummaryByKey,
    batchConflictSelection,
    hasEditableConflicts,
    batchCanFitReplace,
    batchCanFitKeepBoth,
    hasPendingEmptyFolders,
    allActionableComplete,
    startUploadDisabled,
    startUploadTitle,
    clearActiveXhrs,
    handleStartUpload,
    handleRetryFailed,
    handleAbortUpload,
    handleSelectAccount,
    handleSelectConflictAction,
    handleApplyBatchConflictAction,
    handleToggleFolderExpand,
    handleApplyFolderConflictAction,
  };
}
