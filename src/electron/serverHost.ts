import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { AuthCompletedEvent } from '../server/app.js';
import { computeDbFingerprint, resolveDbPath } from '../server/paths.js';

export interface StartServerHostOptions {
  isPackaged: boolean;
  homeDir: string;
  packageRoot: string;
  preferredPort?: number;
  onAuthCompleted?: (payload: AuthCompletedEvent) => void;
}

export interface ServerHostHandle {
  mode: 'attached' | 'embedded' | 'spawned';
  port: number;
  serverUrl: string;
  rendererUrl: string;
  close(): Promise<void>;
}

interface HealthProbeResponse {
  service?: unknown;
  dbFingerprint?: unknown;
}

interface ServerReadyIpcMessage {
  type: 'tsubasa-server-ready';
  port: number;
  hostname?: string;
  url: string;
}

interface AuthCompletedIpcMessage {
  type: 'tsubasa-auth-completed';
  payload: AuthCompletedEvent;
}

const PROBE_TIMEOUT_MS = 350;
const SPAWN_READY_TIMEOUT_MS = 15_000;
const SPAWN_SHUTDOWN_TIMEOUT_MS = 5_000;
const VITE_DEV_URL = 'http://localhost:5173/';

async function probeExistingBackend(port: number, expectedFingerprint: string): Promise<string | null> {
  const serverUrl = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${serverUrl}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as HealthProbeResponse;
    if (body.service === 'tsubasa-backend' && body.dbFingerprint === expectedFingerprint) {
      return serverUrl;
    }
  } catch {
    // No matching server listening on preferredPort.
  }
  return null;
}

async function isHtmlEndpointAvailable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return false;
    }
    const contentType = res.headers.get('content-type') ?? '';
    return contentType.toLowerCase().includes('text/html');
  } catch {
    return false;
  }
}

async function resolveAttachedRendererUrl(serverUrl: string): Promise<string> {
  const envRendererUrl = process.env.TSUBASA_RENDERER_URL?.trim();
  if (envRendererUrl) {
    return envRendererUrl;
  }

  const staticRootUrl = `${serverUrl}/`;
  if (await isHtmlEndpointAvailable(staticRootUrl)) {
    return staticRootUrl;
  }

  if (await isHtmlEndpointAvailable(VITE_DEV_URL)) {
    return VITE_DEV_URL;
  }

  return staticRootUrl;
}

function isServerReadyMessage(msg: unknown): msg is ServerReadyIpcMessage {
  if (!msg || typeof msg !== 'object') return false;
  const record = msg as Record<string, unknown>;
  return (
    record.type === 'tsubasa-server-ready' &&
    typeof record.port === 'number' &&
    typeof record.url === 'string'
  );
}

function isAuthCompletedMessage(msg: unknown): msg is AuthCompletedIpcMessage {
  if (!msg || typeof msg !== 'object') return false;
  const record = msg as Record<string, unknown>;
  return (
    record.type === 'tsubasa-auth-completed' &&
    record.payload !== null &&
    typeof record.payload === 'object'
  );
}

function shutdownSpawnedServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve();
    };

    child.once('exit', finish);

    if (child.connected) {
      try {
        child.send({ type: 'tsubasa-server-shutdown' });
      } catch {
        // Fall through to signal fallback if IPC channel is already closed.
      }
    }

    const termTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    }, SPAWN_SHUTDOWN_TIMEOUT_MS);

    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      finish();
    }, SPAWN_SHUTDOWN_TIMEOUT_MS + 1500);
  });
}

async function startSpawnedDevServer(options: {
  homeDir: string;
  packageRoot: string;
  staticDir: string;
  preferredPort: number;
  onAuthCompleted?: (payload: AuthCompletedEvent) => void;
}): Promise<ServerHostHandle> {
  const serverEntryPath = path.join(options.packageRoot, 'dist', 'server', 'index.js');
  const child = spawn('node', [serverEntryPath], {
    cwd: options.packageRoot,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      TSUBASA_HOME: options.homeDir,
      PORT: String(options.preferredPort),
      TSUBASA_HOSTNAME: '127.0.0.1',
      TSUBASA_FALLBACK_EPHEMERAL: '1',
      TSUBASA_SERVE_STATIC: '1',
      TSUBASA_STATIC_DIR: options.staticDir,
    },
  });

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = shutdownSpawnedServer(child);
    }
    return closePromise;
  };

  const ready = await new Promise<ServerReadyIpcMessage>((resolve, reject) => {
    let settled = false;

    const cleanupStartupListeners = () => {
      clearTimeout(readyTimer);
      child.off('error', onError);
      child.off('exit', onEarlyExit);
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupStartupListeners();
      reject(new Error(`Failed to spawn Tsubasa server process: ${err.message}`));
    };

    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanupStartupListeners();
      reject(
        new Error(
          `Tsubasa server process exited before ready (code=${String(code)}, signal=${String(signal)})`
        )
      );
    };

    const readyTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupStartupListeners();
      void close();
      reject(new Error('Timed out waiting for Tsubasa server startup'));
    }, SPAWN_READY_TIMEOUT_MS);

    child.on('message', (msg: unknown) => {
      if (isServerReadyMessage(msg) && !settled) {
        settled = true;
        cleanupStartupListeners();
        resolve(msg);
        return;
      }
      if (isAuthCompletedMessage(msg)) {
        try {
          options.onAuthCompleted?.(msg.payload);
        } catch {
          // Ignore renderer notification failures.
        }
      }
    });

    child.once('error', onError);
    child.once('exit', onEarlyExit);
  });

  const envRendererUrl = process.env.TSUBASA_RENDERER_URL?.trim();
  return {
    mode: 'spawned',
    port: ready.port,
    serverUrl: ready.url,
    rendererUrl: envRendererUrl || `${ready.url}/`,
    close,
  };
}

export async function startServerHost(options: StartServerHostOptions): Promise<ServerHostHandle> {
  const preferredPort = options.preferredPort ?? (Number(process.env.PORT) || 3000);
  const expectedFingerprint = computeDbFingerprint(resolveDbPath(options.homeDir));

  const attachedServerUrl = await probeExistingBackend(preferredPort, expectedFingerprint);
  if (attachedServerUrl) {
    const rendererUrl = await resolveAttachedRendererUrl(attachedServerUrl);
    return {
      mode: 'attached',
      port: preferredPort,
      serverUrl: attachedServerUrl,
      rendererUrl,
      close: async () => {},
    };
  }

  const staticDir = path.join(options.packageRoot, 'dist');

  if (options.isPackaged) {
    const { startTsubasaServer } = await import('../server/index.js');
    const started = await startTsubasaServer({
      hostname: '127.0.0.1',
      port: preferredPort,
      fallbackToEphemeralPort: true,
      staticDir,
      homeDir: options.homeDir,
      registerSignalHandlers: false,
      onAuthCompleted: options.onAuthCompleted,
    });
    const envRendererUrl = process.env.TSUBASA_RENDERER_URL?.trim();
    return {
      mode: 'embedded',
      port: started.port,
      serverUrl: started.url,
      rendererUrl: envRendererUrl || `${started.url}/`,
      close: () => started.close(),
    };
  }

  return startSpawnedDevServer({
    homeDir: options.homeDir,
    packageRoot: options.packageRoot,
    staticDir,
    preferredPort,
    onAuthCompleted: options.onAuthCompleted,
  });
}
