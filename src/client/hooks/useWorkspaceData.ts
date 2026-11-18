import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../api.js';
import type {
  ClientFileRecord,
  ClientFolder,
  DiscoveredAccount,
  DiscrepancyReport,
  PoolSummary,
  StorageOverview,
  StoredShareLink,
} from '../types.js';
import { SHARE_POOL_RESERVE_ID } from '../utils/format.js';
import {
  dedupeInFlight,
  getPoolCache,
  markPoolTrashStale,
  setDiscrepancyReportCache,
  setPoolCache,
} from '../utils/queryCache.js';
import { subscribeAuthCompleted } from '../utils/useTabLock.js';
import {
  extractErrorMessage,
  isAbortError,
  readResponseError,
  safeStorageGet,
  safeStorageSet,
} from '../utils/workspaceHelpers.js';

const lastDiscrepancyScanByPool = new Map<number, number>();
const DISCREPANCY_COOLDOWN_MS = 60_000;

export interface UseWorkspaceDataOptions {
  currentPathRef: React.RefObject<string>;
  isSyncingRef: React.RefObject<boolean>;
  pendingOpsCountRef: React.RefObject<number>;
  surfaceWorkspaceError: (context: string, err: unknown, fallback: string) => void;
  onClearUiState: () => void;
  onRestoreCachedPoolUi: () => void;
  onPoolSwitched: () => void;
  onAuthConflictsDetected: (accountFilterId?: string) => void;
}

export function useWorkspaceData({
  currentPathRef,
  isSyncingRef,
  pendingOpsCountRef,
  surfaceWorkspaceError,
  onClearUiState,
  onRestoreCachedPoolUi,
  onPoolSwitched,
  onAuthConflictsDetected,
}: UseWorkspaceDataOptions) {
  const [pools, setPools] = useState<PoolSummary[]>([
    { id: 1, name: 'Pool 1', driveFolderName: '_Tsubasa~ Pool 1', accountCount: 0, fileCount: 0, totalBytes: 0 },
  ]);
  const [activePoolId, setActivePoolId] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = Number(safeStorageGet(window.sessionStorage, 'tsubasa-active-pool-id'));
      if (Number.isInteger(saved) && saved >= 1) return saved;
    }
    return 1;
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      safeStorageSet(window.sessionStorage, 'tsubasa-active-pool-id', String(activePoolId));
    }
  }, [activePoolId]);

  const activePool = useMemo(
    () => pools.find((p) => p.id === activePoolId),
    [pools, activePoolId]
  );
  const isSharePoolActive = Boolean(activePool?.isSharePool);

  const [storage, setStorage] = useState<StorageOverview | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredAccount[]>([]);
  const [files, setFiles] = useState<ClientFileRecord[]>([]);
  const [folders, setFolders] = useState<ClientFolder[]>([]);
  const [trashedFiles, setTrashedFiles] = useState<ClientFileRecord[]>([]);
  const [loadedFilesPoolId, setLoadedFilesPoolId] = useState<number | null>(null);
  const [loadedTrashPoolId, setLoadedTrashPoolId] = useState<number | null>(null);
  const [shareLinksByBatch, setShareLinksByBatch] = useState<Record<string, StoredShareLink[]>>({});
  const [shareLinksPoolId, setShareLinksPoolId] = useState<number | null>(null);
  const [pendingDiscrepancies, setPendingDiscrepancies] = useState<Record<string, boolean>>({});

  const filesRequestSeqRef = useRef(0);
  const trashRequestSeqRef = useRef(0);
  const clusterRequestSeqRef = useRef(0);
  const discrepancyRequestSeqRef = useRef(0);
  const filesAbortRef = useRef<{ poolId: number; controller: AbortController } | null>(null);
  const trashAbortRef = useRef<{ poolId: number; controller: AbortController } | null>(null);
  const clusterAbortRef = useRef<{ poolId: number; controller: AbortController } | null>(null);
  const discrepancyAbortRef = useRef<{ poolId: number; controller: AbortController } | null>(null);
  const trashStaleRef = useRef(false);
  const failedFilesLoadPoolRef = useRef<number | null>(null);
  const skipNextPoolEffectRef = useRef<number | null>(null);

  const activePoolIdRef = useRef(activePoolId);
  activePoolIdRef.current = activePoolId;
  const poolsRef = useRef(pools);
  poolsRef.current = pools;
  const filesRef = useRef(files);
  filesRef.current = files;
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  const trashedFilesRef = useRef(trashedFiles);
  trashedFilesRef.current = trashedFiles;
  const storageRef = useRef(storage);
  storageRef.current = storage;
  const discoveredRef = useRef(discovered);
  discoveredRef.current = discovered;
  const loadedFilesPoolIdRef = useRef(loadedFilesPoolId);
  loadedFilesPoolIdRef.current = loadedFilesPoolId;
  const loadedTrashPoolIdRef = useRef(loadedTrashPoolId);
  loadedTrashPoolIdRef.current = loadedTrashPoolId;
  const shareLinksByBatchRef = useRef(shareLinksByBatch);
  shareLinksByBatchRef.current = shareLinksByBatch;
  const shareLinksPoolIdRef = useRef(shareLinksPoolId);
  shareLinksPoolIdRef.current = shareLinksPoolId;
  const pendingDiscrepanciesRef = useRef(pendingDiscrepancies);
  pendingDiscrepanciesRef.current = pendingDiscrepancies;

  const isPoolSharePool = useCallback(
    (poolId: number): boolean =>
      poolsRef.current.some((p) => p.id === poolId && p.isSharePool) || poolId >= SHARE_POOL_RESERVE_ID,
    []
  );

  const markTrashStale = useCallback((poolId?: number) => {
    const targetPoolId = poolId ?? activePoolIdRef.current;
    if (targetPoolId === activePoolIdRef.current) {
      trashStaleRef.current = true;
    }
    markPoolTrashStale(targetPoolId);
  }, []);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Defer aborting so React StrictMode remounts reuse live in-flight reads instead of canceling them.
      setTimeout(() => {
        if (!isMountedRef.current) {
          filesAbortRef.current?.controller.abort();
          trashAbortRef.current?.controller.abort();
          clusterAbortRef.current?.controller.abort();
          discrepancyAbortRef.current?.controller.abort();
        }
      }, 0);
    };
  }, []);

  const checkAccountDiscrepancies = useCallback(
    async (accountList: DiscoveredAccount[], force = false, targetPoolId?: number) => {
      const poolId = targetPoolId ?? activePoolIdRef.current;
      if (isPoolSharePool(poolId)) {
        return;
      }
      const authAccounts = accountList.filter(
        (a) => (a.poolId ?? poolId) === poolId && a.authorized
      );
      if (authAccounts.length === 0) {
        return;
      }
      const now = Date.now();
      const lastScanMs = lastDiscrepancyScanByPool.get(poolId) ?? 0;
      if (!force && now - lastScanMs < DISCREPANCY_COOLDOWN_MS) {
        return;
      }
      lastDiscrepancyScanByPool.set(poolId, now);
      const reqSeq = ++discrepancyRequestSeqRef.current;

      if (discrepancyAbortRef.current && (discrepancyAbortRef.current.poolId !== poolId || force)) {
        discrepancyAbortRef.current.controller.abort();
        discrepancyAbortRef.current = null;
      }
      const controller =
        !force &&
        discrepancyAbortRef.current?.poolId === poolId &&
        !discrepancyAbortRef.current.controller.signal.aborted
          ? discrepancyAbortRef.current.controller
          : new AbortController();
      discrepancyAbortRef.current = { poolId, controller };

      try {
        await Promise.all(
          authAccounts.map(async (acc) => {
            try {
              const report = await dedupeInFlight(
                `discrepancy:${poolId}:${acc.accountId}:${force ? '1' : '0'}`,
                async (signal) => {
                  const res = await client.api.sync['external-changes'][':accountId'].$get(
                    {
                      param: { accountId: acc.accountId },
                      query: force ? { refresh: '1' } : {},
                    },
                    { init: { signal } }
                  );
                  if (!res.ok) return null;
                  return (await res.json()) as DiscrepancyReport;
                },
                controller.signal
              );
              if (!report) return;
              setDiscrepancyReportCache(acc.accountId, report);
              if (activePoolIdRef.current !== poolId || discrepancyRequestSeqRef.current !== reqSeq) {
                return;
              }
              const count =
                (report?.conflicts?.length ?? 0) +
                (report?.overCeiling?.length ?? 0) +
                (report?.unindexed?.length ?? 0) +
                (report?.modified?.length ?? 0) +
                (report?.missingRemote?.length ?? 0);
              setPendingDiscrepancies((prev) => {
                const next = { ...prev, [acc.accountId]: count > 0 };
                setPoolCache(poolId, { pendingDiscrepancies: next });
                return next;
              });
            } catch (err) {
              if (isAbortError(err)) return;
              // Background discrepancy polling skips transient network or scan failures.
            }
          })
        );
      } finally {
        if (discrepancyAbortRef.current?.controller === controller) {
          discrepancyAbortRef.current = null;
        }
      }
    },
    [isPoolSharePool]
  );

  const loadClusterData = useCallback(
    async (targetPoolId?: number): Promise<DiscoveredAccount[] | undefined> => {
      const effectivePoolId = targetPoolId ?? activePoolIdRef.current;
      const reqSeq = ++clusterRequestSeqRef.current;
      const isActivePool = activePoolIdRef.current === effectivePoolId;

      if (isActivePool && clusterAbortRef.current && clusterAbortRef.current.poolId !== effectivePoolId) {
        clusterAbortRef.current.controller.abort();
        clusterAbortRef.current = null;
      }
      const controller =
        clusterAbortRef.current?.poolId === effectivePoolId &&
        !clusterAbortRef.current.controller.signal.aborted
          ? clusterAbortRef.current.controller
          : new AbortController();
      if (isActivePool) {
        clusterAbortRef.current = { poolId: effectivePoolId, controller };
      }

      try {
        const result = await dedupeInFlight(
          `cluster:${effectivePoolId}`,
          async (signal) => {
            const [poolsRes, storageRes, poolRes] = await Promise.all([
              client.api.pools.$get(undefined, { init: { signal } }),
              client.api.storage.overview.$get(
                { query: { poolId: String(effectivePoolId) } },
                { init: { signal } }
              ),
              client.api.accounts.pool.$get(
                { query: { poolId: String(effectivePoolId) } },
                { init: { signal } }
              ),
            ]);
            const [poolsData, storageData, poolData, poolsErr, storageErr, poolErr] = await Promise.all([
              poolsRes.ok ? poolsRes.json() : Promise.resolve(null),
              storageRes.ok ? storageRes.json() : Promise.resolve(null),
              poolRes.ok ? poolRes.json() : Promise.resolve(null),
              poolsRes.ok ? Promise.resolve(null) : readResponseError(poolsRes, 'Failed to load pools'),
              storageRes.ok ? Promise.resolve(null) : readResponseError(storageRes, 'Failed to load storage overview'),
              poolRes.ok ? Promise.resolve(null) : readResponseError(poolRes, 'Failed to load accounts'),
            ]);
            const error = poolsErr || storageErr || poolErr;
            return { poolsData, storageData, poolData, error };
          },
          controller.signal
        );

        const isStillActive = activePoolIdRef.current === effectivePoolId;
        if (isStillActive && clusterRequestSeqRef.current !== reqSeq) return undefined;
        const { poolsData, storageData, poolData, error } = result;

        if (poolsData && isStillActive) {
          setPools(poolsData.pools);
          if (poolsData.pools.length > 0 && !poolsData.pools.some((p) => p.id === effectivePoolId)) {
            const fallbackPool = poolsData.pools.find((p) => !p.isSharePool) ?? poolsData.pools[0];
            setActivePoolId(fallbackPool.id);
          }
        }
        if (storageData) {
          setPoolCache(effectivePoolId, { storage: storageData as StorageOverview });
          if (isStillActive) {
            setStorage(storageData as StorageOverview);
          }
        }
        if (poolData) {
          const accounts = poolData.accounts as DiscoveredAccount[];
          setPoolCache(effectivePoolId, { discovered: accounts });
          if (isStillActive) {
            setDiscovered(accounts);
          }
          if (error && isStillActive) {
            surfaceWorkspaceError('loadClusterData', error, 'Failed to load workspace status');
          }
          return accounts;
        }
        if (error && isStillActive) {
          surfaceWorkspaceError('loadClusterData', error, 'Failed to load workspace status');
        }
      } catch (err) {
        if (isAbortError(err)) return undefined;
        if (activePoolIdRef.current !== effectivePoolId || clusterRequestSeqRef.current !== reqSeq) {
          return undefined;
        }
        surfaceWorkspaceError('loadClusterData', err, 'Failed to load workspace status');
      } finally {
        if (clusterAbortRef.current?.controller === controller) {
          clusterAbortRef.current = null;
        }
      }
      return undefined;
    },
    [surfaceWorkspaceError]
  );

  const loadFiles = useCallback(
    async (path: string, targetPoolId?: number) => {
      const reqPoolId = targetPoolId ?? activePoolIdRef.current;
      const reqSeq = ++filesRequestSeqRef.current;
      const reqIsSharePool =
        poolsRef.current.some((p) => p.id === reqPoolId && p.isSharePool) || reqPoolId >= SHARE_POOL_RESERVE_ID;
      const isActivePool = activePoolIdRef.current === reqPoolId;

      if (isActivePool && filesAbortRef.current && filesAbortRef.current.poolId !== reqPoolId) {
        filesAbortRef.current.controller.abort();
        filesAbortRef.current = null;
      }
      const controller =
        filesAbortRef.current?.poolId === reqPoolId &&
        !filesAbortRef.current.controller.signal.aborted
          ? filesAbortRef.current.controller
          : new AbortController();
      if (isActivePool) {
        filesAbortRef.current = { poolId: reqPoolId, controller };
      }

      try {
        const result = await dedupeInFlight(
          `files:${reqPoolId}`,
          async (signal) => {
            let linksError: string | null = null;
            const [res, linksRes] = await Promise.all([
              client.api.files.$get(
                { query: { path, poolId: String(reqPoolId) } },
                { init: { signal } }
              ),
              reqIsSharePool
                ? client.api.share.links
                    .$get(
                      { query: { poolId: String(reqPoolId) } },
                      { init: { signal } }
                    )
                    .catch((err) => {
                      if (!isAbortError(err)) {
                        linksError = extractErrorMessage(err, 'Failed to load share links');
                      }
                      return null;
                    })
                : Promise.resolve(null),
            ]);
            if (!res.ok) {
              const error = await readResponseError(res, 'Failed to load files');
              return { ok: false as const, error };
            }
            if (reqIsSharePool && linksRes && !linksRes.ok) {
              linksError = await readResponseError(linksRes, 'Failed to load share links');
            }
            const [data, linksData] = await Promise.all([
              res.json(),
              reqIsSharePool && linksRes?.ok ? linksRes.json().catch(() => null) : Promise.resolve(null),
            ]);
            return { ok: true as const, data, linksData, linksError };
          },
          controller.signal
        );

        const isStillActive = activePoolIdRef.current === reqPoolId;
        if (isStillActive && filesRequestSeqRef.current !== reqSeq) return;
        if (result.ok) {
          if (failedFilesLoadPoolRef.current === reqPoolId) {
            failedFilesLoadPoolRef.current = null;
          }
          const nextFiles = result.data.files as ClientFileRecord[];
          const nextFolders = result.data.folders as ClientFolder[];

          if (reqIsSharePool) {
            if (result.linksData) {
              const grouped: Record<string, StoredShareLink[]> = {};
              for (const link of result.linksData.links) {
                if (!grouped[link.batchFolderName]) {
                  grouped[link.batchFolderName] = [];
                }
                grouped[link.batchFolderName].push(link);
              }
              setPoolCache(reqPoolId, {
                files: nextFiles,
                folders: nextFolders,
                loadedFilesPoolId: reqPoolId,
                shareLinksByBatch: grouped,
                shareLinksPoolId: reqPoolId,
              });
              if (isStillActive) {
                setFiles(nextFiles);
                setFolders(nextFolders);
                setLoadedFilesPoolId(reqPoolId);
                setShareLinksByBatch(grouped);
                setShareLinksPoolId(reqPoolId);
              }
            } else {
              setPoolCache(reqPoolId, {
                files: nextFiles,
                folders: nextFolders,
                loadedFilesPoolId: reqPoolId,
              });
              if (isStillActive) {
                setFiles(nextFiles);
                setFolders(nextFolders);
                setLoadedFilesPoolId(reqPoolId);
              }
            }
            if (result.linksError && isStillActive) {
              surfaceWorkspaceError('loadFiles.shareLinks', result.linksError, 'Failed to load share links');
            }
          } else {
            setPoolCache(reqPoolId, {
              files: nextFiles,
              folders: nextFolders,
              loadedFilesPoolId: reqPoolId,
              shareLinksByBatch: {},
              shareLinksPoolId: reqPoolId,
            });
            if (isStillActive) {
              setFiles(nextFiles);
              setFolders(nextFolders);
              setLoadedFilesPoolId(reqPoolId);
              setShareLinksByBatch({});
              setShareLinksPoolId(reqPoolId);
            }
          }
        } else if (isStillActive) {
          failedFilesLoadPoolRef.current = reqPoolId;
          setLoadedFilesPoolId(reqPoolId);
          surfaceWorkspaceError('loadFiles', result.error, 'Failed to load files');
        }
      } catch (err) {
        if (isAbortError(err)) return;
        if (activePoolIdRef.current !== reqPoolId || filesRequestSeqRef.current !== reqSeq) return;
        failedFilesLoadPoolRef.current = reqPoolId;
        surfaceWorkspaceError('loadFiles', err, 'Failed to load files');
        setLoadedFilesPoolId(reqPoolId);
      } finally {
        if (filesAbortRef.current?.controller === controller) {
          filesAbortRef.current = null;
        }
      }
    },
    [surfaceWorkspaceError]
  );

  const loadTrashFiles = useCallback(
    async (targetPoolId?: number) => {
      const reqPoolId = targetPoolId ?? activePoolIdRef.current;
      const reqSeq = ++trashRequestSeqRef.current;
      const isActivePool = activePoolIdRef.current === reqPoolId;

      if (isActivePool && trashAbortRef.current && trashAbortRef.current.poolId !== reqPoolId) {
        trashAbortRef.current.controller.abort();
        trashAbortRef.current = null;
      }
      const controller =
        trashAbortRef.current?.poolId === reqPoolId &&
        !trashAbortRef.current.controller.signal.aborted
          ? trashAbortRef.current.controller
          : new AbortController();
      if (isActivePool) {
        trashAbortRef.current = { poolId: reqPoolId, controller };
      }

      try {
        const result = await dedupeInFlight(
          `trash:${reqPoolId}`,
          async (signal) => {
            const res = await client.api.trash.$get(
              { query: { poolId: String(reqPoolId) } },
              { init: { signal } }
            );
            if (!res.ok) {
              const error = await readResponseError(res, 'Failed to load trash');
              return { ok: false as const, error };
            }
            return { ok: true as const, data: await res.json() };
          },
          controller.signal
        );

        const isStillActive = activePoolIdRef.current === reqPoolId;
        if (isStillActive && trashRequestSeqRef.current !== reqSeq) return;
        if (result.ok) {
          const nextTrashed = (result.data.files as ClientFileRecord[]) || [];
          setPoolCache(reqPoolId, {
            trashedFiles: nextTrashed,
            loadedTrashPoolId: reqPoolId,
            trashStale: false,
          });
          if (isStillActive) {
            setTrashedFiles(nextTrashed);
            trashStaleRef.current = false;
            setLoadedTrashPoolId(reqPoolId);
          }
        } else if (isStillActive) {
          setLoadedTrashPoolId(reqPoolId);
          surfaceWorkspaceError('loadTrashFiles', result.error, 'Failed to load trash');
        }
      } catch (err) {
        if (isAbortError(err)) return;
        if (activePoolIdRef.current !== reqPoolId || trashRequestSeqRef.current !== reqSeq) return;
        surfaceWorkspaceError('loadTrashFiles', err, 'Failed to load trash');
        setLoadedTrashPoolId(reqPoolId);
      } finally {
        if (trashAbortRef.current?.controller === controller) {
          trashAbortRef.current = null;
        }
      }
    },
    [surfaceWorkspaceError]
  );

  // /api/files returns the whole pool, so path changes within a pool need no refetch.
  useEffect(() => {
    if (skipNextPoolEffectRef.current === activePoolId) {
      skipNextPoolEffectRef.current = null;
      return;
    }
    void loadClusterData(activePoolId);
    void loadFiles(currentPathRef.current, activePoolId);
  }, [activePoolId, currentPathRef, loadClusterData, loadFiles]);

  const authAccountsKey = useMemo(() => {
    if (isSharePoolActive) return '';
    return discovered
      .filter((a) => (a.poolId ?? activePoolId) === activePoolId && a.authorized)
      .map((a) => a.accountId)
      .sort()
      .join(',');
  }, [discovered, activePoolId, isSharePoolActive]);

  useEffect(() => {
    if (!isSharePoolActive && authAccountsKey) {
      void checkAccountDiscrepancies(discoveredRef.current, false, activePoolId);
    }
  }, [activePoolId, isSharePoolActive, authAccountsKey, checkAccountDiscrepancies]);

  const clearWorkspaceState = useCallback(() => {
    clusterAbortRef.current?.controller.abort();
    clusterAbortRef.current = null;
    discrepancyAbortRef.current?.controller.abort();
    discrepancyAbortRef.current = null;
    filesAbortRef.current?.controller.abort();
    filesAbortRef.current = null;
    trashAbortRef.current?.controller.abort();
    trashAbortRef.current = null;

    clusterRequestSeqRef.current++;
    discrepancyRequestSeqRef.current++;
    filesRequestSeqRef.current++;
    trashRequestSeqRef.current++;

    setStorage(null);
    setDiscovered([]);
    setFiles([]);
    setFolders([]);
    setTrashedFiles([]);
    setLoadedFilesPoolId(null);
    setLoadedTrashPoolId(null);
    setShareLinksByBatch({});
    setShareLinksPoolId(null);
    setPendingDiscrepancies({});
    trashStaleRef.current = false;
    onClearUiState();
  }, [onClearUiState]);

  const handleSelectPool = useCallback(
    (nextPoolId: number) => {
      const prevPoolId = activePoolIdRef.current;
      if (nextPoolId === prevPoolId) return;

      setPoolCache(prevPoolId, {
        files: filesRef.current,
        folders: foldersRef.current,
        trashedFiles: trashedFilesRef.current,
        storage: storageRef.current,
        discovered: discoveredRef.current,
        shareLinksByBatch: shareLinksByBatchRef.current,
        pendingDiscrepancies: pendingDiscrepanciesRef.current,
        loadedFilesPoolId: loadedFilesPoolIdRef.current,
        loadedTrashPoolId: loadedTrashPoolIdRef.current,
        shareLinksPoolId: shareLinksPoolIdRef.current,
        trashStale: trashStaleRef.current,
      });

      clusterAbortRef.current?.controller.abort();
      discrepancyAbortRef.current?.controller.abort();
      filesAbortRef.current?.controller.abort();
      trashAbortRef.current?.controller.abort();

      clusterRequestSeqRef.current++;
      discrepancyRequestSeqRef.current++;
      filesRequestSeqRef.current++;
      trashRequestSeqRef.current++;

      const cached = getPoolCache(nextPoolId);
      activePoolIdRef.current = nextPoolId;
      startTransition(() => {
        if (cached) {
          setFiles(cached.files);
          setFolders(cached.folders);
          setTrashedFiles(cached.trashedFiles);
          setStorage(cached.storage);
          setDiscovered(cached.discovered);
          setShareLinksByBatch(cached.shareLinksByBatch);
          setPendingDiscrepancies(cached.pendingDiscrepancies);
          setLoadedFilesPoolId(cached.loadedFilesPoolId);
          setLoadedTrashPoolId(cached.loadedTrashPoolId);
          setShareLinksPoolId(cached.shareLinksPoolId);
          trashStaleRef.current = cached.trashStale;
          onRestoreCachedPoolUi();
        } else {
          clearWorkspaceState();
        }
        setActivePoolId(nextPoolId);
        onPoolSwitched();
      });
    },
    [clearWorkspaceState, onPoolSwitched, onRestoreCachedPoolUi]
  );

  const presentAuthorizedAccount = useCallback(
    async ({
      accountFilterId,
      targetPool,
      conflictsCount,
    }: {
      accountFilterId?: string;
      targetPool: number;
      conflictsCount: number;
    }) => {
      const switchingPool = targetPool !== activePoolIdRef.current;
      const nextPath = switchingPool ? '/' : currentPathRef.current;
      if (switchingPool) {
        skipNextPoolEffectRef.current = targetPool;
        handleSelectPool(targetPool);
      }
      lastDiscrepancyScanByPool.set(targetPool, 0);
      const [freshAccounts] = await Promise.all([
        loadClusterData(targetPool),
        loadFiles(nextPath, targetPool),
      ]);
      if (freshAccounts) {
        await checkAccountDiscrepancies(freshAccounts, true, targetPool);
      }
      if (conflictsCount > 0) {
        onAuthConflictsDetected(accountFilterId);
      }
    },
    [
      currentPathRef,
      handleSelectPool,
      loadClusterData,
      loadFiles,
      checkAccountDiscrepancies,
      onAuthConflictsDetected,
    ]
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'success') {
      const rawAccount = params.get('account') || undefined;
      const poolIdParam = Number(params.get('poolId'));
      const parsedConflicts = Number(params.get('conflicts') || '0');
      const conflictsCount =
        Number.isFinite(parsedConflicts) && parsedConflicts > 0 ? parsedConflicts : 0;
      const targetPool =
        Number.isFinite(poolIdParam) && poolIdParam > 0 ? poolIdParam : activePoolIdRef.current;
      window.history.replaceState({}, '', window.location.pathname);
      void presentAuthorizedAccount({
        accountFilterId: rawAccount,
        targetPool,
        conflictsCount,
      });
    }
  }, [presentAuthorizedAccount]);

  useEffect(() => {
    return subscribeAuthCompleted((data) => {
      const rawAccount = typeof data.account === 'string' && data.account ? data.account : undefined;
      const targetPool =
        typeof data.poolId === 'number' && Number.isFinite(data.poolId) && data.poolId > 0
          ? data.poolId
          : activePoolIdRef.current;
      const conflictsCount =
        typeof data.conflicts === 'number' && Number.isFinite(data.conflicts) && data.conflicts > 0
          ? data.conflicts
          : 0;
      void presentAuthorizedAccount({
        accountFilterId: rawAccount,
        targetPool,
        conflictsCount,
      });
    });
  }, [presentAuthorizedAccount]);

  const lastFocusRefreshRef = useRef<number>(0);
  useEffect(() => {
    function handleFocusOrVisible() {
      if (document.visibilityState !== 'visible') return;
      if (isSyncingRef.current || pendingOpsCountRef.current > 0) return;
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < 10_000) return;
      lastFocusRefreshRef.current = now;
      void loadClusterData();
    }
    window.addEventListener('focus', handleFocusOrVisible);
    document.addEventListener('visibilitychange', handleFocusOrVisible);
    return () => {
      window.removeEventListener('focus', handleFocusOrVisible);
      document.removeEventListener('visibilitychange', handleFocusOrVisible);
    };
  }, [isSyncingRef, pendingOpsCountRef, loadClusterData]);

  return {
    pools,
    setPools,
    poolsRef,
    activePoolId,
    setActivePoolId,
    activePoolIdRef,
    activePool,
    isSharePoolActive,
    isPoolSharePool,
    storage,
    setStorage,
    storageRef,
    discovered,
    setDiscovered,
    discoveredRef,
    files,
    setFiles,
    filesRef,
    folders,
    setFolders,
    foldersRef,
    trashedFiles,
    setTrashedFiles,
    trashedFilesRef,
    loadedFilesPoolId,
    setLoadedFilesPoolId,
    loadedTrashPoolId,
    setLoadedTrashPoolId,
    shareLinksByBatch,
    setShareLinksByBatch,
    shareLinksPoolId,
    setShareLinksPoolId,
    pendingDiscrepancies,
    setPendingDiscrepancies,
    trashStaleRef,
    failedFilesLoadPoolRef,
    skipNextPoolEffectRef,
    markTrashStale,
    checkAccountDiscrepancies,
    loadClusterData,
    loadFiles,
    loadTrashFiles,
    clearWorkspaceState,
    handleSelectPool,
    presentAuthorizedAccount,
  };
}
