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
import { colors, darkColors, motion, radius, spacing, typography } from './tokens.stylex.js';
import {
  filterMovableItemsToPath,
  getParentDir,
  isDropHandled,
  normalizeVirtualPath,
} from './utils/virtualPath.js';
import {
  applyDocumentTheme,
  readInitialTheme,
  readThemeChoice,
  saveThemeChoice,
  type EffectiveTheme,
  type ThemeChoice,
} from './utils/theme.js';
import { Header } from './components/Header.js';
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
import { IconAlertTriangle, IconClose } from './components/Icons.js';
import type { StagedItem } from './components/UploadDrawer.js';
import type { RenameTarget } from './components/RenameModal.js';
import type { MoveConflictItem, MoveConflictResolutionMode } from './components/MoveConflictModal.js';
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
const MoveConflictModal = lazy(() =>
  import('./components/MoveConflictModal.js').then((m) => ({ default: m.MoveConflictModal }))
);
const ShareModal = lazy(() =>
  import('./components/ShareModal.js').then((m) => ({ default: m.ShareModal }))
);
function reportDevError(context: string, err: unknown): void {
  if (import.meta.env.DEV) {
    console.error(`[tsubasa] ${context}:`, err);
  }
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'string' && err.trim().length > 0) return err;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  if (
    err &&
    typeof err === 'object' &&
    'error' in err &&
    typeof err.error === 'string' &&
    err.error.trim().length > 0
  ) {
    return err.error;
  }
  return fallback;
}

interface ItemOperationResult {
  id?: string;
  kind?: 'file' | 'folder';
  oldPath?: string;
  newPath?: string;
  success?: boolean;
  skipped?: boolean;
  error?: string;
}

function remapPathPrefix(virtualPath: string, oldPrefix: string, newPrefix: string): string | null {
  if (virtualPath === oldPrefix) return newPrefix;
  if (virtualPath.startsWith(`${oldPrefix}/`)) {
    return `${newPrefix}${virtualPath.slice(oldPrefix.length)}`;
  }
  return null;
}

function applyMoveResultsToClipboard(
  clipboard: ActionPortalClipboard | null,
  poolId: number,
  results: ItemOperationResult[]
): ActionPortalClipboard | null {
  if (!clipboard) return null;
  const movedNonSkipped = results.filter((r) => r.success && !r.skipped);
  const movedIds = new Set(
    movedNonSkipped.map((r) => r.id).filter((id): id is string => Boolean(id))
  );
  const movedFolders = movedNonSkipped.filter(
    (r): r is ItemOperationResult & { oldPath: string; newPath: string } =>
      r.kind === 'folder' && Boolean(r.oldPath && r.newPath && r.oldPath !== r.newPath)
  );
  const movedFilesById = new Map<string, string>();
  for (const r of movedNonSkipped) {
    if (r.kind === 'file' && r.id && r.newPath) {
      movedFilesById.set(r.id, r.newPath);
    }
  }

  const baseItems =
    clipboard.mode === 'cut'
      ? clipboard.items.filter((item) => !movedIds.has(item.id))
      : clipboard.items;
  if (baseItems.length === 0) return null;

  const nextItems = baseItems.map((item) => {
    const directFilePath = item.kind === 'file' ? movedFilesById.get(item.id) : undefined;
    if (directFilePath) {
      const updatedName = directFilePath.split('/').pop() || item.name;
      return { ...item, virtualPath: directFilePath, name: updatedName };
    }
    for (const folderMove of movedFolders) {
      const remapped = remapPathPrefix(item.virtualPath, folderMove.oldPath, folderMove.newPath);
      if (remapped !== null) {
        return {
          ...item,
          virtualPath: remapped,
          ...(item.kind === 'folder' ? { id: `${poolId}:${remapped}` } : {}),
        };
      }
    }
    return item;
  });

  return { ...clipboard, items: nextItems };
}

function parseItemOperationResults(data: unknown): ItemOperationResult[] {
  if (Array.isArray(data)) return data as ItemOperationResult[];
  if (data && typeof data === 'object' && 'results' in data && Array.isArray(data.results)) {
    return data.results as ItemOperationResult[];
  }
  return [];
}

interface PendingMoveConflict {
  items: Array<{ kind: 'file' | 'folder'; id: string }>;
  targetFolderPath: string;
  poolId: number;
  conflicts: MoveConflictItem[];
  cleanCount: number;
  errorMessage?: string | null;
}

interface MoveConflictPayload {
  code: 'MOVE_CONFLICT';
  conflicts: MoveConflictItem[];
  cleanCount?: number;
}

function isMoveConflictPayload(data: unknown): data is MoveConflictPayload {
  if (!data || typeof data !== 'object') return false;
  const candidate = data as Record<string, unknown>;
  return candidate.code === 'MOVE_CONFLICT' && Array.isArray(candidate.conflicts);
}
import { copyTextToClipboard, SHARE_POOL_RESERVE_ID } from './utils/format.js';
import { useBeforeUnload, useMediaQuery } from './utils/useBeforeUnload.js';
import { subscribeAuthCompleted } from './utils/useTabLock.js';
import {
  dedupeInFlight,
  getPoolCache,
  invalidateShareInspectCache,
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

async function readResponseError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return extractErrorMessage(body, res.statusText || fallback);
}

function safeStorageGet(storage: Storage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(storage: Storage | undefined, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore storage access errors in restricted browser contexts.
  }
}

function safeStorageRemove(storage: Storage | undefined, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage access errors in restricted browser contexts.
  }
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
  workspaceErrorRegion: {
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  workspaceErrorBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    borderRadius: radius.compact,
    color: colors.dangerTextOnSurface,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    lineHeight: typography.lineHeightBody,
    boxSizing: 'border-box',
  },
  workspaceErrorContent: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
    flex: 1,
  },
  workspaceErrorIcon: {
    flexShrink: 0,
  },
  workspaceErrorText: {
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  workspaceErrorDismissBtn: {
    height: '28px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightSection,
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    cursor: 'pointer',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
      minWidth: '44px',
    },
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

function isModalActive(): boolean {
  return typeof document !== 'undefined' && Boolean(document.querySelector('dialog[open], [role="dialog"]'));
}

export function App() {
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => readThemeChoice());

  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() => readInitialTheme());

  const handleThemeChange = useCallback((newTheme: ThemeChoice) => {
    saveThemeChoice(newTheme);
    runWithViewTransition(() => {
      flushSync(() => {
        setThemeChoice(newTheme);
      });
    });
  }, []);

  useLayoutEffect(() => {
    let active: EffectiveTheme = 'dark';
    if (themeChoice === 'auto') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      active = mql.matches ? 'dark' : 'light';
      setEffectiveTheme(active);
      applyDocumentTheme(active);
      const listener = (e: MediaQueryListEvent) => {
        const next: EffectiveTheme = e.matches ? 'dark' : 'light';
        setEffectiveTheme(next);
        applyDocumentTheme(next);
      };
      mql.addEventListener('change', listener);
      return () => mql.removeEventListener('change', listener);
    }
    active = themeChoice;
    setEffectiveTheme(themeChoice);
    applyDocumentTheme(active);
  }, [themeChoice]);
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
  const failedFilesLoadPoolRef = useRef<number | null>(null);
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
      return safeStorageGet(window.sessionStorage, 'tsubasa-current-path') || '/';
    }
    return '/';
  });
  const [searchQuery, setSearchQuery] = useState<string>('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [currentNav, setCurrentNav] = useState<'files' | 'trash'>(() => {
    if (typeof window !== 'undefined') {
      const saved = safeStorageGet(window.sessionStorage, 'tsubasa-current-nav');
      if (saved === 'files' || saved === 'trash') return saved;
    }
    return 'files';
  });
  const currentNavRef = useRef(currentNav);
  currentNavRef.current = currentNav;
  const [clipboard, setClipboard] = useState<ActionPortalClipboard | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const surfaceWorkspaceError = useCallback((context: string, err: unknown, fallback: string) => {
    const message = extractErrorMessage(err, fallback);
    setWorkspaceError(message);
    reportDevError(context, err instanceof Error ? err : message);
  }, []);
  const [renameModalItem, setRenameModalItem] = useState<RenameTarget | null>(null);
  const [movePoolTargetAccount, setMovePoolTargetAccount] = useState<AccountItem | null>(null);
  const [moveFilesModalGroup, setMoveFilesModalGroup] = useState<SelectedAccountGroup | null>(null);
  const [pendingMoveConflict, setPendingMoveConflict] = useState<PendingMoveConflict | null>(null);
  const [isResolvingMoveConflict, setIsResolvingMoveConflict] = useState(false);
  const resolvingMoveConflictRef = useRef(false);
  const [scrollRequest, setScrollRequest] = useState<{ id: string; seq: number } | null>(null);
  const [filteredAccountIds, setFilteredAccountIds] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const raw = safeStorageGet(window.sessionStorage, 'tsubasa-filtered-account-ids');
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
      if (filteredAccountIds.size === 0) {
        safeStorageRemove(window.sessionStorage, 'tsubasa-filtered-account-ids');
      } else {
        safeStorageSet(
          window.sessionStorage,
          'tsubasa-filtered-account-ids',
          JSON.stringify(Array.from(filteredAccountIds))
        );
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
    setWorkspaceError(null);
    runWithViewTransition(() => {
      flushSync(() => {
        setCurrentNav(nav);
      });
    });
  }, []);

  const handleNavigate = useCallback(
    (newPath: string) => {
      setWorkspaceError(null);
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
      safeStorageSet(window.sessionStorage, 'tsubasa-current-path', currentPath);
    }
  }, [currentPath]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      safeStorageSet(window.sessionStorage, 'tsubasa-current-nav', currentNav);
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
    if (loadedFilesPoolId !== activePoolId || failedFilesLoadPoolRef.current === activePoolId) return;
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
  }, [files, loadedFilesPoolId, activePoolId]);

  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [pendingOpsCount, setPendingOpsCount] = useState<number>(0);
  const isSyncingRef = useRef(isSyncing);
  isSyncingRef.current = isSyncing;
  const pendingOpsCountRef = useRef(pendingOpsCount);
  pendingOpsCountRef.current = pendingOpsCount;
  const [isMobileOpen, setIsMobileOpen] = useState<boolean>(false);
  const [transferringFileIds, setTransferringFileIds] = useState<Set<string>>(() => new Set());
  const [driveActionModal, setDriveActionModal] = useState<{
    isOpen: boolean;
    account: AccountItem | null;
    isLoading: boolean;
    errorMessage: string | null;
  }>({
    isOpen: false,
    account: null,
    isLoading: false,
    errorMessage: null,
  });
  const executingDriveActionRef = useRef(false);

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
    transferringFileIds.size > 0 ||
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
  const [stagedFiles, setStagedFiles] = useState<Array<File | StagedItem>>([]);
  const [stagedEmptyFolders, setStagedEmptyFolders] = useState<string[]>([]);
  const [uploadTargetPath, setUploadTargetPath] = useState<string | undefined>(undefined);
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

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const currentUrl = getPathUrl(currentPath);
    if (!window.history.state || window.history.state.path !== currentPath) {
      window.history.replaceState({ path: currentPath }, '', currentUrl);
    }

    function handlePopState(e: PopStateEvent) {
      if (driveActionModal.isLoading || pendingOpsCount > 0 || isResolvingMoveConflict) {
        window.history.pushState({ path: currentPath }, '', getPathUrl(currentPath));
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const targetPath = e.state?.path || params.get('path') || '/';

      if (renameModalItem) setRenameModalItem(null);
      if (movePoolTargetAccount) setMovePoolTargetAccount(null);
      if (moveFilesModalGroup) setMoveFilesModalGroup(null);
      if (pendingMoveConflict) setPendingMoveConflict(null);
      if (isUploadDrawerOpen) setIsUploadDrawerOpen(false);
      if (isExternalChangesOpen) setIsExternalChangesOpen(false);
      if (isNewFolderOpen) setIsNewFolderOpen(false);
      if (confirmEmptyTrash) setConfirmEmptyTrash(false);
      if (shareModalState) setShareModalState(null);
      if (isClearSharePoolOpen) setIsClearSharePoolOpen(false);
      if (driveActionModal.isOpen && !driveActionModal.isLoading) {
        setDriveActionModal((prev) => ({ ...prev, isOpen: false }));
      }

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
    moveFilesModalGroup,
    pendingMoveConflict,
    isResolvingMoveConflict,
    isUploadDrawerOpen,
    isExternalChangesOpen,
    isNewFolderOpen,
    confirmEmptyTrash,
    shareModalState,
    isClearSharePoolOpen,
    driveActionModal.isOpen,
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

  const loadTrashFiles = useCallback(async (targetPoolId?: number) => {
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
  }, [surfaceWorkspaceError]);

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
    setFilteredAccountIds(new Set());
    setSelectedIds(new Set());
    setClipboard(null);
    setWorkspaceError(null);
    setPendingMoveConflict(null);
    setIsResolvingMoveConflict(false);
    setScrollRequest(null);
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
          setFilteredAccountIds(new Set());
          setSelectedIds(new Set());
          setClipboard(null);
        } else {
          clearWorkspaceState();
        }
        setActivePoolId(nextPoolId);
        setCurrentPath('/');
        setWorkspaceError(null);
        setIsUploadDrawerOpen(false);
        setIsExternalChangesOpen(false);
        setShareModalState(null);
        setIsClearSharePoolOpen(false);
        setMoveFilesModalGroup(null);
        setPendingMoveConflict(null);
        setIsResolvingMoveConflict(false);
        setRenameModalItem(null);
        setDriveActionModal((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
      });
    },
    [clearWorkspaceState]
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
        if (accountFilterId) {
          setExternalChangesAccountId(accountFilterId);
        }
        setIsExternalChangesOpen(true);
      }
    },
    [handleSelectPool, loadClusterData, loadFiles, checkAccountDiscrepancies]
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

  // Prevent mouse back/forward buttons from triggering browser history navigation.
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

        if (isModalActive()) return;

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
  }, []);

  const handleImportOAuth = useCallback(
    async (file: File) => {
      setWorkspaceError(null);
      setIsImporting(true);
      try {
        const text = await file.text();

        if (file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(text);
            if (parsed.web && !parsed.installed) {
              surfaceWorkspaceError(
                'importOAuth',
                "Uploaded credential is 'Web application'; Tsubasa requires 'Desktop app' credentials.",
                "Uploaded credential is 'Web application'; Tsubasa requires 'Desktop app' credentials."
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
            poolId: activePoolIdRef.current,
          },
        });

        if (res.ok) {
          invalidateShareInspectCache();
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
            });
          } else {
            await loadClusterData();
          }
        } else {
          const msg = await readResponseError(res, 'Failed to import OAuth credentials');
          surfaceWorkspaceError('importOAuth', msg, 'Failed to import OAuth credentials');
        }
      } catch (err) {
        surfaceWorkspaceError('importOAuth', err, 'Failed to import OAuth credentials');
      } finally {
        setIsImporting(false);
      }
    },
    [presentAuthorizedAccount, loadClusterData, surfaceWorkspaceError]
  );

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
  }, [isPoolSharePool, markTrashStale, loadClusterData, loadFiles, checkAccountDiscrepancies, surfaceWorkspaceError]);

  const handleUploadFiles = useCallback(
    (fileList: FileList) => {
      if (isSharePoolActive) return;
      const list = Array.from(fileList);
      if (list.length > 0) {
        setStagedFiles(list);
        setStagedEmptyFolders([]);
        setUploadTargetPath(undefined);
        setIsUploadDrawerOpen(true);
      }
    },
    [isSharePoolActive]
  );

  const handleStageDroppedUpload = useCallback(
    (dropped: { files: Array<{ file: File; virtualPath: string }>; emptyFolders: string[]; basePath?: string }) => {
      if (isSharePoolActive || isModalActive()) return;
      if (dropped.files.length > 0 || dropped.emptyFolders.length > 0) {
        setStagedFiles(dropped.files);
        setStagedEmptyFolders(dropped.emptyFolders);
        setUploadTargetPath(dropped.basePath);
        setIsUploadDrawerOpen(true);
      }
    },
    [isSharePoolActive]
  );

  const handleDropExternalToPath = useCallback(
    async (targetPath: string, dataTransfer: DataTransfer) => {
      if (isSharePoolActive || isModalActive()) return;
      try {
        const extracted = await extractDataTransferEntries(dataTransfer, targetPath);
        if (extracted.files.length > 0 || extracted.emptyFolders.length > 0) {
          setStagedFiles(extracted.files);
          setStagedEmptyFolders(extracted.emptyFolders);
          setUploadTargetPath(extracted.basePath);
          setIsUploadDrawerOpen(true);
        }
      } catch (err) {
        surfaceWorkspaceError('handleDropExternalToPath', err, 'Failed to read dropped files');
      }
    },
    [isSharePoolActive, surfaceWorkspaceError]
  );

  useEffect(() => {
    const handleWindowDragOver = (e: DragEvent) => {
      if (currentNav === 'trash' || isSharePoolActive || isModalActive()) return;
      if (e.dataTransfer?.types?.includes('application/x-tsubasa-items')) return;
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleWindowDrop = async (e: DragEvent) => {
      if (currentNav === 'trash' || isSharePoolActive) return;
      if (isModalActive()) {
        e.preventDefault();
        return;
      }
      if (e.dataTransfer?.types?.includes('application/x-tsubasa-items')) return;
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        if (isDropHandled(e)) return;
        try {
          const extracted = await extractDataTransferEntries(e.dataTransfer, currentPath);
          if (extracted.files.length > 0 || extracted.emptyFolders.length > 0) {
            setStagedFiles(extracted.files);
            setStagedEmptyFolders(extracted.emptyFolders);
            setUploadTargetPath(extracted.basePath);
            setIsUploadDrawerOpen(true);
          }
        } catch (err) {
          surfaceWorkspaceError('handleWindowDrop', err, 'Failed to read dropped files');
        }
      }
    };

    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', handleWindowDrop);

    return () => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, [currentNav, currentPath, isSharePoolActive, surfaceWorkspaceError]);

  const handleOpenNewFolder = useCallback(() => {
    if (isSharePoolActive) return;
    setIsNewFolderOpen(true);
  }, [isSharePoolActive]);

  const handleCreateFolder = useCallback(
    async (folderName: string) => {
      if (isSharePoolActive) return;
      setWorkspaceError(null);
      const targetPath = currentPathRef.current;
      const poolId = activePoolIdRef.current;
      const newPath = normalizeVirtualPath((targetPath === '/' ? '' : targetPath) + '/' + folderName);
      const prevFolders = foldersRef.current;
      const prevFiles = filesRef.current;
      if (prevFolders.some((f) => f.virtualPath === newPath)) {
        throw new Error(`A folder named "${folderName}" already exists in this directory`);
      }
      if (prevFiles.some((f) => !f.isTrashed && f.virtualPath === newPath)) {
        throw new Error(`A file named "${folderName}" already exists in this directory`);
      }

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

      const rollbackFolder = () => {
        if (activePoolIdRef.current === poolId) {
          setFolders((prev) => prev.filter((f) => f.id !== optimisticFolder.id));
        } else {
          const cached = getPoolCache(poolId);
          if (cached) {
            setPoolCache(poolId, {
              folders: cached.folders.filter((f) => f.id !== optimisticFolder.id),
            });
          }
        }
      };

      try {
        return await runPendingOp(async () => {
          const res = await client.api.folders.$post({
            json: { virtualPath: newPath, name: folderName, poolId },
          });
          if (res.ok) {
            invalidateShareInspectCache();
            const created = (await res.json().catch(() => null)) as { id?: string } | null;
            const createdId = created?.id || `${poolId}:${newPath}`;
            await loadFiles(targetPath, poolId);
            if (activePoolIdRef.current === poolId && currentPathRef.current === targetPath) {
              setSelectedIds(new Set([createdId]));
              setScrollRequest((prev) => ({ id: createdId, seq: (prev?.seq ?? 0) + 1 }));
            }
            return;
          }
          rollbackFolder();
          const msg = await readResponseError(res, 'Failed to create folder');
          if (res.status !== 409) {
            surfaceWorkspaceError('createFolder', msg, 'Failed to create folder');
          }
          throw Object.assign(new Error(msg), { handled: true });
        });
      } catch (err) {
        rollbackFolder();
        if (!(err instanceof Error && 'handled' in err)) {
          surfaceWorkspaceError('createFolder', err, 'Failed to create folder');
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    [isSharePoolActive, loadFiles, runPendingOp, surfaceWorkspaceError]
  );

  const handleDownload = useCallback((file: ClientFileRecord) => {
    const url = `/api/files/${encodeURIComponent(file.id)}/download`;
    const win = window.open(url, '_blank');
    if (!win) {
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name || '';
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
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
          navigateParent = getParentDir(folder.virtualPath);
        }
        return { ok: true, navigateParent };
      }
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: ('error' in err ? (err.error as string) : null) || 'Failed to delete folder' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const handleTrash = useCallback(
    async (file: ClientFileRecord) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      const wasTrashView = currentNavRef.current === 'trash';
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
      if (wasTrashView) {
        setTrashedFiles((prev) => [{ ...file, isTrashed: true }, ...prev]);
      } else {
        markTrashStale(poolId);
      }

      await runPendingOp(async () => {
        const result = await trashFileRequest(file);
        if (result.ok) {
          invalidateShareInspectCache();
          await Promise.all([
            loadFiles(currentPathRef.current, poolId),
            currentNavRef.current === 'trash' ? loadTrashFiles(poolId) : Promise.resolve(),
            loadClusterData(poolId),
          ]);
        } else {
          if (activePoolIdRef.current === poolId) {
            setFiles((prev) => (prev.some((f) => f.id === file.id) ? prev : [...prev, file]));
            if (wasTrashView) {
              setTrashedFiles((prev) => prev.filter((f) => f.id !== file.id));
            }
            surfaceWorkspaceError('handleTrash', result.error, 'Failed to move file to trash');
          } else {
            const cached = getPoolCache(poolId);
            if (cached) {
              setPoolCache(poolId, {
                files: cached.files.some((f) => f.id === file.id) ? cached.files : [...cached.files, file],
                trashedFiles: wasTrashView
                  ? cached.trashedFiles.filter((f) => f.id !== file.id)
                  : cached.trashedFiles,
              });
            }
          }
        }
      });
    },
    [markTrashStale, runPendingOp, loadFiles, loadTrashFiles, loadClusterData, surfaceWorkspaceError]
  );

  const handleRestoreFile = useCallback(
    async (file: ClientFileRecord) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      setTrashedFiles((prev) => prev.filter((f) => f.id !== file.id));
      setFiles((prev) => [...prev, { ...file, isTrashed: false }]);

      await runPendingOp(async () => {
        const result = await restoreFileRequest(file);
        if (result.ok) {
          invalidateShareInspectCache();
          await Promise.all([
            currentNavRef.current === 'trash' ? loadTrashFiles(poolId) : Promise.resolve(),
            loadFiles(currentPathRef.current, poolId),
            loadClusterData(poolId),
          ]);
        } else {
          if (activePoolIdRef.current === poolId) {
            setTrashedFiles((prev) => (prev.some((f) => f.id === file.id) ? prev : [file, ...prev]));
            setFiles((prev) => prev.filter((f) => f.id !== file.id));
            surfaceWorkspaceError('handleRestoreFile', result.error, 'Restore failed');
          } else {
            const cached = getPoolCache(poolId);
            if (cached) {
              setPoolCache(poolId, {
                trashedFiles: cached.trashedFiles.some((f) => f.id === file.id)
                  ? cached.trashedFiles
                  : [file, ...cached.trashedFiles],
                files: cached.files.filter((f) => f.id !== file.id),
              });
            }
          }
        }
      });
    },
    [runPendingOp, loadTrashFiles, loadFiles, loadClusterData, surfaceWorkspaceError]
  );

  const handlePermanentDelete = useCallback(
    async (file: ClientFileRecord) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      const wasSelected = selectedIds.has(file.id);
      setTrashedFiles((prev) => prev.filter((f) => f.id !== file.id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(file.id);
        return next;
      });

      await runPendingOp(async () => {
        const result = await permanentDeleteFileRequest(file);
        if (result.ok) {
          invalidateShareInspectCache();
          await Promise.all([
            currentNavRef.current === 'trash' ? loadTrashFiles(poolId) : Promise.resolve(),
            loadClusterData(poolId),
          ]);
        } else {
          if (activePoolIdRef.current === poolId) {
            setTrashedFiles((prev) => (prev.some((f) => f.id === file.id) ? prev : [file, ...prev]));
            if (wasSelected) {
              setSelectedIds((prev) => new Set(prev).add(file.id));
            }
            surfaceWorkspaceError('handlePermanentDelete', result.error, 'Delete failed');
          } else {
            const cached = getPoolCache(poolId);
            if (cached) {
              setPoolCache(poolId, {
                trashedFiles: cached.trashedFiles.some((f) => f.id === file.id)
                  ? cached.trashedFiles
                  : [file, ...cached.trashedFiles],
              });
            }
          }
        }
      });
    },
    [selectedIds, runPendingOp, loadTrashFiles, loadClusterData, surfaceWorkspaceError]
  );

  const handleDeleteFolder = useCallback(
    async (folder: ClientFolder) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      const folderPrefix = folder.virtualPath === '/' ? '/' : `${folder.virtualPath}/`;
      const removedFolders = foldersRef.current.filter(
        (f) => f.id === folder.id || f.virtualPath.startsWith(folderPrefix)
      );
      const removedFiles = filesRef.current.filter((f) => f.virtualPath.startsWith(folderPrefix));
      const wasSelected = selectedIds.has(folder.id);

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

      await runPendingOp(async () => {
        const result = await deleteFolderRequest(folder);
        if (result.ok) {
          invalidateShareInspectCache();
          if (result.navigateParent !== undefined) {
            if (activePoolIdRef.current === poolId) {
              handleNavigate(result.navigateParent);
            }
            await loadFiles(result.navigateParent, poolId);
          } else {
            await loadFiles(currentPathRef.current, poolId);
          }
        } else {
          if (activePoolIdRef.current === poolId) {
            setFolders((prev) => {
              const existingIds = new Set(prev.map((f) => f.id));
              const toRestore = removedFolders.filter((f) => !existingIds.has(f.id));
              return toRestore.length > 0 ? [...prev, ...toRestore] : prev;
            });
            setFiles((prev) => {
              const existingIds = new Set(prev.map((f) => f.id));
              const toRestore = removedFiles.filter((f) => !existingIds.has(f.id));
              return toRestore.length > 0 ? [...prev, ...toRestore] : prev;
            });
            if (wasSelected) {
              setSelectedIds((prev) => new Set(prev).add(folder.id));
            }
            surfaceWorkspaceError('handleDeleteFolder', result.error, 'Failed to delete folder');
          } else {
            const cached = getPoolCache(poolId);
            if (cached) {
              const existingFolderIds = new Set(cached.folders.map((f) => f.id));
              const existingFileIds = new Set(cached.files.map((f) => f.id));
              setPoolCache(poolId, {
                folders: [...cached.folders, ...removedFolders.filter((f) => !existingFolderIds.has(f.id))],
                files: [...cached.files, ...removedFiles.filter((f) => !existingFileIds.has(f.id))],
              });
            }
          }
        }
      });
    },
    [selectedIds, runPendingOp, handleNavigate, loadFiles, surfaceWorkspaceError]
  );

  const executeDeleteBatch = useCallback(
    async (
      navMode: 'files' | 'trash',
      selectedFolders: ClientFolder[],
      selectedFilesList: ClientFileRecord[]
    ) => {
      setWorkspaceError(null);
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
          const failed = results.filter((r) => !r.ok);
          if (results.some((r) => r.ok)) {
            invalidateShareInspectCache();
          }
          if (failed.length > 0) {
            if (activePoolIdRef.current === poolId) {
              setTrashedFiles(prevTrashed);
              setSelectedIds(prevSelected);
              surfaceWorkspaceError(
                'executeDeleteBatch.permanent',
                failed[0].error,
                'Some files could not be permanently deleted'
              );
            } else {
              setPoolCache(poolId, { trashedFiles: prevTrashed });
            }
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

          for (const res of folderResults) {
            if (res.ok && res.navigateParent !== undefined) {
              nextPath = res.navigateParent;
            }
          }
          const failedFolder = folderResults.find((r) => !r.ok);
          const failedFile = fileResults.find((r) => !r.ok);
          if (folderResults.some((r) => r.ok) || fileResults.some((r) => r.ok)) {
            invalidateShareInspectCache();
          }

          if (failedFolder || failedFile) {
            if (activePoolIdRef.current === poolId) {
              setFiles(prevFiles);
              setFolders(prevFolders);
              setSelectedIds(prevSelected);
              surfaceWorkspaceError(
                'executeDeleteBatch',
                failedFolder?.error || failedFile?.error,
                'Some items could not be deleted'
              );
            } else {
              setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
            }
          } else if (nextPath !== currentPathRef.current && activePoolIdRef.current === poolId) {
            handleNavigate(nextPath);
          }
          await Promise.all([loadFiles(nextPath, poolId), loadClusterData(poolId)]);
        }
      });
    },
    [selectedIds, markTrashStale, runPendingOp, loadTrashFiles, loadClusterData, handleNavigate, loadFiles, surfaceWorkspaceError]
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

  const refreshAfterMove = useCallback(
    async (poolId: number) => {
      if (currentNavRef.current === 'trash') {
        await Promise.all([
          loadFiles(currentPathRef.current, poolId),
          loadTrashFiles(poolId),
          loadClusterData(poolId),
        ]);
      } else {
        markTrashStale(poolId);
        await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
      }
    },
    [loadFiles, loadTrashFiles, loadClusterData, markTrashStale]
  );

  const handleMoveItems = useCallback(
    async (itemsToMove: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string) => {
      if (isSharePoolActive || itemsToMove.length === 0) return;
      const poolId = activePoolIdRef.current;
      const prevFiles = filesRef.current;
      const prevFolders = foldersRef.current;
      const prevClipboard = clipboard;
      const prevSelected = selectedIds;

      const fileById = new Map(prevFiles.map((f) => [f.id, f]));
      const folderById = new Map(prevFolders.map((f) => [f.id, f]));
      const { normalizedTarget: normTarget, validItems } = filterMovableItemsToPath(
        itemsToMove,
        targetFolderPath,
        (item) => (item.kind === 'folder' ? folderById.get(item.id) : fileById.get(item.id))?.virtualPath
      );
      if (validItems.length === 0) return;
      setWorkspaceError(null);

      const movedIds = new Set(validItems.map((i) => i.id));
      const destPrefix = normTarget === '/' ? '' : normTarget;
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
            json: { items: validItems, targetFolderPath: normTarget, poolId, conflictMode: 'reject' },
          });
          const data: unknown = await res.json().catch(() => ({}));
          const isStillActive = activePoolIdRef.current === poolId;
          if (res.status === 409 && isMoveConflictPayload(data)) {
            if (isStillActive) {
              setFiles(prevFiles);
              setFolders(prevFolders);
              setClipboard(prevClipboard);
              setSelectedIds(prevSelected);
              setPendingMoveConflict({
                items: validItems,
                targetFolderPath: normTarget,
                poolId,
                conflicts: data.conflicts,
                cleanCount: typeof data.cleanCount === 'number' ? data.cleanCount : 0,
              });
            } else {
              setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
            }
            return;
          }
          if (res.ok) {
            invalidateShareInspectCache();
            const results = parseItemOperationResults(data);
            const failed = results.filter((r) => !r.success);
            const anySucceeded = results.some((r) => r.success && !r.skipped);
            if (anySucceeded && isStillActive) {
              setClipboard(applyMoveResultsToClipboard(prevClipboard, poolId, results));
            }
            if (failed.length > 0) {
              if (!anySucceeded && isStillActive) {
                setClipboard(prevClipboard);
              }
              if (isStillActive) {
                setFiles(prevFiles);
                setFolders(prevFolders);
                setSelectedIds(prevSelected);
                surfaceWorkspaceError('handleMoveItems', failed[0].error, 'Some items could not be moved');
              } else {
                setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
              }
            }
            await refreshAfterMove(poolId);
          } else {
            if (isStillActive) {
              setFiles(prevFiles);
              setFolders(prevFolders);
              setClipboard(prevClipboard);
              setSelectedIds(prevSelected);
              surfaceWorkspaceError('handleMoveItems', data, 'Failed to move items');
            } else {
              setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
            }
          }
        } catch (err) {
          if (activePoolIdRef.current === poolId) {
            setFiles(prevFiles);
            setFolders(prevFolders);
            setClipboard(prevClipboard);
            setSelectedIds(prevSelected);
            surfaceWorkspaceError('handleMoveItems', err, 'Failed to move items');
          } else {
            setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
          }
        }
      });
    },
    [
      isSharePoolActive,
      clipboard,
      selectedIds,
      runPendingOp,
      refreshAfterMove,
      surfaceWorkspaceError,
    ]
  );

  const handleResolveMoveConflict = useCallback(
    async (mode: MoveConflictResolutionMode) => {
      if (!pendingMoveConflict || resolvingMoveConflictRef.current) return;
      resolvingMoveConflictRef.current = true;
      const { items, targetFolderPath, poolId } = pendingMoveConflict;
      setIsResolvingMoveConflict(true);
      setPendingMoveConflict((prev) => (prev ? { ...prev, errorMessage: null } : prev));
      setWorkspaceError(null);

      await runPendingOp(async () => {
        try {
          const res = await client.api.items.move.$post({
            json: { items, targetFolderPath, poolId, conflictMode: mode },
          });
          const isStillActive = activePoolIdRef.current === poolId;
          if (res.ok) {
            invalidateShareInspectCache();
            const data = await res.json().catch(() => ({}));
            const results = parseItemOperationResults(data);
            const failed = results.filter((r) => !r.success);
            if (isStillActive) {
              setClipboard((prev) => applyMoveResultsToClipboard(prev, poolId, results));
              setSelectedIds(new Set());
              if (failed.length > 0) {
                surfaceWorkspaceError(
                  'handleResolveMoveConflict',
                  failed[0].error,
                  'Some items could not be moved'
                );
              }
              setPendingMoveConflict(null);
            }
            await refreshAfterMove(poolId);
          } else if (isStillActive) {
            const msg = await readResponseError(res, 'Failed to move items');
            setPendingMoveConflict((prev) => (prev ? { ...prev, errorMessage: msg } : prev));
          }
        } catch (err) {
          if (activePoolIdRef.current === poolId) {
            const msg = extractErrorMessage(err, 'Failed to move items');
            setPendingMoveConflict((prev) => (prev ? { ...prev, errorMessage: msg } : prev));
          }
        } finally {
          resolvingMoveConflictRef.current = false;
          setIsResolvingMoveConflict(false);
        }
      });
    },
    [pendingMoveConflict, runPendingOp, refreshAfterMove, surfaceWorkspaceError]
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
      setWorkspaceError(null);

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
            const error = res.ok ? undefined : await readResponseError(res, 'Failed to delete folder');
            return { ok: res.ok, error, folder, fPath };
          });

          const fileResults = await runWithConcurrency(trashedFilesList, 6, async (file) => {
            const res = await client.api.files[':id'].trash.$post({
              param: { id: file.id },
            });
            const error = res.ok ? undefined : await readResponseError(res, 'Failed to move file to trash');
            return { ok: res.ok, error, file };
          });

          const trashedIds = new Set<string>();
          let firstError: string | undefined;
          for (const fr of folderResults) {
            if (fr.ok) {
              trashedIds.add(fr.folder.id);
              if (
                fr.fPath &&
                (effectivePath === fr.fPath || effectivePath.startsWith(fr.fPath + '/'))
              ) {
                effectivePath = getParentDir(fr.fPath);
              }
            } else if (!firstError) {
              firstError = fr.error;
            }
          }
          for (const fr of fileResults) {
            if (fr.ok) {
              trashedIds.add(fr.file.id);
            } else if (!firstError) {
              firstError = fr.error;
            }
          }

          const isStillActive = activePoolIdRef.current === poolId;
          if (trashedIds.size > 0) {
            invalidateShareInspectCache();
          }
          if (trashedIds.size < activeItems.length) {
            if (isStillActive) {
              setFiles(prevFiles);
              setFolders(prevFolders);
              setSelectedIds(prevSelected);
              setClipboard(prevClipboard);
              surfaceWorkspaceError(
                'handleTrashItems',
                firstError ?? null,
                'Some items could not be moved to trash'
              );
            } else {
              setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
            }
          } else if (trashedIds.size > 0 && effectivePath !== currentPathRef.current && isStillActive) {
            handleNavigate(effectivePath);
          }

          if (currentNavRef.current === 'trash') {
            await Promise.all([loadFiles(effectivePath, poolId), loadTrashFiles(poolId), loadClusterData(poolId)]);
          } else {
            markTrashStale(poolId);
            await Promise.all([loadFiles(effectivePath, poolId), loadClusterData(poolId)]);
          }
        } catch (err) {
          if (activePoolIdRef.current === poolId) {
            setFiles(prevFiles);
            setFolders(prevFolders);
            setSelectedIds(prevSelected);
            setClipboard(prevClipboard);
            surfaceWorkspaceError('handleTrashItems', err, 'Some items could not be moved to trash');
          } else {
            setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
          }
        }
      });
    },
    [
      selectedIds,
      clipboard,
      runPendingOp,
      handleNavigate,
      loadFiles,
      loadTrashFiles,
      loadClusterData,
      markTrashStale,
      surfaceWorkspaceError,
    ]
  );

  const handleCopyItems = useCallback(
    async (itemsToCopy: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string) => {
      if (itemsToCopy.length === 0) return;
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      await runPendingOp(async () => {
        try {
          const res = await client.api.items.copy.$post({
            json: { items: itemsToCopy, targetFolderPath, poolId },
          });
          const data = await res.json().catch(() => ({}));
          const isStillActive = activePoolIdRef.current === poolId;
          if (res.ok) {
            invalidateShareInspectCache();
            const results = parseItemOperationResults(data);
            const failed = results.filter((r) => !r.success);
            if (isStillActive) {
              if (failed.length > 0) {
                surfaceWorkspaceError('handleCopyItems', failed[0].error, 'Some items could not be copied');
              }
              setSelectedIds(new Set());
            }
            await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
          } else if (isStillActive) {
            surfaceWorkspaceError('handleCopyItems', data, 'Failed to copy items');
          }
        } catch (err) {
          if (activePoolIdRef.current === poolId) {
            surfaceWorkspaceError('handleCopyItems', err, 'Failed to copy items');
          }
        }
      });
    },
    [loadFiles, loadClusterData, runPendingOp, surfaceWorkspaceError]
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
      const poolId = activePoolIdRef.current;

      if (kind === 'pool') {
        const targetPoolId = Number(id);
        const prevPoolName = poolsRef.current.find((p) => p.id === targetPoolId)?.name;
        setPools((prev) => prev.map((p) => (p.id === targetPoolId ? { ...p, name: newName } : p)));
        return await runPendingOp(async () => {
          try {
            const res = await client.api.pools[':id'].$patch({
              param: { id },
              json: { name: newName },
            });
            if (res.ok) {
              invalidateShareInspectCache();
              await loadClusterData(poolId);
              return;
            }
            if (prevPoolName !== undefined) {
              setPools((prev) => prev.map((p) => (p.id === targetPoolId ? { ...p, name: prevPoolName } : p)));
            }
            const errMsg = await readResponseError(res, 'Failed to rename pool');
            reportDevError('handleRename.pool', errMsg);
            throw Object.assign(new Error(errMsg), { handled: true });
          } catch (err) {
            if (prevPoolName !== undefined) {
              setPools((prev) => prev.map((p) => (p.id === targetPoolId ? { ...p, name: prevPoolName } : p)));
            }
            if (!(err instanceof Error && 'handled' in err)) {
              reportDevError('handleRename.pool', err);
            }
            throw err instanceof Error ? err : new Error(String(err));
          }
        });
      }

      const prevFiles = filesRef.current;
      const prevFolders = foldersRef.current;
      const prevTrashed = trashedFilesRef.current;
      const targetPath = currentPathRef.current;
      const wasTrashView = currentNavRef.current === 'trash';

      const prevFolder = kind === 'folder' ? prevFolders.find((f) => f.id === id) : undefined;
      const prevFile =
        kind === 'file'
          ? prevFiles.find((f) => f.id === id) ?? prevTrashed.find((f) => f.id === id)
          : undefined;

      if (kind === 'folder') {
        if (prevFolder) {
          const parentPath = getParentDir(prevFolder.virtualPath);
          const candidatePath = (parentPath === '/' ? '' : parentPath) + '/' + newName;
          if (prevFolders.some((f) => f.id !== id && f.virtualPath === candidatePath)) {
            throw new Error(`A folder named "${newName}" already exists in this directory`);
          }
          if (prevFiles.some((f) => !f.isTrashed && f.virtualPath === candidatePath)) {
            throw new Error(`A file named "${newName}" already exists in this directory`);
          }
        }
      } else if (prevFile && !prevFile.isTrashed) {
        const parentPath = getParentDir(prevFile.virtualPath);
        const candidatePath = (parentPath === '/' ? '' : parentPath) + '/' + newName;
        if (prevFolders.some((f) => f.virtualPath === candidatePath)) {
          throw new Error(`A folder named "${newName}" already exists in this directory`);
        }
        if (prevFiles.some((f) => !f.isTrashed && f.id !== id && f.virtualPath === candidatePath)) {
          throw new Error(`A file named "${newName}" already exists in this directory`);
        }
      }

      if (kind === 'file') {
        setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name: newName } : f)));
        setTrashedFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name: newName } : f)));
      } else {
        setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: newName } : f)));
      }

      const rollbackItemRename = () => {
        if (activePoolIdRef.current === poolId) {
          if (kind === 'file' && prevFile) {
            setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name: prevFile.name } : f)));
            setTrashedFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name: prevFile.name } : f)));
          } else if (kind === 'folder' && prevFolder) {
            setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: prevFolder.name } : f)));
          }
        } else {
          const cached = getPoolCache(poolId);
          if (cached) {
            if (kind === 'file' && prevFile) {
              setPoolCache(poolId, {
                files: cached.files.map((f) => (f.id === id ? { ...f, name: prevFile.name } : f)),
                trashedFiles: cached.trashedFiles.map((f) =>
                  f.id === id ? { ...f, name: prevFile.name } : f
                ),
              });
            } else if (kind === 'folder' && prevFolder) {
              setPoolCache(poolId, {
                folders: cached.folders.map((f) => (f.id === id ? { ...f, name: prevFolder.name } : f)),
              });
            }
          }
        }
      };

      return await runPendingOp(async () => {
        try {
          const res = await client.api.items.rename.$post({
            json: { kind, id, name: newName, poolId },
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            invalidateShareInspectCache();
            const oldFolderP =
              ('oldPath' in data ? (data.oldPath as string) : null) ||
              ('oldVirtualPath' in data ? (data.oldVirtualPath as string) : null);
            const newFolderP =
              ('newPath' in data ? (data.newPath as string) : null) ||
              ('newVirtualPath' in data ? (data.newVirtualPath as string) : null);
            const renamedId = kind === 'folder' && newFolderP ? `${poolId}:${newFolderP}` : id;

            if (kind === 'folder' && oldFolderP && newFolderP) {
              if (activePoolIdRef.current === poolId) {
                setClipboard((prev) => {
                  if (!prev) return prev;
                  let changed = false;
                  const nextItems = prev.items.map((item) => {
                    const remapped = remapPathPrefix(item.virtualPath, oldFolderP, newFolderP);
                    if (remapped === null) return item;
                    changed = true;
                    const isExactFolder = item.kind === 'folder' && item.virtualPath === oldFolderP;
                    return {
                      ...item,
                      virtualPath: remapped,
                      ...(isExactFolder ? { name: newName } : {}),
                      ...(item.kind === 'folder' ? { id: `${poolId}:${remapped}` } : {}),
                    };
                  });
                  return changed ? { ...prev, items: nextItems } : prev;
                });
              }
            } else if (kind === 'file') {
              if (activePoolIdRef.current === poolId) {
                setClipboard((prev) => {
                  if (!prev) return prev;
                  let changed = false;
                  const nextItems = prev.items.map((item) => {
                    if (item.kind !== 'file' || item.id !== id) return item;
                    changed = true;
                    const parentPath = getParentDir(item.virtualPath);
                    const nextVirtualPath =
                      newFolderP || (parentPath === '/' ? '' : parentPath) + '/' + newName;
                    return {
                      ...item,
                      name: newName,
                      virtualPath: nextVirtualPath,
                    };
                  });
                  return changed ? { ...prev, items: nextItems } : prev;
                });
              }
            }

            const isInsideRenamedFolder =
              kind === 'folder' &&
              Boolean(oldFolderP) &&
              (targetPath === oldFolderP || targetPath.startsWith(oldFolderP + '/'));

            if (isInsideRenamedFolder && oldFolderP) {
              const relativeSuffix = targetPath.slice(oldFolderP.length);
              const nextPath = `${newFolderP}${relativeSuffix}`;
              if (activePoolIdRef.current === poolId) {
                handleNavigate(nextPath);
              }
              await loadFiles(nextPath, poolId);
            } else {
              await Promise.all([
                loadFiles(targetPath, poolId),
                wasTrashView || currentNavRef.current === 'trash' ? loadTrashFiles(poolId) : Promise.resolve(),
              ]);
              if (activePoolIdRef.current === poolId && currentPathRef.current === targetPath) {
                setSelectedIds(new Set([renamedId]));
                setScrollRequest((prev) => ({ id: renamedId, seq: (prev?.seq ?? 0) + 1 }));
              }
            }
            return;
          }
          rollbackItemRename();
          const errMsg = ('error' in data ? (data.error as string) : null) || 'Failed to rename item';
          if (res.status !== 409) {
            reportDevError('handleRename', errMsg);
          }
          throw Object.assign(new Error(errMsg), { handled: true });
        } catch (err) {
          rollbackItemRename();
          if (!(err instanceof Error && 'handled' in err)) {
            reportDevError('handleRename', err);
          }
          throw err instanceof Error ? err : new Error(String(err));
        }
      });
    },
    [runPendingOp, loadFiles, loadTrashFiles, handleNavigate, loadClusterData]
  );

  const executeBatchRestore = useCallback(
    async (toRestore: ClientFileRecord[]) => {
      if (toRestore.length === 0) return;
      setWorkspaceError(null);
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
        const failed = results.filter((r) => !r.ok);
        if (results.some((r) => r.ok)) {
          invalidateShareInspectCache();
        }
        if (failed.length > 0) {
          if (activePoolIdRef.current === poolId) {
            setTrashedFiles(prevTrashed);
            setFiles(prevFiles);
            setSelectedIds(prevSelected);
            surfaceWorkspaceError(
              'executeBatchRestore',
              failed[0].error,
              'Some files could not be restored'
            );
          } else {
            setPoolCache(poolId, { trashedFiles: prevTrashed, files: prevFiles });
          }
        }
        await Promise.all([
          loadTrashFiles(poolId),
          loadFiles(currentPathRef.current, poolId),
          loadClusterData(poolId),
        ]);
      });
    },
    [selectedIds, runPendingOp, loadTrashFiles, loadFiles, loadClusterData, surfaceWorkspaceError]
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
    handleOpenNewFolder,
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
    handleOpenNewFolder,
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
        } else if (state.clipboard?.mode === 'cut') {
          e.preventDefault();
          setClipboard(null);
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

      if (
        e.key === 'Backspace' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        state.selectedIds.size === 0 &&
        state.currentNav === 'files' &&
        state.currentPath !== '/'
      ) {
        e.preventDefault();
        state.handleNavigate(getParentDir(state.currentPath));
        return;
      }

      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === 'n' || e.key === 'N')
      ) {
        if (!state.isSharePoolActive && state.currentNav === 'files') {
          e.preventDefault();
          state.handleOpenNewFolder();
        }
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
            state.handleNavigate(getParentDir(state.currentPath));
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
    setWorkspaceError(null);
    const poolId = activePoolIdRef.current;

    await runPendingOp(async () => {
      try {
        const res = await client.api.trash.empty.$delete({
          query: { poolId: String(poolId) },
        });
        if (res.ok) {
          invalidateShareInspectCache();
          if (activePoolIdRef.current === poolId) {
            setTrashedFiles([]);
            setSelectedIds(new Set());
            trashStaleRef.current = false;
          } else {
            setPoolCache(poolId, { trashedFiles: [], trashStale: false });
          }
          await Promise.all([loadTrashFiles(poolId), loadClusterData(poolId)]);
        } else {
          const msg = await readResponseError(res, 'Empty trash failed');
          throw Object.assign(new Error(msg), { handled: true });
        }
      } catch (err) {
        if (err instanceof Error && 'handled' in err) {
          throw err;
        }
        throw new Error(extractErrorMessage(err, 'Empty trash failed'));
      }
    });
  }, [runPendingOp, loadTrashFiles, loadClusterData]);

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
    [isSharePoolActive, runPendingOp, loadFiles, loadClusterData, surfaceWorkspaceError]
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
    [isSharePoolActive, runPendingOp, loadFiles, loadClusterData]
  );

  const handleDisableAccount = useCallback(
    async (accountId: string) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      try {
        const res = await client.api.accounts[':id'].disable.$post({
          param: { id: accountId },
        });
        if (res.ok) {
          invalidateShareInspectCache();
          await loadClusterData(poolId);
        } else {
          const msg = await readResponseError(res, 'Failed to disable drive');
          if (activePoolIdRef.current === poolId) {
            surfaceWorkspaceError('handleDisableAccount', msg, 'Failed to disable drive');
          }
        }
      } catch (err) {
        if (activePoolIdRef.current === poolId) {
          surfaceWorkspaceError('handleDisableAccount', err, 'Failed to disable drive');
        }
      }
    },
    [loadClusterData, surfaceWorkspaceError]
  );

  const handleEnableAccount = useCallback(
    async (accountId: string) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      try {
        const res = await client.api.accounts[':id'].enable.$post({
          param: { id: accountId },
        });
        if (res.ok) {
          invalidateShareInspectCache();
          await loadClusterData(poolId);
        } else {
          const msg = await readResponseError(res, 'Failed to enable drive');
          if (activePoolIdRef.current === poolId) {
            surfaceWorkspaceError('handleEnableAccount', msg, 'Failed to enable drive');
          }
        }
      } catch (err) {
        if (activePoolIdRef.current === poolId) {
          surfaceWorkspaceError('handleEnableAccount', err, 'Failed to enable drive');
        }
      }
    },
    [loadClusterData, surfaceWorkspaceError]
  );

  const handleOpenDriveAction = useCallback(
    (account: AccountItem) => {
      const poolId = activePoolIdRef.current;
      if (loadedTrashPoolIdRef.current !== poolId || trashStaleRef.current) {
        void loadTrashFiles(poolId);
      }
      setDriveActionModal({
        isOpen: true,
        account,
        isLoading: false,
        errorMessage: null,
      });
    },
    [loadTrashFiles]
  );

  async function handleExecuteDriveAction() {
    const { account } = driveActionModal;
    if (!account || executingDriveActionRef.current) return;
    executingDriveActionRef.current = true;
    const poolId = activePoolIdRef.current;

    setDriveActionModal((prev) => ({ ...prev, isLoading: true, errorMessage: null }));

    try {
      const res = await client.api.accounts[':id'].$delete({
        param: { id: account.id },
      });
      const data = await res.json().catch(() => ({}));
      const isStillActive = activePoolIdRef.current === poolId;
      if (res.ok) {
        invalidateShareInspectCache();
        setDriveActionModal((prev) => ({ ...prev, isOpen: false, isLoading: false }));
        if (isStillActive) {
          await Promise.all([loadClusterData(poolId), loadFiles(currentPathRef.current, poolId)]);
        } else {
          await Promise.all([loadClusterData(poolId), loadFiles('/', poolId)]);
        }
      } else if (isStillActive) {
        setDriveActionModal((prev) => ({
          ...prev,
          isLoading: false,
          errorMessage: ('error' in data ? (data.error as string) : null) || 'Failed to remove drive',
        }));
      } else {
        setDriveActionModal((prev) => ({ ...prev, isLoading: false }));
      }
    } catch (err) {
      if (activePoolIdRef.current === poolId) {
        setDriveActionModal((prev) => ({
          ...prev,
          isLoading: false,
          errorMessage: err instanceof Error ? err.message : String(err),
        }));
      } else {
        setDriveActionModal((prev) => ({ ...prev, isLoading: false }));
      }
    } finally {
      executingDriveActionRef.current = false;
    }
  }

  const driveFiles = useMemo(() => {
    const targetAccountId = driveActionModal.account?.id;
    if (!targetAccountId) return [];
    const byId = new Map<string, ClientFileRecord>();
    for (const f of files) {
      if (f.accountId === targetAccountId) byId.set(f.id, f);
    }
    for (const f of trashedFiles) {
      if (f.accountId === targetAccountId && !byId.has(f.id)) byId.set(f.id, f);
    }
    return Array.from(byId.values());
  }, [files, trashedFiles, driveActionModal.account?.id]);
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
  }, [handleSelectPool, loadClusterData, loadFiles, runPendingOp, surfaceWorkspaceError]);

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
    [handleSelectPool, loadClusterData, loadFiles, runPendingOp, surfaceWorkspaceError]
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
      activePoolIdRef.current = result.sharePoolId;
      currentNavRef.current = 'files';
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
    setWorkspaceError(null);
    const poolId = activePoolIdRef.current;

    await runPendingOp(async () => {
      try {
        const res = await client.api.pools[':id']['clear-share'].$post({
          param: { id: String(poolId) },
        });
        if (res.ok) {
          invalidateShareInspectCache();
          const nextPath = '/';
          if (activePoolIdRef.current === poolId) {
            setFiles([]);
            setFolders([]);
            setShareLinksByBatch({});
            setSelectedIds(new Set());
            if (currentPathRef.current !== nextPath) {
              handleNavigate(nextPath);
            }
          } else {
            setPoolCache(poolId, {
              files: [],
              folders: [],
              shareLinksByBatch: {},
            });
          }
          if (currentNavRef.current === 'trash') {
            await Promise.all([loadFiles(nextPath, poolId), loadTrashFiles(poolId), loadClusterData(poolId)]);
          } else {
            markTrashStale(poolId);
            await Promise.all([loadFiles(nextPath, poolId), loadClusterData(poolId)]);
          }
        } else {
          const msg = await readResponseError(res, 'Failed to clear Share Pool');
          throw Object.assign(new Error(msg), { handled: true });
        }
      } catch (err) {
        if (err instanceof Error && 'handled' in err) {
          throw err;
        }
        throw new Error(extractErrorMessage(err, 'Failed to clear Share Pool'));
      }
    });
  }, [handleNavigate, loadFiles, loadTrashFiles, loadClusterData, markTrashStale, runPendingOp]);

  const handleCopyBatchLinks = useCallback(async (batchFolderName: string): Promise<boolean> => {
    const links = shareLinksByBatchRef.current[batchFolderName] ?? [];
    const urls = links.map((l) => l.webViewLink).filter(Boolean);
    if (urls.length === 0) return false;

    const text = urls.join('\n');
    return await copyTextToClipboard(text);
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
    return selectedFiles.filter(
      (f) => idsSet.has(f.id) && f.accountId === moveFilesModalGroup.accountId
    );
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
      handleOpenDriveAction(acc);
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
    if (isModalActive()) return;
    if (droppedFiles.length > 0) {
      setStagedFiles(droppedFiles);
      setStagedEmptyFolders([]);
      setUploadTargetPath(undefined);
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
          onCopyItemsToPath={isSharePoolActive ? undefined : handleCopyItems}
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

        {workspaceError && (
          <div {...stylex.props(styles.workspaceErrorRegion)}>
            <div {...stylex.props(styles.workspaceErrorBanner)} role="alert">
              <div {...stylex.props(styles.workspaceErrorContent)}>
                <IconAlertTriangle size={16} {...stylex.props(styles.workspaceErrorIcon)} />
                <span {...stylex.props(styles.workspaceErrorText)}>{workspaceError}</span>
              </div>
              <button
                type="button"
                onClick={() => setWorkspaceError(null)}
                aria-label="Dismiss error"
                {...stylex.props(styles.workspaceErrorDismissBtn)}
              >
                <IconClose size={14} />
                <span>Dismiss</span>
              </button>
            </div>
          </div>
        )}

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
                onCopyItems={isSharePoolActive ? undefined : handleCopyItems}
                scrollRequest={scrollRequest}
                clipboard={isSharePoolActive ? null : clipboard}
                accounts={accountItems}
                onTransferFile={isSharePoolActive ? undefined : handleTransferFile}
                transferringFileIds={transferringFileIds}
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
                transferringFileIds={transferringFileIds}
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
              setUploadTargetPath(undefined);
            }}
            stagedFiles={stagedFiles}
            stagedEmptyFolders={stagedEmptyFolders}
            currentPath={uploadTargetPath ?? currentPath}
            accounts={accountItems}
            poolId={activePoolId}
            onUploadComplete={async () => {
              invalidateShareInspectCache();
              await Promise.all([loadClusterData(), loadFiles(currentPath)]);
            }}
            onClearFiles={() => {
              setStagedFiles([]);
              setStagedEmptyFolders([]);
              setUploadTargetPath(undefined);
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
              invalidateShareInspectCache();
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

        {pendingMoveConflict !== null && (
          <MoveConflictModal
            isOpen={pendingMoveConflict !== null}
            onClose={() => {
              if (!isResolvingMoveConflict) {
                setPendingMoveConflict(null);
              }
            }}
            targetFolderPath={pendingMoveConflict.targetFolderPath}
            conflicts={pendingMoveConflict.conflicts}
            cleanCount={pendingMoveConflict.cleanCount}
            onResolve={handleResolveMoveConflict}
            isSubmitting={isResolvingMoveConflict}
            errorMessage={pendingMoveConflict.errorMessage}
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
            account={driveActionModal.account}
            filesCount={driveFilesCount}
            totalBytes={driveTotalBytes}
            isLoading={driveActionModal.isLoading}
            errorMessage={driveActionModal.errorMessage}
          />
        )}
      </Suspense>
    </div>
  );
}

export default App;
