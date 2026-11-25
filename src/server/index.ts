import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { acquireWriterLock, WriterLockError, type WriterLockHandle } from './lock.js';
import { getPackageRootDir, setTsubasaHomeOverride } from './paths.js';
import { getDefaultServerPort } from './ports.js';
import type { AuthCompletedEvent } from './routes/accounts.js';

export interface StartTsubasaServerOptions {
  port?: number;
  hostname?: string;
  fallbackToEphemeralPort?: boolean;
  staticDir?: string;
  homeDir?: string;
  enableHttpLogger?: boolean;
  enableCompress?: boolean;
  onAuthCompleted?: (payload: AuthCompletedEvent) => void;
  registerSignalHandlers?: boolean;
}

export interface StartedTsubasaServer {
  port: number;
  hostname: string;
  url: string;
  close(): Promise<void>;
}

interface BoundServer {
  server: ServerType;
  port: number;
  hostname: string;
}

function formatServerUrl(hostname: string, port: number): string {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `http://${host}:${port}`;
}

function bindHttpServer(
  fetch: (request: Request) => Response | Promise<Response>,
  port: number,
  hostname?: string
): Promise<BoundServer> {
  return new Promise((resolve, reject) => {
    const server = serve({
      fetch,
      port,
      ...(hostname ? { hostname } : {}),
    });

    const onError = (err: Error) => {
      server.off('listening', onListening);
      try {
        server.close();
      } catch {
        // Ignore close errors on a failed bind.
      }
      reject(err);
    };

    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to resolve bound HTTP server address'));
        return;
      }
      const resolvedHostname =
        hostname || (addr.address === '::' || addr.address === '0.0.0.0' ? 'localhost' : addr.address);
      resolve({
        server,
        port: addr.port,
        hostname: resolvedHostname,
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
  });
}

export async function startTsubasaServer(
  options: StartTsubasaServerOptions = {}
): Promise<StartedTsubasaServer> {
  if (options.homeDir) {
    setTsubasaHomeOverride(options.homeDir);
  }

  const writerLock: WriterLockHandle = acquireWriterLock({
    homeDir: options.homeDir,
    command: process.argv.join(' '),
  });

  const onProcessExit = () => {
    writerLock.release();
  };
  process.on('exit', onProcessExit);

  let loadedModules:
    | [
        typeof import('./db/index.js'),
        typeof import('./db/init.js'),
        typeof import('./app.js'),
        typeof import('./drive/index.js'),
        typeof import('./drive/importDrive.js'),
      ]
    | undefined;

  try {
    // Dynamically import DB, app, and Drive modules only after home override and writer lock
    // are established, preventing a blocked duplicate process from opening SQLite or workers.
    loadedModules = await Promise.all([
      import('./db/index.js'),
      import('./db/init.js'),
      import('./app.js'),
      import('./drive/index.js'),
      import('./drive/importDrive.js'),
    ]);
  } catch (err) {
    process.off('exit', onProcessExit);
    writerLock.release();
    throw err;
  }

  const [
    { sqlite },
    { initializeDatabase },
    { createApp },
    { authPool, hydratePool1Startup, stopOutboxWorker },
    { recoverOrphanedTransferJobsOnStartup },
  ] = loadedModules;

  const cleanupResources = () => {
    try {
      authPool.stopWatching();
    } catch {
      // Ignore watcher stop errors during cleanup.
    }
    try {
      stopOutboxWorker();
    } catch {
      // Ignore outbox worker stop errors during cleanup.
    }
    try {
      sqlite.close();
    } catch {
      // Ignore close errors if already closed.
    }
    process.off('exit', onProcessExit);
    writerLock.release();
  };

  try {
    initializeDatabase();
  } catch (err) {
    cleanupResources();
    throw err;
  }

  const app = createApp({
    enableHttpLogger: options.enableHttpLogger,
    enableCompress: options.enableCompress,
    staticDir: options.staticDir,
    onAuthCompleted: options.onAuthCompleted,
  });

  const preferredPort = options.port ?? getDefaultServerPort(true);
  const hostname = options.hostname?.trim() || undefined;
  const fallbackToEphemeralPort = options.fallbackToEphemeralPort ?? false;

  let bound: BoundServer;
  try {
    bound = await bindHttpServer(app.fetch, preferredPort, hostname);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // Windows returns EACCES for reserved ports and conflicting/exclusive socket binds.
    const canFallback = code === 'EADDRINUSE' || code === 'EACCES';
    if (fallbackToEphemeralPort && preferredPort !== 0 && canFallback) {
      try {
        bound = await bindHttpServer(app.fetch, 0, hostname);
      } catch (fallbackErr) {
        cleanupResources();
        throw fallbackErr;
      }
    } else {
      cleanupResources();
      throw err;
    }
  }

  const { server, port: boundPort, hostname: boundHostname } = bound;
  writerLock.updateMetadata({ port: boundPort, hostname: boundHostname });
  const url = formatServerUrl(boundHostname, boundPort);

  console.log(`Tsubasa server listening on ${url}`);

  let closePromise: Promise<void> | null = null;
  let signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];

  const onRuntimeError = (err: Error) => {
    console.error('Tsubasa server error:', err);
  };
  server.on('error', onRuntimeError);

  const close = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }

    closePromise = new Promise<void>((resolve) => {
      for (const { signal, handler } of signalHandlers) {
        process.off(signal, handler);
      }
      signalHandlers = [];
      server.off('error', onRuntimeError);

      try {
        authPool.stopWatching();
      } catch {
        // Ignore watcher stop errors during shutdown.
      }
      try {
        stopOutboxWorker();
      } catch {
        // Ignore outbox worker stop errors during shutdown.
      }

      let finalized = false;
      const finalize = () => {
        if (finalized) {
          return;
        }
        finalized = true;
        clearTimeout(forceCloseTimer);
        cleanupResources();
        resolve();
      };

      const forceCloseTimer = setTimeout(finalize, 5000);
      forceCloseTimer.unref();

      try {
        if ('closeIdleConnections' in server && typeof server.closeIdleConnections === 'function') {
          server.closeIdleConnections();
        }
        server.close(() => {
          finalize();
        });
      } catch {
        finalize();
      }
    });

    return closePromise;
  };

  if (options.registerSignalHandlers) {
    let shuttingDown = false;
    const handleSignal = (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      console.log(`Received ${signal}, shutting down...`);
      void close().finally(() => {
        process.exit(0);
      });
    };

    const sigintHandler = () => handleSignal('SIGINT');
    const sigtermHandler = () => handleSignal('SIGTERM');
    signalHandlers = [
      { signal: 'SIGINT', handler: sigintHandler },
      { signal: 'SIGTERM', handler: sigtermHandler },
    ];
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);
  }

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

  return {
    port: boundPort,
    hostname: boundHostname,
    url,
    close,
  };
}

function normalizeEntryPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  let real = resolved;
  try {
    real = (fs.realpathSync.native ?? fs.realpathSync)(resolved);
  } catch {
    // Fall back to resolved path if realpath fails (e.g. virtual/asar path).
  }
  const normalized = path.normalize(real);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isDirectEntrypoint(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    const currentFile = fileURLToPath(import.meta.url);
    return normalizeEntryPath(currentFile) === normalizeEntryPath(entryArg);
  } catch {
    return false;
  }
}

function sendIpcMessage(message: unknown): void {
  if (typeof process.send !== 'function') {
    return;
  }
  try {
    process.send(message);
  } catch {
    // Ignore IPC send errors if parent channel is already closed.
  }
}

async function runStandalone(): Promise<void> {
  const hasIpc = typeof process.send === 'function';
  const serveStatic = process.env.TSUBASA_SERVE_STATIC === '1';
  const staticDir = serveStatic
    ? process.env.TSUBASA_STATIC_DIR?.trim() || path.join(getPackageRootDir(), 'dist')
    : undefined;
  const hostname = process.env.TSUBASA_HOSTNAME?.trim() || undefined;
  const fallbackToEphemeralPort = process.env.TSUBASA_FALLBACK_EPHEMERAL === '1';

  let started: StartedTsubasaServer;
  try {
    started = await startTsubasaServer({
      hostname,
      fallbackToEphemeralPort,
      staticDir,
      registerSignalHandlers: true,
      onAuthCompleted: hasIpc
        ? (payload) => {
            sendIpcMessage({ type: 'tsubasa-auth-completed', payload });
          }
        : undefined,
    });
  } catch (err) {
    if (err instanceof WriterLockError) {
      const holderInfo = err.holder ? ` (pid ${err.holder.pid}, started ${err.holder.startedAt})` : '';
      console.error(`Cannot start Tsubasa server: writer lock is already held${holderInfo}.`);
      process.exit(1);
    }
    throw err;
  }

  if (hasIpc) {
    sendIpcMessage({
      type: 'tsubasa-server-ready',
      port: started.port,
      hostname: started.hostname,
      url: started.url,
    });

    process.on('message', (msg: unknown) => {
      if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'tsubasa-server-shutdown') {
        void started.close().finally(() => {
          process.exit(0);
        });
      }
    });
  }
}

if (isDirectEntrypoint()) {
  void runStandalone().catch((err) => {
    console.error('Fatal Tsubasa server startup error:', err);
    process.exit(1);
  });
}
