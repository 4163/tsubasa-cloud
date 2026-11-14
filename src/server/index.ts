import { serve } from '@hono/node-server';
import app from './app.js';
import { sqlite } from './db/index.js';
import { initializeDatabase } from './db/init.js';
import { authPool, hydrateAccount, isSharePoolId, runIncrementalSync } from './drive/index.js';

initializeDatabase();

authPool.scan();
const accountRecords = authPool.getAll();
console.log(`Discovered ${accountRecords.length} account credential files in .oauths/`);

const selectAccountPoolStmt = sqlite.prepare('SELECT pool_id as poolId FROM accounts WHERE id = ? LIMIT 1');

for (const record of accountRecords) {
  if (!record.authorized) {
    continue;
  }

  const accountId = record.config.accountId;
  const existingRow = selectAccountPoolStmt.get(accountId) as { poolId: number } | undefined;
  const knownPool = existingRow
    ? existingRow.poolId
    : authPool.hasPreferredPool(accountId)
      ? authPool.getPreferredPool(accountId)
      : record.config.preferredPoolId;

  if (knownPool !== undefined && knownPool !== 1) {
    continue;
  }

  hydrateAccount(accountId)
    .then(async (res) => {
      console.log(`Hydrated account ${res.email} (${res.accountId}) in Pool ${res.poolId}`);
      if (res.poolId === 1 && !isSharePoolId(res.poolId)) {
        await runIncrementalSync(res.accountId);
      }
    })
    .catch((err) => console.warn(`Hydration deferred for ${accountId}:`, err.message));
}

const port = Number(process.env.PORT) || 3000;

console.log(`Tsubasa server listening on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
