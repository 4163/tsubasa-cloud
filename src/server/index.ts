import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from './app.js';
import { sqlite } from './db/index.js';
import { initializeDatabase } from './db/init.js';
import { authPool, hydratePool1Startup } from './drive/index.js';

initializeDatabase();

const port = Number(process.env.PORT) || 3000;

console.log(`Tsubasa server listening on http://localhost:${port}`);

const server = serve({
  fetch: app.fetch,
  port,
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  authPool.stopWatching();

  const forceExitTimer = setTimeout(() => {
    sqlite.close();
    process.exit(0);
  }, 5000);
  forceExitTimer.unref();

  server.close(() => {
    clearTimeout(forceExitTimer);
    sqlite.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

void hydratePool1Startup().catch((err) => {
  console.warn(
    'Startup Pool 1 hydration failed:',
    err instanceof Error ? err.message : String(err)
  );
});
