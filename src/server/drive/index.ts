import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { authPool } from './auth.js';
import { hydrateAccount, isSharePoolId } from './client.js';
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

export async function syncAllAccounts(poolId?: number): Promise<{
  hydrated: string[];
  synced: string[];
  errors: Array<{ accountId: string; error: string }>;
}> {
  authPool.scan();
  const records = authPool.getAll();
  const hydrated: string[] = [];
  const synced: string[] = [];
  const errors: Array<{ accountId: string; error: string }> = [];

  for (const record of records) {
    if (!record.authorized) {
      continue;
    }

    const accountId = record.config.accountId;
    const existingAccount = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
    });

    if (existingAccount && isSharePoolId(existingAccount.poolId)) {
      continue;
    }

    if (poolId !== undefined && existingAccount && existingAccount.poolId !== poolId) {
      continue;
    }

    try {
      const hydRes = await hydrateAccount(accountId, existingAccount ? undefined : poolId);
      if (isSharePoolId(hydRes.poolId)) {
        continue;
      }
      if (poolId !== undefined && hydRes.poolId !== poolId) {
        hydrated.push(hydRes.accountId);
        continue;
      }

      hydrated.push(hydRes.accountId);
      await runIncrementalSync(hydRes.accountId);
      synced.push(hydRes.accountId);
    } catch (err) {
      errors.push({
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { hydrated, synced, errors };
}

