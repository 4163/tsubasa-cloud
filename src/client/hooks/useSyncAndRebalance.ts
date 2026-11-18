import { useCallback, useMemo, useRef, useState } from 'react';
import { client } from '../api.js';
import type {
  AccountItem,
  ClientFileRecord,
  DiscoveredAccount,
  StorageOverview,
} from '../types.js';
import { invalidateShareInspectCache } from '../utils/queryCache.js';
import { extractErrorMessage, readResponseError } from '../utils/workspaceHelpers.js';

export interface UseSyncAndRebalanceOptions {
  activePoolId: number;
  activePoolIdRef: React.MutableRefObject<number>;
  isSharePoolActive: boolean;
  isPoolSharePool: (poolId: number) => boolean;
  storage: StorageOverview | null;
  discovered: DiscoveredAccount[];
  discoveredRef: React.RefObject<DiscoveredAccount[]>;
  files: ClientFileRecord[];
  pendingDiscrepancies: Record<string, boolean>;
  currentNavRef: React.MutableRefObject<'files' | 'trash'>;
  currentPathRef: React.RefObject<string>;
  externalChangesAccountId: string | undefined;
  setWorkspaceError: React.Dispatch<React.SetStateAction<string | null>>;
  surfaceWorkspaceError: (context: string, err: unknown, fallback: string) => void;
  runPendingOp: <T>(fn: () => Promise<T>) => Promise<T>;
  markTrashStale: (poolId?: number) => void;
  checkAccountDiscrepancies: (
    accountList: DiscoveredAccount[],
    force?: boolean,
    targetPoolId?: number
  ) => Promise<void>;
  loadClusterData: (targetPoolId?: number) => Promise<DiscoveredAccount[] | undefined>;
  loadFiles: (path: string, targetPoolId?: number) => Promise<void>;
}

export function useSyncAndRebalance({
  activePoolId,
  activePoolIdRef,
  isSharePoolActive,
  isPoolSharePool,
  storage,
  discovered,
  discoveredRef,
  files,
  pendingDiscrepancies,
  currentNavRef,
  currentPathRef,
  externalChangesAccountId,
  setWorkspaceError,
  surfaceWorkspaceError,
  runPendingOp,
  markTrashStale,
  checkAccountDiscrepancies,
  loadClusterData,
  loadFiles,
}: UseSyncAndRebalanceOptions) {
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const isSyncingRef = useRef(isSyncing);
  isSyncingRef.current = isSyncing;
  const [transferringFileIds, setTransferringFileIds] = useState<Set<string>>(() => new Set());

  const handleSyncAll = useCallback(async () => {
    const reqPoolId = activePoolIdRef.current;
    if (isPoolSharePool(reqPoolId)) return;
    setWorkspaceError(null);
    setIsSyncing(true);
    try {
      const res = await client.api.sync.all.$post({
        query: { poolId: String(reqPoolId) },
      });
      if (activePoolIdRef.current !== reqPoolId) return;
      if (res.ok) {
        invalidateShareInspectCache();
        await res.json();
        if (activePoolIdRef.current !== reqPoolId) return;
        if (currentNavRef.current !== 'trash') {
          markTrashStale(reqPoolId);
        }
        const [freshAccounts] = await Promise.all([
          loadClusterData(reqPoolId),
          loadFiles(currentPathRef.current, reqPoolId),
        ]);
        if (activePoolIdRef.current !== reqPoolId) return;
        await checkAccountDiscrepancies(freshAccounts ?? discoveredRef.current, true, reqPoolId);
      } else {
        const msg = await readResponseError(res, 'Failed to sync pool');
        surfaceWorkspaceError('handleSyncAll', msg, 'Failed to sync pool');
      }
    } catch (err) {
      if (activePoolIdRef.current !== reqPoolId) return;
      surfaceWorkspaceError('handleSyncAll', err, 'Failed to sync pool');
    } finally {
      setIsSyncing(false);
    }
  }, [
    activePoolIdRef,
    currentNavRef,
    currentPathRef,
    discoveredRef,
    setWorkspaceError,
    isPoolSharePool,
    markTrashStale,
    loadClusterData,
    loadFiles,
    checkAccountDiscrepancies,
    surfaceWorkspaceError,
  ]);

  // Count active files per account to show the filter toggle only on accounts with files in the pool
  const accountFileCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of files) {
      if (!f.isTrashed) {
        map.set(f.accountId, (map.get(f.accountId) ?? 0) + 1);
      }
    }
    return map;
  }, [files]);

  const accountItems: AccountItem[] = useMemo(() => {
    const items = discovered.map((d) => {
      const summary = storage?.accounts.find((a) => a.id === d.accountId);
      const quotaUsed = summary?.quotaUsedBytes ?? 0;
      const usableLimit = summary?.usableLimitBytes ?? (d.authorized ? 15356127360 : 0);
      const isBreached = quotaUsed > usableLimit;
      const tsubasaUsed = summary?.tsubasaUsedBytes ?? 0;
      const canRebalance = isBreached && tsubasaUsed > 0;
      const hasDiscrepancy = Boolean(pendingDiscrepancies[d.accountId]);
      const hasPendingChanges = canRebalance || hasDiscrepancy;

      return {
        id: d.accountId,
        email: summary?.email || d.accountId,
        displayName: summary?.displayName || d.accountId,
        avatarUrl: summary?.avatarUrl,
        quotaLimitBytes: summary?.quotaLimitBytes ?? (d.authorized ? 16106127360 : 0),
        quotaUsedBytes: quotaUsed,
        usableLimitBytes: usableLimit,
        headroomBytes: summary?.headroomBytes ?? (d.authorized ? 15356127360 : 0),
        tsubasaUsedBytes: summary?.tsubasaUsedBytes ?? 0,
        syncState: summary?.syncState || 'idle',
        isDisabled: summary?.isDisabled ?? d.isDisabled ?? false,
        authorized: d.authorized,
        transferStats: summary?.transferStats,
        hasPendingChanges,
        hasDiscrepancy,
        mtimeMs: d.mtimeMs,
        poolId: summary?.poolId ?? d.poolId ?? activePoolId,
        canSwitchPool: summary?.canSwitchPool ?? d.canSwitchPool ?? ((summary?.tsubasaUsedBytes ?? 0) === 0),
        fileCount: accountFileCountMap.get(d.accountId) ?? 0,
      };
    });

    return items.sort((a, b) => {
      if (!a.authorized && b.authorized) return -1;
      if (a.authorized && !b.authorized) return 1;

      if (!a.authorized && !b.authorized) {
        const mtimeA = a.mtimeMs ?? 0;
        const mtimeB = b.mtimeMs ?? 0;
        if (mtimeA !== mtimeB) {
          return mtimeB - mtimeA;
        }
        return a.id.localeCompare(b.id, undefined, { sensitivity: 'base' });
      }

      // Pin active accounts with changes, and disabled accounts with external discrepancies.
      // Disabled accounts with only auto-rebalance breaches stay in normal sort order.
      const aIsPinned = Boolean(a.hasPendingChanges) && (!a.isDisabled || Boolean(a.hasDiscrepancy));
      const bIsPinned = Boolean(b.hasPendingChanges) && (!b.isDisabled || Boolean(b.hasDiscrepancy));
      if (aIsPinned && !bIsPinned) return -1;
      if (!aIsPinned && bIsPinned) return 1;

      const emailA = (a.email || a.id).toLowerCase();
      const emailB = (b.email || b.id).toLowerCase();
      return emailA.localeCompare(emailB, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [discovered, storage, pendingDiscrepancies, activePoolId, accountFileCountMap]);

  const accountItemsRef = useRef(accountItems);
  accountItemsRef.current = accountItems;

  const externalChangesAccounts = useMemo(() => {
    return accountItems
      .filter(
        (a) =>
          a.hasPendingChanges ||
          (externalChangesAccountId && a.id === externalChangesAccountId)
      )
      .map((a) => ({
        id: a.id,
        displayName: a.displayName,
        email: a.email,
        quotaUsedBytes: a.quotaUsedBytes,
        usableLimitBytes: a.usableLimitBytes,
        tsubasaUsedBytes: a.tsubasaUsedBytes,
      }));
  }, [accountItems, externalChangesAccountId]);

  const handleTransferFile = useCallback(
    async (fileId: string, targetAccountId: string) => {
      if (isSharePoolActive) return;
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      setTransferringFileIds((prev) => new Set(prev).add(fileId));
      await runPendingOp(async () => {
        try {
          const res = await client.api.sync.rebalance.file.$post({
            json: { fileId, targetAccountId },
          });
          if (res.ok) {
            invalidateShareInspectCache();
            await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
          } else {
            const msg = await readResponseError(res, 'Failed to transfer file');
            if (activePoolIdRef.current === poolId) {
              surfaceWorkspaceError('handleTransferFile', msg, 'Failed to transfer file');
            }
          }
        } catch (err) {
          if (activePoolIdRef.current === poolId) {
            surfaceWorkspaceError('handleTransferFile', err, 'Failed to transfer file');
          }
        } finally {
          setTransferringFileIds((prev) => {
            const next = new Set(prev);
            next.delete(fileId);
            return next;
          });
        }
      });
    },
    [
      isSharePoolActive,
      activePoolIdRef,
      currentPathRef,
      setWorkspaceError,
      runPendingOp,
      loadFiles,
      loadClusterData,
      surfaceWorkspaceError,
    ]
  );

  const handleTransferBatch = useCallback(
    async (fileIds: string[], targetAccountId: string) => {
      if (isSharePoolActive) return;
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;

      await runPendingOp(async () => {
        try {
          const res = await client.api.sync.rebalance.batch.$post({
            json: { fileIds, targetAccountId },
          });
          if (!res.ok) {
            const msg = await readResponseError(res, 'Failed to transfer files');
            throw Object.assign(new Error(msg), { handled: true });
          }
        } catch (err) {
          if (err instanceof Error && 'handled' in err) {
            throw err;
          }
          throw new Error(extractErrorMessage(err, 'Failed to transfer files'));
        } finally {
          invalidateShareInspectCache();
          await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
        }
      });
    },
    [
      isSharePoolActive,
      activePoolIdRef,
      currentPathRef,
      setWorkspaceError,
      runPendingOp,
      loadFiles,
      loadClusterData,
    ]
  );

  return {
    isSyncing,
    isSyncingRef,
    transferringFileIds,
    handleSyncAll,
    accountItems,
    accountItemsRef,
    externalChangesAccounts,
    handleTransferFile,
    handleTransferBatch,
  };
}
