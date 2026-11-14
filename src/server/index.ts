import { serve } from '@hono/node-server';
import app from './app.js';
import { initializeDatabase } from './db/init.js';
import { hydratePool1Startup } from './drive/index.js';

initializeDatabase();

const port = Number(process.env.PORT) || 3000;

console.log(`Tsubasa server listening on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});

void hydratePool1Startup().catch((err) => {
  console.warn(
    'Startup Pool 1 hydration failed:',
    err instanceof Error ? err.message : String(err)
  );
});
