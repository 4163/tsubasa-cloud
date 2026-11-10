import React, { useEffect, useState, useCallback, useMemo } from 'react';
import * as stylex from '@stylexjs/stylex';
import { client } from './api.js';
import { colors, darkColors, radius, typography } from './tokens.stylex.js';
import { Header, type ThemeChoice } from './components/Header.js';
import { Sidebar, type AccountItem, type AccountTransferStats } from './components/Sidebar.js';
import { ActionPortal, type ActionPortalClipboard } from './components/ActionPortal.js';
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
  const [storage, setStorage] = useState<StorageOverview | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredAccount[]>([]);
  const [files, setFiles] = useState<ClientFileRecord[]>([]);
  const [folders, setFolders] = useState<ClientFolder[]>([]);

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
      if (isUploadDrawerOpen) setIsUploadDrawerOpen(false);
      if (isExternalChangesOpen) setIsExternalChangesOpen(false);
      if (isNewFolderOpen) setIsNewFolderOpen(false);
      if (confirmEmptyTrash) setConfirmEmptyTrash(false);

      setCurrentNav('files');
      setCurrentPath(targetPath);
      setSelectedIds(new Set());
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [
    currentPath,
    renameModalItem,
    isUploadDrawerOpen,
    isExternalChangesOpen,
    isNewFolderOpen,
    confirmEmptyTrash,
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

  const loadClusterData = useCallback(async () => {
    try {
      const storageRes = await client.api.storage.overview.$get();
      if (storageRes.ok) {
        setStorage(await storageRes.json());
      }

      const poolRes = await client.api.accounts.pool.$get();
      if (poolRes.ok) {
        const poolData = await poolRes.json();
        setDiscovered(poolData.accounts);
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Cluster offline');
    }
  }, []);

  const loadFiles = useCallback(async (path: string) => {
    try {
      const res = await client.api.files.$get({ query: { path } });
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files as ClientFileRecord[]);
        setFolders(data.folders as ClientFolder[]);
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Failed to query files');
    }
  }, []);

  const loadTrashFiles = useCallback(async () => {
    try {
      const res = await client.api.trash.$get();
      if (res.ok) {
        const data = await res.json();
        setTrashedFiles((data.files as ClientFileRecord[]) || []);
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Failed to query trash');
    }
  }, []);

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
          isUploadDrawerOpen ||
          isExternalChangesOpen ||
          confirmEmptyTrash ||
          isNewFolderOpen ||
          driveActionModal.isOpen
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
    isUploadDrawerOpen,
    isExternalChangesOpen,
    confirmEmptyTrash,
    isNewFolderOpen,
    driveActionModal.isOpen,
  ]);

  async function handleAuthorizeAccount(accountId: string) {
    showToast('Authorize link copied to clipboard. Paste it in your browser.');
  }

  async function handleImportOAuth(file: File) {
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
    setIsSyncing(true);
    showToast('Fetching changes from Google Drive...');
    try {
      const res = await client.api.sync.all.$post();
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
    const list = Array.from(fileList);
    if (list.length > 0) {
      setStagedFiles(list);
      setStagedEmptyFolders([]);
      setIsUploadDrawerOpen(true);
    }
  }

  const handleStageDroppedUpload = useCallback(
    (dropped: { files: Array<{ file: File; virtualPath: string }>; emptyFolders: string[] }) => {
      if (dropped.files.length > 0 || dropped.emptyFolders.length > 0) {
        setStagedFiles(dropped.files);
        setStagedEmptyFolders(dropped.emptyFolders);
        setIsUploadDrawerOpen(true);
      }
    },
    []
  );

  const handleDropExternalToPath = useCallback(
    async (targetPath: string, dataTransfer: DataTransfer) => {
      const extracted = await extractDataTransferEntries(dataTransfer, targetPath);
      if (extracted.files.length > 0 || extracted.emptyFolders.length > 0) {
        setStagedFiles(extracted.files);
        setStagedEmptyFolders(extracted.emptyFolders);
        setIsUploadDrawerOpen(true);
      }
    },
    []
  );

  useEffect(() => {
    const handleWindowDragOver = (e: DragEvent) => {
      if (currentNav === 'trash') return;
      if (e.dataTransfer?.types?.includes('application/x-tsubasa-items')) return;
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleWindowDrop = async (e: DragEvent) => {
      if (currentNav === 'trash') return;
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
  }, [currentNav, currentPath]);

  function handleOpenNewFolder() {
    setIsNewFolderOpen(true);
  }

  async function handleCreateFolder(folderName: string) {
    const newPath = (currentPath === '/' ? '' : currentPath) + '/' + folderName;
    try {
      const res = await client.api.folders.$post({
        json: { virtualPath: newPath, name: folderName },
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
        query: { virtualPath: folder.virtualPath },
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
      if (itemsToMove.length === 0) return;
      try {
        const res = await client.api.items.move.$post({
          json: { items: itemsToMove, targetFolderPath },
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
    [currentPath, loadFiles, loadTrashFiles, loadClusterData, showToast]
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
            query: { virtualPath: fPath },
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
    [currentPath, handleNavigate, loadFiles, loadTrashFiles, loadClusterData, showToast]
  );

  const handleCopyItems = useCallback(
    async (itemsToCopy: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string) => {
      if (itemsToCopy.length === 0) return;
      try {
        showToast(`Copying ${itemsToCopy.length} ${itemsToCopy.length === 1 ? 'item' : 'items'}...`);
        const res = await client.api.items.copy.$post({
          json: { items: itemsToCopy, targetFolderPath },
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
    [currentPath, loadFiles, loadClusterData, showToast]
  );

  const handleCutSelected = useCallback(() => {
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
  }, [selectedIds, currentNav, folders, files, showToast]);

  const handleCopySelected = useCallback(() => {
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
  }, [selectedIds, currentNav, folders, files, showToast]);

  const handlePaste = useCallback(() => {
    if (!clipboard || clipboard.items.length === 0 || currentNav === 'trash') return;
    if (clipboard.mode === 'cut') {
      handleMoveItems(clipboard.items, currentPath);
    } else {
      handleCopyItems(clipboard.items, currentPath);
    }
  }, [clipboard, currentNav, currentPath, handleMoveItems, handleCopyItems]);

  const handleOpenRenameSelected = useCallback(() => {
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
  }, [selectedIds, currentNav, folders, files, trashedFiles]);

  const handleRename = useCallback(
    async (kind: 'file' | 'folder', id: string, newName: string) => {
      try {
        const res = await client.api.items.rename.$post({
          json: { kind, id, name: newName },
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
      }
    },
    [currentPath, loadFiles, showToast, handleNavigate]
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
        if (selectedIds.size > 0 && !selectedIds.has('__parent__') && currentNav !== 'trash') {
          e.preventDefault();
          handleCutSelected();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (selectedIds.size > 0 && !selectedIds.has('__parent__') && currentNav !== 'trash') {
          e.preventDefault();
          handleCopySelected();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        if (clipboard && clipboard.items.length > 0 && currentNav !== 'trash') {
          e.preventDefault();
          handlePaste();
        }
        return;
      }

      if (e.key === 'F2') {
        if (selectedIds.size === 1 && !selectedIds.has('__parent__')) {
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
    currentPath,
    handleNavigate,
    handleCutSelected,
    handleCopySelected,
    handlePaste,
    handleOpenRenameSelected,
  ]);

  async function handleEmptyTrashExecute() {
    try {
      const res = await client.api.trash.empty.$delete();
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
  }, [discovered, storage, pendingDiscrepancies]);

  async function handleTransferFile(fileId: string, targetAccountId: string) {
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

  const actionableSelectedCount = useMemo(() => {
    return Array.from(selectedIds).filter((id) => id !== '__parent__').length;
  }, [selectedIds]);

  const selectedFiles = (currentNav === 'trash' ? trashedFiles : files).filter((f) => selectedIds.has(f.id));
  const selectedTotalBytes = selectedFiles.reduce((acc, f) => acc + (f.sizeBytes || 0), 0);
  const trashedTotalBytes = trashedFiles.reduce((acc, f) => acc + (f.sizeBytes || 0), 0);

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
        tsubasaUsedBytes={storage?.totalTsubasaUsedBytes ?? storage?.systemStorage?.systemBytesTotal ?? 0}
        poolHeadroomBytes={storage?.totalHeadroomBytes ?? 0}
        totalLimitBytes={storage?.totalLimitBytes ?? 0}
        clusterTransfer={storage?.clusterTransfer}
        currentNav={currentNav}
        onSelectNav={(nav) => setCurrentNav(nav)}
        onAuthorizeAccount={handleAuthorizeAccount}
        onRefreshStorage={loadClusterData}
        onOpenExternalChanges={(accId) => {
          setExternalChangesAccountId(accId);
          setIsExternalChangesOpen(true);
        }}
        onImportOAuth={handleImportOAuth}
        onDisableAccount={(acc) => handleDisableAccount(acc.id)}
        onEnableAccount={handleEnableAccount}
        onRemoveAccount={(acc) => handleOpenDriveAction(acc, 'remove')}
        isImporting={isImporting}
        isSyncing={isSyncing}
        isMobileOpen={isMobileOpen}
        onCloseMobile={() => setIsMobileOpen(false)}
        onDropItemsToRoot={(items) => handleMoveItems(items, '/')}
        onDropItemsToTrash={handleTrashItems}
        onDropExternalToRoot={(dt) => handleDropExternalToPath('/', dt)}
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
          trashedCount={trashedFiles.length}
          onEmptyTrash={() => setConfirmEmptyTrash(true)}
          selectedCount={actionableSelectedCount}
          selectedTotalBytes={selectedTotalBytes}
          onClearSelection={() => setSelectedIds(new Set())}
          onDeleteSelected={handleDeleteSelected}
          onRenamePrompt={handleOpenRenameSelected}
          onRestoreSelected={handleBatchRestore}
          onCutSelected={handleCutSelected}
          onCopySelected={handleCopySelected}
          clipboard={clipboard}
          onPaste={handlePaste}
          onMoveItemsToPath={handleMoveItems}
          onDropExternalToPath={handleDropExternalToPath}
        />

        <FileTable
          files={currentNav === 'trash' ? trashedFiles : files}
          folders={currentNav === 'trash' ? [] : folders}
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
          onDropFiles={(droppedFiles) => {
            if (droppedFiles.length > 0) {
              setStagedFiles(droppedFiles);
              setStagedEmptyFolders([]);
              setIsUploadDrawerOpen(true);
            }
          }}
          onStageDroppedUpload={handleStageDroppedUpload}
          onMoveItems={handleMoveItems}
          clipboard={clipboard}
          accounts={accountItems}
          onTransferFile={handleTransferFile}
          transferringFileId={transferringFileId}
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

      <ConfirmPurgeModal
        isOpen={confirmEmptyTrash && currentNav === 'trash'}
        onClose={() => setConfirmEmptyTrash(false)}
        onConfirm={handleEmptyTrashExecute}
        itemCount={trashedFiles.length}
        totalBytes={trashedTotalBytes}
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
