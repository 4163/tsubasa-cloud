import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { InferResponseType } from 'hono/client';
import { client } from './api.js';
import { colors, darkColors, radius, typography } from './tokens.stylex.js';
import { Header, type ThemeChoice } from './components/Header.js';
import { Sidebar, type AccountItem, type AccountTransferStats, type PoolSummary } from './components/Sidebar.js';
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
import { UploadDrawer, type StagedItem } from './components/UploadDrawer.js';
import { ExternalChangesDrawer } from './components/ExternalChangesDrawer.js';
import { NewFolderModal } from './components/NewFolderModal.js';
import { ConfirmPurgeModal } from './components/ConfirmPurgeModal.js';
import { ConfirmDriveActionModal } from './components/ConfirmDriveActionModal.js';
import { RenameModal, type RenameTarget } from './components/RenameModal.js';
import { MovePoolModal } from './components/MovePoolModal.js';
import { MoveFilesModal } from './components/MoveFilesModal.js';
import { ShareModal, type ShareExecuteResult, type ShareTargetItem } from './components/ShareModal.js';
import { copyTextToClipboard, SHARE_POOL_RESERVE_ID } from './utils/format.js';

interface AccountSummary {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  usableLimitBytes: number;
  headroomBytes: number;
  tsubasaUsedBytes?: number;
  syncState: string;
  isDisabled?: boolean;
  transferStats?: AccountTransferStats;
  poolId?: number;
  canSwitchPool?: boolean;
}

interface StorageOverview {
  totalAccounts: number;
  totalLimitBytes: number;
  totalUsedBytes: number;
  totalHeadroomBytes: number;
  totalTsubasaUsedBytes?: number;
  systemStorage?: {
    systemFilesCount: number;
    systemBytesTotal: number;
  };
  clusterTransfer?: {
    totalUploadedBytes24h: number;
    totalRemainingUploadBytes24h: number;
    dailyUploadLimitBytes: number;
    rateLimitedAccountsCount: number;
  };
  accounts: AccountSummary[];
}

interface DiscoveredAccount {
  accountId: string;
  clientId: string;
  authorized: boolean;
  sourceFile: string;
  isDisabled?: boolean;
  mtimeMs?: number;
  poolId?: number;
  canSwitchPool?: boolean;
}

type StoredShareLink = InferResponseType<typeof client.api.share.links.$get, 200>['links'][number];

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
  statusToast: {
    position: 'fixed',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: colors.surfaceElevated,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    color: colors.primaryText,
    paddingTop: '8px',
    paddingBottom: '8px',
    paddingLeft: '18px',
    paddingRight: '18px',
    borderRadius: radius.card,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    zIndex: 10000,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  },
  errorToast: {
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.danger,
    color: colors.danger,
    pointerEvents: 'auto',
    cursor: 'pointer',
  },
});

let lastDiscrepancyScanMs = 0;
const DISCREPANCY_COOLDOWN_MS = 60_000;

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
    setThemeChoice(newTheme);
    try {
      localStorage.setItem('tsubasa-theme-choice', newTheme);
    } catch {}
  }, []);

  useEffect(() => {
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
  const [shareLinksByBatch, setShareLinksByBatch] = useState<Record<string, StoredShareLink[]>>({});
  const [shareLinksPoolId, setShareLinksPoolId] = useState<number | null>(null);
  const filesRequestSeqRef = useRef(0);
  const poolsRef = useRef(pools);
  poolsRef.current = pools;

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [currentNav, setCurrentNav] = useState<'files' | 'trash'>(() => {
    if (typeof window !== 'undefined') {
      const saved = window.sessionStorage.getItem('tsubasa-current-nav');
      if (saved === 'files' || saved === 'trash') return saved;
    }
    return 'files';
  });
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
  }, []);

  const handleNavigate = useCallback(
    (newPath: string) => {
      if (typeof window !== 'undefined') {
        const nextUrl = getPathUrl(newPath);
        if (newPath !== currentPath) {
          window.history.pushState({ path: newPath }, '', nextUrl);
        }
      }
      setCurrentPath(newPath);
      setSelectedIds(new Set());
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
  const [isMobileOpen, setIsMobileOpen] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
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

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(max-width: 768px)');
    const handleMediaChange = (e: MediaQueryListEvent) => {
      if (!e.matches) {
        setIsMobileOpen(false);
      }
    };
    if (mql.addEventListener) {
      mql.addEventListener('change', handleMediaChange);
      return () => mql.removeEventListener('change', handleMediaChange);
    } else if (mql.addListener) {
      mql.addListener(handleMediaChange);
      return () => mql.removeListener(handleMediaChange);
    }
  }, []);

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
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

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
  ]);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 4000);
  }, []);

  const checkAccountDiscrepancies = useCallback(async (accountList: DiscoveredAccount[], force = false) => {
    const now = Date.now();
    if (!force && now - lastDiscrepancyScanMs < DISCREPANCY_COOLDOWN_MS) {
      return;
    }
    lastDiscrepancyScanMs = now;
    const authAccounts = accountList.filter((a) => a.authorized);
    await Promise.all(
      authAccounts.map(async (acc) => {
        try {
          const res = await client.api.sync['external-changes'][':accountId'].$get({
            param: { accountId: acc.accountId },
          });
          if (res.ok) {
            const report = await res.json();
            const count =
              (report?.overCeiling?.length ?? 0) +
              (report?.unindexed?.length ?? 0) +
              (report?.modified?.length ?? 0) +
              (report?.missingRemote?.length ?? 0);
            setPendingDiscrepancies((prev) => ({
              ...prev,
              [acc.accountId]: count > 0,
            }));
          }
        } catch {
          // Silently skip if network or scan is unavailable
        }
      })
    );
  }, []);

  const loadClusterData = useCallback(
    async (targetPoolId?: number) => {
      const effectivePoolId = targetPoolId ?? activePoolId;
      try {
        const poolsRes = await client.api.pools.$get();
        if (poolsRes.ok) {
          const poolsData = await poolsRes.json();
          setPools(poolsData.pools);
          if (poolsData.pools.length > 0 && !poolsData.pools.some((p) => p.id === effectivePoolId)) {
            const fallbackPool = poolsData.pools.find((p) => !p.isSharePool) ?? poolsData.pools[0];
            setActivePoolId(fallbackPool.id);
          }
        }

        const storageRes = await client.api.storage.overview.$get({
          query: { poolId: String(effectivePoolId) },
        });
        if (storageRes.ok) {
          setStorage(await storageRes.json());
        }

        const poolRes = await client.api.accounts.pool.$get({
          query: { poolId: String(effectivePoolId) },
        });
        if (poolRes.ok) {
          const poolData = await poolRes.json();
          setDiscovered(poolData.accounts);
        }
      } catch (err) {
        setErrorNotice(err instanceof Error ? err.message : 'Cluster offline');
      }
    },
    [activePoolId]
  );

  const loadFiles = useCallback(
    async (path: string, targetPoolId?: number) => {
      const reqPoolId = targetPoolId ?? activePoolId;
      const reqSeq = ++filesRequestSeqRef.current;
      const reqIsSharePool =
        poolsRef.current.some((p) => p.id === reqPoolId && p.isSharePool) || reqPoolId >= SHARE_POOL_RESERVE_ID;
      try {
        const [res, linksRes] = await Promise.all([
          client.api.files.$get({ query: { path, poolId: String(reqPoolId) } }),
          reqIsSharePool
            ? client.api.share.links.$get({ query: { poolId: String(reqPoolId) } }).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (res.ok) {
          const [data, linksData] = await Promise.all([
            res.json(),
            reqIsSharePool && linksRes?.ok ? linksRes.json().catch(() => null) : Promise.resolve(null),
          ]);
          if (filesRequestSeqRef.current !== reqSeq) return;
          setFiles(data.files as ClientFileRecord[]);
          setFolders(data.folders as ClientFolder[]);
          setLoadedFilesPoolId(reqPoolId);
          if (reqIsSharePool) {
            if (linksData) {
              const grouped: Record<string, StoredShareLink[]> = {};
              for (const link of linksData.links) {
                if (!grouped[link.batchFolderName]) {
                  grouped[link.batchFolderName] = [];
                }
                grouped[link.batchFolderName].push(link);
              }
              setShareLinksByBatch(grouped);
              setShareLinksPoolId(reqPoolId);
            }
          } else {
            setShareLinksByBatch({});
            setShareLinksPoolId(reqPoolId);
          }
        }
      } catch (err) {
        if (filesRequestSeqRef.current !== reqSeq) return;
        setErrorNotice(err instanceof Error ? err.message : 'Failed to query files');
      }
    },
    [activePoolId]
  );

  const loadTrashFiles = useCallback(async () => {
    try {
      const res = await client.api.trash.$get({ query: { poolId: String(activePoolId) } });
      if (res.ok) {
        const data = await res.json();
        setTrashedFiles((data.files as ClientFileRecord[]) || []);
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Failed to query trash');
    }
  }, [activePoolId]);

  useEffect(() => {
    loadClusterData();
    loadFiles(currentPath);
  }, [loadClusterData, loadFiles, currentPath]);

  useEffect(() => {
    if (discovered.length > 0) {
      void checkAccountDiscrepancies(discovered, false);
    }
  }, [discovered, checkAccountDiscrepancies]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'success') {
      const account = params.get('account') || 'Google account';
      showToast(`Account "${account}" successfully authorized.`);
      window.history.replaceState({}, '', window.location.pathname);
      loadClusterData();
    }
  }, [loadClusterData, showToast]);

  useEffect(() => {
    function handleFocus() {
      loadClusterData();
    }
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [loadClusterData]);

  useEffect(() => {
    if (currentNav === 'trash') {
      loadTrashFiles();
      setConfirmEmptyTrash(false);
    }
  }, [currentNav, loadTrashFiles]);

  function handleSelect(id: string, isMulti: boolean) {
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
  }

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

  async function handleAuthorizeAccount(accountId: string) {
    showToast('Authorize link copied to clipboard. Paste it in your browser.');
  }

  async function handleImportOAuth(file: File) {
    if (isSharePoolActive) return;
    setIsImporting(true);
    showToast(`Inspecting credentials from ${file.name}...`);
    try {
      const text = await file.text();

      if (file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.web && !parsed.installed) {
            setErrorNotice(
              "The uploaded credential is a 'Web application'. Tsubasa requires credentials with Application Type: 'Desktop app' (see docs/roadmap.md lines 170-173)."
            );
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
          poolId: activePoolId,
        },
      });

      if (res.ok) {
        const result = await res.json();
        showToast(`Imported credentials for "${result.accountId}".`);
        await loadClusterData();
        if (!result.authorized) {
          showToast(`Account "${result.accountId}" added. Click "Authorize" to complete Google sign-in.`);
        }
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorNotice(err.error || 'Failed to import OAuth credentials');
      }
    } catch (err) {
      setErrorNotice(`Import error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsImporting(false);
    }
  }

  async function handleSyncAll() {
    if (isSharePoolActive) return;
    setIsSyncing(true);
    showToast('Fetching changes from Google Drive...');
    try {
      const res = await client.api.sync.all.$post({
        query: { poolId: String(activePoolId) },
      });
      if (res.ok) {
        const report = await res.json();
        showToast(`Update complete: ${report.synced.length} drives checked.`);
        await loadClusterData();
        await loadFiles(currentPath);
        await checkAccountDiscrepancies(discovered, true);
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Fetch changes failed');
    } finally {
      setIsSyncing(false);
    }
  }

  function handleUploadFiles(fileList: FileList) {
    if (isSharePoolActive) return;
    const list = Array.from(fileList);
    if (list.length > 0) {
      setStagedFiles(list);
      setStagedEmptyFolders([]);
      setIsUploadDrawerOpen(true);
    }
  }

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

  function handleOpenNewFolder() {
    if (isSharePoolActive) return;
    setIsNewFolderOpen(true);
  }

  async function handleCreateFolder(folderName: string) {
    if (isSharePoolActive) return;
    const newPath = (currentPath === '/' ? '' : currentPath) + '/' + folderName;
    try {
      const res = await client.api.folders.$post({
        json: { virtualPath: newPath, name: folderName, poolId: activePoolId },
      });
      if (res.ok) {
        showToast(`Created folder "${folderName}".`);
        await loadFiles(currentPath);
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(('error' in err ? err.error : null) || 'Failed to create folder');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    }
  }

  function handleDownload(file: ClientFileRecord) {
    window.open(`/api/files/${encodeURIComponent(file.id)}/download`, '_blank');
  }

  async function handleTrash(file: ClientFileRecord) {
    try {
      const res = await client.api.files[':id'].trash.$post({ param: { id: file.id } });
      if (res.ok) {
        showToast(`Moved "${file.name}" to trash.`);
        await loadFiles(currentPath);
        await loadTrashFiles();
        await loadClusterData();
      }
    } catch (err) {
      setErrorNotice(`Trash error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleRestoreFile(file: ClientFileRecord) {
    try {
      const res = await client.api.files[':id'].restore.$post({
        param: { id: file.id },
      });
      if (res.ok) {
        showToast(`Restored "${file.name}".`);
        await loadTrashFiles();
        await loadFiles(currentPath);
        await loadClusterData();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(('error' in err ? err.error : null) || 'Restore failed');
      }
    } catch (err) {
      setErrorNotice(`Restore error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handlePermanentDelete(file: ClientFileRecord) {
    try {
      const res = await client.api.files[':id'].permanent.$delete({
        param: { id: file.id },
      });
      if (res.ok) {
        showToast(`Permanently deleted "${file.name}".`);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(file.id);
          return next;
        });
        await loadTrashFiles();
        await loadClusterData();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(('error' in err ? err.error : null) || 'Delete failed');
      }
    } catch (err) {
      setErrorNotice(`Delete error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleDeleteFolder(folder: ClientFolder) {
    try {
      const res = await client.api.folders.$delete({
        query: { virtualPath: folder.virtualPath, poolId: String(activePoolId) },
      });
      if (res.ok) {
        showToast(`Deleted folder "${folder.name}".`);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(folder.id);
          return next;
        });
        if (currentPath === folder.virtualPath || currentPath.startsWith(folder.virtualPath + '/')) {
          const parts = folder.virtualPath.split('/').filter(Boolean);
          const parent = parts.length <= 1 ? '/' : '/' + parts.slice(0, -1).join('/');
          handleNavigate(parent);
          await loadFiles(parent);
        } else {
          await loadFiles(currentPath);
        }
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(('error' in err ? err.error : null) || 'Failed to delete folder');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteSelected() {
    const idsToDelete = new Set(Array.from(selectedIds).filter((id) => id !== '__parent__'));
    if (idsToDelete.size === 0) return;
    setSelectedIds(new Set());

    const selectedFolders = folders.filter((f) => idsToDelete.has(f.id));
    const selectedFiles = (currentNav === 'trash' ? trashedFiles : files).filter((f) => idsToDelete.has(f.id));

    if (currentNav === 'trash') {
      for (const f of selectedFiles) {
        await handlePermanentDelete(f);
      }
    } else {
      for (const folder of selectedFolders) {
        await handleDeleteFolder(folder);
      }
      for (const file of selectedFiles) {
        await handleTrash(file);
      }
    }
  }

  const handleMoveItems = useCallback(
    async (itemsToMove: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string) => {
      if (isSharePoolActive || itemsToMove.length === 0) return;
      try {
        const res = await client.api.items.move.$post({
          json: { items: itemsToMove, targetFolderPath, poolId: activePoolId },
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          const results = 'results' in data && Array.isArray(data.results) ? data.results : [];
          const successCount = results.filter((r: any) => r.success).length;
          const failed = results.filter((r: any) => !r.success);
          if (failed.length > 0) {
            setErrorNotice(failed[0].error || 'Some items could not be moved');
          }
          if (successCount > 0) {
            showToast(`Moved ${successCount} ${successCount === 1 ? 'item' : 'items'} to ${targetFolderPath}.`);
          }
          setClipboard((prev) => {
            if (!prev || prev.mode !== 'cut') return prev;
            const movedIds = new Set(itemsToMove.map((i) => i.id));
            const remaining = prev.items.filter((i) => !movedIds.has(i.id));
            return remaining.length > 0 ? { ...prev, items: remaining } : null;
          });
          setSelectedIds(new Set());
          await Promise.all([loadFiles(currentPath), loadTrashFiles(), loadClusterData()]);
        } else {
          setErrorNotice(('error' in data ? (data.error as string) : null) || 'Failed to move items');
        }
      } catch (err) {
        setErrorNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [currentPath, loadFiles, loadTrashFiles, loadClusterData, showToast, activePoolId]
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

      const trashedFolders = activeItems.filter((i) => i.kind === 'folder');
      const trashedFilesList = activeItems.filter((i) => i.kind === 'file');

      let effectivePath = currentPath;
      const trashedIds = new Set<string>();

      try {
        for (const folder of trashedFolders) {
          const fPath = folder.virtualPath || folder.id;
          const res = await client.api.folders.$delete({
            query: { virtualPath: fPath, poolId: String(activePoolId) },
          });
          if (res.ok) {
            trashedIds.add(folder.id);
            if (fPath && (effectivePath === fPath || effectivePath.startsWith(fPath + '/'))) {
              const parts = fPath.split('/').filter(Boolean);
              effectivePath = parts.length <= 1 ? '/' : '/' + parts.slice(0, -1).join('/');
            }
          }
        }

        for (const file of trashedFilesList) {
          const res = await client.api.files[':id'].trash.$post({
            param: { id: file.id },
          });
          if (res.ok) {
            trashedIds.add(file.id);
          }
        }

        if (trashedIds.size > 0) {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const id of trashedIds) {
              next.delete(id);
            }
            return next;
          });

          setClipboard((prev) => {
            if (!prev || prev.mode !== 'cut') return prev;
            const remaining = prev.items.filter((i) => !trashedIds.has(i.id));
            return remaining.length > 0 ? { ...prev, items: remaining } : null;
          });

          if (effectivePath !== currentPath) {
            handleNavigate(effectivePath);
          }

          await Promise.all([
            loadFiles(effectivePath),
            loadTrashFiles(),
            loadClusterData(),
          ]);

          if (trashedIds.size === 1) {
            const single = activeItems.find((i) => trashedIds.has(i.id));
            const singleName = single?.name || (single?.virtualPath ? single.virtualPath.split('/').pop() : 'item');
            showToast(`Moved "${singleName}" to trash.`);
          } else {
            showToast(`Moved ${trashedIds.size} items to trash.`);
          }
        }
      } catch (err) {
        setErrorNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [currentPath, handleNavigate, loadFiles, loadTrashFiles, loadClusterData, showToast, activePoolId]
  );

  const handleCopyItems = useCallback(
    async (itemsToCopy: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string) => {
      if (itemsToCopy.length === 0) return;
      try {
        showToast(`Copying ${itemsToCopy.length} ${itemsToCopy.length === 1 ? 'item' : 'items'}...`);
        const res = await client.api.items.copy.$post({
          json: { items: itemsToCopy, targetFolderPath, poolId: activePoolId },
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          const results = 'results' in data && Array.isArray(data.results) ? data.results : [];
          const successCount = results.filter((r: any) => r.success).length;
          const failed = results.filter((r: any) => !r.success);
          if (failed.length > 0) {
            setErrorNotice(failed[0].error || 'Some items could not be copied');
          }
          if (successCount > 0) {
            showToast(`Copied ${successCount} ${successCount === 1 ? 'item' : 'items'} to ${targetFolderPath}.`);
          }
          setSelectedIds(new Set());
          await Promise.all([loadFiles(currentPath), loadClusterData()]);
        } else {
          setErrorNotice(('error' in data ? (data.error as string) : null) || 'Failed to copy items');
        }
      } catch (err) {
        setErrorNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [currentPath, loadFiles, loadClusterData, showToast, activePoolId]
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
      showToast(`Cut ${items.length} ${items.length === 1 ? 'item' : 'items'}. Press Ctrl+V or Paste to move here.`);
    }
  }, [isSharePoolActive, selectedIds, currentNav, folders, files, showToast]);

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
      showToast(`Copied ${items.length} ${items.length === 1 ? 'item' : 'items'}. Press Ctrl+V or Paste to duplicate.`);
    }
  }, [isSharePoolActive, selectedIds, currentNav, folders, files, showToast]);

  const handlePaste = useCallback(() => {
    if (isSharePoolActive) return;
    if (!clipboard || clipboard.items.length === 0 || currentNav === 'trash') return;
    if (clipboard.mode === 'cut') {
      handleMoveItems(clipboard.items, currentPath);
    } else {
      handleCopyItems(clipboard.items, currentPath);
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
      if (kind === 'pool') {
        try {
          const res = await client.api.pools[':id'].$patch({
            param: { id },
            json: { name: newName },
          });
          if (res.ok) {
            showToast(`Renamed pool to "${newName}".`);
            setRenameModalItem(null);
            setPools((prev) => prev.map((p) => (p.id === Number(id) ? { ...p, name: newName } : p)));
            await loadClusterData();
          } else {
            const err = (await res.json().catch(() => ({}))) as { error?: string };
            const errMsg = err.error || 'Failed to rename pool';
            setErrorNotice(errMsg);
            throw new Error(errMsg);
          }
        } catch (err) {
          setErrorNotice(err instanceof Error ? err.message : String(err));
          throw err;
        }
        return;
      }

      try {
        const res = await client.api.items.rename.$post({
          json: { kind, id, name: newName, poolId: activePoolId },
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showToast(`Renamed to "${newName}".`);
          setRenameModalItem(null);
          const oldFolderP = ('oldPath' in data ? (data.oldPath as string) : null) || ('oldVirtualPath' in data ? (data.oldVirtualPath as string) : null);
          const newFolderP = ('newPath' in data ? (data.newPath as string) : null) || ('newVirtualPath' in data ? (data.newVirtualPath as string) : null);
          if (
            kind === 'folder' &&
            oldFolderP &&
            (currentPath === oldFolderP || currentPath.startsWith(oldFolderP + '/'))
          ) {
            const relativeSuffix = currentPath.slice(oldFolderP.length);
            const nextPath = `${newFolderP}${relativeSuffix}`;
            handleNavigate(nextPath);
            await loadFiles(nextPath);
          } else {
            await loadFiles(currentPath);
          }
        } else {
          const errMsg = ('error' in data ? (data.error as string) : null) || 'Failed to rename item';
          setErrorNotice(errMsg);
          throw new Error(errMsg);
        }
      } catch (err) {
        setErrorNotice(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [currentPath, loadFiles, showToast, handleNavigate, activePoolId, loadClusterData]
  );

  const handleBatchRestore = useCallback(async () => {
    const actionableIds = Array.from(selectedIds).filter((id) => id !== '__parent__');
    if (actionableIds.length === 0 || currentNav !== 'trash') return;
    const toRestore = trashedFiles.filter((f) => actionableIds.includes(f.id));
    if (toRestore.length === 0) return;
    for (const file of toRestore) {
      await handleRestoreFile(file);
    }
    setSelectedIds(new Set());
    showToast(`Restored ${toRestore.length} ${toRestore.length === 1 ? 'file' : 'files'}.`);
  }, [selectedIds, currentNav, trashedFiles, handleRestoreFile, showToast]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (
        activeTag === 'input' ||
        activeTag === 'textarea' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }

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
        if (renameModalItem) {
          e.preventDefault();
          setRenameModalItem(null);
          return;
        }
        if (movePoolTargetAccount) {
          e.preventDefault();
          setMovePoolTargetAccount(null);
          return;
        }
        if (selectedIds.size > 0) {
          e.preventDefault();
          setSelectedIds(new Set());
        }
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
        if (selectedIds.size === 1 && selectedIds.has('__parent__')) {
          return;
        }
        e.preventDefault();
        handleDeleteSelected();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
        if (!isSharePoolActive && selectedIds.size > 0 && !selectedIds.has('__parent__') && currentNav !== 'trash') {
          e.preventDefault();
          handleCutSelected();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (!isSharePoolActive && selectedIds.size > 0 && !selectedIds.has('__parent__') && currentNav !== 'trash') {
          e.preventDefault();
          handleCopySelected();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        if (!isSharePoolActive && clipboard && clipboard.items.length > 0 && currentNav !== 'trash') {
          e.preventDefault();
          handlePaste();
        }
        return;
      }

      if (e.key === 'F2') {
        if (!isSharePoolActive && selectedIds.size === 1 && !selectedIds.has('__parent__')) {
          e.preventDefault();
          handleOpenRenameSelected();
        }
        return;
      }

      if (e.key === 'Enter') {
        if (selectedIds.size === 1 && currentNav !== 'trash') {
          const singleId = Array.from(selectedIds)[0];
          if (singleId === '__parent__') {
            e.preventDefault();
            const parts = currentPath.split('/').filter(Boolean);
            const parent = parts.length <= 1 ? '/' : '/' + parts.slice(0, -1).join('/');
            handleNavigate(parent);
            return;
          }
          const foundFolder = folders.find((f) => f.id === singleId);
          if (foundFolder) {
            e.preventDefault();
            handleNavigate(foundFolder.virtualPath);
            return;
          }
          const foundFile = files.find((f) => f.id === singleId && !f.isTrashed);
          if (foundFile) {
            e.preventDefault();
            handleDownload(foundFile);
            return;
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    selectedIds,
    folders,
    files,
    trashedFiles,
    currentNav,
    clipboard,
    renameModalItem,
    movePoolTargetAccount,
    currentPath,
    handleNavigate,
    handleCutSelected,
    handleCopySelected,
    handlePaste,
    handleOpenRenameSelected,
    isSharePoolActive,
  ]);

  async function handleEmptyTrashExecute() {
    try {
      const res = await client.api.trash.empty.$delete({
        query: { poolId: String(activePoolId) },
      });
      if (res.ok) {
        setConfirmEmptyTrash(false);
        showToast('Trash emptied. Storage permanently reclaimed.');
        await loadTrashFiles();
        await loadClusterData();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(('error' in err ? err.error : null) || 'Empty trash failed');
      }
    } catch (err) {
      setErrorNotice(`Empty trash error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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

  async function handleTransferFile(fileId: string, targetAccountId: string) {
    if (isSharePoolActive) return;
    const file = files.find((f) => f.id === fileId);
    const targetAcc = accountItems.find((a) => a.id === targetAccountId);
    const targetName = targetAcc?.displayName || targetAccountId;
    setTransferringFileId(fileId);
    try {
      const res = await client.api.sync.rebalance.file.$post({
        json: { fileId, targetAccountId },
      });
      if (res.ok) {
        showToast(`Transferred "${file?.name || fileId}" to ${targetName}.`);
        await loadFiles(currentPath);
        await loadClusterData();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(('error' in err ? err.error : null) || 'Failed to transfer file');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferringFileId(null);
    }
  }

  async function handleTransferBatch(fileIds: string[], targetAccountId: string) {
    if (isSharePoolActive) return;
    const targetAcc = accountItems.find((a) => a.id === targetAccountId);
    const targetName = targetAcc?.displayName || targetAccountId;
    try {
      const res = await client.api.sync.rebalance.batch.$post({
        json: { fileIds, targetAccountId },
      });
      if (res.ok) {
        showToast(`Transferred ${fileIds.length} file${fileIds.length === 1 ? '' : 's'} to ${targetName}.`);
        setMoveFilesModalGroup(null);
      } else {
        const err = await res.json().catch(() => ({}));
        const errorMsg = ('error' in err ? (err.error as string) : null) || 'Failed to transfer files';
        setErrorNotice(errorMsg);
        throw new Error(errorMsg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorNotice(msg);
      throw err;
    } finally {
      await loadFiles(currentPath);
      await loadClusterData();
    }
  }

  async function handleDisableAccount(accountId: string) {
    try {
      const res = await client.api.accounts[':id'].disable.$post({
        param: { id: accountId },
      });
      if (res.ok) {
        showToast('Drive disabled. Excluded from storage pool.');
        await loadClusterData();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(('error' in err ? err.error : null) || 'Failed to disable drive');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleEnableAccount(accountId: string) {
    try {
      const res = await client.api.accounts[':id'].enable.$post({
        param: { id: accountId },
      });
      if (res.ok) {
        showToast('Drive re-enabled in storage pool.');
        await loadClusterData();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(('error' in err ? err.error : null) || 'Failed to enable drive');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    }
  }

  function handleOpenDriveAction(account: AccountItem, action: 'remove') {
    setDriveActionModal({
      isOpen: true,
      action,
      account,
      isLoading: false,
      errorMessage: null,
    });
  }

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
        showToast(`Drive removed. Evacuated ${filesMoved} ${filesMoved === 1 ? 'file' : 'files'}.`);
        await loadClusterData();
        await loadFiles(currentPath);
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

  const clearWorkspaceState = useCallback(() => {
    setFiles([]);
    setFolders([]);
    setTrashedFiles([]);
    setLoadedFilesPoolId(null);
    setShareLinksByBatch({});
    setShareLinksPoolId(null);
    setFilteredAccountIds(new Set());
    setSelectedIds(new Set());
    setClipboard(null);
  }, []);

  const handleSelectPool = useCallback(
    (nextPoolId: number) => {
      if (nextPoolId === activePoolId) return;
      clearWorkspaceState();
      setActivePoolId(nextPoolId);
      setCurrentPath('/');
      setIsUploadDrawerOpen(false);
      setIsExternalChangesOpen(false);
      setShareModalState(null);
      setIsClearSharePoolOpen(false);
      setMoveFilesModalGroup(null);
      setRenameModalItem(null);
    },
    [activePoolId, clearWorkspaceState]
  );

  const handleCreatePool = useCallback(async () => {
    try {
      const res = await client.api.pools.$post({ json: { name: undefined } });
      if (res.ok) {
        const created = await res.json();
        showToast(`Created "${created.name}".`);
        setPools((prev) => [...prev, created]);
        handleSelectPool(created.id);
        await loadClusterData(created.id);
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(('error' in err ? (err.error as string) : null) || 'Failed to create pool');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    }
  }, [showToast, handleSelectPool, loadClusterData]);

  const handleDeletePool = useCallback(
    async (pool: PoolSummary) => {
      const standardPools = pools.filter((p) => !p.isSharePool);
      const currentIndex = standardPools.findIndex((p) => p.id === pool.id);
      const remainingStandardPools = pools.filter((p) => p.id !== pool.id && !p.isSharePool);
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

      try {
        const res = await client.api.pools[':id'].$delete({
          param: { id: String(pool.id) },
        });
        if (res.ok) {
          showToast(`Deleted pool "${pool.name}".`);
          setPools(pools.filter((p) => p.id !== pool.id));
          handleSelectPool(targetPool.id);
          await loadClusterData(targetPool.id);
        } else {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          setErrorNotice(err.error || 'Failed to delete pool');
        }
      } catch (err) {
        setErrorNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [pools, showToast, handleSelectPool, loadClusterData]
  );

  const handleSwitchAccountPool = useCallback(
    async (accountId: string, targetPoolId: number) => {
      try {
        const res = await client.api.accounts[':id'].pool.$post({
          param: { id: accountId },
          json: { poolId: targetPoolId },
        });
        if (res.ok) {
          const targetPool = pools.find((p) => p.id === targetPoolId);
          showToast(`Moved "${accountId}" to ${targetPool?.name || 'Pool ' + targetPoolId}.`);
          await Promise.all([loadClusterData(), loadFiles(currentPath), loadTrashFiles()]);
        } else {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          const errMsg = err.error || 'Cannot switch account pool';
          setErrorNotice(errMsg);
          throw new Error(errMsg);
        }
      } catch (err) {
        setErrorNotice(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [pools, showToast, loadClusterData, loadFiles, currentPath, loadTrashFiles]
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
      setActivePoolId(result.sharePoolId);
      setCurrentNav('files');
      handleNavigate(batchPath);
      await Promise.all([loadClusterData(result.sharePoolId), loadFiles(batchPath, result.sharePoolId)]);
    },
    [clearWorkspaceState, handleNavigate, loadClusterData, loadFiles]
  );

  const handleClearSharePoolConfirm = useCallback(async () => {
    try {
      const res = await client.api.pools[':id']['clear-share'].$post({
        param: { id: String(activePoolId) },
      });
      if (res.ok) {
        setIsClearSharePoolOpen(false);
        showToast('Share Pool cleared. Copied files and folders removed.');
        await Promise.all([
          loadFiles(currentPath),
          loadTrashFiles(),
          loadClusterData(activePoolId),
        ]);
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        const errMsg = err.error || 'Failed to clear Share Pool';
        setErrorNotice(errMsg);
        throw new Error(errMsg);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setErrorNotice(errMsg);
      throw err;
    }
  }, [activePoolId, currentPath, loadFiles, loadTrashFiles, loadClusterData, showToast]);

  const handleCopyBatchLinks = useCallback(
    async (batchFolderName: string): Promise<boolean> => {
      const links = shareLinksByBatch[batchFolderName] ?? [];
      const urls = links.map((l) => l.webViewLink).filter(Boolean);
      if (urls.length === 0) return false;

      const text = urls.join('\n');
      const ok = await copyTextToClipboard(text);
      if (!ok) return false;

      showToast(
        urls.length === 1
          ? `Copied share link for ${batchFolderName}.`
          : `Copied ${urls.length} share links for ${batchFolderName}.`
      );
      return true;
    },
    [shareLinksByBatch, showToast]
  );

  const isSharePoolDataReady = isSharePoolActive && loadedFilesPoolId === activePoolId;
  const isShareLinksReady = isSharePoolDataReady && shareLinksPoolId === activePoolId;
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

  const actionableSelectedCount = useMemo(() => {
    return Array.from(selectedIds).filter((id) => id !== '__parent__').length;
  }, [selectedIds]);

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
        onRenamePoolPrompt={
          isSharePoolActive
            ? undefined
            : (pool) => setRenameModalItem({ kind: 'pool', id: String(pool.id), name: pool.name })
        }
        onDeletePoolPrompt={isSharePoolActive ? undefined : handleDeletePool}
        onSwitchAccountPool={handleSwitchAccountPool}
        onOpenMovePool={(acc) => setMovePoolTargetAccount(acc)}
        currentNav={currentNav}
        onSelectNav={(nav) => setCurrentNav(nav)}
        onAuthorizeAccount={handleAuthorizeAccount}
        onRefreshStorage={loadClusterData}
        onOpenExternalChanges={
          isSharePoolActive
            ? undefined
            : (accId) => {
                setExternalChangesAccountId(accId);
                setIsExternalChangesOpen(true);
              }
        }
        onImportOAuth={isSharePoolActive ? undefined : handleImportOAuth}
        onDisableAccount={(acc) => handleDisableAccount(acc.id)}
        onEnableAccount={handleEnableAccount}
        onRemoveAccount={(acc) => handleOpenDriveAction(acc, 'remove')}
        isImporting={isImporting}
        isSyncing={isSyncing}
        isMobileOpen={isMobileOpen}
        onCloseMobile={() => setIsMobileOpen(false)}
        onDropItemsToRoot={isSharePoolActive ? undefined : (items) => handleMoveItems(items, '/')}
        onDropItemsToTrash={handleTrashItems}
        onDropExternalToRoot={isSharePoolActive ? undefined : (dt) => handleDropExternalToPath('/', dt)}
      />

      <DitherDivider orientation="vertical" isDark={effectiveTheme === 'dark'} />

      <div {...stylex.props(styles.mainWorkspace)}>
        <Header
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          theme={themeChoice}
          onThemeChange={handleThemeChange}
          onToggleMobileMenu={() => setIsMobileOpen((o) => !o)}
        />

        <ActionPortal
          currentPath={currentPath}
          onNavigatePath={(path) => {
            setCurrentNav('files');
            handleNavigate(path);
          }}
          onUploadFiles={handleUploadFiles}
          onCreateFolderPrompt={handleOpenNewFolder}
          onSyncAll={handleSyncAll}
          isSyncing={isSyncing}
          isTrashView={currentNav === 'trash'}
          trashedCount={displayedTrashedFiles.length}
          onEmptyTrash={() => setConfirmEmptyTrash(true)}
          selectedCount={actionableSelectedCount}
          selectedTotalBytes={selectedTotalBytes}
          selectedAccountGroups={selectedAccountGroups}
          onOpenMoveFilesModal={
            isSharePoolActive ? undefined : (group) => setMoveFilesModalGroup(group)
          }
          onClearSelection={() => setSelectedIds(new Set())}
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
          onClearSharePool={
            isSharePoolDataReady
              ? () => setIsClearSharePoolOpen(true)
              : undefined
          }
          activeShareLinksCount={activeBatchLinks.length}
          onCopyActiveShareLinks={
            activeBatchLinks.length > 0 && activeBatchFolderName
              ? () => handleCopyBatchLinks(activeBatchFolderName)
              : undefined
          }
          selectedShareBatches={selectedShareBatches}
          onCopyShareBatchLinks={handleCopyBatchLinks}
        />

        <FileTable
          files={currentNav === 'trash' ? displayedTrashedFiles : displayedFiles}
          folders={currentNav === 'trash' ? [] : displayedFolders}
          currentPath={currentPath}
          searchQuery={searchQuery}
          selectedIds={selectedIds}
          onSelect={handleSelect}
          onSelectMultiple={handleSelectMultiple}
          onClearSelection={() => setSelectedIds(new Set())}
          onNavigate={(path) => {
            if (currentNav === 'trash') setCurrentNav('files');
            handleNavigate(path);
          }}
          onDownload={handleDownload}
          onTrash={handleTrash}
          onDeleteFolder={handleDeleteFolder}
          isTrashView={currentNav === 'trash'}
          onRestore={handleRestoreFile}
          onPermanentDelete={handlePermanentDelete}
          onDropFiles={
            isSharePoolActive
              ? undefined
              : (droppedFiles) => {
                  if (droppedFiles.length > 0) {
                    setStagedFiles(droppedFiles);
                    setStagedEmptyFolders([]);
                    setIsUploadDrawerOpen(true);
                  }
                }
          }
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
          await loadClusterData();
          await loadFiles(currentPath);
          showToast('Upload finished. Cluster updated.');
        }}
        onClearFiles={() => {
          setStagedFiles([]);
          setStagedEmptyFolders([]);
        }}
      />

      {isExternalChangesOpen && (
        <ExternalChangesDrawer
          isOpen={isExternalChangesOpen}
          onClose={() => {
            setIsExternalChangesOpen(false);
            setExternalChangesAccountId(undefined);
          }}
          accounts={externalChangesAccounts}
          initialAccountId={externalChangesAccountId}
          onResolved={async () => {
            await loadClusterData();
            await loadFiles(currentPath);
            showToast('Discrepancies updated.');
          }}
        />
      )}

      <NewFolderModal
        isOpen={isNewFolderOpen}
        onClose={() => setIsNewFolderOpen(false)}
        currentPath={currentPath}
        onCreateFolder={handleCreateFolder}
      />

      <RenameModal
        isOpen={renameModalItem !== null}
        onClose={() => setRenameModalItem(null)}
        item={renameModalItem}
        onRename={handleRename}
      />

      <MovePoolModal
        isOpen={movePoolTargetAccount !== null}
        onClose={() => setMovePoolTargetAccount(null)}
        account={movePoolTargetAccount}
        pools={pools}
        activePoolId={activePoolId}
        onConfirm={handleSwitchAccountPool}
      />

      <MoveFilesModal
        isOpen={moveFilesModalGroup !== null}
        onClose={() => setMoveFilesModalGroup(null)}
        sourceAccount={accountItems.find((a) => a.id === moveFilesModalGroup?.accountId) ?? null}
        files={modalFiles}
        accounts={accountItems}
        onConfirm={handleTransferBatch}
      />

      <ConfirmPurgeModal
        isOpen={confirmEmptyTrash && currentNav === 'trash'}
        onClose={() => setConfirmEmptyTrash(false)}
        onConfirm={handleEmptyTrashExecute}
        itemCount={trashedFiles.length}
        totalBytes={trashedTotalBytes}
      />

      <ShareModal
        isOpen={shareModalState !== null && shareModalState.items.length > 0}
        onClose={() => setShareModalState(null)}
        items={shareModalState?.items ?? []}
        sourcePoolId={shareModalState?.sourcePoolId ?? activePoolId}
        onComplete={handleShareComplete}
      />

      <ConfirmPurgeModal
        isOpen={isClearSharePoolOpen}
        onClose={() => setIsClearSharePoolOpen(false)}
        onConfirm={handleClearSharePoolConfirm}
        itemCount={Math.max(activePool?.fileCount ?? 0, files.length + folders.length)}
        totalBytes={activePool?.totalBytes ?? files.reduce((acc, f) => acc + (f.sizeBytes || 0), 0)}
        mode="share_pool"
      />

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

      {toastMessage && (
        <div {...stylex.props(styles.statusToast)}>
          {toastMessage}
        </div>
      )}

      {errorNotice && (
        <div
          {...stylex.props(styles.statusToast, styles.errorToast)}
          onClick={() => setErrorNotice(null)}
        >
          Notice: {errorNotice}
        </div>
      )}
    </div>
  );
}

export default App;
