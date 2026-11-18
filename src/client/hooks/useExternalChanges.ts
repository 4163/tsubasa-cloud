import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { client } from '../api.js';
import type {
  ExternalDiscrepancyItem,
  PathConflictItem,
  DiscrepancyReport,
} from '../types.js';
import {
  getDiscrepancyReportCache,
  setDiscrepancyReportCache,
  invalidateDiscrepancyReportCache,
} from '../utils/queryCache.js';
import { readResponseError } from '../utils/workspaceHelpers.js';

export interface ExternalChangesAccountOption {
  id: string;
  displayName: string;
  email: string;
  quotaUsedBytes?: number;
  usableLimitBytes?: number;
  tsubasaUsedBytes?: number;
}

export interface UseExternalChangesOptions {
  isOpen: boolean;
  accounts: ExternalChangesAccountOption[];
  initialAccountId?: string;
  onResolved: (summary?: {
    accountId: string;
    remainingCount: number;
    refreshFiles?: boolean;
  }) => Promise<void>;
}

export function countDiscrepancies(report: DiscrepancyReport | null | undefined): number {
  if (!report) return 0;
  return (
    (report.conflicts?.length ?? 0) +
    (report.overCeiling?.length ?? 0) +
    (report.unindexed?.length ?? 0) +
    (report.modified?.length ?? 0) +
    (report.missingRemote?.length ?? 0)
  );
}

export function useExternalChanges({
  isOpen,
  accounts,
  initialAccountId,
  onResolved,
}: UseExternalChangesOptions) {
  const [selectedAccount, setSelectedAccount] = useState<string>(() => {
    if (initialAccountId && accounts.some((a) => a.id === initialAccountId)) {
      return initialAccountId;
    }
    return accounts[0]?.id || '';
  });
  const [report, setReport] = useState<DiscrepancyReport | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [showIndividualFiles, setShowIndividualFiles] = useState(false);
  const [confirmingEject, setConfirmingEject] = useState(false);

  const activeScanRef = useRef<string | null>(null);
  const scanSeqRef = useRef(0);
  const scanAbortRef = useRef<AbortController | null>(null);

  const currentAccount = accounts.find((a) => a.id === selectedAccount);
  const isBreached = currentAccount
    ? (currentAccount.quotaUsedBytes ?? 0) > (currentAccount.usableLimitBytes ?? 0)
    : false;
  const hasPoolFiles = (currentAccount?.tsubasaUsedBytes ?? 0) > 0;
  const showRebalance = isBreached && hasPoolFiles;

  useEffect(() => {
    if (accounts.length === 0) {
      setSelectedAccount('');
      setReport(null);
      return;
    }
    if (initialAccountId && accounts.some((a) => a.id === initialAccountId)) {
      setSelectedAccount(initialAccountId);
    } else if (!selectedAccount || !accounts.some((a) => a.id === selectedAccount)) {
      setSelectedAccount(accounts[0].id);
    }
  }, [initialAccountId, accounts]);

  const scanAccount = useCallback(
    async (accId: string, forceRefresh = false): Promise<DiscrepancyReport | null> => {
      if (!accId) return null;

      scanAbortRef.current?.abort();
      const controller = new AbortController();
      scanAbortRef.current = controller;
      const scanSeq = ++scanSeqRef.current;
      activeScanRef.current = accId;

      const cached = !forceRefresh ? getDiscrepancyReportCache(accId) : null;
      if (cached) {
        setReport(cached);
      } else if (!forceRefresh) {
        setReport(null);
      } else {
        setReport((prev) => (prev?.accountId === accId ? prev : null));
      }

      setIsScanning(true);
      setStatusNotice(null);
      setConfirmingEject(false);

      const isCurrentScan = () =>
        scanSeq === scanSeqRef.current &&
        activeScanRef.current === accId &&
        !controller.signal.aborted;

      try {
        const res = await client.api.sync['external-changes'][':accountId'].$get(
          {
            param: { accountId: accId },
            query: forceRefresh ? { refresh: '1' } : {},
          },
          { init: { signal: controller.signal } }
        );
        if (!isCurrentScan()) return null;

        if (res.ok) {
          const data = (await res.json()) as DiscrepancyReport;
          if (isCurrentScan()) {
            setDiscrepancyReportCache(accId, data);
            setReport(data);
            return data;
          }
        } else {
          const msg = await readResponseError(res, `Scan failed (${res.status})`);
          if (isCurrentScan()) {
            setStatusNotice(msg);
          }
        }
      } catch (err) {
        const isAbortError =
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === 'AbortError') ||
          (err instanceof Error && err.name === 'AbortError');
        if (isAbortError) return null;
        if (isCurrentScan()) {
          setStatusNotice(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (scanSeq === scanSeqRef.current && activeScanRef.current === accId) {
          if (scanAbortRef.current === controller) {
            scanAbortRef.current = null;
          }
          setIsScanning(false);
        }
      }
      return null;
    },
    []
  );

  useEffect(() => {
    if (isOpen && selectedAccount) {
      setShowIndividualFiles(false);
      setConfirmingEject(false);
      void scanAccount(selectedAccount);
    } else {
      scanAbortRef.current?.abort();
      scanAbortRef.current = null;
      activeScanRef.current = null;
      scanSeqRef.current += 1;
      setIsScanning(false);
    }
    return () => {
      scanAbortRef.current?.abort();
      scanAbortRef.current = null;
      activeScanRef.current = null;
      scanSeqRef.current += 1;
    };
  }, [isOpen, selectedAccount, scanAccount]);

  const exactDuplicates = useMemo(
    () => (report?.conflicts ?? []).filter((c) => c.isExactDuplicate),
    [report?.conflicts]
  );

  const acceptableItems = useMemo(
    () => [...(report?.unindexed ?? []), ...(report?.modified ?? [])],
    [report?.unindexed, report?.modified]
  );

  const handleAccept = async (item: ExternalDiscrepancyItem) => {
    setActiveActionId(item.driveFileId);
    try {
      const res = await client.api.sync.resolve.accept.$post({
        json: {
          accountId: item.accountId,
          driveFileId: item.driveFileId,
          targetVirtualPath: item.virtualPath,
          name: item.name,
          sizeBytes: item.sizeBytes,
          mimeType: item.mimeType,
          hash: item.hash ?? undefined,
        },
      });

      if (res.ok) {
        const nextReport: DiscrepancyReport | null = report
          ? {
              ...report,
              unindexed: report.unindexed.filter((i) => i.driveFileId !== item.driveFileId),
              modified: report.modified.filter((i) => i.driveFileId !== item.driveFileId),
              overCeiling: report.overCeiling.filter((i) => i.driveFileId !== item.driveFileId),
            }
          : null;
        if (nextReport) setDiscrepancyReportCache(selectedAccount, nextReport);
        setReport(nextReport);
        await onResolved({
          accountId: selectedAccount,
          remainingCount: countDiscrepancies(nextReport),
          refreshFiles: true,
        });
      } else {
        setStatusNotice(await readResponseError(res, 'Failed to accept file'));
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleBulkResolve = async (action: 'accept-all' | 'eject-all') => {
    if (!selectedAccount) return;
    setActiveActionId(action);
    setStatusNotice(null);
    try {
      const res =
        action === 'accept-all'
          ? await client.api.sync.resolve['accept-all'].$post({
              json: {
                accountId: selectedAccount,
                items: acceptableItems.map((i) => ({
                  driveFileId: i.driveFileId,
                  virtualPath: i.virtualPath,
                  sizeBytes: i.sizeBytes,
                  mimeType: i.mimeType,
                  hash: i.hash ?? undefined,
                })),
              },
            })
          : await client.api.sync.resolve['eject-all'].$post({
              json: { accountId: selectedAccount },
            });

      if (res.ok) {
        const data = await res.json();
        setConfirmingEject(false);
        if (
          action === 'eject-all' &&
          'failedCount' in data &&
          typeof data.failedCount === 'number' &&
          data.failedCount > 0
        ) {
          invalidateDiscrepancyReportCache(selectedAccount);
          const rescanned = await scanAccount(selectedAccount, true);
          await onResolved({
            accountId: selectedAccount,
            remainingCount: countDiscrepancies(rescanned ?? report),
            refreshFiles: false,
          });
          setStatusNotice(
            `${data.failedCount.toLocaleString()} files could not be ejected. Check the server log.`
          );
        } else {
          const nextReport: DiscrepancyReport | null = report
            ? {
                ...report,
                unindexed: [],
                modified: [],
              }
            : null;
          if (nextReport) setDiscrepancyReportCache(selectedAccount, nextReport);
          setReport(nextReport);
          await onResolved({
            accountId: selectedAccount,
            remainingCount: countDiscrepancies(nextReport),
            refreshFiles: action === 'accept-all',
          });
        }
      } else {
        const fallback =
          action === 'accept-all' ? 'Failed to accept files' : 'Failed to eject files';
        setStatusNotice(await readResponseError(res, fallback));
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleMoveToRoot = async (item: ExternalDiscrepancyItem) => {
    setActiveActionId(item.driveFileId);
    try {
      const res = await client.api.sync.resolve['move-to-root'].$post({
        json: {
          accountId: item.accountId,
          driveFileId: item.driveFileId,
        },
      });

      if (res.ok) {
        const nextReport: DiscrepancyReport | null = report
          ? {
              ...report,
              overCeiling: report.overCeiling.filter((i) => i.driveFileId !== item.driveFileId),
              unindexed: report.unindexed.filter((i) => i.driveFileId !== item.driveFileId),
              modified: report.modified.filter((i) => i.driveFileId !== item.driveFileId),
            }
          : null;
        if (nextReport) setDiscrepancyReportCache(selectedAccount, nextReport);
        setReport(nextReport);
        await onResolved({
          accountId: selectedAccount,
          remainingCount: countDiscrepancies(nextReport),
          refreshFiles: false,
        });
      } else {
        setStatusNotice(await readResponseError(res, 'Failed to eject file'));
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleRemoveMissing = async (item: { driveFileId: string; accountId: string }) => {
    setActiveActionId(item.driveFileId);
    setStatusNotice(null);
    try {
      const res = await client.api.sync.resolve['remove-missing'].$post({
        json: {
          accountId: item.accountId,
          driveFileId: item.driveFileId,
        },
      });

      if (res.ok) {
        const nextReport: DiscrepancyReport | null = report
          ? {
              ...report,
              missingRemote: report.missingRemote.filter((i) => i.driveFileId !== item.driveFileId),
            }
          : null;
        if (nextReport) setDiscrepancyReportCache(selectedAccount, nextReport);
        setReport(nextReport);
        await onResolved({
          accountId: selectedAccount,
          remainingCount: countDiscrepancies(nextReport),
          refreshFiles: true,
        });
      } else {
        setStatusNotice(await readResponseError(res, 'Failed to remove missing file'));
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleAutoRebalance = async () => {
    if (!selectedAccount) return;
    setActiveActionId('rebalance');
    try {
      const res = await client.api.sync.rebalance.auto[':accountId'].$post({
        param: { accountId: selectedAccount },
      });

      if (res.ok) {
        const data = await res.json();
        const rawResults = 'results' in data && Array.isArray(data.results) ? data.results : [];
        const succeededCount = rawResults.filter(
          (r) => r && (!('success' in r) || Boolean((r as { success?: boolean }).success))
        ).length;
        const failedCount = rawResults.length - succeededCount;
        invalidateDiscrepancyReportCache(selectedAccount);
        const scannedReport = await scanAccount(selectedAccount, true);
        await onResolved({
          accountId: selectedAccount,
          remainingCount: countDiscrepancies(scannedReport ?? report),
          refreshFiles: true,
        });
        if (failedCount > 0) {
          setStatusNotice(
            `Rebalance complete. ${succeededCount} files migrated, ${failedCount} failed.`
          );
        } else {
          setStatusNotice(`Rebalance complete. ${succeededCount} files migrated.`);
        }
      } else {
        setStatusNotice(await readResponseError(res, 'Auto-rebalance failed'));
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleResolveConflict = async (
    item: PathConflictItem,
    resolution: 'keep_both' | 'deduplicate' | 'replace_existing' | 'eject'
  ) => {
    setActiveActionId(item.driveFileId);
    setStatusNotice(null);
    try {
      const res = await client.api.sync.resolve.conflict.$post({
        json: {
          accountId: item.accountId,
          driveFileId: item.driveFileId,
          resolution,
          targetVirtualPath: item.virtualPath,
        },
      });

      if (res.ok) {
        const nextReport: DiscrepancyReport | null = report
          ? {
              ...report,
              conflicts: report.conflicts.filter((c) => c.driveFileId !== item.driveFileId),
            }
          : null;
        if (nextReport) setDiscrepancyReportCache(selectedAccount, nextReport);
        setReport(nextReport);
        await onResolved({
          accountId: selectedAccount,
          remainingCount: countDiscrepancies(nextReport),
          refreshFiles: resolution !== 'eject' && resolution !== 'deduplicate',
        });
      } else {
        setStatusNotice(await readResponseError(res, 'Failed to resolve conflict'));
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleBatchResolveConflicts = async (
    items: PathConflictItem[],
    resolution: 'keep_both' | 'deduplicate'
  ) => {
    if (items.length === 0 || !selectedAccount) return;
    setActiveActionId('batch-conflict');
    setStatusNotice(null);
    try {
      const res = await client.api.sync.resolve['conflicts-batch'].$post({
        json: {
          accountId: selectedAccount,
          items: items.map((i) => ({
            driveFileId: i.driveFileId,
            targetVirtualPath: i.virtualPath,
          })),
          resolution,
        },
      });
      if (res.ok) {
        const data = await res.json();
        const results =
          'results' in data && Array.isArray(data.results) ? data.results : null;
        const succeededIds = results
          ? new Set(
              results
                .filter((r) => r && r.success === true && typeof r.driveFileId === 'string')
                .map((r) => r.driveFileId)
            )
          : new Set(items.map((i) => i.driveFileId));
        const failedResults = results ? results.filter((r) => r && r.success !== true) : [];
        const failedCount =
          'failedCount' in data && typeof data.failedCount === 'number'
            ? data.failedCount
            : failedResults.length;

        const nextReport: DiscrepancyReport | null = report
          ? {
              ...report,
              conflicts: report.conflicts.filter((c) => !succeededIds.has(c.driveFileId)),
            }
          : null;
        if (nextReport) setDiscrepancyReportCache(selectedAccount, nextReport);
        setReport(nextReport);
        await onResolved({
          accountId: selectedAccount,
          remainingCount: countDiscrepancies(nextReport),
          refreshFiles: resolution === 'keep_both' && succeededIds.size > 0,
        });
        if (failedCount > 0) {
          const firstError = failedResults.find(
            (r) => typeof r.error === 'string' && r.error
          )?.error;
          setStatusNotice(
            firstError
              ? `${failedCount.toLocaleString()} conflict(s) failed to resolve: ${firstError}`
              : `${failedCount.toLocaleString()} conflict(s) failed to resolve.`
          );
        }
      } else {
        setStatusNotice(await readResponseError(res, 'Failed to resolve conflicts'));
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const isLocked = activeActionId !== null;
  const showPoolSummary = acceptableItems.length > 1;
  const showIndividualAcceptable = !showPoolSummary || showIndividualFiles;

  let acceptableBytes = 0;
  const acceptableFolders = new Set<string>();
  for (const item of acceptableItems) {
    acceptableBytes += item.sizeBytes;
    const parentDir = item.virtualPath.slice(0, item.virtualPath.lastIndexOf('/'));
    if (parentDir) acceptableFolders.add(parentDir);
  }
  const poolSummaryParts = [
    report?.unindexed.length ? `${report.unindexed.length.toLocaleString()} new` : null,
    report?.modified.length ? `${report.modified.length.toLocaleString()} updated` : null,
    acceptableFolders.size > 0
      ? `${acceptableFolders.size.toLocaleString()} ${acceptableFolders.size === 1 ? 'folder' : 'folders'}`
      : null,
  ].filter(Boolean);

  const totalDiscrepancies = countDiscrepancies(report);

  return {
    selectedAccount,
    setSelectedAccount,
    report,
    isScanning,
    activeActionId,
    statusNotice,
    showIndividualFiles,
    setShowIndividualFiles,
    confirmingEject,
    setConfirmingEject,
    currentAccount,
    showRebalance,
    isLocked,
    exactDuplicates,
    acceptableItems,
    showPoolSummary,
    showIndividualAcceptable,
    acceptableBytes,
    poolSummaryParts,
    totalDiscrepancies,
    scanAccount,
    handleAccept,
    handleBulkResolve,
    handleMoveToRoot,
    handleRemoveMissing,
    handleAutoRebalance,
    handleResolveConflict,
    handleBatchResolveConflicts,
  };
}
