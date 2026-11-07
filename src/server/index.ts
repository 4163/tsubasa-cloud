import { serve } from '@hono/node-server';
import app from './app.js';
import { initializeDatabase } from './db/init.js';
import { authPool, hydrateAccount } from './drive/index.js';

initializeDatabase();

authPool.scan();
const accountRecords = authPool.getAll();
console.log(`Discovered ${accountRecords.length} account credential files in .oauths/`);

for (const record of accountRecords) {
  if (record.authorized) {
    hydrateAccount(record.config.accountId)
      .then((res) => console.log(`Hydrated account ${res.email} (${res.accountId})`))
      .catch((err) => console.warn(`Hydration deferred for ${record.config.accountId}:`, err.message));
  }
}

const port = Number(process.env.PORT) || 3000;

console.log(`Tsubasa server listening on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
