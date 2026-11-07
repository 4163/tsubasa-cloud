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

interface StorageOverview {
  totalAccounts: number;
  totalLimitBytes: number;
  totalUsedBytes: number;
  totalHeadroomBytes: number;
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
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '1.5rem',
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
  detailText: {
    fontSize: '0.8125rem',
    color: '#94a3b8',
    marginTop: '0.75rem',
  },
});

export function App() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [storage, setStorage] = useState<StorageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadStatus() {
      try {
        const healthRes = await client.api.health.$get();
        if (healthRes.ok) {
          const data = await healthRes.json();
          setHealth(data);
        }

        const storageRes = await client.api.storage.overview.$get();
        if (storageRes.ok) {
          const data = await storageRes.json();
          setStorage(data);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to connect to backend');
      }
    }

    loadStatus();
  }, []);

  const formatGb = (bytes: number) => (bytes / (1024 * 1024 * 1024)).toFixed(2);

  return (
    <div {...stylex.props(styles.container)}>
      <header {...stylex.props(styles.header)}>
        <div>
          <h1 {...stylex.props(styles.title)}>Tsubasa Virtual Storage</h1>
          <div {...stylex.props(styles.subtitle)}>Local-first pooled Google Drive architecture</div>
        </div>
        {health ? (
          <span {...stylex.props(styles.badgeSuccess)}>
            ● RPC Connected
          </span>
        ) : (
          <span {...stylex.props(styles.badgePending)}>
            ○ Connecting...
          </span>
        )}
      </header>

      {error && (
        <div style={{ color: '#ff9492', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
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
          <h2 {...stylex.props(styles.cardTitle)}>Connected Accounts</h2>
          <div {...stylex.props(styles.statValue)}>
            {storage ? storage.totalAccounts : 0}
          </div>
          <p {...stylex.props(styles.detailText)}>
            Accounts scanned dynamically from .oauths/ credentials pool.
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
    </div>
  );
}

export default App;

