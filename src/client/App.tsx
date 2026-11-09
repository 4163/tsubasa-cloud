import React, { useEffect, useState, useCallback } from 'react';
import * as stylex from '@stylexjs/stylex';
import { client } from './api.js';
import { colors, darkColors, layout, radius, typography } from './tokens.stylex.js';
import { Header, type ThemeChoice } from './components/Header.js';
import { Sidebar, type AccountItem } from './components/Sidebar.js';
import { ActionPortal } from './components/ActionPortal.js';
import { FileTable, type ClientFileRecord, type ClientFolder } from './components/FileTable.js';
import { DitherDivider } from './components/DitherDivider.js';
import { UploadDrawer } from './components/UploadDrawer.js';
import { ExternalChangesDrawer } from './components/ExternalChangesDrawer.js';
import { NewFolderModal } from './components/NewFolderModal.js';
import { ConfirmPurgeModal } from './components/ConfirmPurgeModal.js';
import { ConfirmDriveActionModal } from './components/ConfirmDriveActionModal.js';

interface HealthData {
  status: string;
  service: string;
  timestamp: number;
}

export interface AccountTransferStats {
  accountId: string;
  rollingWindowMs: number;
  uploadedBytes24h: number;
  remainingUploadBytes24h: number;
  dailyUploadLimitBytes: number;
  isUploadRateLimited: boolean;
  downloadedBytes24h: number;
  oldestTransferTimestamp: number | null;
  latestTransferTimestamp: number | null;
  nextResetMs: number | null;
  fullResetMs: number | null;
  nextExpiringBytes: number | null;
  activeTransferCount24h: number;
}

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
  alertBanner: {
    backgroundColor: colors.dangerSurface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.danger,
    color: colors.danger,
    paddingTop: '6px',
    paddingBottom: '6px',
    paddingLeft: '16px',
    paddingRight: '16px',
    fontSize: '12px',
    fontWeight: '600',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    gap: '12px',
  },
  bannerActionBtn: {
    height: '24px',
    paddingLeft: '10px',
    paddingRight: '10px',
    borderRadius: '4px',
    backgroundColor: colors.danger,
    color: '#ffffff',
    borderWidth: '0px',
    fontSize: '11px',
    fontWeight: '600',
    cursor: 'pointer',
    flexShrink: 0,
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
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.16)',
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
  const [health, setHealth] = useState<HealthData | null>(null);
  const [storage, setStorage] = useState<StorageOverview | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredAccount[]>([]);
  const [files, setFiles] = useState<ClientFileRecord[]>([]);
  const [folders, setFolders] = useState<ClientFolder[]>([]);

  const [currentPath, setCurrentPath] = useState<string>('/');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [currentNav, setCurrentNav] = useState<'files' | 'trash'>('files');

  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [isMobileOpen, setIsMobileOpen] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [transferringFileId, setTransferringFileId] = useState<string | null>(null);
  const [driveActionModal, setDriveActionModal] = useState<{
    isOpen: boolean;
    action: 'disable' | 'remove';
    account: AccountItem | null;
    isLoading: boolean;
    errorMessage: string | null;
  }>({
    isOpen: false,
    action: 'disable',
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
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [isUploadDrawerOpen, setIsUploadDrawerOpen] = useState<boolean>(false);

  const [isExternalChangesOpen, setIsExternalChangesOpen] = useState<boolean>(false);
  const [externalChangesAccountId, setExternalChangesAccountId] = useState<string | undefined>(undefined);

  const [trashedFiles, setTrashedFiles] = useState<ClientFileRecord[]>([]);
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState<boolean>(false);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState<boolean>(false);
  const [pendingDiscrepancies, setPendingDiscrepancies] = useState<Record<string, boolean>>({});

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 4000);
  }, []);

  const checkAccountDiscrepancies = useCallback(async (accountList: DiscoveredAccount[]) => {
    const authAccounts = accountList.filter((a) => a.authorized);
    await Promise.all(
      authAccounts.map(async (acc) => {
        try {
          const res = await fetch(`/api/sync/external-changes/${encodeURIComponent(acc.accountId)}`);
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
      const healthRes = await client.api.health.$get();
      if (healthRes.ok) {
        setHealth(await healthRes.json());
      }

      const storageRes = await client.api.storage.overview.$get();
      if (storageRes.ok) {
        setStorage(await storageRes.json());
      }

      const poolRes = await client.api.accounts.pool.$get();
      if (poolRes.ok) {
        const poolData = await poolRes.json();
        setDiscovered(poolData.accounts);
        checkAccountDiscrepancies(poolData.accounts);
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Cluster offline');
    }
  }, [checkAccountDiscrepancies]);

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
      const res = await fetch('/api/trash');
      if (res.ok) {
        const data = await res.json();
        setTrashedFiles(data.files || []);
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
      if (isMulti) {
        const next = new Set(prev);
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
        return new Set(ids);
      }
      const next = new Set(prev);
      if (mode === 'add') {
        for (const id of ids) next.add(id);
      } else if (mode === 'toggle') {
        for (const id of ids) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
      }
      return next;
    });
  }, []);

  function handleNavigate(path: string) {
    setCurrentPath(path);
    setSelectedIds(new Set());
  }

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
      setIsUploadDrawerOpen(true);
    }
  }

  function handleOpenNewFolder() {
    setIsNewFolderOpen(true);
  }

  async function handleCreateFolder(folderName: string) {
    const newPath = (currentPath === '/' ? '' : currentPath) + '/' + folderName;
    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ virtualPath: newPath, name: folderName }),
      });
      if (res.ok) {
        showToast(`Created folder "${folderName}".`);
        await loadFiles(currentPath);
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(err.error || 'Failed to create folder');
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
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/restore`, { method: 'POST' });
      if (res.ok) {
        showToast(`Restored "${file.name}".`);
        await loadTrashFiles();
        await loadFiles(currentPath);
        await loadClusterData();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(err.error || 'Restore failed');
      }
    } catch (err) {
      setErrorNotice(`Restore error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handlePermanentDelete(file: ClientFileRecord) {
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/permanent`, { method: 'DELETE' });
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
        setErrorNotice(err.error || 'Delete failed');
      }
    } catch (err) {
      setErrorNotice(`Delete error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleDeleteFolder(folder: ClientFolder) {
    try {
      const res = await fetch(`/api/folders?virtualPath=${encodeURIComponent(folder.virtualPath)}`, {
        method: 'DELETE',
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
          setCurrentPath(parent);
          await loadFiles(parent);
        } else {
          await loadFiles(currentPath);
        }
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(err.error || 'Failed to delete folder');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteSelected() {
    if (selectedIds.size === 0) return;
    const idsToDelete = new Set(selectedIds);
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

      if (e.key === 'Escape') {
        if (selectedIds.size > 0) {
          e.preventDefault();
          setSelectedIds(new Set());
        }
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
        e.preventDefault();
        handleDeleteSelected();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, folders, files, trashedFiles, currentNav]);

  async function handleEmptyTrashExecute() {
    try {
      const res = await fetch('/api/trash/empty', { method: 'DELETE' });
      if (res.ok) {
        setConfirmEmptyTrash(false);
        showToast('Trash emptied. Storage permanently reclaimed.');
        await loadTrashFiles();
        await loadClusterData();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(err.error || 'Empty trash failed');
      }
    } catch (err) {
      setErrorNotice(`Empty trash error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Aggregate account list merging discovered with storage overview
  const accountItems: AccountItem[] = discovered.map((d) => {
    const summary = storage?.accounts.find((a) => a.id === d.accountId);
    const quotaUsed = summary?.quotaUsedBytes ?? 0;
    const usableLimit = summary?.usableLimitBytes ?? (d.authorized ? 15356127360 : 0);
    const isBreached = quotaUsed > usableLimit;
    const hasDiscrepancy = Boolean(pendingDiscrepancies[d.accountId]);
    const hasPendingChanges = isBreached || hasDiscrepancy;

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
    };
  });

  async function handleTransferFile(fileId: string, targetAccountId: string) {
    const file = files.find((f) => f.id === fileId);
    const targetAcc = accountItems.find((a) => a.id === targetAccountId);
    const targetName = targetAcc?.displayName || targetAccountId;
    setTransferringFileId(fileId);
    try {
      const res = await fetch('/api/sync/rebalance/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, targetAccountId }),
      });
      if (res.ok) {
        showToast(`Transferred "${file?.name || fileId}" to ${targetName}.`);
        await loadFiles(currentPath);
        await loadClusterData();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(err.error || 'Failed to transfer file');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferringFileId(null);
    }
  }

  async function handleDisableAccount(accountId: string) {
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/disable`, {
        method: 'POST',
      });
      if (res.ok) {
        showToast('Drive disabled. Excluded from storage pool.');
        await loadClusterData();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(err.error || 'Failed to disable drive');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleEnableAccount(accountId: string) {
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/enable`, {
        method: 'POST',
      });
      if (res.ok) {
        showToast('Drive re-enabled in storage pool.');
        await loadClusterData();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(err.error || 'Failed to enable drive');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    }
  }

  function handleOpenDriveAction(account: AccountItem, action: 'disable' | 'remove') {
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
      const res = await fetch(`/api/accounts/${encodeURIComponent(account.id)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setDriveActionModal((prev) => ({ ...prev, isOpen: false, isLoading: false }));
        const filesMoved = data.filesMoved ?? 0;
        showToast(`Drive removed. Evacuated ${filesMoved} ${filesMoved === 1 ? 'file' : 'files'}.`);
        await loadClusterData();
        await loadFiles(currentPath);
      } else {
        setDriveActionModal((prev) => ({
          ...prev,
          isLoading: false,
          errorMessage: data.error || 'Failed to remove drive',
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

  const breachedAccounts = accountItems.filter((a) => a.quotaUsedBytes > a.usableLimitBytes);

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

        {breachedAccounts.length > 0 && (
          <div {...stylex.props(styles.alertBanner)}>
            <span>
              Warning: {breachedAccounts.length} account has breached the 750 MB reserve ceiling (&gt;14.25 GB). Incoming Gmail may fail.
            </span>
            <button
              type="button"
              {...stylex.props(styles.bannerActionBtn)}
              onClick={() => {
                setExternalChangesAccountId(breachedAccounts[0].id);
                setIsExternalChangesOpen(true);
              }}
            >
              Resolve external modifications
            </button>
          </div>
        )}

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
          selectedCount={selectedIds.size}
          selectedTotalBytes={selectedTotalBytes}
          onClearSelection={() => setSelectedIds(new Set())}
          onDeleteSelected={handleDeleteSelected}
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
              setIsUploadDrawerOpen(true);
            }
          }}
          accounts={accountItems}
          onTransferFile={handleTransferFile}
          transferringFileId={transferringFileId}
        />
      </div>

      <UploadDrawer
        isOpen={isUploadDrawerOpen}
        onClose={() => setIsUploadDrawerOpen(false)}
        stagedFiles={stagedFiles}
        currentPath={currentPath}
        accounts={accountItems}
        onUploadComplete={async () => {
          await loadClusterData();
          await loadFiles(currentPath);
          showToast('Upload finished. Cluster updated.');
        }}
        onClearFiles={() => setStagedFiles([])}
      />

      <ExternalChangesDrawer
        isOpen={isExternalChangesOpen}
        onClose={() => {
          setIsExternalChangesOpen(false);
          setExternalChangesAccountId(undefined);
        }}
        accounts={accountItems
          .filter((a) => a.hasPendingChanges || (externalChangesAccountId && a.id === externalChangesAccountId && pendingDiscrepancies[a.id] !== false))
          .map((a) => ({ id: a.id, displayName: a.displayName, email: a.email }))}
        initialAccountId={externalChangesAccountId}
        onResolved={async () => {
          await loadClusterData();
          await loadFiles(currentPath);
          showToast('Discrepancies updated.');
        }}
      />

      <NewFolderModal
        isOpen={isNewFolderOpen}
        onClose={() => setIsNewFolderOpen(false)}
        currentPath={currentPath}
        onCreateFolder={handleCreateFolder}
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
