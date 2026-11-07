import React, { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { client } from './api.js';

interface HealthData {
  status: string;
  service: string;
  timestamp: number;
  sqlite: {
    journalMode: string;
  };
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
  accounts: AccountSummary[];
}

interface DiscoveredAccount {
  accountId: string;
  clientId: string;
  authorized: boolean;
  sourceFile: string;
}

const styles = stylex.create({
  container: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: '#090d16',
    color: '#f1f5f9',
    padding: '2rem',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottom: '1px solid #1e293b',
    paddingBottom: '1.25rem',
    marginBottom: '2rem',
    flexWrap: 'wrap',
    gap: '1rem',
  },
  titleGroup: {
    display: 'flex',
    flexDirection: 'column',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: '700',
    letterSpacing: '-0.025em',
    margin: 0,
    color: '#ffffff',
  },
  subtitle: {
    fontSize: '0.875rem',
    color: '#94a3b8',
    marginTop: '0.25rem',
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '1.5rem',
    marginBottom: '2.5rem',
  },
  card: {
    backgroundColor: '#0f172a',
    borderRadius: '0.5rem',
    padding: '1.5rem',
    border: '1px solid #1e293b',
  },
  cardTitle: {
    fontSize: '0.875rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#94a3b8',
    marginBottom: '0.75rem',
    margin: 0,
  },
  statValue: {
    fontSize: '1.75rem',
    fontWeight: '700',
    color: '#f8fafc',
    margin: '0.5rem 0',
  },
  sectionHeading: {
    fontSize: '1.125rem',
    fontWeight: '600',
    color: '#f8fafc',
    marginBottom: '1rem',
  },
  accountList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  accountRow: {
    backgroundColor: '#0f172a',
    border: '1px solid #1e293b',
    borderRadius: '0.5rem',
    padding: '1.25rem 1.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '1rem',
  },
  accountInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  avatar: {
    width: '2.5rem',
    height: '2.5rem',
    borderRadius: '9999px',
    backgroundColor: '#1e293b',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: '600',
    color: '#38bdf8',
  },
  accountDetails: {
    display: 'flex',
    flexDirection: 'column',
  },
  accountName: {
    fontSize: '0.9375rem',
    fontWeight: '600',
    color: '#ffffff',
  },
  accountMeta: {
    fontSize: '0.8125rem',
    color: '#94a3b8',
    marginTop: '0.125rem',
  },
  accountActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  badgeSuccess: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '0.25rem 0.625rem',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: '600',
    backgroundColor: '#064e3b',
    color: '#7ee787',
    border: '1px solid #047857',
  },
  badgePending: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '0.25rem 0.625rem',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: '600',
    backgroundColor: '#3f2c06',
    color: '#facc15',
    border: '1px solid #854d0e',
  },
  badgeError: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '0.25rem 0.625rem',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: '600',
    backgroundColor: '#450a0a',
    color: '#ff9492',
    border: '1px solid #82071e',
  },
  buttonPrimary: {
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '0.375rem',
    padding: '0.5rem 1rem',
    fontSize: '0.875rem',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
  },
  buttonSecondary: {
    backgroundColor: '#1e293b',
    color: '#e2e8f0',
    border: '1px solid #334155',
    borderRadius: '0.375rem',
    padding: '0.5rem 0.875rem',
    fontSize: '0.8125rem',
    fontWeight: '500',
    cursor: 'pointer',
  },
  detailText: {
    fontSize: '0.8125rem',
    color: '#94a3b8',
    marginTop: '0.75rem',
  },
  statusBanner: {
    color: '#7ee787',
    marginBottom: '1rem',
    fontSize: '0.875rem',
  },
  errorBanner: {
    color: '#ff9492',
    marginBottom: '1.5rem',
    fontSize: '0.875rem',
  },
});

export function App() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [storage, setStorage] = useState<StorageOverview | null>(null);
  const [pool, setPool] = useState<DiscoveredAccount[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadData() {
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
        setPool(poolData.accounts);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to query Tsubasa~ backend');
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleAuthorize(accountId: string) {
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
      setError(err instanceof Error ? err.message : 'Failed to obtain authorization URL');
    }
  }

  async function handleSyncAccount(accountId: string) {
    setSyncing(true);
    setStatusMessage(`Syncing account ${accountId}...`);
    try {
      const res = await client.api.sync[':id'].$post({ param: { id: accountId } });
      if (res.ok) {
        const report = await res.json();
        setStatusMessage(`Sync complete for ${accountId}: ${'filesUpdated' in report ? report.filesUpdated : 0} files updated.`);
        await loadData();
      } else {
        setError(`Sync failed for ${accountId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to sync ${accountId}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleSyncAll() {
    setSyncing(true);
    setStatusMessage('Syncing all authorized Google accounts...');
    try {
      const res = await client.api.sync.all.$post();
      if (res.ok) {
        const report = await res.json();
        setStatusMessage(`All accounts synced: ${report.synced.length} active.`);
        await loadData();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync all failed');
    } finally {
      setSyncing(false);
    }
  }

  const formatGb = (bytes: number) => (bytes / (1024 * 1024 * 1024)).toFixed(2);

  return (
    <div {...stylex.props(styles.container)}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.titleGroup)}>
          <h1 {...stylex.props(styles.title)}>Tsubasa~ Virtual Storage</h1>
          <div {...stylex.props(styles.subtitle)}>Local-first pooled Google Drive storage engine</div>
        </div>
        <div {...stylex.props(styles.headerActions)}>
          <button
            type="button"
            {...stylex.props(styles.buttonPrimary)}
            onClick={handleSyncAll}
            disabled={syncing}
          >
            {syncing ? 'Syncing...' : 'Sync All Drives'}
          </button>
          {health ? (
            <span {...stylex.props(styles.badgeSuccess)}>● RPC Connected</span>
          ) : (
            <span {...stylex.props(styles.badgePending)}>○ Connecting...</span>
          )}
        </div>
      </header>

      {statusMessage && (
        <div {...stylex.props(styles.statusBanner)}>
          ✓ {statusMessage}
        </div>
      )}

      {error && (
        <div {...stylex.props(styles.errorBanner)}>
          Notice: {error}
        </div>
      )}

      <main {...stylex.props(styles.grid)}>
        <div {...stylex.props(styles.card)}>
          <h2 {...stylex.props(styles.cardTitle)}>SQLite WAL Cache</h2>
          <div {...stylex.props(styles.statValue)}>
            {health?.sqlite.journalMode ? health.sqlite.journalMode.toUpperCase() : 'Initializing'}
          </div>
          <p {...stylex.props(styles.detailText)}>
            Local index cache ready for sub-2ms reads and atomic offline transactions.
          </p>
        </div>

        <div {...stylex.props(styles.card)}>
          <h2 {...stylex.props(styles.cardTitle)}>Account Pool</h2>
          <div {...stylex.props(styles.statValue)}>{pool.length}</div>
          <p {...stylex.props(styles.detailText)}>
            {storage?.totalAccounts || 0} hydrated and active in storage cluster.
          </p>
        </div>

        <div {...stylex.props(styles.card)}>
          <h2 {...stylex.props(styles.cardTitle)}>Pooled Headroom</h2>
          <div {...stylex.props(styles.statValue)}>
            {storage ? `${formatGb(storage.totalHeadroomBytes)} GB` : '0.00 GB'}
          </div>
          <p {...stylex.props(styles.detailText)}>
            Usable storage reserving 750 MB safety buffer per 15 GB account.
          </p>
        </div>
      </main>

      <section>
        <h2 {...stylex.props(styles.sectionHeading)}>Configured Accounts (.oauths/)</h2>
        <div {...stylex.props(styles.accountList)}>
          {pool.map((acc) => {
            const summary = storage?.accounts.find((s) => s.id === acc.accountId);
            return (
              <div key={acc.accountId} {...stylex.props(styles.accountRow)}>
                <div {...stylex.props(styles.accountInfo)}>
                  <div {...stylex.props(styles.avatar)}>
                    {summary?.displayName ? summary.displayName[0].toUpperCase() : acc.accountId[0].toUpperCase()}
                  </div>
                  <div {...stylex.props(styles.accountDetails)}>
                    <div {...stylex.props(styles.accountName)}>
                      {summary?.displayName || acc.accountId}
                    </div>
                    <div {...stylex.props(styles.accountMeta)}>
                      {summary?.email || `Credential ID: ${acc.accountId}`} •{' '}
                      {acc.authorized
                        ? summary
                          ? `${formatGb(summary.quotaUsedBytes)} GB used / ${formatGb(summary.usableLimitBytes)} GB usable`
                          : 'Tokens saved • Hydration pending'
                        : 'Awaiting OAuth consent'}
                    </div>
                  </div>
                </div>

                <div {...stylex.props(styles.accountActions)}>
                  {acc.authorized ? (
                    <>
                      <span {...stylex.props(styles.badgeSuccess)}>● Authorized</span>
                      <button
                        type="button"
                        {...stylex.props(styles.buttonSecondary)}
                        onClick={() => handleSyncAccount(acc.accountId)}
                        disabled={syncing}
                      >
                        Sync
                      </button>
                    </>
                  ) : (
                    <>
                      <span {...stylex.props(styles.badgePending)}>○ Pending</span>
                      <button
                        type="button"
                        {...stylex.props(styles.buttonPrimary)}
                        onClick={() => handleAuthorize(acc.accountId)}
                      >
                        Authorize Account
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default App;
