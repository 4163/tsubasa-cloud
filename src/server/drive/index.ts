import { authPool } from './auth.js';
import { hydrateAccount } from './client.js';
import { runColdReconciliation } from './sync.js';
import { runIncrementalSync } from './delta.js';

export * from './auth.js';
export * from './client.js';
export * from './sync.js';
export * from './delta.js';
export * from './mirror.js';
export * from './transfer.js';
export * from './detector.js';
export * from './rebalance.js';
export * from './operations.js';

export async function syncAllAccounts(): Promise<{
  hydrated: string[];
  synced: string[];
  errors: Array<{ accountId: string; error: string }>;
}> {
  authPool.scan();
  const accounts = authPool.getAll();
  const hydrated: string[] = [];
  const synced: string[] = [];
  const errors: Array<{ accountId: string; error: string }> = [];

  for (const record of accounts) {
    if (!record.authorized) {
      continue;
    }

    try {
      await hydrateAccount(record.config.accountId);
      hydrated.push(record.config.accountId);

      await runIncrementalSync(record.config.accountId);
      synced.push(record.config.accountId);
    } catch (err) {
      errors.push({
        accountId: record.config.accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { hydrated, synced, errors };
}

