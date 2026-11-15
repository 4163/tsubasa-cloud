import React, {
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { client } from './api.js';
import { colors, darkColors } from './tokens.stylex.js';
import { Header, type ThemeChoice } from './components/Header.js';
import { Sidebar, type AccountItem, type PoolSummary } from './components/Sidebar.js';
import {
  ActionPortal,
  type ActionPortalClipboard,
  type SelectedAccountGroup,
  type SelectedShareBatch,
} from './components/ActionPortal.js';
import {
  FileTable,
  extractDataTransferEntries,
  type ClientFileRecord,
  type ClientFolder,
} from './components/FileTable.js';
import { DitherDivider } from './components/DitherDivider.js';
import type { StagedItem } from './components/UploadDrawer.js';
import type { RenameTarget } from './components/RenameModal.js';
import type { ShareExecuteResult, ShareTargetItem } from './components/ShareModal.js';

const UploadDrawer = lazy(() =>
  import('./components/UploadDrawer.js').then((m) => ({ default: m.UploadDrawer }))
);
const ExternalChangesDrawer = lazy(() =>
  import('./components/ExternalChangesDrawer.js').then((m) => ({ default: m.ExternalChangesDrawer }))
);
const NewFolderModal = lazy(() =>
  import('./components/NewFolderModal.js').then((m) => ({ default: m.NewFolderModal }))
);
const ConfirmPurgeModal = lazy(() =>
  import('./components/ConfirmPurgeModal.js').then((m) => ({ default: m.ConfirmPurgeModal }))
);
const ConfirmDriveActionModal = lazy(() =>
  import('./components/ConfirmDriveActionModal.js').then((m) => ({
    default: m.ConfirmDriveActionModal,
  }))
);
const RenameModal = lazy(() =>
  import('./components/RenameModal.js').then((m) => ({ default: m.RenameModal }))
);
const MovePoolModal = lazy(() =>
  import('./components/MovePoolModal.js').then((m) => ({ default: m.MovePoolModal }))
);
const MoveFilesModal = lazy(() =>
  import('./components/MoveFilesModal.js').then((m) => ({ default: m.MoveFilesModal }))
);
const ShareModal = lazy(() =>
  import('./components/ShareModal.js').then((m) => ({ default: m.ShareModal }))
);
import { ToastRegion, pushToast } from './components/ToastRegion.js';
import { copyTextToClipboard, SHARE_POOL_RESERVE_ID } from './utils/format.js';
import { useBeforeUnload, useMediaQuery } from './utils/useBeforeUnload.js';
import { subscribeAuthCompleted } from './utils/useTabLock.js';
import {
  dedupeInFlight,
  getPoolCache,
  markPoolTrashStale,
  runWithConcurrency,
  setDiscrepancyReportCache,
  setPoolCache,
  type DiscrepancyReport,
  type DiscoveredAccount,
  type StorageOverview,
  type StoredShareLink,
} from './utils/queryCache.js';

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

function getParentFolderPath(virtualPath: string): string {
  const normalized = virtualPath.startsWith('/') ? virtualPath : `/${virtualPath}`;
  const trimmed = normalized.endsWith('/') && normalized.length > 1 ? normalized.slice(0, -1) : normalized;
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return trimmed.slice(0, lastSlash);
}

const styles = stylex.create({
  shell: {
    width: '100vw',
    height: '100vh',
    display: 'flex',
    backgroundColor: colors.canvas,
    overflow: 'hidden',
    position: 'relative',
  },
  mainWorkspace: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    height: '100%',
    minWidth: 0,
    overflow: 'hidden',
    position: 'relative',
  },
  fileTableStage: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    position: 'relative',
  },
  fileTablePane: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  fileTablePaneHidden: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    contentVisibility: 'hidden',
    display: {
      default: 'flex',
      '@supports not (content-visibility: hidden)': 'none',
    },
  },
});

function runWithViewTransition(update: () => void) {
  if (
    typeof document !== 'undefined' &&
    'startViewTransition' in document &&
    typeof document.startViewTransition === 'function' &&
    window.matchMedia('(prefers-reduced-motion: no-preference)').matches
  ) {
    document.startViewTransition(update);
  } else {
    update();
  }
}

const lastDiscrepancyScanByPool = new Map<number, number>();
const DISCREPANCY_COOLDOWN_MS = 60_000;
const EMPTY_SELECTED_IDS = new Set<string>();

export function App() {
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('tsubasa-theme-choice') as ThemeChoice;
      if (saved === 'auto' || saved === 'light' || saved === 'dark') {
        return saved;
      }
    }
    return 'auto';
  });

  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('tsubasa-theme-choice');
      if (saved === 'light' || saved === 'dark') return saved;
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'dark';
  });

  const handleThemeChange = useCallback((newTheme: ThemeChoice) => {
    try {
      localStorage.setItem('tsubasa-theme-choice', newTheme);
    } catch {}
    runWithViewTransition(() => {
      flushSync(() => {
        setThemeChoice(newTheme);
      });
    });
  }, []);

  useLayoutEffect(() => {
    let active: 'light' | 'dark' = 'dark';
    if (themeChoice === 'auto') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      active = mql.matches ? 'dark' : 'light';
      setEffectiveTheme(active);
      const listener = (e: MediaQueryListEvent) => {
        const next = e.matches ? 'dark' : 'light';
        setEffectiveTheme(next);
        document.documentElement.setAttribute('data-theme', next);
        document.documentElement.style.backgroundColor = next === 'dark' ? '#0b1412' : '#eef2ec';
        document.documentElement.style.color = next === 'dark' ? '#e5f2eb' : '#111d18';
        if (next === 'dark') {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      };
      mql.addEventListener('change', listener);
      return () => mql.removeEventListener('change', listener);
    } else {
      active = themeChoice;
      setEffectiveTheme(themeChoice);
    }
    document.documentElement.setAttribute('data-theme', active);
    document.documentElement.style.backgroundColor = active === 'dark' ? '#0b1412' : '#eef2ec';
    document.documentElement.style.color = active === 'dark' ? '#e5f2eb' : '#111d18';
    if (active === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [themeChoice]);
  const [pools, setPools] = useState<PoolSummary[]>([
    { id: 1, name: 'Pool 1', driveFolderName: '_Tsubasa~ Pool 1', accountCount: 0, fileCount: 0, totalBytes: 0 },
  ]);
  const [activePoolId, setActivePoolId] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = Number(window.sessionStorage.getItem('tsubasa-active-pool-id'));
      if (Number.isInteger(saved) && saved >= 1) return saved;
    }
    return 1;
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('tsubasa-active-pool-id', String(activePoolId));
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
  const [loadedFilesPoolId, setLoadedFilesPoolId] = useState<number | null>(null);
  const [loadedTrashPoolId, setLoadedTrashPoolId] = useState<number | null>(null);
  const [shareLinksByBatch, setShareLinksByBatch] = useState<Record<string, StoredShareLink[]>>({});
  const [shareLinksPoolId, setShareLinksPoolId] = useState<number | null>(null);
  const filesRequestSeqRef = useRef(0);
  const trashRequestSeqRef = useRef(0);
  const clusterRequestSeqRef = useRef(0);
  const discrepancyRequestSeqRef = useRef(0);
  const filesAbortRef = useRef<{ poolId: number; controller: AbortController } | null>(null);
  const trashAbortRef = useRef<{ poolId: number; controller: AbortController } | null>(null);
  const clusterAbortRef = useRef<{ poolId: number; controller: AbortController } | null>(null);
  const discrepancyAbortRef = useRef<{ poolId: number; controller: AbortController } | null>(null);
  const trashStaleRef = useRef(false);
  const skipNextPoolEffectRef = useRef<number | null>(null);
  const activePoolIdRef = useRef(activePoolId);
  activePoolIdRef.current = activePoolId;
  const poolsRef = useRef(pools);
  poolsRef.current = pools;
  const isPoolSharePool = useCallback(
    (poolId: number): boolean =>
      poolsRef.current.some((p) => p.id === poolId && p.isSharePool) || poolId >= SHARE_POOL_RESERVE_ID,
    []
  );

  function getPathUrl(targetPath: string): string {
    if (typeof window === 'undefined') return '';
    const url = new URL(window.location.href);
    if (targetPath === '/' || !targetPath) {
      url.searchParams.delete('path');
    } else {
      url.searchParams.set('path', targetPath);
    }
    return url.pathname + (url.search ? url.search : '') + url.hash;
  }

  const [currentPath, setCurrentPath] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const urlPath = urlParams.get('path');
      if (urlPath) return urlPath;
      return window.sessionStorage.getItem('tsubasa-current-path') || '/';
    }
    return '/';
  });
  const [searchQuery, setSearchQuery] = useState<string>('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [currentNav, setCurrentNav] = useState<'files' | 'trash'>(() => {
    if (typeof window !== 'undefined') {
      const saved = window.sessionStorage.getItem('tsubasa-current-nav');
      if (saved === 'files' || saved === 'trash') return saved;
    }
    return 'files';
  });
  const currentNavRef = useRef(currentNav);
  currentNavRef.current = currentNav;
  const [clipboard, setClipboard] = useState<ActionPortalClipboard | null>(null);
  const [renameModalItem, setRenameModalItem] = useState<RenameTarget | null>(null);
  const [movePoolTargetAccount, setMovePoolTargetAccount] = useState<AccountItem | null>(null);
  const [moveFilesModalGroup, setMoveFilesModalGroup] = useState<SelectedAccountGroup | null>(null);
  const [filteredAccountIds, setFilteredAccountIds] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const raw = window.sessionStorage.getItem('tsubasa-filtered-account-ids');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            return new Set(parsed.filter((id) => typeof id === 'string'));
          }
        }
      } catch {
        // Ignore storage parse errors
      }
    }
    return new Set();
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        if (filteredAccountIds.size === 0) {
          window.sessionStorage.removeItem('tsubasa-filtered-account-ids');
        } else {
          window.sessionStorage.setItem(
            'tsubasa-filtered-account-ids',
            JSON.stringify(Array.from(filteredAccountIds))
          );
        }
      } catch {
        // Ignore storage errors
      }
    }
  }, [filteredAccountIds]);

  const handleToggleAccountFilter = useCallback((accountId: string) => {
    startTransition(() => {
      setSelectedIds(new Set());
      setFilteredAccountIds((prev) => {
        const next = new Set(prev);
        if (next.has(accountId)) {
          next.delete(accountId);
        } else {
          next.add(accountId);
        }
        return next;
      });
    });
  }, []);

  const [hasVisitedFiles, setHasVisitedFiles] = useState<boolean>(() => currentNav === 'files');
  const [hasVisitedTrash, setHasVisitedTrash] = useState<boolean>(() => currentNav === 'trash');

  useEffect(() => {
    if (currentNav === 'files') setHasVisitedFiles(true);
    if (currentNav === 'trash') setHasVisitedTrash(true);
  }, [currentNav]);

  const handleSelectNav = useCallback((nav: 'files' | 'trash') => {
    runWithViewTransition(() => {
      flushSync(() => {
        setCurrentNav(nav);
      });
    });
  }, []);

  const handleNavigate = useCallback(
    (newPath: string) => {
      if (typeof window !== 'undefined') {
        const nextUrl = getPathUrl(newPath);
        if (newPath !== currentPath) {
          window.history.pushState({ path: newPath }, '', nextUrl);
        }
      }
      startTransition(() => {
        setCurrentPath(newPath);
        setSelectedIds(new Set());
      });
    },
    [currentPath]
  );

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('tsubasa-current-path', currentPath);
    }
  }, [currentPath]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('tsubasa-current-nav', currentNav);
    }
  }, [currentNav]);

  useEffect(() => {
    if (currentPath === '/' || folders.length === 0) return;
    const exists = folders.some((f) => f.virtualPath === currentPath);
    if (!exists) {
      const parts = currentPath.split('/').filter(Boolean);
      let fallback = '/';
      for (let i = parts.length - 1; i >= 1; i--) {
        const ancestor = '/' + parts.slice(0, i).join('/');
        if (folders.some((f) => f.virtualPath === ancestor)) {
          fallback = ancestor;
          break;
        }
      }
      handleNavigate(fallback);
    }
  }, [folders, currentPath, handleNavigate]);

  useEffect(() => {
    setFilteredAccountIds((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set<string>();
      for (const id of prev) {
        if (files.some((f) => !f.isTrashed && f.accountId === id)) {
          valid.add(id);
        }
      }
      if (valid.size === prev.size) return prev;
      return valid;
    });
  }, [files]);

  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [pendingOpsCount, setPendingOpsCount] = useState<number>(0);
  const isSyncingRef = useRef(isSyncing);
  isSyncingRef.current = isSyncing;
  const pendingOpsCountRef = useRef(pendingOpsCount);
  pendingOpsCountRef.current = pendingOpsCount;
  const [isMobileOpen, setIsMobileOpen] = useState<boolean>(false);
  const [transferringFileId, setTransferringFileId] = useState<string | null>(null);
  const [driveActionModal, setDriveActionModal] = useState<{
    isOpen: boolean;
    action: 'remove';
    account: AccountItem | null;
    isLoading: boolean;
    errorMessage: string | null;
  }>({
    isOpen: false,
    action: 'remove',
    account: null,
    isLoading: false,
    errorMessage: null,
  });

  const runPendingOp = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setPendingOpsCount((c) => c + 1);
    try {
      return await fn();
    } finally {
      setPendingOpsCount((c) => Math.max(0, c - 1));
    }
  }, []);

  const hasInFlightAppProcess =
    isSyncing ||
    isImporting ||
    transferringFileId !== null ||
    driveActionModal.isLoading ||
    pendingOpsCount > 0;

  useBeforeUnload(hasInFlightAppProcess);

  const isMobileViewport = useMediaQuery('(max-width: 768px)');
  const prevMobileViewportRef = useRef(isMobileViewport);
  useEffect(() => {
    if (prevMobileViewportRef.current !== isMobileViewport) {
      prevMobileViewportRef.current = isMobileViewport;
      if (!isMobileViewport) {
        setIsMobileOpen(false);
      }
      setIsExternalChangesOpen(false);
      setExternalChangesAccountId(undefined);
    }
  }, [isMobileViewport]);

  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      document.body.classList.add('resize-animation-stopper');
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        document.body.classList.remove('resize-animation-stopper');
      }, 150);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimer);
    };
  }, []);
  // Drawers and modals state
  const [stagedFiles, setStagedFiles] = useState<Array<File | StagedItem>>([]);
  const [stagedEmptyFolders, setStagedEmptyFolders] = useState<string[]>([]);
  const [isUploadDrawerOpen, setIsUploadDrawerOpen] = useState<boolean>(false);

  const [isExternalChangesOpen, setIsExternalChangesOpen] = useState<boolean>(false);
  const [externalChangesAccountId, setExternalChangesAccountId] = useState<string | undefined>(undefined);

  const [trashedFiles, setTrashedFiles] = useState<ClientFileRecord[]>([]);
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState<boolean>(false);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState<boolean>(false);
  const [shareModalState, setShareModalState] = useState<{
    items: ShareTargetItem[];
    sourcePoolId: number;
  } | null>(null);
  const [isClearSharePoolOpen, setIsClearSharePoolOpen] = useState<boolean>(false);
  const [pendingDiscrepancies, setPendingDiscrepancies] = useState<Record<string, boolean>>({});

  // Synchronize browser history and popstate events (e.g. Mouse Back/Forward, Browser Back/Forward, Alt+Left/Right)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const currentUrl = getPathUrl(currentPath);
    if (!window.history.state || window.history.state.path !== currentPath) {
      window.history.replaceState({ path: currentPath }, '', currentUrl);
    }

    function handlePopState(e: PopStateEvent) {
      if (driveActionModal.isLoading || pendingOpsCount > 0) {
        window.history.pushState({ path: currentPath }, '', getPathUrl(currentPath));
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const targetPath = e.state?.path || params.get('path') || '/';

      if (renameModalItem) setRenameModalItem(null);
      if (movePoolTargetAccount) setMovePoolTargetAccount(null);
      if (isUploadDrawerOpen) setIsUploadDrawerOpen(false);
      if (isExternalChangesOpen) setIsExternalChangesOpen(false);
      if (isNewFolderOpen) setIsNewFolderOpen(false);
      if (confirmEmptyTrash) setConfirmEmptyTrash(false);
      if (shareModalState) setShareModalState(null);
      if (isClearSharePoolOpen) setIsClearSharePoolOpen(false);

      setCurrentNav('files');
      setCurrentPath(targetPath);
      setSelectedIds(new Set());
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [
    currentPath,
    renameModalItem,
    movePoolTargetAccount,
    isUploadDrawerOpen,
    isExternalChangesOpen,
    isNewFolderOpen,
    confirmEmptyTrash,
    shareModalState,
    isClearSharePoolOpen,
    driveActionModal.isLoading,
    pendingOpsCount,
  ]);

  const filesRef = useRef(files);
  filesRef.current = files;
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  const trashedFilesRef = useRef(trashedFiles);
  trashedFilesRef.current = trashedFiles;
  const storageRef = useRef(storage);
  storageRef.current = storage;
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
                async () => {
                  const res = await client.api.sync['external-changes'][':accountId'].$get(
                    {
                      param: { accountId: acc.accountId },
                      query: force ? { refresh: '1' } : {},
                    },
                    { init: { signal: controller.signal } }
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
              // Silently skip if network or scan is unavailable
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

      if (clusterAbortRef.current && clusterAbortRef.current.poolId !== effectivePoolId) {
        clusterAbortRef.current.controller.abort();
        clusterAbortRef.current = null;
      }
      const controller =
        clusterAbortRef.current?.poolId === effectivePoolId &&
        !clusterAbortRef.current.controller.signal.aborted
          ? clusterAbortRef.current.controller
          : new AbortController();
      clusterAbortRef.current = { poolId: effectivePoolId, controller };

      try {
        const result = await dedupeInFlight(
          `cluster:${effectivePoolId}`,
          async () => {
            const [poolsRes, storageRes, poolRes] = await Promise.all([
              client.api.pools.$get(undefined, { init: { signal: controller.signal } }),
              client.api.storage.overview.$get(
                { query: { poolId: String(effectivePoolId) } },
                { init: { signal: controller.signal } }
              ),
              client.api.accounts.pool.$get(
                { query: { poolId: String(effectivePoolId) } },
                { init: { signal: controller.signal } }
              ),
            ]);
            const [poolsData, storageData, poolData] = await Promise.all([
              poolsRes.ok ? poolsRes.json() : Promise.resolve(null),
              storageRes.ok ? storageRes.json() : Promise.resolve(null),
              poolRes.ok ? poolRes.json() : Promise.resolve(null),
            ]);
            return { poolsData, storageData, poolData };
          },
          controller.signal
        );

        if (clusterRequestSeqRef.current !== reqSeq) return undefined;
        const { poolsData, storageData, poolData } = result;

        if (poolsData) {
          setPools(poolsData.pools);
          if (poolsData.pools.length > 0 && !poolsData.pools.some((p) => p.id === effectivePoolId)) {
            const fallbackPool = poolsData.pools.find((p) => !p.isSharePool) ?? poolsData.pools[0];
            setActivePoolId(fallbackPool.id);
          }
        }
        if (storageData) {
          setStorage(storageData as StorageOverview);
          setPoolCache(effectivePoolId, { storage: storageData as StorageOverview });
        }
        if (poolData) {
          const accounts = poolData.accounts as DiscoveredAccount[];
          setDiscovered(accounts);
          setPoolCache(effectivePoolId, { discovered: accounts });
          return accounts;
        }
      } catch (err) {
        if (isAbortError(err)) return undefined;
        if (clusterRequestSeqRef.current !== reqSeq) return undefined;
        pushToast({
          variant: 'error',
          message: err instanceof Error ? err.message : 'Cluster offline',
        });
      } finally {
        if (clusterAbortRef.current?.controller === controller) {
          clusterAbortRef.current = null;
        }
      }
      return undefined;
    },
    []
  );

  const loadFiles = useCallback(
    async (path: string, targetPoolId?: number) => {
      const reqPoolId = targetPoolId ?? activePoolIdRef.current;
      const reqSeq = ++filesRequestSeqRef.current;
      const reqIsSharePool =
        poolsRef.current.some((p) => p.id === reqPoolId && p.isSharePool) || reqPoolId >= SHARE_POOL_RESERVE_ID;

      if (filesAbortRef.current && filesAbortRef.current.poolId !== reqPoolId) {
        filesAbortRef.current.controller.abort();
        filesAbortRef.current = null;
      }
      const controller =
        filesAbortRef.current?.poolId === reqPoolId &&
        !filesAbortRef.current.controller.signal.aborted
          ? filesAbortRef.current.controller
          : new AbortController();
      filesAbortRef.current = { poolId: reqPoolId, controller };

      try {
        const result = await dedupeInFlight(
          `files:${reqPoolId}`,
          async () => {
            const [res, linksRes] = await Promise.all([
              client.api.files.$get(
                { query: { path, poolId: String(reqPoolId) } },
                { init: { signal: controller.signal } }
              ),
              reqIsSharePool
                ? client.api.share.links
                    .$get(
                      { query: { poolId: String(reqPoolId) } },
                      { init: { signal: controller.signal } }
                    )
                    .catch(() => null)
                : Promise.resolve(null),
            ]);
            if (!res.ok) return { ok: false as const };
            const [data, linksData] = await Promise.all([
              res.json(),
              reqIsSharePool && linksRes?.ok ? linksRes.json().catch(() => null) : Promise.resolve(null),
            ]);
            return { ok: true as const, data, linksData };
          },
          controller.signal
        );

        if (filesRequestSeqRef.current !== reqSeq) return;
        if (result.ok) {
          const nextFiles = result.data.files as ClientFileRecord[];
          const nextFolders = result.data.folders as ClientFolder[];
          setFiles(nextFiles);
          setFolders(nextFolders);
          setLoadedFilesPoolId(reqPoolId);

          if (reqIsSharePool) {
            if (result.linksData) {
              const grouped: Record<string, StoredShareLink[]> = {};
              for (const link of result.linksData.links) {
                if (!grouped[link.batchFolderName]) {
                  grouped[link.batchFolderName] = [];
                }
                grouped[link.batchFolderName].push(link);
              }
              setShareLinksByBatch(grouped);
              setShareLinksPoolId(reqPoolId);
              setPoolCache(reqPoolId, {
                files: nextFiles,
                folders: nextFolders,
                loadedFilesPoolId: reqPoolId,
                shareLinksByBatch: grouped,
                shareLinksPoolId: reqPoolId,
              });
            } else {
              setPoolCache(reqPoolId, {
                files: nextFiles,
                folders: nextFolders,
                loadedFilesPoolId: reqPoolId,
              });
            }
          } else {
            setShareLinksByBatch({});
            setShareLinksPoolId(reqPoolId);
            setPoolCache(reqPoolId, {
              files: nextFiles,
              folders: nextFolders,
              loadedFilesPoolId: reqPoolId,
              shareLinksByBatch: {},
              shareLinksPoolId: reqPoolId,
            });
          }
        } else {
          setLoadedFilesPoolId(reqPoolId);
        }
      } catch (err) {
        if (isAbortError(err)) return;
        if (filesRequestSeqRef.current !== reqSeq) return;
        pushToast({
          variant: 'error',
          message: err instanceof Error ? err.message : 'Failed to query files',
        });
        setLoadedFilesPoolId(reqPoolId);
      } finally {
        if (filesAbortRef.current?.controller === controller) {
          filesAbortRef.current = null;
        }
      }
    },
    []
  );

  const loadTrashFiles = useCallback(async (targetPoolId?: number) => {
    const reqPoolId = targetPoolId ?? activePoolIdRef.current;
    const reqSeq = ++trashRequestSeqRef.current;

    if (trashAbortRef.current && trashAbortRef.current.poolId !== reqPoolId) {
      trashAbortRef.current.controller.abort();
      trashAbortRef.current = null;
    }
    const controller =
      trashAbortRef.current?.poolId === reqPoolId &&
      !trashAbortRef.current.controller.signal.aborted
        ? trashAbortRef.current.controller
        : new AbortController();
    trashAbortRef.current = { poolId: reqPoolId, controller };

    try {
      const result = await dedupeInFlight(
        `trash:${reqPoolId}`,
        async () => {
          const res = await client.api.trash.$get(
            { query: { poolId: String(reqPoolId) } },
            { init: { signal: controller.signal } }
          );
          if (!res.ok) return null;
          return await res.json();
        },
        controller.signal
      );

      if (trashRequestSeqRef.current !== reqSeq) return;
      if (result) {
        const nextTrashed = (result.files as ClientFileRecord[]) || [];
        setTrashedFiles(nextTrashed);
        if (reqPoolId === activePoolIdRef.current) {
          trashStaleRef.current = false;
        }
        setPoolCache(reqPoolId, {
          trashedFiles: nextTrashed,
          loadedTrashPoolId: reqPoolId,
          trashStale: false,
        });
      }
      setLoadedTrashPoolId(reqPoolId);
    } catch (err) {
      if (isAbortError(err)) return;
      if (trashRequestSeqRef.current !== reqSeq) return;
      pushToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to query trash',
      });
      setLoadedTrashPoolId(reqPoolId);
    } finally {
      if (trashAbortRef.current?.controller === controller) {
        trashAbortRef.current = null;
      }
    }
  }, []);

  // /api/files returns the whole pool, so path changes within a pool need no refetch.
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;

  useEffect(() => {
    if (skipNextPoolEffectRef.current === activePoolId) {
      skipNextPoolEffectRef.current = null;
      return;
    }
    void loadClusterData(activePoolId);
    void loadFiles(currentPathRef.current, activePoolId);
  }, [activePoolId, loadClusterData, loadFiles]);

  const discoveredRef = useRef(discovered);
  discoveredRef.current = discovered;

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
    clusterRequestSeqRef.current++;
    discrepancyRequestSeqRef.current++;
    setFiles([]);
    setFolders([]);
    setTrashedFiles([]);
    setLoadedFilesPoolId(null);
    setLoadedTrashPoolId(null);
    setShareLinksByBatch({});
    setShareLinksPoolId(null);
    setFilteredAccountIds(new Set());
    setSelectedIds(new Set());
    setClipboard(null);
    setPendingDiscrepancies({});
    trashStaleRef.current = false;
  }, []);

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
          setFilteredAccountIds(new Set());
          setSelectedIds(new Set());
          setClipboard(null);
        } else {
          clearWorkspaceState();
        }
        setActivePoolId(nextPoolId);
        setCurrentPath('/');
        setIsUploadDrawerOpen(false);
        setIsExternalChangesOpen(false);
        setShareModalState(null);
        setIsClearSharePoolOpen(false);
        setMoveFilesModalGroup(null);
        setRenameModalItem(null);
      });
    },
    [clearWorkspaceState]
  );

  const presentAuthorizedAccount = useCallback(
    async ({
      accountFilterId,
      targetPool,
      conflictsCount,
      conflictToast,
      cleanToast,
    }: {
      accountFilterId?: string;
      targetPool: number;
      conflictsCount: number;
      conflictToast: string;
      cleanToast: string;
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
        pushToast({ variant: 'info', message: conflictToast });
        if (accountFilterId) {
          setExternalChangesAccountId(accountFilterId);
        }
        setIsExternalChangesOpen(true);
      } else {
        pushToast({ variant: 'success', message: cleanToast });
      }
    },
    [handleSelectPool, loadClusterData, loadFiles, checkAccountDiscrepancies]
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'success') {
      const rawAccount = params.get('account') || undefined;
      const accountLabel = rawAccount || 'Google account';
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
        conflictToast: `Account "${accountLabel}" authorized with ${conflictsCount} file ${conflictsCount === 1 ? 'conflict' : 'conflicts'}.`,
        cleanToast: `Account "${accountLabel}" successfully authorized.`,
      });
    }
  }, [presentAuthorizedAccount]);

  useEffect(() => {
    return subscribeAuthCompleted((data) => {
      const rawAccount = typeof data.account === 'string' && data.account ? data.account : undefined;
      const accountLabel = rawAccount || 'Google account';
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
        conflictToast: `Account "${accountLabel}" authorized with ${conflictsCount} file ${conflictsCount === 1 ? 'conflict' : 'conflicts'}.`,
        cleanToast: `Account "${accountLabel}" successfully authorized.`,
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
  }, [loadClusterData]);

  useEffect(() => {
    if (currentNav === 'trash') {
      if (loadedTrashPoolId !== activePoolId || trashStaleRef.current) {
        void loadTrashFiles(activePoolId);
      }
      setConfirmEmptyTrash(false);
    }
  }, [currentNav, activePoolId, loadedTrashPoolId, loadTrashFiles]);

  const handleSelect = useCallback((id: string, isMulti: boolean) => {
    setSelectedIds((prev) => {
      if (id === '__parent__') {
        if (prev.has('__parent__') && prev.size === 1) {
          return new Set();
        }
        return new Set(['__parent__']);
      }
      if (isMulti) {
        const next = new Set(prev);
        next.delete('__parent__');
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      }
      if (prev.has(id) && prev.size === 1) {
        return new Set();
      }
      return new Set([id]);
    });
  }, []);

  const handleSelectMultiple = useCallback((ids: string[], mode: 'set' | 'add' | 'toggle' = 'set') => {
    setSelectedIds((prev) => {
      if (mode === 'set') {
        return new Set(ids.filter((id) => id !== '__parent__'));
      }
      const next = new Set(prev);
      next.delete('__parent__');
      if (mode === 'add') {
        for (const id of ids) {
          if (id !== '__parent__') next.add(id);
        }
      } else if (mode === 'toggle') {
        for (const id of ids) {
          if (id === '__parent__') continue;
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
      }
      return next;
    });
  }, []);

  // Mouse button navigation for directory history (mouse buttons 3 & 4)
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
      }
    }

    function handleMouseDown(e: MouseEvent) {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
      }
    }

    function handleMouseUp(e: MouseEvent) {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        e.stopPropagation();

        const isAnyModalOpen = Boolean(
          renameModalItem ||
          movePoolTargetAccount ||
          isUploadDrawerOpen ||
          isExternalChangesOpen ||
          confirmEmptyTrash ||
          isNewFolderOpen ||
          driveActionModal.isOpen ||
          shareModalState ||
          isClearSharePoolOpen
        );
        if (isAnyModalOpen) return;

        if (e.button === 3) {
          window.history.back();
        } else if (e.button === 4) {
          window.history.forward();
        }
      }
    }

    function handleAuxClick(e: MouseEvent) {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    window.addEventListener('pointerdown', handlePointerDown, { capture: true });
    window.addEventListener('mousedown', handleMouseDown, { capture: true });
    window.addEventListener('mouseup', handleMouseUp, { capture: true });
    window.addEventListener('auxclick', handleAuxClick, { capture: true });

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      window.removeEventListener('mousedown', handleMouseDown, { capture: true });
      window.removeEventListener('mouseup', handleMouseUp, { capture: true });
      window.removeEventListener('auxclick', handleAuxClick, { capture: true });
    };
  }, [
    renameModalItem,
    movePoolTargetAccount,
    isUploadDrawerOpen,
    isExternalChangesOpen,
    confirmEmptyTrash,
    isNewFolderOpen,
    driveActionModal.isOpen,
    shareModalState,
    isClearSharePoolOpen,
  ]);

  const handleAuthorizeAccount = useCallback(async (_accountId: string) => {
    pushToast({ variant: 'info', message: 'Authorize link copied to clipboard. Paste it in your browser.' });
  }, []);

  const handleImportOAuth = useCallback(
    async (file: File) => {
      setIsImporting(true);
      pushToast({ variant: 'info', message: `Inspecting credentials from ${file.name}...` });
      try {
        const text = await file.text();

        if (file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(text);
            if (parsed.web && !parsed.installed) {
              pushToast({
                variant: 'error',
                message:
                  "The uploaded credential is a 'Web application'. Tsubasa requires credentials with Application Type: 'Desktop app' (see docs/roadmap.md lines 170-173).",
              });
              return;
            }
          } catch {
            // If JSON parse fails here, server will handle it with validation error
          }
        }

        const res = await client.api.accounts.oauth.import.$post({
          json: {
            filename: file.name,
            content: text,
            poolId: activePoolIdRef.current,
          },
        });

        if (res.ok) {
          const result = await res.json();
          if (result.authorized && result.accountId) {
            const targetPool =
              'poolId' in result && typeof result.poolId === 'number'
                ? result.poolId
                : activePoolIdRef.current;
            const conflictsCount =
              'conflictsCount' in result && typeof result.conflictsCount === 'number'
                ? result.conflictsCount
                : 0;
            await presentAuthorizedAccount({
              accountFilterId: result.accountId,
              targetPool,
              conflictsCount,
              conflictToast: `Imported "${result.accountId}" with ${conflictsCount} file ${conflictsCount === 1 ? 'conflict' : 'conflicts'}.`,
              cleanToast: `Imported credentials for "${result.accountId}".`,
            });
          } else {
            await loadClusterData();
            pushToast({
              variant: 'info',
              message: `Account "${result.accountId}" added. Click "Authorize" to complete Google sign-in.`,
            });
          }
        } else {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          pushToast({ variant: 'error', message: err.error || 'Failed to import OAuth credentials' });
        }
      } catch (err) {
        pushToast({
          variant: 'error',
          message: `Import error: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setIsImporting(false);
      }
    },
    [presentAuthorizedAccount, loadClusterData]
  );

  const handleSyncAll = useCallback(async () => {
    const reqPoolId = activePoolIdRef.current;
    if (isPoolSharePool(reqPoolId)) return;
    setIsSyncing(true);
    pushToast({ variant: 'info', message: 'Fetching changes from Google Drive...' });
    try {
      const res = await client.api.sync.all.$post({
        query: { poolId: String(reqPoolId) },
      });
      if (activePoolIdRef.current !== reqPoolId) return;
      if (res.ok) {
        const report = await res.json();
        if (activePoolIdRef.current !== reqPoolId) return;
        pushToast({ variant: 'success', message: `Update complete: ${report.synced.length} drives checked.` });
        if (currentNavRef.current !== 'trash') {
          markTrashStale(reqPoolId);
        }
        const [freshAccounts] = await Promise.all([
          loadClusterData(reqPoolId),
          loadFiles(currentPathRef.current, reqPoolId),
        ]);
        if (activePoolIdRef.current !== reqPoolId) return;
        await checkAccountDiscrepancies(freshAccounts ?? discoveredRef.current, true, reqPoolId);
      }
    } catch (err) {
      if (activePoolIdRef.current !== reqPoolId) return;
      pushToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Fetch changes failed',
      });
    } finally {
      setIsSyncing(false);
    }
  }, [isPoolSharePool, markTrashStale, loadClusterData, loadFiles, checkAccountDiscrepancies]);

  const handleUploadFiles = useCallback(
    (fileList: FileList) => {
      if (isSharePoolActive) return;
      const list = Array.from(fileList);
      if (list.length > 0) {
        setStagedFiles(list);
        setStagedEmptyFolders([]);
        setIsUploadDrawerOpen(true);
      }
    },
    [isSharePoolActive]
  );

  const handleStageDroppedUpload = useCallback(
    (dropped: { files: Array<{ file: File; virtualPath: string }>; emptyFolders: string[] }) => {
      if (isSharePoolActive) return;
      if (dropped.files.length > 0 || dropped.emptyFolders.length > 0) {
        setStagedFiles(dropped.files);
        setStagedEmptyFolders(dropped.emptyFolders);
        setIsUploadDrawerOpen(true);
      }
    },
    [isSharePoolActive]
  );

  const handleDropExternalToPath = useCallback(
    async (targetPath: string, dataTransfer: DataTransfer) => {
      if (isSharePoolActive) return;
      const extracted = await extractDataTransferEntries(dataTransfer, targetPath);
      if (extracted.files.length > 0 || extracted.emptyFolders.length > 0) {
        setStagedFiles(extracted.files);
        setStagedEmptyFolders(extracted.emptyFolders);
        setIsUploadDrawerOpen(true);
      }
    },
    [isSharePoolActive]
  );

  useEffect(() => {
    const handleWindowDragOver = (e: DragEvent) => {
      if (currentNav === 'trash' || isSharePoolActive) return;
      if (e.dataTransfer?.types?.includes('application/x-tsubasa-items')) return;
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleWindowDrop = async (e: DragEvent) => {
      if (currentNav === 'trash' || isSharePoolActive) return;
      if (e.dataTransfer?.types?.includes('application/x-tsubasa-items')) return;
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        if ((e as any).__tsubasaHandled) return;
        const extracted = await extractDataTransferEntries(e.dataTransfer, currentPath);
        if (extracted.files.length > 0 || extracted.emptyFolders.length > 0) {
          setStagedFiles(extracted.files);
          setStagedEmptyFolders(extracted.emptyFolders);
          setIsUploadDrawerOpen(true);
        }
      }
    };

    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', handleWindowDrop);

    return () => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, [currentNav, currentPath, isSharePoolActive]);

  const handleOpenNewFolder = useCallback(() => {
    if (isSharePoolActive) return;
    setIsNewFolderOpen(true);
  }, [isSharePoolActive]);

  const handleCreateFolder = useCallback(
    async (folderName: string) => {
      if (isSharePoolActive) return;
      setIsNewFolderOpen(false);
      const targetPath = currentPathRef.current;
      const poolId = activePoolIdRef.current;
      const newPath = (targetPath === '/' ? '' : targetPath) + '/' + folderName;
      const prevFolders = foldersRef.current;
      const parentFolder = prevFolders.find((f) => f.virtualPath === targetPath) ?? null;
      const nowIso = new Date().toISOString();
      const optimisticFolder: ClientFolder = {
        id: `optimistic-folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: folderName,
        virtualPath: newPath,
        parentFolderId: parentFolder?.id ?? null,
        poolId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      setFolders((prev) => [...prev, optimisticFolder]);

      try {
        const res = await client.api.folders.$post({
          json: { virtualPath: newPath, name: folderName, poolId },
        });
        if (res.ok) {
          pushToast({ variant: 'success', message: `Created folder "${folderName}".` });
          await loadFiles(targetPath, poolId);
        } else {
          setFolders(prevFolders);
          const err = await res.json().catch(() => ({}));
          const msg = ('error' in err ? (err.error as string) : null) || 'Failed to create folder';
          pushToast({
            variant: 'error',
            message: msg,
            action: { label: 'Retry', onClick: () => void handleCreateFolder(folderName) },
          });
        }
      } catch (err) {
        setFolders(prevFolders);
        pushToast({
          variant: 'error',
          message: err instanceof Error ? err.message : String(err),
          action: { label: 'Retry', onClick: () => void handleCreateFolder(folderName) },
        });
      }
    },
    [isSharePoolActive, loadFiles]
  );

  const handleDownload = useCallback((file: ClientFileRecord) => {
    window.open(`/api/files/${encodeURIComponent(file.id)}/download`, '_blank');
  }, []);

  async function trashFileRequest(file: ClientFileRecord): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await client.api.files[':id'].trash.$post({ param: { id: file.id } });
      if (res.ok) return { ok: true };
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: ('error' in err ? (err.error as string) : null) || 'Trash failed' };
    } catch (err) {
      return { ok: false, error: `Trash error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function restoreFileRequest(file: ClientFileRecord): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await client.api.files[':id'].restore.$post({
        param: { id: file.id },
      });
      if (res.ok) return { ok: true };
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: ('error' in err ? (err.error as string) : null) || 'Restore failed' };
    } catch (err) {
      return { ok: false, error: `Restore error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function permanentDeleteFileRequest(file: ClientFileRecord): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await client.api.files[':id'].permanent.$delete({
        param: { id: file.id },
      });
      if (res.ok) return { ok: true };
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: ('error' in err ? (err.error as string) : null) || 'Delete failed' };
    } catch (err) {
      return { ok: false, error: `Delete error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function deleteFolderRequest(
    folder: ClientFolder
  ): Promise<{ ok: boolean; navigateParent?: string; error?: string }> {
    try {
      const res = await client.api.folders.$delete({
        query: { virtualPath: folder.virtualPath, poolId: String(activePoolIdRef.current) },
      });
      if (res.ok) {
        let navigateParent: string | undefined;
        const currPath = currentPathRef.current;
        if (currPath === folder.virtualPath || currPath.startsWith(folder.virtualPath + '/')) {
          const parts = folder.virtualPath.split('/').filter(Boolean);
          navigateParent = parts.length <= 1 ? '/' : '/' + parts.slice(0, -1).join('/');
        }
        return { ok: true, navigateParent };
      }
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: ('error' in err ? (err.error as string) : null) || 'Failed to delete folder' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const undoTrashFiles = useCallback(
    async (filesToRestore: ClientFileRecord[]) => {
      if (filesToRestore.length === 0) return;
      const poolId = activePoolIdRef.current;
      const results = await runWithConcurrency(filesToRestore, 6, (f) => restoreFileRequest(f));
      const restoredCount = results.filter((r) => r.ok).length;
      if (restoredCount > 0) {
        pushToast({
          variant: 'success',
          message:
            restoredCount === 1
              ? `Restored "${filesToRestore[0].name}".`
              : `Restored ${restoredCount} files.`,
        });
      } else {
        pushToast({ variant: 'error', message: results.find((r) => !r.ok)?.error || 'Undo failed' });
      }
      if (currentNavRef.current === 'trash') {
        await Promise.all([loadTrashFiles(poolId), loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
      } else {
        markTrashStale(poolId);
        await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
      }
    },
    [loadTrashFiles, loadFiles, loadClusterData, markTrashStale]
  );

  const undoMoveItems = useCallback(
    async (
      groups: Array<{
        targetFolderPath: string;
        items: Array<{ kind: 'file' | 'folder'; id: string }>;
      }>
    ) => {
      if (groups.length === 0) return;
      const poolId = activePoolIdRef.current;
      await runPendingOp(async () => {
        const results = await runWithConcurrency(groups, 6, async (group) => {
          const res = await client.api.items.move.$post({
            json: { items: group.items, targetFolderPath: group.targetFolderPath, poolId },
          });
          return res.ok;
        });
        const allOk = results.every(Boolean);
        if (allOk) {
          pushToast({ variant: 'success', message: 'Move undone.' });
        } else {
          pushToast({ variant: 'error', message: 'Some items could not be moved back.' });
        }
        await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
      });
    },
    [runPendingOp, loadFiles, loadClusterData]
  );

  const handleTrash = useCallback(
    async (file: ClientFileRecord) => {
      const poolId = activePoolIdRef.current;
      const prevFiles = filesRef.current;
      const prevTrashed = trashedFilesRef.current;
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
      if (currentNavRef.current === 'trash') {
        setTrashedFiles((prev) => [{ ...file, isTrashed: true }, ...prev]);
      } else {
        markTrashStale(poolId);
      }

      const result = await trashFileRequest(file);
      if (result.ok) {
        pushToast({
          variant: 'success',
          message: `Moved "${file.name}" to trash.`,
          action: { label: 'Undo', onClick: () => void undoTrashFiles([file]) },
        });
        await Promise.all([
          loadFiles(currentPathRef.current, poolId),
          currentNavRef.current === 'trash' ? loadTrashFiles(poolId) : Promise.resolve(),
          loadClusterData(poolId),
        ]);
      } else {
        setFiles(prevFiles);
        setTrashedFiles(prevTrashed);
        pushToast({
          variant: 'error',
          message: result.error || 'Failed to move file to trash',
          action: { label: 'Retry', onClick: () => void handleTrash(file) },
        });
      }
    },
    [markTrashStale, undoTrashFiles, loadFiles, loadTrashFiles, loadClusterData]
  );

  const handleRestoreFile = useCallback(
    async (file: ClientFileRecord) => {
      const poolId = activePoolIdRef.current;
      const prevTrashed = trashedFilesRef.current;
      const prevFiles = filesRef.current;
      setTrashedFiles((prev) => prev.filter((f) => f.id !== file.id));
      setFiles((prev) => [...prev, { ...file, isTrashed: false }]);

      const result = await restoreFileRequest(file);
      if (result.ok) {
        pushToast({ variant: 'success', message: `Restored "${file.name}".` });
        await Promise.all([
          currentNavRef.current === 'trash' ? loadTrashFiles(poolId) : Promise.resolve(),
          loadFiles(currentPathRef.current, poolId),
          loadClusterData(poolId),
        ]);
      } else {
        setTrashedFiles(prevTrashed);
        setFiles(prevFiles);
        pushToast({
          variant: 'error',
          message: result.error || 'Restore failed',
          action: { label: 'Retry', onClick: () => void handleRestoreFile(file) },
        });
      }
    },
    [loadTrashFiles, loadFiles, loadClusterData]
  );

  const handlePermanentDelete = useCallback(
    async (file: ClientFileRecord) => {
      const poolId = activePoolIdRef.current;
      const prevTrashed = trashedFilesRef.current;
      const prevSelected = selectedIds;
      setTrashedFiles((prev) => prev.filter((f) => f.id !== file.id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(file.id);
        return next;
      });

      const result = await permanentDeleteFileRequest(file);
      if (result.ok) {
        pushToast({ variant: 'success', message: `Permanently deleted "${file.name}".` });
        await Promise.all([
          currentNavRef.current === 'trash' ? loadTrashFiles(poolId) : Promise.resolve(),
          loadClusterData(poolId),
        ]);
      } else {
        setTrashedFiles(prevTrashed);
        setSelectedIds(prevSelected);
        pushToast({
          variant: 'error',
          message: result.error || 'Delete failed',
          action: { label: 'Retry', onClick: () => void handlePermanentDelete(file) },
        });
      }
    },
    [selectedIds, loadTrashFiles, loadClusterData]
  );

  const handleDeleteFolder = useCallback(
    async (folder: ClientFolder) => {
      const poolId = activePoolIdRef.current;
      const prevFolders = foldersRef.current;
      const prevFiles = filesRef.current;
      const prevSelected = selectedIds;

      const folderPrefix = folder.virtualPath === '/' ? '/' : `${folder.virtualPath}/`;
      setFolders((prev) =>
        prev.filter((f) => f.id !== folder.id && !f.virtualPath.startsWith(folderPrefix))
      );
      setFiles((prev) =>
        prev.filter((f) => !f.virtualPath.startsWith(folderPrefix))
      );
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(folder.id);
        return next;
      });

      const result = await deleteFolderRequest(folder);
      if (result.ok) {
        pushToast({ variant: 'success', message: `Deleted folder "${folder.name}".` });
        if (result.navigateParent !== undefined) {
          handleNavigate(result.navigateParent);
          await loadFiles(result.navigateParent, poolId);
        } else {
          await loadFiles(currentPathRef.current, poolId);
        }
      } else {
        setFolders(prevFolders);
        setFiles(prevFiles);
        setSelectedIds(prevSelected);
        pushToast({
          variant: 'error',
          message: result.error || 'Failed to delete folder',
          action: { label: 'Retry', onClick: () => void handleDeleteFolder(folder) },
        });
      }
    },
    [selectedIds, handleNavigate, loadFiles]
  );

  const executeDeleteBatch = useCallback(
    async (
      navMode: 'files' | 'trash',
      selectedFolders: ClientFolder[],
      selectedFilesList: ClientFileRecord[]
    ) => {
      const poolId = activePoolIdRef.current;
      const prevFiles = filesRef.current;
      const prevFolders = foldersRef.current;
      const prevTrashed = trashedFilesRef.current;
      const prevSelected = selectedIds;

      const folderIds = new Set(selectedFolders.map((f) => f.id));
      const fileIds = new Set(selectedFilesList.map((f) => f.id));
      setSelectedIds(new Set());

      if (navMode === 'trash') {
        setTrashedFiles((prev) => prev.filter((f) => !fileIds.has(f.id)));
      } else {
        setFolders((prev) => prev.filter((f) => !folderIds.has(f.id)));
        setFiles((prev) => prev.filter((f) => !fileIds.has(f.id)));
        markTrashStale(poolId);
      }

      await runPendingOp(async () => {
        if (navMode === 'trash') {
          const results = await runWithConcurrency(selectedFilesList, 6, (f) =>
            permanentDeleteFileRequest(f)
          );
          const deletedCount = results.filter((r) => r.ok).length;
          const failed = results.filter((r) => !r.ok);
          if (failed.length > 0) {
            setTrashedFiles(prevTrashed);
            setSelectedIds(prevSelected);
            pushToast({
              variant: 'error',
              message: failed[0].error || 'Some files could not be permanently deleted',
              action: {
                label: 'Retry',
                onClick: () => void executeDeleteBatch(navMode, selectedFolders, selectedFilesList),
              },
            });
          } else if (deletedCount > 0) {
            pushToast({
              variant: 'success',
              message: `Permanently deleted ${deletedCount} ${deletedCount === 1 ? 'file' : 'files'}.`,
            });
          }
          await Promise.all([loadTrashFiles(poolId), loadClusterData(poolId)]);
        } else {
          let nextPath = currentPathRef.current;
          const folderResults = await runWithConcurrency(selectedFolders, 6, (folder) =>
            deleteFolderRequest(folder)
          );
          const fileResults = await runWithConcurrency(selectedFilesList, 6, (file) =>
            trashFileRequest(file)
          );

          let deletedFolders = 0;
          for (const res of folderResults) {
            if (res.ok) {
              deletedFolders++;
              if (res.navigateParent !== undefined) {
                nextPath = res.navigateParent;
              }
            }
          }
          const trashedSucceededFiles = selectedFilesList.filter((_, idx) => fileResults[idx]?.ok);
          const failedFolder = folderResults.find((r) => !r.ok);
          const failedFile = fileResults.find((r) => !r.ok);

          if (failedFolder || failedFile) {
            setFiles(prevFiles);
            setFolders(prevFolders);
            setSelectedIds(prevSelected);
            pushToast({
              variant: 'error',
              message: failedFolder?.error || failedFile?.error || 'Some items could not be deleted',
              action: {
                label: 'Retry',
                onClick: () => void executeDeleteBatch(navMode, selectedFolders, selectedFilesList),
              },
            });
          } else {
            if (nextPath !== currentPathRef.current) {
              handleNavigate(nextPath);
            }
            const totalDone = deletedFolders + trashedSucceededFiles.length;
            if (totalDone > 0) {
              pushToast({
                variant: 'success',
                message: `Deleted ${totalDone} ${totalDone === 1 ? 'item' : 'items'}.`,
                action:
                  trashedSucceededFiles.length > 0
                    ? { label: 'Undo', onClick: () => void undoTrashFiles(trashedSucceededFiles) }
                    : undefined,
              });
            }
          }
          await Promise.all([loadFiles(nextPath, poolId), loadClusterData(poolId)]);
        }
      });
    },
    [selectedIds, markTrashStale, runPendingOp, loadTrashFiles, loadClusterData, handleNavigate, undoTrashFiles, loadFiles]
  );

  const handleDeleteSelected = useCallback(async () => {
    const idsToDelete = new Set(Array.from(selectedIds).filter((id) => id !== '__parent__'));
    if (idsToDelete.size === 0) return;

    const navMode = currentNavRef.current;
    const selectedFolders = foldersRef.current.filter((f) => idsToDelete.has(f.id));
    const selectedFilesList = (navMode === 'trash' ? trashedFilesRef.current : filesRef.current).filter(
      (f) => idsToDelete.has(f.id)
    );
    await executeDeleteBatch(navMode, selectedFolders, selectedFilesList);
  }, [selectedIds, executeDeleteBatch]);

  const handleMoveItems = useCallback(
    async (itemsToMove: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string) => {
      if (isSharePoolActive || itemsToMove.length === 0) return;
      const poolId = activePoolIdRef.current;
      const prevFiles = filesRef.current;
      const prevFolders = foldersRef.current;
      const prevClipboard = clipboard;
      const prevSelected = selectedIds;

      const movedIds = new Set(itemsToMove.map((i) => i.id));
      const undoMap = new Map<string, Array<{ kind: 'file' | 'folder'; id: string }>>();
      for (const item of itemsToMove) {
        const record =
          item.kind === 'folder'
            ? prevFolders.find((f) => f.id === item.id)
            : prevFiles.find((f) => f.id === item.id);
        if (record) {
          const origParent = getParentFolderPath(record.virtualPath);
          if (origParent !== targetFolderPath) {
            const list = undoMap.get(origParent) ?? [];
            list.push(item);
            undoMap.set(origParent, list);
          }
        }
      }
      const undoGroups = Array.from(undoMap.entries()).map(([origPath, items]) => ({
        targetFolderPath: origPath,
        items,
      }));

      const destPrefix = targetFolderPath === '/' ? '' : targetFolderPath;
      setFiles((prev) =>
        prev.map((f) => (movedIds.has(f.id) ? { ...f, virtualPath: `${destPrefix}/${f.name}` } : f))
      );
      setFolders((prev) =>
        prev.map((f) => (movedIds.has(f.id) ? { ...f, virtualPath: `${destPrefix}/${f.name}` } : f))
      );
      setClipboard((prev) => {
        if (!prev || prev.mode !== 'cut') return prev;
        const remaining = prev.items.filter((i) => !movedIds.has(i.id));
        return remaining.length > 0 ? { ...prev, items: remaining } : null;
      });
      setSelectedIds(new Set());

      await runPendingOp(async () => {
        try {
          const res = await client.api.items.move.$post({
            json: { items: itemsToMove, targetFolderPath, poolId },
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            const results = 'results' in data && Array.isArray(data.results) ? data.results : [];
            const successCount = results.filter((r: any) => r.success).length;
            const failed = results.filter((r: any) => !r.success);
            if (failed.length > 0) {
              setFiles(prevFiles);
              setFolders(prevFolders);
              setClipboard(prevClipboard);
              setSelectedIds(prevSelected);
              pushToast({
                variant: 'error',
                message: failed[0].error || 'Some items could not be moved',
                action: { label: 'Retry', onClick: () => void handleMoveItems(itemsToMove, targetFolderPath) },
              });
            } else if (successCount > 0) {
              pushToast({
                variant: 'success',
                message: `Moved ${successCount} ${successCount === 1 ? 'item' : 'items'} to ${targetFolderPath}.`,
                action:
                  undoGroups.length > 0
                    ? { label: 'Undo', onClick: () => void undoMoveItems(undoGroups) }
                    : undefined,
              });
            }
            if (currentNavRef.current === 'trash') {
              await Promise.all([loadFiles(currentPathRef.current, poolId), loadTrashFiles(poolId), loadClusterData(poolId)]);
            } else {
              markTrashStale(poolId);
              await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
            }
          } else {
            setFiles(prevFiles);
            setFolders(prevFolders);
            setClipboard(prevClipboard);
            setSelectedIds(prevSelected);
            pushToast({
              variant: 'error',
              message: ('error' in data ? (data.error as string) : null) || 'Failed to move items',
              action: { label: 'Retry', onClick: () => void handleMoveItems(itemsToMove, targetFolderPath) },
            });
          }
        } catch (err) {
          setFiles(prevFiles);
          setFolders(prevFolders);
          setClipboard(prevClipboard);
          setSelectedIds(prevSelected);
          pushToast({
            variant: 'error',
            message: err instanceof Error ? err.message : String(err),
            action: { label: 'Retry', onClick: () => void handleMoveItems(itemsToMove, targetFolderPath) },
          });
        }
      });
    },
    [
      isSharePoolActive,
      clipboard,
      selectedIds,
      runPendingOp,
      undoMoveItems,
      loadFiles,
      loadTrashFiles,
      loadClusterData,
      markTrashStale,
    ]
  );

  const handleTrashItems = useCallback(
    async (
      itemsToTrash: Array<{
        kind: 'file' | 'folder';
        id: string;
        name?: string;
        virtualPath?: string;
        isTrashed?: boolean;
      }>
    ) => {
      const activeItems = itemsToTrash.filter((item) => !item.isTrashed);
      if (activeItems.length === 0) return;

      const poolId = activePoolIdRef.current;
      const prevFiles = filesRef.current;
      const prevFolders = foldersRef.current;
      const prevSelected = selectedIds;
      const prevClipboard = clipboard;

      const trashedFolders = activeItems.filter((i) => i.kind === 'folder');
      const trashedFilesList = activeItems.filter((i) => i.kind === 'file');
      const activeIds = new Set(activeItems.map((i) => i.id));

      setFiles((prev) => prev.filter((f) => !activeIds.has(f.id)));
      setFolders((prev) => prev.filter((f) => !activeIds.has(f.id)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of activeIds) next.delete(id);
        return next;
      });
      setClipboard((prev) => {
        if (!prev || prev.mode !== 'cut') return prev;
        const remaining = prev.items.filter((i) => !activeIds.has(i.id));
        return remaining.length > 0 ? { ...prev, items: remaining } : null;
      });

      let effectivePath = currentPathRef.current;

      await runPendingOp(async () => {
        try {
          const folderResults = await runWithConcurrency(trashedFolders, 6, async (folder) => {
            const fPath = folder.virtualPath || folder.id;
            const res = await client.api.folders.$delete({
              query: { virtualPath: fPath, poolId: String(poolId) },
            });
            return { ok: res.ok, folder, fPath };
          });

          const fileResults = await runWithConcurrency(trashedFilesList, 6, async (file) => {
            const res = await client.api.files[':id'].trash.$post({
              param: { id: file.id },
            });
            return { ok: res.ok, file };
          });

          const trashedIds = new Set<string>();
          for (const fr of folderResults) {
            if (fr.ok) {
              trashedIds.add(fr.folder.id);
              if (
                fr.fPath &&
                (effectivePath === fr.fPath || effectivePath.startsWith(fr.fPath + '/'))
              ) {
                const parts = fr.fPath.split('/').filter(Boolean);
                effectivePath = parts.length <= 1 ? '/' : '/' + parts.slice(0, -1).join('/');
              }
            }
          }
          const succeededFileRecords: ClientFileRecord[] = [];
          for (const fr of fileResults) {
            if (fr.ok) {
              trashedIds.add(fr.file.id);
              const fullRecord = prevFiles.find((f) => f.id === fr.file.id);
              if (fullRecord) succeededFileRecords.push(fullRecord);
            }
          }

          if (trashedIds.size < activeItems.length) {
            setFiles(prevFiles);
            setFolders(prevFolders);
            setSelectedIds(prevSelected);
            setClipboard(prevClipboard);
            pushToast({
              variant: 'error',
              message: 'Some items could not be moved to trash',
              action: { label: 'Retry', onClick: () => void handleTrashItems(itemsToTrash) },
            });
          } else if (trashedIds.size > 0) {
            if (effectivePath !== currentPathRef.current) {
              handleNavigate(effectivePath);
            }
            const undoAction =
              succeededFileRecords.length > 0
                ? { label: 'Undo', onClick: () => void undoTrashFiles(succeededFileRecords) }
                : undefined;

            if (trashedIds.size === 1) {
              const single = activeItems.find((i) => trashedIds.has(i.id));
              const singleName =
                single?.name || (single?.virtualPath ? single.virtualPath.split('/').pop() : 'item');
              pushToast({
                variant: 'success',
                message: `Moved "${singleName}" to trash.`,
                action: undoAction,
              });
            } else {
              pushToast({
                variant: 'success',
                message: `Moved ${trashedIds.size} items to trash.`,
                action: undoAction,
              });
            }
          }

          if (currentNavRef.current === 'trash') {
            await Promise.all([loadFiles(effectivePath, poolId), loadTrashFiles(poolId), loadClusterData(poolId)]);
          } else {
            markTrashStale(poolId);
            await Promise.all([loadFiles(effectivePath, poolId), loadClusterData(poolId)]);
          }
        } catch (err) {
          setFiles(prevFiles);
          setFolders(prevFolders);
          setSelectedIds(prevSelected);
          setClipboard(prevClipboard);
          pushToast({
            variant: 'error',
            message: err instanceof Error ? err.message : String(err),
            action: { label: 'Retry', onClick: () => void handleTrashItems(itemsToTrash) },
          });
        }
      });
    },
    [
      selectedIds,
      clipboard,
      runPendingOp,
      handleNavigate,
      undoTrashFiles,
      loadFiles,
      loadTrashFiles,
      loadClusterData,
      markTrashStale,
    ]
  );

  const handleCopyItems = useCallback(
    async (itemsToCopy: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string) => {
      if (itemsToCopy.length === 0) return;
      const poolId = activePoolIdRef.current;
      await runPendingOp(async () => {
        try {
          pushToast({
            variant: 'info',
            message: `Copying ${itemsToCopy.length} ${itemsToCopy.length === 1 ? 'item' : 'items'}...`,
          });
          const res = await client.api.items.copy.$post({
            json: { items: itemsToCopy, targetFolderPath, poolId },
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            const results = 'results' in data && Array.isArray(data.results) ? data.results : [];
            const successCount = results.filter((r: any) => r.success).length;
            const failed = results.filter((r: any) => !r.success);
            if (failed.length > 0) {
              pushToast({ variant: 'error', message: failed[0].error || 'Some items could not be copied' });
            }
            if (successCount > 0) {
              pushToast({
                variant: 'success',
                message: `Copied ${successCount} ${successCount === 1 ? 'item' : 'items'} to ${targetFolderPath}.`,
              });
            }
            setSelectedIds(new Set());
            await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
          } else {
            pushToast({
              variant: 'error',
              message: ('error' in data ? (data.error as string) : null) || 'Failed to copy items',
            });
          }
        } catch (err) {
          pushToast({
            variant: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    },
    [loadFiles, loadClusterData, runPendingOp]
  );

  const handleCutSelected = useCallback(() => {
    if (isSharePoolActive) return;
    const actionableIds = Array.from(selectedIds).filter((id) => id !== '__parent__');
    if (actionableIds.length === 0 || currentNav === 'trash') return;
    const selectedFolders = folders.filter((f) => actionableIds.includes(f.id));
    const selectedFilesList = files.filter((f) => actionableIds.includes(f.id) && !f.isTrashed);
    const items = [
      ...selectedFolders.map((f) => ({ kind: 'folder' as const, id: f.id, name: f.name, virtualPath: f.virtualPath })),
      ...selectedFilesList.map((f) => ({ kind: 'file' as const, id: f.id, name: f.name, virtualPath: f.virtualPath })),
    ];
    if (items.length > 0) {
      setClipboard({ mode: 'cut', items });
      pushToast({
        variant: 'info',
        message: `Cut ${items.length} ${items.length === 1 ? 'item' : 'items'}. Press Ctrl+V or Paste to move here.`,
      });
    }
  }, [isSharePoolActive, selectedIds, currentNav, folders, files]);

  const handleCopySelected = useCallback(() => {
    if (isSharePoolActive) return;
    const actionableIds = Array.from(selectedIds).filter((id) => id !== '__parent__');
    if (actionableIds.length === 0 || currentNav === 'trash') return;
    const selectedFolders = folders.filter((f) => actionableIds.includes(f.id));
    const selectedFilesList = files.filter((f) => actionableIds.includes(f.id) && !f.isTrashed);
    const items = [
      ...selectedFolders.map((f) => ({ kind: 'folder' as const, id: f.id, name: f.name, virtualPath: f.virtualPath })),
      ...selectedFilesList.map((f) => ({ kind: 'file' as const, id: f.id, name: f.name, virtualPath: f.virtualPath })),
    ];
    if (items.length > 0) {
      setClipboard({ mode: 'copy', items });
      pushToast({
        variant: 'info',
        message: `Copied ${items.length} ${items.length === 1 ? 'item' : 'items'}. Press Ctrl+V or Paste to duplicate.`,
      });
    }
  }, [isSharePoolActive, selectedIds, currentNav, folders, files]);

  const handlePaste = useCallback(() => {
    if (isSharePoolActive) return;
    if (!clipboard || clipboard.items.length === 0 || currentNav === 'trash') return;
    if (clipboard.mode === 'cut') {
      void handleMoveItems(clipboard.items, currentPath);
    } else {
      void handleCopyItems(clipboard.items, currentPath);
    }
  }, [isSharePoolActive, clipboard, currentNav, currentPath, handleMoveItems, handleCopyItems]);

  const handleOpenRenameSelected = useCallback(() => {
    if (isSharePoolActive) return;
    if (selectedIds.size !== 1 || selectedIds.has('__parent__')) return;
    const selectedId = Array.from(selectedIds)[0];
    const foundFolder = folders.find((f) => f.id === selectedId);
    if (foundFolder) {
      setRenameModalItem({ kind: 'folder', id: foundFolder.id, name: foundFolder.name });
      return;
    }
    const allFiles = currentNav === 'trash' ? trashedFiles : files;
    const foundFile = allFiles.find((f) => f.id === selectedId);
    if (foundFile) {
      setRenameModalItem({ kind: 'file', id: foundFile.id, name: foundFile.name });
    }
  }, [isSharePoolActive, selectedIds, currentNav, folders, files, trashedFiles]);

  const handleRename = useCallback(
    async (kind: 'file' | 'folder' | 'pool', id: string, newName: string) => {
      setRenameModalItem(null);
      const poolId = activePoolIdRef.current;

      if (kind === 'pool') {
        const prevPools = poolsRef.current;
        setPools((prev) => prev.map((p) => (p.id === Number(id) ? { ...p, name: newName } : p)));
        try {
          const res = await client.api.pools[':id'].$patch({
            param: { id },
            json: { name: newName },
          });
          if (res.ok) {
            pushToast({ variant: 'success', message: `Renamed pool to "${newName}".` });
            await loadClusterData(poolId);
          } else {
            setPools(prevPools);
            const err = (await res.json().catch(() => ({}))) as { error?: string };
            const errMsg = err.error || 'Failed to rename pool';
            pushToast({
              variant: 'error',
              message: errMsg,
              action: { label: 'Retry', onClick: () => void handleRename(kind, id, newName) },
            });
          }
        } catch (err) {
          setPools(prevPools);
          pushToast({
            variant: 'error',
            message: err instanceof Error ? err.message : String(err),
            action: { label: 'Retry', onClick: () => void handleRename(kind, id, newName) },
          });
        }
        return;
      }

      const prevFiles = filesRef.current;
      const prevFolders = foldersRef.current;
      const prevTrashed = trashedFilesRef.current;
      const targetPath = currentPathRef.current;

      if (kind === 'file') {
        setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name: newName } : f)));
        setTrashedFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name: newName } : f)));
      } else {
        setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: newName } : f)));
      }

      try {
        const res = await client.api.items.rename.$post({
          json: { kind, id, name: newName, poolId },
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          pushToast({ variant: 'success', message: `Renamed to "${newName}".` });
          const oldFolderP =
            ('oldPath' in data ? (data.oldPath as string) : null) ||
            ('oldVirtualPath' in data ? (data.oldVirtualPath as string) : null);
          const newFolderP =
            ('newPath' in data ? (data.newPath as string) : null) ||
            ('newVirtualPath' in data ? (data.newVirtualPath as string) : null);
          if (
            kind === 'folder' &&
            oldFolderP &&
            (targetPath === oldFolderP || targetPath.startsWith(oldFolderP + '/'))
          ) {
            const relativeSuffix = targetPath.slice(oldFolderP.length);
            const nextPath = `${newFolderP}${relativeSuffix}`;
            handleNavigate(nextPath);
            await loadFiles(nextPath, poolId);
          } else {
            await loadFiles(targetPath, poolId);
          }
        } else {
          setFiles(prevFiles);
          setFolders(prevFolders);
          setTrashedFiles(prevTrashed);
          const errMsg = ('error' in data ? (data.error as string) : null) || 'Failed to rename item';
          pushToast({
            variant: 'error',
            message: errMsg,
            action: { label: 'Retry', onClick: () => void handleRename(kind, id, newName) },
          });
        }
      } catch (err) {
        setFiles(prevFiles);
        setFolders(prevFolders);
        setTrashedFiles(prevTrashed);
        pushToast({
          variant: 'error',
          message: err instanceof Error ? err.message : String(err),
          action: { label: 'Retry', onClick: () => void handleRename(kind, id, newName) },
        });
      }
    },
    [loadFiles, handleNavigate, loadClusterData]
  );

  const executeBatchRestore = useCallback(
    async (toRestore: ClientFileRecord[]) => {
      if (toRestore.length === 0) return;
      const poolId = activePoolIdRef.current;
      const prevTrashed = trashedFilesRef.current;
      const prevFiles = filesRef.current;
      const prevSelected = selectedIds;
      const restoreIds = new Set(toRestore.map((f) => f.id));

      setTrashedFiles((prev) => prev.filter((f) => !restoreIds.has(f.id)));
      setFiles((prev) => [...prev, ...toRestore.map((f) => ({ ...f, isTrashed: false }))]);
      setSelectedIds(new Set());

      await runPendingOp(async () => {
        const results = await runWithConcurrency(toRestore, 6, (file) => restoreFileRequest(file));
        const restoredCount = results.filter((r) => r.ok).length;
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
          setTrashedFiles(prevTrashed);
          setFiles(prevFiles);
          setSelectedIds(prevSelected);
          pushToast({
            variant: 'error',
            message: failed[0].error || 'Some files could not be restored',
            action: { label: 'Retry', onClick: () => void executeBatchRestore(toRestore) },
          });
        } else if (restoredCount > 0) {
          pushToast({
            variant: 'success',
            message: `Restored ${restoredCount} ${restoredCount === 1 ? 'file' : 'files'}.`,
          });
        }
        await Promise.all([
          loadTrashFiles(poolId),
          loadFiles(currentPathRef.current, poolId),
          loadClusterData(poolId),
        ]);
      });
    },
    [selectedIds, runPendingOp, loadTrashFiles, loadFiles, loadClusterData]
  );

  const handleBatchRestore = useCallback(async () => {
    const actionableIds = Array.from(selectedIds).filter((id) => id !== '__parent__');
    if (actionableIds.length === 0 || currentNav !== 'trash') return;
    const toRestore = trashedFiles.filter((f) => actionableIds.includes(f.id));
    await executeBatchRestore(toRestore);
  }, [selectedIds, currentNav, trashedFiles, executeBatchRestore]);

  const keydownStateRef = useRef({
    selectedIds,
    folders,
    files,
    trashedFiles,
    currentNav,
    clipboard,
    currentPath,
    isSharePoolActive,
    activePoolId,
    handleNavigate,
    handleCutSelected,
    handleCopySelected,
    handlePaste,
    handleOpenRenameSelected,
    handleDeleteSelected,
    handleDownload,
  });
  keydownStateRef.current = {
    selectedIds,
    folders,
    files,
    trashedFiles,
    currentNav,
    clipboard,
    currentPath,
    isSharePoolActive,
    activePoolId,
    handleNavigate,
    handleCutSelected,
    handleCopySelected,
    handlePaste,
    handleOpenRenameSelected,
    handleDeleteSelected,
    handleDownload,
  };

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const activeEl = document.activeElement as HTMLElement | null;
      const interactiveSelector =
        'input, textarea, select, button, a, [contenteditable], [contenteditable="true"], dialog[open], [role="dialog"], [popover]:popover-open';
      const isInteractiveEl = (node: HTMLElement | null) =>
        Boolean(node && (node.closest(interactiveSelector) !== null || node.isContentEditable));
      if (isInteractiveEl(target) || isInteractiveEl(activeEl)) {
        return;
      }
      if (document.querySelector('dialog[open], [role="dialog"]')) {
        return;
      }

      const state = keydownStateRef.current;

      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        window.history.back();
        return;
      }

      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        window.history.forward();
        return;
      }

      if (e.key === 'Escape') {
        if (state.selectedIds.size > 0) {
          e.preventDefault();
          setSelectedIds(new Set());
        }
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIds.size > 0) {
        if (state.selectedIds.size === 1 && state.selectedIds.has('__parent__')) {
          return;
        }
        e.preventDefault();
        void state.handleDeleteSelected();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
        if (
          !state.isSharePoolActive &&
          state.selectedIds.size > 0 &&
          !state.selectedIds.has('__parent__') &&
          state.currentNav !== 'trash'
        ) {
          e.preventDefault();
          state.handleCutSelected();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (
          !state.isSharePoolActive &&
          state.selectedIds.size > 0 &&
          !state.selectedIds.has('__parent__') &&
          state.currentNav !== 'trash'
        ) {
          e.preventDefault();
          state.handleCopySelected();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        if (
          !state.isSharePoolActive &&
          state.clipboard &&
          state.clipboard.items.length > 0 &&
          state.currentNav !== 'trash'
        ) {
          e.preventDefault();
          state.handlePaste();
        }
        return;
      }

      if (e.key === 'F2') {
        if (
          !state.isSharePoolActive &&
          state.selectedIds.size === 1 &&
          !state.selectedIds.has('__parent__')
        ) {
          e.preventDefault();
          state.handleOpenRenameSelected();
        }
        return;
      }

      if (e.key === 'Enter') {
        if (state.selectedIds.size === 1 && state.currentNav !== 'trash') {
          const singleId = Array.from(state.selectedIds)[0];
          if (singleId === '__parent__') {
            e.preventDefault();
            const parts = state.currentPath.split('/').filter(Boolean);
            const parent = parts.length <= 1 ? '/' : '/' + parts.slice(0, -1).join('/');
            state.handleNavigate(parent);
            return;
          }
          const foundFolder = state.folders.find((f) => f.id === singleId);
          if (foundFolder) {
            e.preventDefault();
            state.handleNavigate(foundFolder.virtualPath);
            return;
          }
          const foundFile = state.files.find((f) => f.id === singleId && !f.isTrashed);
          if (foundFile) {
            e.preventDefault();
            state.handleDownload(foundFile);
            return;
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleEmptyTrashExecute = useCallback(async () => {
    setConfirmEmptyTrash(false);
    const poolId = activePoolIdRef.current;
    const prevTrashed = trashedFilesRef.current;
    const prevSelected = selectedIds;
    setTrashedFiles([]);
    setSelectedIds(new Set());

    await runPendingOp(async () => {
      try {
        const res = await client.api.trash.empty.$delete({
          query: { poolId: String(poolId) },
        });
        if (res.ok) {
          pushToast({ variant: 'success', message: 'Trash emptied. Storage permanently reclaimed.' });
          trashStaleRef.current = false;
          await Promise.all([loadTrashFiles(poolId), loadClusterData(poolId)]);
        } else {
          setTrashedFiles(prevTrashed);
          setSelectedIds(prevSelected);
          const err = await res.json().catch(() => ({}));
          pushToast({
            variant: 'error',
            message: ('error' in err ? (err.error as string) : null) || 'Empty trash failed',
            action: { label: 'Retry', onClick: () => void handleEmptyTrashExecute() },
          });
        }
      } catch (err) {
        setTrashedFiles(prevTrashed);
        setSelectedIds(prevSelected);
        pushToast({
          variant: 'error',
          message: `Empty trash error: ${err instanceof Error ? err.message : String(err)}`,
          action: { label: 'Retry', onClick: () => void handleEmptyTrashExecute() },
        });
      }
    });
  }, [selectedIds, runPendingOp, loadTrashFiles, loadClusterData]);

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

  // Aggregate account list merging discovered with storage overview
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
      // 1. OAuth accounts that are not authorized yet
      if (!a.authorized && b.authorized) return -1;
      if (a.authorized && !b.authorized) return 1;

      // Both are unauthorized (imported / pending auth):
      // Put the newest imported account at the very top
      if (!a.authorized && !b.authorized) {
        const mtimeA = a.mtimeMs ?? 0;
        const mtimeB = b.mtimeMs ?? 0;
        if (mtimeA !== mtimeB) {
          return mtimeB - mtimeA;
        }
        return a.id.localeCompare(b.id, undefined, { sensitivity: 'base' });
      }

      // 2. Accounts that have changes and should be pinned to the top:
      // Active accounts with any changes (external files or auto-rebalance),
      // OR disabled accounts that have detected external modifications.
      // If a disabled account has no external changes apart from "Auto-rebalance files", it is not pinned.
      const aIsPinned = Boolean(a.hasPendingChanges) && (!a.isDisabled || Boolean(a.hasDiscrepancy));
      const bIsPinned = Boolean(b.hasPendingChanges) && (!b.isDisabled || Boolean(b.hasDiscrepancy));
      if (aIsPinned && !bIsPinned) return -1;
      if (!aIsPinned && bIsPinned) return 1;

      // 3. Normal accounts (and among accounts with changes):
      // Alphabetical strictly based on Gmail address (email), fallback to id
      const emailA = (a.email || a.id).toLowerCase();
      const emailB = (b.email || b.id).toLowerCase();
      return emailA.localeCompare(emailB, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [discovered, storage, pendingDiscrepancies, activePoolId, accountFileCountMap]);

  const accountItemsRef = useRef(accountItems);
  accountItemsRef.current = accountItems;

  const handleTransferFile = useCallback(
    async (fileId: string, targetAccountId: string) => {
      if (isSharePoolActive) return;
      const poolId = activePoolIdRef.current;
      const file = filesRef.current.find((f) => f.id === fileId);
      const targetAcc = accountItemsRef.current.find((a) => a.id === targetAccountId);
      const targetName = targetAcc?.displayName || targetAccountId;
      setTransferringFileId(fileId);
      try {
        const res = await client.api.sync.rebalance.file.$post({
          json: { fileId, targetAccountId },
        });
        if (res.ok) {
          pushToast({
            variant: 'success',
            message: `Transferred "${file?.name || fileId}" to ${targetName}.`,
          });
          await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
        } else {
          const err = await res.json().catch(() => ({}));
          pushToast({
            variant: 'error',
            message: ('error' in err ? (err.error as string) : null) || 'Failed to transfer file',
          });
        }
      } catch (err) {
        pushToast({
          variant: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setTransferringFileId(null);
      }
    },
    [isSharePoolActive, loadFiles, loadClusterData]
  );

  const handleTransferBatch = useCallback(
    async (fileIds: string[], targetAccountId: string) => {
      if (isSharePoolActive) return;
      setMoveFilesModalGroup(null);
      const poolId = activePoolIdRef.current;
      const targetAcc = accountItemsRef.current.find((a) => a.id === targetAccountId);
      const targetName = targetAcc?.displayName || targetAccountId;
      const prevFiles = filesRef.current;
      const idSet = new Set(fileIds);

      setFiles((prev) =>
        prev.map((f) => (idSet.has(f.id) ? { ...f, accountId: targetAccountId } : f))
      );

      await runPendingOp(async () => {
        try {
          const res = await client.api.sync.rebalance.batch.$post({
            json: { fileIds, targetAccountId },
          });
          if (res.ok) {
            pushToast({
              variant: 'success',
              message: `Transferred ${fileIds.length} file${fileIds.length === 1 ? '' : 's'} to ${targetName}.`,
            });
          } else {
            setFiles(prevFiles);
            const err = await res.json().catch(() => ({}));
            const errorMsg =
              ('error' in err ? (err.error as string) : null) || 'Failed to transfer files';
            pushToast({
              variant: 'error',
              message: errorMsg,
              action: { label: 'Retry', onClick: () => void handleTransferBatch(fileIds, targetAccountId) },
            });
          }
        } catch (err) {
          setFiles(prevFiles);
          const msg = err instanceof Error ? err.message : String(err);
          pushToast({
            variant: 'error',
            message: msg,
            action: { label: 'Retry', onClick: () => void handleTransferBatch(fileIds, targetAccountId) },
          });
        } finally {
          await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
        }
      });
    },
    [isSharePoolActive, runPendingOp, loadFiles, loadClusterData]
  );

  const handleDisableAccount = useCallback(
    async (accountId: string) => {
      try {
        const res = await client.api.accounts[':id'].disable.$post({
          param: { id: accountId },
        });
        if (res.ok) {
          pushToast({ variant: 'success', message: 'Drive disabled. Excluded from storage pool.' });
          await loadClusterData();
        } else {
          const err = await res.json().catch(() => ({}));
          pushToast({
            variant: 'error',
            message: ('error' in err ? (err.error as string) : null) || 'Failed to disable drive',
          });
        }
      } catch (err) {
        pushToast({
          variant: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [loadClusterData]
  );

  const handleEnableAccount = useCallback(
    async (accountId: string) => {
      try {
        const res = await client.api.accounts[':id'].enable.$post({
          param: { id: accountId },
        });
        if (res.ok) {
          pushToast({ variant: 'success', message: 'Drive re-enabled in storage pool.' });
          await loadClusterData();
        } else {
          const err = await res.json().catch(() => ({}));
          pushToast({
            variant: 'error',
            message: ('error' in err ? (err.error as string) : null) || 'Failed to enable drive',
          });
        }
      } catch (err) {
        pushToast({
          variant: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [loadClusterData]
  );

  const handleOpenDriveAction = useCallback((account: AccountItem, action: 'remove') => {
    setDriveActionModal({
      isOpen: true,
      action,
      account,
      isLoading: false,
      errorMessage: null,
    });
  }, []);

  async function handleExecuteDriveAction() {
    const { account } = driveActionModal;
    if (!account) return;

    setDriveActionModal((prev) => ({ ...prev, isLoading: true, errorMessage: null }));

    try {
      const res = await client.api.accounts[':id'].$delete({
        param: { id: account.id },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setDriveActionModal((prev) => ({ ...prev, isOpen: false, isLoading: false }));
        const filesMoved = ('filesMoved' in data ? (data.filesMoved as number) : 0) ?? 0;
        pushToast({
          variant: 'success',
          message: `Drive removed. Evacuated ${filesMoved} ${filesMoved === 1 ? 'file' : 'files'}.`,
        });
        await Promise.all([loadClusterData(), loadFiles(currentPathRef.current)]);
      } else {
        setDriveActionModal((prev) => ({
          ...prev,
          isLoading: false,
          errorMessage: ('error' in data ? (data.error as string) : null) || 'Failed to remove drive',
        }));
      }
    } catch (err) {
      setDriveActionModal((prev) => ({
        ...prev,
        isLoading: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const driveFiles = files.filter((f) => f.accountId === driveActionModal.account?.id);
  const driveFilesCount = driveFiles.length;
  const driveTotalBytes = driveFiles.reduce((sum, f) => sum + (f.sizeBytes || 0), 0);

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

  const handleCreatePool = useCallback(async () => {
    await runPendingOp(async () => {
      try {
        const res = await client.api.pools.$post({ json: { name: undefined } });
        if (res.ok) {
          const created = await res.json();
          pushToast({ variant: 'success', message: `Created "${created.name}".` });
          setPools((prev) => [...prev, created]);
          skipNextPoolEffectRef.current = created.id;
          handleSelectPool(created.id);
          await Promise.all([loadClusterData(created.id), loadFiles('/', created.id)]);
        } else {
          const err = await res.json().catch(() => ({}));
          pushToast({
            variant: 'error',
            message: ('error' in err ? (err.error as string) : null) || 'Failed to create pool',
          });
        }
      } catch (err) {
        pushToast({
          variant: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }, [handleSelectPool, loadClusterData, loadFiles, runPendingOp]);

  const handleDeletePool = useCallback(
    async (pool: PoolSummary) => {
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
            pushToast({ variant: 'success', message: `Deleted pool "${pool.name}".` });
            setPools((prev) => prev.filter((p) => p.id !== pool.id));
            skipNextPoolEffectRef.current = targetPool.id;
            handleSelectPool(targetPool.id);
            await Promise.all([loadClusterData(targetPool.id), loadFiles('/', targetPool.id)]);
          } else {
            const err = (await res.json().catch(() => ({}))) as { error?: string };
            pushToast({ variant: 'error', message: err.error || 'Failed to delete pool' });
          }
        } catch (err) {
          pushToast({
            variant: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    },
    [handleSelectPool, loadClusterData, loadFiles, runPendingOp]
  );

  const handleSwitchAccountPool = useCallback(
    async (accountId: string, targetPoolId: number) => {
      setMovePoolTargetAccount(null);
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
            const targetPool = poolsRef.current.find((p) => p.id === targetPoolId);
            pushToast({
              variant: 'success',
              message: `Moved "${accountId}" to ${targetPool?.name || 'Pool ' + targetPoolId}.`,
            });
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
            setDiscovered(prevDiscovered);
            setStorage(prevStorage);
            const err = (await res.json().catch(() => ({}))) as { error?: string };
            const errMsg = err.error || 'Cannot switch account pool';
            pushToast({
              variant: 'error',
              message: errMsg,
              action: {
                label: 'Retry',
                onClick: () => void handleSwitchAccountPool(accountId, targetPoolId),
              },
            });
          }
        } catch (err) {
          setDiscovered(prevDiscovered);
          setStorage(prevStorage);
          pushToast({
            variant: 'error',
            message: err instanceof Error ? err.message : String(err),
            action: {
              label: 'Retry',
              onClick: () => void handleSwitchAccountPool(accountId, targetPoolId),
            },
          });
        }
      });
    },
    [loadClusterData, loadFiles, loadTrashFiles, markTrashStale, runPendingOp]
  );

  const handleShareSelected = useCallback(() => {
    if (isSharePoolActive || currentNav === 'trash') return;
    const actionableIds = new Set(Array.from(selectedIds).filter((id) => id !== '__parent__'));
    if (actionableIds.size === 0) return;

    const selectedFoldersList = folders.filter((f) => actionableIds.has(f.id));
    const selectedFilesList = files.filter((f) => actionableIds.has(f.id) && !f.isTrashed);
    const items: ShareTargetItem[] = [
      ...selectedFoldersList.map((f) => ({
        kind: 'folder' as const,
        id: f.id,
        name: f.name,
        virtualPath: f.virtualPath,
      })),
      ...selectedFilesList.map((f) => ({
        kind: 'file' as const,
        id: f.id,
        name: f.name,
        virtualPath: f.virtualPath,
      })),
    ];
    if (items.length > 0) {
      setShareModalState({ items, sourcePoolId: activePoolId });
    }
  }, [isSharePoolActive, currentNav, selectedIds, folders, files, activePoolId]);

  const handleShareItem = useCallback(
    (item: ShareTargetItem) => {
      if (isSharePoolActive) return;
      setShareModalState({ items: [item], sourcePoolId: activePoolId });
    },
    [isSharePoolActive, activePoolId]
  );

  const handleShareComplete = useCallback(
    async (result: ShareExecuteResult) => {
      clearWorkspaceState();
      const batchPath = '/' + result.batchFolderName;
      skipNextPoolEffectRef.current = result.sharePoolId;
      startTransition(() => {
        setActivePoolId(result.sharePoolId);
        setCurrentNav('files');
      });
      handleNavigate(batchPath);
      await Promise.all([loadClusterData(result.sharePoolId), loadFiles(batchPath, result.sharePoolId)]);
    },
    [clearWorkspaceState, handleNavigate, loadClusterData, loadFiles]
  );

  const handleClearSharePoolConfirm = useCallback(async () => {
    setIsClearSharePoolOpen(false);
    const poolId = activePoolIdRef.current;
    const prevFiles = filesRef.current;
    const prevFolders = foldersRef.current;
    const prevShareLinks = shareLinksByBatchRef.current;
    const prevSelected = selectedIds;

    setFiles([]);
    setFolders([]);
    setShareLinksByBatch({});
    setSelectedIds(new Set());

    await runPendingOp(async () => {
      try {
        const res = await client.api.pools[':id']['clear-share'].$post({
          param: { id: String(poolId) },
        });
        if (res.ok) {
          const nextPath = '/';
          if (currentPathRef.current !== nextPath) {
            handleNavigate(nextPath);
          }
          pushToast({
            variant: 'success',
            message: 'Share Pool cleared. Copied files and folders removed.',
          });
          if (currentNavRef.current === 'trash') {
            await Promise.all([loadFiles(nextPath, poolId), loadTrashFiles(poolId), loadClusterData(poolId)]);
          } else {
            markTrashStale(poolId);
            await Promise.all([loadFiles(nextPath, poolId), loadClusterData(poolId)]);
          }
        } else {
          setFiles(prevFiles);
          setFolders(prevFolders);
          setShareLinksByBatch(prevShareLinks);
          setSelectedIds(prevSelected);
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          const errMsg = err.error || 'Failed to clear Share Pool';
          pushToast({
            variant: 'error',
            message: errMsg,
            action: { label: 'Retry', onClick: () => void handleClearSharePoolConfirm() },
          });
        }
      } catch (err) {
        setFiles(prevFiles);
        setFolders(prevFolders);
        setShareLinksByBatch(prevShareLinks);
        setSelectedIds(prevSelected);
        const errMsg = err instanceof Error ? err.message : String(err);
        pushToast({
          variant: 'error',
          message: errMsg,
          action: { label: 'Retry', onClick: () => void handleClearSharePoolConfirm() },
        });
      }
    });
  }, [selectedIds, handleNavigate, loadFiles, loadTrashFiles, loadClusterData, markTrashStale, runPendingOp]);

  const handleCopyBatchLinks = useCallback(async (batchFolderName: string): Promise<boolean> => {
    const links = shareLinksByBatchRef.current[batchFolderName] ?? [];
    const urls = links.map((l) => l.webViewLink).filter(Boolean);
    if (urls.length === 0) return false;

    const text = urls.join('\n');
    const ok = await copyTextToClipboard(text);
    if (!ok) return false;

    pushToast({
      variant: 'success',
      message:
        urls.length === 1
          ? `Copied share link for ${batchFolderName}.`
          : `Copied ${urls.length} share links for ${batchFolderName}.`,
    });
    return true;
  }, []);

  const isSharePoolDataReady = isSharePoolActive && loadedFilesPoolId === activePoolId;
  const isShareLinksReady = isSharePoolDataReady && shareLinksPoolId === activePoolId;
  const isTableLoading =
    currentNav === 'trash' ? loadedTrashPoolId !== activePoolId : loadedFilesPoolId !== activePoolId;
  const activeBatchFolderName =
    isShareLinksReady && currentNav !== 'trash' && currentPath !== '/'
      ? (currentPath.split('/').filter(Boolean)[0] ?? null)
      : null;
  const activeBatchLinks = activeBatchFolderName ? (shareLinksByBatch[activeBatchFolderName] ?? []) : [];

  const displayedFiles = useMemo(() => {
    if (filteredAccountIds.size === 0) return files;
    return files.filter((f) => filteredAccountIds.has(f.accountId));
  }, [files, filteredAccountIds]);

  const displayedTrashedFiles = useMemo(() => {
    if (filteredAccountIds.size === 0) return trashedFiles;
    return trashedFiles.filter((f) => filteredAccountIds.has(f.accountId));
  }, [trashedFiles, filteredAccountIds]);

  const displayedFolders = useMemo(() => {
    if (filteredAccountIds.size === 0) return folders;

    const validPaths = new Set<string>();
    const validFolderIds = new Set<string>();
    const folderById = new Map<string, ClientFolder>();
    for (const folder of folders) {
      folderById.set(folder.id, folder);
    }

    for (const f of displayedFiles) {
      if (f.isTrashed) continue;
      const vPath = f.virtualPath.startsWith('/') ? f.virtualPath : '/' + f.virtualPath;
      let slashIdx = vPath.indexOf('/', 1);
      while (slashIdx !== -1) {
        validPaths.add(vPath.slice(0, slashIdx));
        slashIdx = vPath.indexOf('/', slashIdx + 1);
      }
      if (f.folderId) {
        let currId: string | null = f.folderId;
        while (currId && folderById.has(currId)) {
          validFolderIds.add(currId);
          currId = folderById.get(currId)?.parentFolderId ?? null;
        }
      }
    }

    return folders.filter((folder) => {
      const canonical = folder.virtualPath === '/'
        ? '/'
        : folder.virtualPath.endsWith('/')
          ? folder.virtualPath.slice(0, -1)
          : folder.virtualPath;
      return validPaths.has(canonical) || validFolderIds.has(folder.id);
    });
  }, [folders, displayedFiles, filteredAccountIds]);

  const visibleSelectableIds = useMemo(() => {
    const validIds = new Set<string>();
    if (currentNav === 'trash') {
      for (const f of displayedTrashedFiles) validIds.add(f.id);
    } else {
      for (const f of displayedFiles) validIds.add(f.id);
      for (const folder of displayedFolders) validIds.add(folder.id);
    }
    return validIds;
  }, [currentNav, displayedTrashedFiles, displayedFiles, displayedFolders]);

  useEffect(() => {
    if (selectedIds.size === 0) return;
    if (currentNav === 'trash') {
      if (loadedTrashPoolId !== activePoolId) return;
    } else if (loadedFilesPoolId !== activePoolId) {
      return;
    }

    let changed = false;
    for (const id of selectedIds) {
      if (id !== '__parent__' && !visibleSelectableIds.has(id)) {
        changed = true;
        break;
      }
    }
    if (!changed) return;

    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (id === '__parent__' || visibleSelectableIds.has(id)) next.add(id);
      }
      return next;
    });
  }, [selectedIds, currentNav, activePoolId, loadedFilesPoolId, loadedTrashPoolId, visibleSelectableIds]);

  const actionableSelectedCount = useMemo(() => {
    if (selectedIds.size === 0) return 0;
    let count = 0;
    for (const id of selectedIds) {
      if (id !== '__parent__' && visibleSelectableIds.has(id)) {
        count += 1;
      }
    }
    return count;
  }, [selectedIds, visibleSelectableIds]);

  const selectedFiles = useMemo(() => {
    const source = currentNav === 'trash' ? displayedTrashedFiles : displayedFiles;
    return source.filter((f) => selectedIds.has(f.id));
  }, [currentNav, displayedTrashedFiles, displayedFiles, selectedIds]);

  const selectedTotalBytes = useMemo(() => {
    return selectedFiles.reduce((acc, f) => acc + (f.sizeBytes || 0), 0);
  }, [selectedFiles]);
  const trashedTotalBytes = displayedTrashedFiles.reduce((acc, f) => acc + (f.sizeBytes || 0), 0);

  const selectedAccountGroups: SelectedAccountGroup[] = useMemo(() => {
    if (currentNav === 'trash') return [];
    const groupsMap = new Map<string, { fileIds: string[]; totalBytes: number }>();
    for (const f of selectedFiles) {
      const existing = groupsMap.get(f.accountId);
      if (existing) {
        existing.fileIds.push(f.id);
        existing.totalBytes += f.sizeBytes || 0;
      } else {
        groupsMap.set(f.accountId, { fileIds: [f.id], totalBytes: f.sizeBytes || 0 });
      }
    }
    return Array.from(groupsMap.entries()).map(([accountId, group]) => {
      const acc = accountItems.find((a) => a.id === accountId);
      return {
        accountId,
        accountName: acc?.displayName || accountId,
        fileIds: group.fileIds,
        totalBytes: group.totalBytes,
      };
    });
  }, [currentNav, selectedFiles, accountItems]);

  const selectedShareBatches: SelectedShareBatch[] = useMemo(() => {
    if (!isShareLinksReady || currentNav === 'trash' || currentPath !== '/') {
      return [];
    }
    const batches: SelectedShareBatch[] = [];
    for (const folder of displayedFolders) {
      if (!selectedIds.has(folder.id)) continue;
      const segments = folder.virtualPath.split('/').filter(Boolean);
      if (segments.length !== 1) continue;
      const batchFolderName = segments[0];
      const links = shareLinksByBatch[batchFolderName] ?? [];
      if (links.length === 0) continue;
      batches.push({
        batchFolderName,
        linksCount: links.length,
      });
    }
    return batches;
  }, [isShareLinksReady, currentNav, currentPath, displayedFolders, selectedIds, shareLinksByBatch]);

  const modalFiles = useMemo(() => {
    if (!moveFilesModalGroup) return [];
    const idsSet = new Set(moveFilesModalGroup.fileIds);
    return selectedFiles.filter((f) => idsSet.has(f.id));
  }, [moveFilesModalGroup, selectedFiles]);

  const handleRenamePoolPrompt = useCallback((pool: PoolSummary) => {
    setRenameModalItem({ kind: 'pool', id: String(pool.id), name: pool.name });
  }, []);

  const handleOpenMovePool = useCallback((acc: AccountItem) => {
    setMovePoolTargetAccount(acc);
  }, []);

  const handleOpenExternalChanges = useCallback((accId?: string) => {
    setExternalChangesAccountId(accId);
    setIsExternalChangesOpen(true);
  }, []);

  const handleDisableAccountItem = useCallback(
    (acc: AccountItem) => {
      void handleDisableAccount(acc.id);
    },
    [handleDisableAccount]
  );

  const handleRemoveAccountItem = useCallback(
    (acc: AccountItem) => {
      handleOpenDriveAction(acc, 'remove');
    },
    [handleOpenDriveAction]
  );

  const handleCloseMobile = useCallback(() => {
    setIsMobileOpen(false);
  }, []);

  const handleToggleMobileMenu = useCallback(() => {
    setIsMobileOpen((o) => !o);
  }, []);

  const handleDropItemsToRoot = useCallback(
    (items: Array<{ kind: 'file' | 'folder'; id: string }>) => {
      void handleMoveItems(items, '/');
    },
    [handleMoveItems]
  );

  const handleDropExternalToRoot = useCallback(
    (dt: DataTransfer) => {
      void handleDropExternalToPath('/', dt);
    },
    [handleDropExternalToPath]
  );

  const handleNavigatePath = useCallback(
    (path: string) => {
      if (currentNavRef.current === 'trash') {
        handleSelectNav('files');
      }
      handleNavigate(path);
    },
    [handleSelectNav, handleNavigate]
  );

  const handleOpenEmptyTrash = useCallback(() => {
    setConfirmEmptyTrash(true);
  }, []);

  const handleOpenMoveFilesModal = useCallback((group: SelectedAccountGroup) => {
    setMoveFilesModalGroup(group);
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleOpenClearSharePool = useCallback(() => {
    setIsClearSharePoolOpen(true);
  }, []);

  const activeBatchFolderNameRef = useRef(activeBatchFolderName);
  activeBatchFolderNameRef.current = activeBatchFolderName;

  const handleCopyActiveShareLinks = useCallback(async () => {
    if (!activeBatchFolderNameRef.current) return false;
    return handleCopyBatchLinks(activeBatchFolderNameRef.current);
  }, [handleCopyBatchLinks]);

  const handleDropFilesToTable = useCallback((droppedFiles: File[]) => {
    if (droppedFiles.length > 0) {
      setStagedFiles(droppedFiles);
      setStagedEmptyFolders([]);
      setIsUploadDrawerOpen(true);
    }
  }, []);

  return (
    <div
      {...stylex.props(
        styles.shell,
        effectiveTheme === 'dark' && darkColors
      )}
      data-theme={effectiveTheme}
    >
      <div className="grain-overlay" />

      <Sidebar
        accounts={accountItems}
        filteredAccountIds={filteredAccountIds}
        onToggleAccountFilter={handleToggleAccountFilter}
        tsubasaUsedBytes={storage?.totalTsubasaUsedBytes ?? storage?.systemStorage?.systemBytesTotal ?? 0}
        poolHeadroomBytes={storage?.totalHeadroomBytes ?? 0}
        totalLimitBytes={storage?.totalLimitBytes ?? 0}
        clusterTransfer={storage?.clusterTransfer}
        pools={pools}
        activePoolId={activePoolId}
        onSelectPool={handleSelectPool}
        onCreatePool={handleCreatePool}
        onRenamePoolPrompt={isSharePoolActive ? undefined : handleRenamePoolPrompt}
        onDeletePoolPrompt={isSharePoolActive ? undefined : handleDeletePool}
        onSwitchAccountPool={handleSwitchAccountPool}
        onOpenMovePool={handleOpenMovePool}
        currentNav={currentNav}
        onSelectNav={handleSelectNav}
        onAuthorizeAccount={handleAuthorizeAccount}
        onRefreshStorage={loadClusterData}
        onOpenExternalChanges={isSharePoolActive ? undefined : handleOpenExternalChanges}
        onImportOAuth={handleImportOAuth}
        onDisableAccount={handleDisableAccountItem}
        onEnableAccount={handleEnableAccount}
        onRemoveAccount={handleRemoveAccountItem}
        isImporting={isImporting}
        isSyncing={isSyncing}
        isMobileOpen={isMobileOpen}
        isDimmed={isExternalChangesOpen}
        onCloseMobile={handleCloseMobile}
        onDropItemsToRoot={isSharePoolActive ? undefined : handleDropItemsToRoot}
        onDropItemsToTrash={handleTrashItems}
        onDropExternalToRoot={isSharePoolActive ? undefined : handleDropExternalToRoot}
      />

      <DitherDivider orientation="vertical" isDark={effectiveTheme === 'dark'} />

      <div {...stylex.props(styles.mainWorkspace)}>
        <Header
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          theme={themeChoice}
          onThemeChange={handleThemeChange}
          onToggleMobileMenu={handleToggleMobileMenu}
          isMobileMenuOpen={isMobileOpen}
        />

        <ActionPortal
          currentPath={currentPath}
          onNavigatePath={handleNavigatePath}
          onUploadFiles={handleUploadFiles}
          onCreateFolderPrompt={handleOpenNewFolder}
          onSyncAll={handleSyncAll}
          isSyncing={isSyncing}
          isTrashView={currentNav === 'trash'}
          trashedCount={displayedTrashedFiles.length}
          onEmptyTrash={handleOpenEmptyTrash}
          selectedCount={actionableSelectedCount}
          selectedTotalBytes={selectedTotalBytes}
          selectedAccountGroups={selectedAccountGroups}
          onOpenMoveFilesModal={isSharePoolActive ? undefined : handleOpenMoveFilesModal}
          onClearSelection={handleClearSelection}
          onDeleteSelected={handleDeleteSelected}
          onRenamePrompt={isSharePoolActive ? undefined : handleOpenRenameSelected}
          onRestoreSelected={handleBatchRestore}
          onCutSelected={isSharePoolActive ? undefined : handleCutSelected}
          onCopySelected={isSharePoolActive ? undefined : handleCopySelected}
          clipboard={isSharePoolActive ? null : clipboard}
          onPaste={isSharePoolActive ? undefined : handlePaste}
          onMoveItemsToPath={isSharePoolActive ? undefined : handleMoveItems}
          onDropExternalToPath={isSharePoolActive ? undefined : handleDropExternalToPath}
          onShareSelected={isSharePoolActive ? undefined : handleShareSelected}
          isSharePoolActive={isSharePoolActive}
          sharePoolItemCount={isSharePoolDataReady ? files.length + folders.length : 0}
          onClearSharePool={isSharePoolDataReady ? handleOpenClearSharePool : undefined}
          activeShareLinksCount={activeBatchLinks.length}
          onCopyActiveShareLinks={
            activeBatchLinks.length > 0 && activeBatchFolderName ? handleCopyActiveShareLinks : undefined
          }
          selectedShareBatches={selectedShareBatches}
          onCopyShareBatchLinks={handleCopyBatchLinks}
        />

        <div {...stylex.props(styles.fileTableStage)}>
          {hasVisitedFiles && (
            <div
              {...stylex.props(
                styles.fileTablePane,
                currentNav !== 'files' && styles.fileTablePaneHidden
              )}
              inert={currentNav !== 'files'}
            >
              <FileTable
                files={displayedFiles}
                folders={displayedFolders}
                isLoading={isTableLoading && currentNav === 'files'}
                currentPath={currentPath}
                searchQuery={deferredSearchQuery}
                selectedIds={currentNav === 'files' ? selectedIds : EMPTY_SELECTED_IDS}
                onSelect={handleSelect}
                onSelectMultiple={handleSelectMultiple}
                onClearSelection={handleClearSelection}
                onNavigate={handleNavigatePath}
                onDownload={handleDownload}
                onTrash={handleTrash}
                onDeleteFolder={handleDeleteFolder}
                isTrashView={false}
                onRestore={handleRestoreFile}
                onPermanentDelete={handlePermanentDelete}
                onDropFiles={isSharePoolActive ? undefined : handleDropFilesToTable}
                onStageDroppedUpload={isSharePoolActive ? undefined : handleStageDroppedUpload}
                onMoveItems={isSharePoolActive ? undefined : handleMoveItems}
                clipboard={isSharePoolActive ? null : clipboard}
                accounts={accountItems}
                onTransferFile={isSharePoolActive ? undefined : handleTransferFile}
                transferringFileId={transferringFileId}
                onShareItem={isSharePoolActive ? undefined : handleShareItem}
                isSharePoolActive={isSharePoolActive}
                shareLinksByBatch={isShareLinksReady ? shareLinksByBatch : undefined}
                onCopyShareLinks={isShareLinksReady ? handleCopyBatchLinks : undefined}
              />
            </div>
          )}

          {hasVisitedTrash && (
            <div
              {...stylex.props(
                styles.fileTablePane,
                currentNav !== 'trash' && styles.fileTablePaneHidden
              )}
              inert={currentNav !== 'trash'}
            >
              <FileTable
                files={displayedTrashedFiles}
                folders={[]}
                isLoading={isTableLoading && currentNav === 'trash'}
                currentPath={currentPath}
                searchQuery={deferredSearchQuery}
                selectedIds={currentNav === 'trash' ? selectedIds : EMPTY_SELECTED_IDS}
                onSelect={handleSelect}
                onSelectMultiple={handleSelectMultiple}
                onClearSelection={handleClearSelection}
                onNavigate={handleNavigatePath}
                onDownload={handleDownload}
                onTrash={handleTrash}
                onDeleteFolder={handleDeleteFolder}
                isTrashView={true}
                onRestore={handleRestoreFile}
                onPermanentDelete={handlePermanentDelete}
                onDropFiles={undefined}
                onStageDroppedUpload={undefined}
                onMoveItems={undefined}
                clipboard={null}
                accounts={accountItems}
                onTransferFile={undefined}
                transferringFileId={transferringFileId}
                onShareItem={undefined}
                isSharePoolActive={isSharePoolActive}
                shareLinksByBatch={undefined}
                onCopyShareLinks={undefined}
              />
            </div>
          )}
        </div>
      </div>

      <Suspense fallback={null}>
        {isUploadDrawerOpen && (
          <UploadDrawer
            isOpen={isUploadDrawerOpen}
            onClose={() => {
              setIsUploadDrawerOpen(false);
              setStagedFiles([]);
              setStagedEmptyFolders([]);
            }}
            stagedFiles={stagedFiles}
            stagedEmptyFolders={stagedEmptyFolders}
            currentPath={currentPath}
            accounts={accountItems}
            poolId={activePoolId}
            onUploadComplete={async () => {
              await Promise.all([loadClusterData(), loadFiles(currentPath)]);
              pushToast({ variant: 'success', message: 'Upload finished. Cluster updated.' });
            }}
            onClearFiles={() => {
              setStagedFiles([]);
              setStagedEmptyFolders([]);
            }}
          />
        )}

        {isExternalChangesOpen && (
          <ExternalChangesDrawer
            isOpen={isExternalChangesOpen}
            onClose={() => {
              setIsExternalChangesOpen(false);
              setExternalChangesAccountId(undefined);
            }}
            accounts={externalChangesAccounts}
            initialAccountId={externalChangesAccountId}
            isMobileSidebarOpen={isMobileViewport && isMobileOpen}
            onResolved={async (summary) => {
              if (summary) {
                setPendingDiscrepancies((prev) => ({
                  ...prev,
                  [summary.accountId]: summary.remainingCount > 0,
                }));
              }
              await Promise.all([
                loadClusterData(),
                summary?.refreshFiles !== false ? loadFiles(currentPath) : Promise.resolve(),
              ]);
              pushToast({ variant: 'success', message: 'Discrepancies updated.' });
            }}
          />
        )}

        {isNewFolderOpen && (
          <NewFolderModal
            isOpen={isNewFolderOpen}
            onClose={() => setIsNewFolderOpen(false)}
            currentPath={currentPath}
            onCreateFolder={handleCreateFolder}
          />
        )}

        {renameModalItem !== null && (
          <RenameModal
            isOpen={renameModalItem !== null}
            onClose={() => setRenameModalItem(null)}
            item={renameModalItem}
            onRename={handleRename}
          />
        )}

        {movePoolTargetAccount !== null && (
          <MovePoolModal
            isOpen={movePoolTargetAccount !== null}
            onClose={() => setMovePoolTargetAccount(null)}
            account={movePoolTargetAccount}
            pools={pools}
            activePoolId={activePoolId}
            onConfirm={handleSwitchAccountPool}
          />
        )}

        {moveFilesModalGroup !== null && (
          <MoveFilesModal
            isOpen={moveFilesModalGroup !== null}
            onClose={() => setMoveFilesModalGroup(null)}
            sourceAccount={accountItems.find((a) => a.id === moveFilesModalGroup?.accountId) ?? null}
            files={modalFiles}
            accounts={accountItems}
            onConfirm={handleTransferBatch}
          />
        )}

        {confirmEmptyTrash && currentNav === 'trash' && (
          <ConfirmPurgeModal
            isOpen={confirmEmptyTrash && currentNav === 'trash'}
            onClose={() => setConfirmEmptyTrash(false)}
            onConfirm={handleEmptyTrashExecute}
            itemCount={trashedFiles.length}
            totalBytes={trashedTotalBytes}
          />
        )}

        {Boolean(shareModalState && shareModalState.items.length > 0) && (
          <ShareModal
            isOpen={shareModalState !== null && shareModalState.items.length > 0}
            onClose={() => setShareModalState(null)}
            items={shareModalState?.items ?? []}
            sourcePoolId={shareModalState?.sourcePoolId ?? activePoolId}
            onComplete={handleShareComplete}
          />
        )}

        {isClearSharePoolOpen && (
          <ConfirmPurgeModal
            isOpen={isClearSharePoolOpen}
            onClose={() => setIsClearSharePoolOpen(false)}
            onConfirm={handleClearSharePoolConfirm}
            itemCount={Math.max(activePool?.fileCount ?? 0, files.length + folders.length)}
            totalBytes={activePool?.totalBytes ?? files.reduce((acc, f) => acc + (f.sizeBytes || 0), 0)}
            mode="share_pool"
          />
        )}

        {driveActionModal.isOpen && (
          <ConfirmDriveActionModal
            isOpen={driveActionModal.isOpen}
            onClose={() => {
              if (!driveActionModal.isLoading) {
                setDriveActionModal((prev) => ({ ...prev, isOpen: false }));
              }
            }}
            onConfirm={handleExecuteDriveAction}
            action={driveActionModal.action}
            account={driveActionModal.account}
            filesCount={driveFilesCount}
            totalBytes={driveTotalBytes}
            isLoading={driveActionModal.isLoading}
            errorMessage={driveActionModal.errorMessage}
          />
        )}
      </Suspense>

      <ToastRegion />
    </div>
  );
}

export default App;
