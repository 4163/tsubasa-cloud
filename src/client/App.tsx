import React, { useEffect, useState, useCallback } from 'react';
import * as stylex from '@stylexjs/stylex';
import { client } from './api.js';
import { colors, darkColors, layout } from './tokens.stylex.js';
import { Header, type ThemeChoice } from './components/Header.js';
import { Sidebar, type AccountItem } from './components/Sidebar.js';
import { ActionPortal } from './components/ActionPortal.js';
import { FileTable, type ClientFileRecord, type ClientFolder } from './components/FileTable.js';
import { DitherDivider } from './components/DitherDivider.js';

interface HealthData {
  status: string;
  service: string;
  timestamp: number;
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
  syncState: string;
}

interface StorageOverview {
  totalAccounts: number;
  totalLimitBytes: number;
  totalUsedBytes: number;
  totalHeadroomBytes: number;
  systemStorage?: {
    systemFilesCount: number;
    systemBytesTotal: number;
  };
  accounts: AccountSummary[];
}

interface DiscoveredAccount {
  accountId: string;
  clientId: string;
  authorized: boolean;
  sourceFile: string;
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
  },
  statusToast: {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    backgroundColor: colors.surfaceElevated,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    color: colors.primaryText,
    paddingTop: '8px',
    paddingBottom: '8px',
    paddingLeft: '16px',
    paddingRight: '16px',
    borderRadius: '8px',
    fontSize: '12px',
    fontWeight: '500',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
    zIndex: 10000,
    pointerEvents: 'none',
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
  const [isMobileOpen, setIsMobileOpen] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 4000);
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

  useEffect(() => {
    loadClusterData();
    loadFiles(currentPath);
  }, [loadClusterData, loadFiles, currentPath]);

  function handleSelect(id: string, isMulti: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(isMulti ? prev : []);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleNavigate(path: string) {
    setCurrentPath(path);
    setSelectedIds(new Set());
  }

  async function handleAuthorizeAccount(accountId: string) {
    try {
      const res = await client.api.accounts['auth-url'][':id'].$get({
        param: { id: accountId },
        query: {},
      });
      if (res.ok) {
        const data = await res.json();
        if ('url' in data && data.url) {
          window.location.href = data.url;
        }
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Auth URL generation failed');
    }
  }

  async function handleSyncAccount(accountId: string) {
    setIsSyncing(true);
    showToast(`Syncing drive account ${accountId}...`);
    try {
      const res = await client.api.sync[':id'].$post({ param: { id: accountId } });
      if (res.ok) {
        const report = await res.json();
        showToast(`Sync complete for ${accountId}: ${'filesUpdated' in report ? report.filesUpdated : 0} records.`);
        await loadClusterData();
        await loadFiles(currentPath);
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleSyncAll() {
    setIsSyncing(true);
    showToast('Syncing all cluster accounts with Google Drive...');
    try {
      const res = await client.api.sync.all.$post();
      if (res.ok) {
        const report = await res.json();
        showToast(`Sync completed: ${report.synced.length} drives updated.`);
        await loadClusterData();
        await loadFiles(currentPath);
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Sync all failed');
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleUploadFiles(fileList: FileList) {
    const total = fileList.length;
    showToast(`Uploading ${total} file${total > 1 ? 's' : ''}...`);

    for (let i = 0; i < total; i++) {
      const file = fileList[i];
      const virtualPath = (currentPath === '/' ? '' : currentPath) + '/' + file.name;

      try {
        const response = await fetch(`/api/files/upload?virtualPath=${encodeURIComponent(virtualPath)}`, {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
          },
          body: file,
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Upload failed with status ${response.status}`);
        }
      } catch (err) {
        setErrorNotice(`Failed to upload ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }

    showToast('Upload finished. Refreshing cluster.');
    await loadClusterData();
    await loadFiles(currentPath);
  }

  function handleCreateFolderPrompt() {
    const folderName = window.prompt('Enter new folder name:');
    if (!folderName || !folderName.trim()) return;

    const newPath = (currentPath === '/' ? '' : currentPath) + '/' + folderName.trim();
    setFolders((prev) => [
      ...prev,
      {
        id: `virtual-folder-${Date.now()}`,
        virtualPath: newPath,
        name: folderName.trim(),
        parentFolderId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    showToast(`Created virtual folder "${folderName.trim()}".`);
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
        await loadClusterData();
      }
    } catch (err) {
      setErrorNotice(`Trash error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Aggregate account list merging discovered with storage overview
  const accountItems: AccountItem[] = discovered.map((d) => {
    const summary = storage?.accounts.find((a) => a.id === d.accountId);
    return {
      id: d.accountId,
      email: summary?.email || d.accountId,
      displayName: summary?.displayName || d.accountId,
      avatarUrl: summary?.avatarUrl,
      quotaLimitBytes: summary?.quotaLimitBytes ?? 16106127360,
      quotaUsedBytes: summary?.quotaUsedBytes ?? 0,
      usableLimitBytes: summary?.usableLimitBytes ?? 15356127360,
      headroomBytes: summary?.headroomBytes ?? 15356127360,
      syncState: summary?.syncState || 'idle',
      authorized: d.authorized,
    };
  });

  const breachedAccounts = accountItems.filter((a) => a.quotaUsedBytes > a.usableLimitBytes);

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
        tsubasaUsedBytes={storage?.systemStorage?.systemBytesTotal ?? 0}
        poolHeadroomBytes={storage?.totalHeadroomBytes ?? 0}
        totalLimitBytes={storage?.totalLimitBytes ?? 0}
        currentNav={currentNav}
        onSelectNav={(nav) => setCurrentNav(nav)}
        onAuthorizeAccount={handleAuthorizeAccount}
        onSyncAccount={handleSyncAccount}
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
          </div>
        )}

        <ActionPortal
          currentPath={currentPath}
          onNavigatePath={handleNavigate}
          onUploadFiles={handleUploadFiles}
          onCreateFolderPrompt={handleCreateFolderPrompt}
          onSyncAll={handleSyncAll}
          isSyncing={isSyncing}
        />

        <FileTable
          files={files}
          folders={folders}
          currentPath={currentPath}
          searchQuery={searchQuery}
          selectedIds={selectedIds}
          onSelect={handleSelect}
          onNavigate={handleNavigate}
          onDownload={handleDownload}
          onTrash={handleTrash}
        />
      </div>

      {toastMessage && (
        <div {...stylex.props(styles.statusToast)}>
          {toastMessage}
        </div>
      )}

      {errorNotice && (
        <div
          {...stylex.props(styles.statusToast)}
          style={{ backgroundColor: '#82071e', color: '#ff9492' }}
          onClick={() => setErrorNotice(null)}
        >
          Notice: {errorNotice}
        </div>
      )}
    </div>
  );
}

export default App;
