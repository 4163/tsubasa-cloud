import { useCallback } from 'react';
import { client } from '../api.js';
import type { DiscoveredAccount, PoolSummary, StorageOverview } from '../types.js';
import { invalidateShareInspectCache, setPoolCache } from '../utils/queryCache.js';
import { extractErrorMessage, readResponseError } from '../utils/workspaceHelpers.js';

export interface UsePoolManagementOptions {
  poolsRef: React.RefObject<PoolSummary[]>;
  setPools: React.Dispatch<React.SetStateAction<PoolSummary[]>>;
  activePoolIdRef: React.MutableRefObject<number>;
  skipNextPoolEffectRef: React.MutableRefObject<number | null>;
  setStorage: React.Dispatch<React.SetStateAction<StorageOverview | null>>;
  storageRef: React.RefObject<StorageOverview | null>;
  setDiscovered: React.Dispatch<React.SetStateAction<DiscoveredAccount[]>>;
  discoveredRef: React.RefObject<DiscoveredAccount[]>;
  currentNavRef: React.MutableRefObject<'files' | 'trash'>;
  currentPathRef: React.RefObject<string>;
  setWorkspaceError: React.Dispatch<React.SetStateAction<string | null>>;
  surfaceWorkspaceError: (context: string, err: unknown, fallback: string) => void;
  runPendingOp: <T>(fn: () => Promise<T>) => Promise<T>;
  markTrashStale: (poolId?: number) => void;
  loadClusterData: (targetPoolId?: number) => Promise<DiscoveredAccount[] | undefined>;
  loadFiles: (path: string, targetPoolId?: number) => Promise<void>;
  loadTrashFiles: (targetPoolId?: number) => Promise<void>;
  handleSelectPool: (nextPoolId: number) => void;
}

export function usePoolManagement({
  poolsRef,
  setPools,
  activePoolIdRef,
  skipNextPoolEffectRef,
  setStorage,
  storageRef,
  setDiscovered,
  discoveredRef,
  currentNavRef,
  currentPathRef,
  setWorkspaceError,
  surfaceWorkspaceError,
  runPendingOp,
  markTrashStale,
  loadClusterData,
  loadFiles,
  loadTrashFiles,
  handleSelectPool,
}: UsePoolManagementOptions) {
  const handleCreatePool = useCallback(async () => {
    setWorkspaceError(null);
    await runPendingOp(async () => {
      try {
        const res = await client.api.pools.$post({ json: { name: undefined } });
        if (res.ok) {
          invalidateShareInspectCache();
          const created = await res.json();
          setPools((prev) => [...prev, created]);
          skipNextPoolEffectRef.current = created.id;
          handleSelectPool(created.id);
          await Promise.all([loadClusterData(created.id), loadFiles('/', created.id)]);
        } else {
          const msg = await readResponseError(res, 'Failed to create pool');
          surfaceWorkspaceError('handleCreatePool', msg, 'Failed to create pool');
        }
      } catch (err) {
        surfaceWorkspaceError('handleCreatePool', err, 'Failed to create pool');
      }
    });
  }, [
    setWorkspaceError,
    setPools,
    skipNextPoolEffectRef,
    handleSelectPool,
    loadClusterData,
    loadFiles,
    runPendingOp,
    surfaceWorkspaceError,
  ]);

  const handleDeletePool = useCallback(
    async (pool: PoolSummary) => {
      setWorkspaceError(null);
      const currentPools = poolsRef.current;
      const standardPools = currentPools.filter((p) => !p.isSharePool);
      const currentIndex = standardPools.findIndex((p) => p.id === pool.id);
      const remainingStandardPools = currentPools.filter((p) => p.id !== pool.id && !p.isSharePool);
      if (remainingStandardPools.length === 0) return;

      const nextAdjacent = remainingStandardPools[currentIndex];
      const prevAdjacent = currentIndex > 0 ? remainingStandardPools[currentIndex - 1] : undefined;

      let targetPool: PoolSummary;
      if (nextAdjacent && nextAdjacent.accountCount === 0) {
        targetPool = nextAdjacent;
      } else if (prevAdjacent && prevAdjacent.accountCount === 0) {
        targetPool = prevAdjacent;
      } else {
        const otherEmpty = remainingStandardPools.find((p) => p.accountCount === 0);
        if (otherEmpty) {
          targetPool = otherEmpty;
        } else {
          targetPool = nextAdjacent || prevAdjacent || remainingStandardPools[0];
        }
      }

      await runPendingOp(async () => {
        try {
          const res = await client.api.pools[':id'].$delete({
            param: { id: String(pool.id) },
          });
          if (res.ok) {
            invalidateShareInspectCache();
            setPools((prev) => prev.filter((p) => p.id !== pool.id));
            skipNextPoolEffectRef.current = targetPool.id;
            handleSelectPool(targetPool.id);
            await Promise.all([loadClusterData(targetPool.id), loadFiles('/', targetPool.id)]);
          } else {
            const msg = await readResponseError(res, 'Failed to delete pool');
            surfaceWorkspaceError('handleDeletePool', msg, 'Failed to delete pool');
          }
        } catch (err) {
          surfaceWorkspaceError('handleDeletePool', err, 'Failed to delete pool');
        }
      });
    },
    [
      poolsRef,
      setPools,
      skipNextPoolEffectRef,
      setWorkspaceError,
      handleSelectPool,
      loadClusterData,
      loadFiles,
      runPendingOp,
      surfaceWorkspaceError,
    ]
  );

  const handleSwitchAccountPool = useCallback(
    async (accountId: string, targetPoolId: number) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      const prevDiscovered = discoveredRef.current;
      const prevStorage = storageRef.current;

      setDiscovered((prev) => prev.filter((a) => a.accountId !== accountId));
      setStorage((prev) =>
        prev
          ? {
              ...prev,
              accounts: prev.accounts.filter((a) => a.id !== accountId),
              totalAccounts: Math.max(0, prev.totalAccounts - 1),
            }
          : prev
      );

      await runPendingOp(async () => {
        try {
          const res = await client.api.accounts[':id'].pool.$post({
            param: { id: accountId },
            json: { poolId: targetPoolId },
          });
          if (res.ok) {
            invalidateShareInspectCache();
            if (currentNavRef.current === 'trash') {
              await Promise.all([
                loadClusterData(poolId),
                loadFiles(currentPathRef.current, poolId),
                loadTrashFiles(poolId),
              ]);
            } else {
              markTrashStale(poolId);
              markTrashStale(targetPoolId);
              await Promise.all([loadClusterData(poolId), loadFiles(currentPathRef.current, poolId)]);
            }
          } else {
            const msg = await readResponseError(res, 'Cannot switch account pool');
            if (activePoolIdRef.current === poolId) {
              setDiscovered(prevDiscovered);
              setStorage(prevStorage);
            } else {
              setPoolCache(poolId, { discovered: prevDiscovered, storage: prevStorage });
            }
            throw Object.assign(new Error(msg), { handled: true });
          }
        } catch (err) {
          if (err instanceof Error && 'handled' in err) {
            throw err;
          }
          const msg = extractErrorMessage(err, 'Cannot switch account pool');
          if (activePoolIdRef.current === poolId) {
            setDiscovered(prevDiscovered);
            setStorage(prevStorage);
          } else {
            setPoolCache(poolId, { discovered: prevDiscovered, storage: prevStorage });
          }
          throw new Error(msg);
        }
      });
    },
    [
      activePoolIdRef,
      discoveredRef,
      storageRef,
      currentNavRef,
      currentPathRef,
      setDiscovered,
      setStorage,
      setWorkspaceError,
      loadClusterData,
      loadFiles,
      loadTrashFiles,
      markTrashStale,
      runPendingOp,
    ]
  );

  return {
    handleCreatePool,
    handleDeletePool,
    handleSwitchAccountPool,
  };
}
