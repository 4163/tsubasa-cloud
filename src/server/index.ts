import 'dotenv/config';
import { serve } from '@hono/node-server';
import { acquireWriterLock, WriterLockError, type WriterLockHandle } from './lock.js';

async function startServer(): Promise<void> {
  let writerLock: WriterLockHandle;
  try {
    writerLock = acquireWriterLock({
      command: process.argv.join(' '),
    });
  } catch (err) {
    if (err instanceof WriterLockError) {
      const holderInfo = err.holder ? ` (pid ${err.holder.pid}, started ${err.holder.startedAt})` : '';
      console.error(`Cannot start Tsubasa server: writer lock is already held${holderInfo}.`);
      process.exit(1);
    }
    throw err;
  }

  process.on('exit', () => {
    writerLock.release();
  });

  // Dynamically import DB, app, and Drive modules only after the writer lock is held,
  // preventing a blocked duplicate server process from opening SQLite or spawning background workers.
  const [{ sqlite }, { initializeDatabase }, { createApp }, { authPool, hydratePool1Startup, stopOutboxWorker }, { recoverOrphanedTransferJobsOnStartup }] =
    await Promise.all([
      import('./db/index.js'),
      import('./db/init.js'),
      import('./app.js'),
      import('./drive/index.js'),
      import('./drive/importDrive.js'),
    ]);

  try {
    initializeDatabase();
  } catch (err) {
    sqlite.close();
    writerLock.release();
    throw err;
  }

  const app = createApp();
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

  void recoverOrphanedTransferJobsOnStartup()
    .then((summary) => {
      if (summary.recoveredJobs > 0 || summary.revokedShares > 0 || summary.failedShareRevocations > 0) {
        console.log(
          `Startup transfer job recovery: paused=${summary.recoveredJobs}, revokedShares=${summary.revokedShares}, failedShareRevocations=${summary.failedShareRevocations}`
        );
      }
    })
    .catch((err) => {
      console.warn(
        'Startup orphaned transfer job recovery failed:',
        err instanceof Error ? err.message : String(err)
      );
    });
}

void startServer().catch((err) => {
  console.error('Fatal Tsubasa server startup error:', err);
  process.exit(1);
});
