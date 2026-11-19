import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from './app.js';
import { sqlite } from './db/index.js';
import { initializeDatabase } from './db/init.js';
import { authPool, hydratePool1Startup, stopOutboxWorker } from './drive/index.js';
import { acquireWriterLock, WriterLockError, type WriterLockHandle } from './lock.js';

let writerLock: WriterLockHandle;
try {
  writerLock = acquireWriterLock({
    command: process.argv.join(' '),
  });
} catch (err) {
  if (err instanceof WriterLockError) {
    const holderInfo = err.holder ? ` (pid ${err.holder.pid}, started ${err.holder.startedAt})` : '';
    console.error(`Cannot start Tsubasa server: writer lock is already held${holderInfo}.`);
    sqlite.close();
    process.exit(1);
  }
  sqlite.close();
  throw err;
}

process.on('exit', () => {
  writerLock.release();
});

try {
  initializeDatabase();
} catch (err) {
  sqlite.close();
  writerLock.release();
  throw err;
}

const port = Number(process.env.PORT) || 3000;

console.log(`Tsubasa server listening on http://localhost:${port}`);

const server = serve({
  fetch: app.fetch,
  port,
});

server.on('error', (err) => {
  console.error('Tsubasa server error:', err);
  authPool.stopWatching();
  stopOutboxWorker();
  sqlite.close();
  writerLock.release();
  process.exit(1);
});

let shuttingDown = false;

function finalizeShutdown(exitCode = 0): void {
  try {
    sqlite.close();
  } catch {
    // Ignore close errors if already closed.
  }
  writerLock.release();
  process.exit(exitCode);
}

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  authPool.stopWatching();
  stopOutboxWorker();

  const forceExitTimer = setTimeout(() => {
    finalizeShutdown(0);
  }, 5000);
  forceExitTimer.unref();

  server.close(() => {
    clearTimeout(forceExitTimer);
    finalizeShutdown(0);
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
