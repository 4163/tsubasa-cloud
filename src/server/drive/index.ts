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

const SYNC_ACCOUNT_CONCURRENCY = 5;

export async function syncAllAccounts(poolId = 1): Promise<{
  hydrated: string[];
  synced: string[];
  errors: Array<{ accountId: string; error: string }>;
}> {
  if (isSharePoolId(poolId)) {
    return { hydrated: [], synced: [], errors: [] };
  }

  authPool.scan();
  const records = authPool.getAll().filter((r) => r.authorized);
  const hydrated: string[] = [];
  const synced: string[] = [];
  const errors: Array<{ accountId: string; error: string }> = [];

  let nextIndex = 0;
  const workerCount = Math.min(SYNC_ACCOUNT_CONCURRENCY, records.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < records.length) {
        const record = records[nextIndex++];
        const accountId = record.config.accountId;

        const existingAccount = await db.query.accounts.findFirst({
          where: eq(accounts.id, accountId),
        });

        if (existingAccount) {
          if (isSharePoolId(existingAccount.poolId) || existingAccount.poolId !== poolId) {
            continue;
          }
        } else {
          const preferredPool = authPool.hasPreferredPool(accountId)
            ? authPool.getPreferredPool(accountId)
            : record.config.preferredPoolId;
          if (preferredPool !== undefined && (isSharePoolId(preferredPool) || preferredPool !== poolId)) {
            continue;
          }
        }

        try {
          const hydRes = await hydrateAccount(accountId, existingAccount ? undefined : poolId);
          if (isSharePoolId(hydRes.poolId) || hydRes.poolId !== poolId) {
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
    })
  );

  return { hydrated, synced, errors };
}

