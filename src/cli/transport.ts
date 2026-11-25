import {
  computeDbFingerprint,
  resolveTsubasaPaths,
  setTsubasaHomeOverride,
} from '../server/paths.js';
import {
  acquireWriterLock,
  readWriterLock,
  WriterLockError,
  type WriterLockHandle,
} from '../server/lock.js';
import { getDefaultServerPort, isValidPort } from '../server/ports.js';
import { CliError, EXIT_CODES, mapErrorCodeToExitCode } from './lib/errors.js';

export interface TransportOptions {
  homeDir?: string;
  server?: string;
  local?: boolean;
  write?: boolean;
  noWaitOutbox?: boolean;
  outboxTimeoutMs?: number;
}

export interface CliTransport {
  readonly mode: 'http' | 'local';
  readonly serverUrl: string | null;
  readonly homeDir: string;
  readonly dbPath: string;
  readonly dbFingerprint: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  requestJson<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  close(): Promise<void>;
}

interface HealthResponse {
  service?: unknown;
  dbFingerprint?: unknown;
}

const AUTO_PROBE_TIMEOUT_MS = 250;
const EXPLICIT_SERVER_TIMEOUT_MS = 2_000;

function normalizeBaseUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/+$/, '');
}

function getDefaultServerUrl(): string {
  return `http://127.0.0.1:${getDefaultServerPort()}`;
}

function getAutoProbeCandidateUrls(writerLockPath: string): string[] {
  const defaultUrl = getDefaultServerUrl();
  const lockPort = readWriterLock(writerLockPath)?.port;
  const lockUrl = isValidPort(lockPort) ? `http://127.0.0.1:${lockPort}` : null;
  const hasExplicitEnvPort = Boolean(process.env.PORT?.trim());

  const ordered = hasExplicitEnvPort ? [defaultUrl, lockUrl] : [lockUrl, defaultUrl];
  const unique: string[] = [];
  for (const url of ordered) {
    if (url && !unique.includes(url)) {
      unique.push(url);
    }
  }
  return unique;
}

async function probeAutoServer(
  writerLockPath: string,
  expectedFingerprint: string
): Promise<string | null> {
  for (const candidateUrl of getAutoProbeCandidateUrls(writerLockPath)) {
    const probe = await probeHealth(candidateUrl, AUTO_PROBE_TIMEOUT_MS);
    if (probe.ok && probe.dbFingerprint === expectedFingerprint) {
      return candidateUrl;
    }
  }
  return null;
}

async function probeHealth(
  baseUrl: string,
  timeoutMs: number
): Promise<{ ok: true; dbFingerprint: string | null } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as HealthResponse;
    if (body?.service !== 'tsubasa-backend') {
      return { ok: false, reason: 'Target is not a Tsubasa backend' };
    }
    const fingerprint = typeof body.dbFingerprint === 'string' ? body.dbFingerprint : null;
    return { ok: true, dbFingerprint: fingerprint };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function parseResponseJsonOrThrow<T>(response: Response): Promise<T> {
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
  }

  if (response.ok) {
    return parsed as T;
  }

  const record =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  const code =
    typeof record.code === 'string' && record.code.length > 0
      ? record.code
      : response.status === 404
        ? 'NOT_FOUND'
        : response.status === 409
          ? 'CONFLICT'
          : response.status === 401 || response.status === 403
            ? 'AUTH_ERROR'
            : response.status === 400
              ? 'VALIDATION_ERROR'
              : 'RUNTIME_ERROR';
  const message =
    typeof record.error === 'string' && record.error.length > 0
      ? record.error
      : typeof record.message === 'string' && record.message.length > 0
        ? record.message
        : `Request failed with HTTP ${response.status}`;
  const hint = typeof record.hint === 'string' && record.hint.length > 0 ? record.hint : null;
  const details =
    record.details !== undefined
      ? record.details
      : 'conflicts' in record || 'cleanCount' in record
        ? {
            ...(record.conflicts !== undefined ? { conflicts: record.conflicts } : {}),
            ...(record.cleanCount !== undefined ? { cleanCount: record.cleanCount } : {}),
          }
        : null;

  throw new CliError(code, message, {
    exitCode: mapErrorCodeToExitCode(code, response.status),
    details,
    hint,
  });
}

function createHttpTransport(
  serverUrl: string,
  homeDir: string,
  dbPath: string,
  dbFingerprint: string
): CliTransport {
  const request = async (requestPath: string, init?: RequestInit): Promise<Response> => {
    const normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    try {
      return await fetch(`${serverUrl}${normalizedPath}`, init);
    } catch (err) {
      throw new CliError(
        'SERVER_UNREACHABLE',
        `Failed to reach Tsubasa server at ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`,
        {
          exitCode: EXIT_CODES.AUTH_UPSTREAM,
          hint: 'Verify the server is running or pass --local for standalone execution.',
        }
      );
    }
  };

  return {
    mode: 'http',
    serverUrl,
    homeDir,
    dbPath,
    dbFingerprint,
    request,
    async requestJson<T = unknown>(requestPath: string, init?: RequestInit): Promise<T> {
      const response = await request(requestPath, init);
      return parseResponseJsonOrThrow<T>(response);
    },
    async close(): Promise<void> {
      // HTTP transport holds no local SQLite or lock resources.
    },
  };
}

export async function createProbeOnlyTransport(
  options: Pick<TransportOptions, 'homeDir' | 'server' | 'local'> = {}
): Promise<CliTransport> {
  if (options.homeDir) {
    setTsubasaHomeOverride(options.homeDir);
  }

  const paths = resolveTsubasaPaths(options.homeDir);
  const dbFingerprint = computeDbFingerprint(paths.dbPath);

  const rawExplicitServer = options.server?.trim() || process.env.TSUBASA_API_URL?.trim() || '';
  if (rawExplicitServer && options.local) {
    throw new CliError(
      'USAGE_ERROR',
      'Cannot combine --server / TSUBASA_API_URL with --local.',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  let mode: 'http' | 'local' = 'local';
  let serverUrl: string | null = null;

  if (rawExplicitServer) {
    const explicitUrl = normalizeBaseUrl(rawExplicitServer);
    const probe = await probeHealth(explicitUrl, EXPLICIT_SERVER_TIMEOUT_MS);
    if (!probe.ok) {
      throw new CliError(
        'SERVER_UNREACHABLE',
        `Tsubasa server at ${explicitUrl} is unreachable (${probe.reason}).`,
        {
          exitCode: EXIT_CODES.AUTH_UPSTREAM,
          hint: 'Start the server or remove --server / TSUBASA_API_URL to allow local execution.',
        }
      );
    }
    mode = 'http';
    serverUrl = explicitUrl;
  } else if (!options.local) {
    const discoveredUrl = await probeAutoServer(paths.writerLockPath, dbFingerprint);
    if (discoveredUrl) {
      mode = 'http';
      serverUrl = discoveredUrl;
    }
  }

  const unsupported = async (): Promise<never> => {
    throw new CliError('RUNTIME_ERROR', 'Probe-only transport does not execute API requests.', {
      exitCode: EXIT_CODES.RUNTIME,
    });
  };

  return {
    mode,
    serverUrl,
    homeDir: paths.homeDir,
    dbPath: paths.dbPath,
    dbFingerprint,
    request: unsupported,
    requestJson: unsupported,
    async close(): Promise<void> {},
  };
}

export async function createCliTransport(options: TransportOptions = {}): Promise<CliTransport> {
  if (options.homeDir) {
    setTsubasaHomeOverride(options.homeDir);
  }

  const paths = resolveTsubasaPaths(options.homeDir);
  const dbFingerprint = computeDbFingerprint(paths.dbPath);

  const rawExplicitServer = options.server?.trim() || process.env.TSUBASA_API_URL?.trim() || '';
  if (rawExplicitServer && options.local) {
    throw new CliError(
      'USAGE_ERROR',
      'Cannot combine --server / TSUBASA_API_URL with --local.',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  if (rawExplicitServer) {
    const explicitUrl = normalizeBaseUrl(rawExplicitServer);
    const probe = await probeHealth(explicitUrl, EXPLICIT_SERVER_TIMEOUT_MS);
    if (!probe.ok) {
      throw new CliError(
        'SERVER_UNREACHABLE',
        `Tsubasa server at ${explicitUrl} is unreachable (${probe.reason}).`,
        {
          exitCode: EXIT_CODES.AUTH_UPSTREAM,
          hint: 'Start the server or remove --server / TSUBASA_API_URL to allow local execution.',
        }
      );
    }
    return createHttpTransport(explicitUrl, paths.homeDir, paths.dbPath, dbFingerprint);
  }

  if (!options.local) {
    const discoveredUrl = await probeAutoServer(paths.writerLockPath, dbFingerprint);
    if (discoveredUrl) {
      return createHttpTransport(discoveredUrl, paths.homeDir, paths.dbPath, dbFingerprint);
    }
  }

  let writerLock: WriterLockHandle | null = null;
  const onExit = () => {
    writerLock?.release();
  };
  const releaseWriterLock = () => {
    process.off('exit', onExit);
    writerLock?.release();
    writerLock = null;
  };

  if (options.write) {
    try {
      writerLock = acquireWriterLock({
        homeDir: paths.homeDir,
        command: process.argv.join(' '),
        cwd: process.cwd(),
      });
      process.once('exit', onExit);
    } catch (err) {
      if (err instanceof WriterLockError) {
        // If a server finished binding HTTP right after our initial probe, forward to it.
        if (!options.local) {
          const discoveredUrl = await probeAutoServer(paths.writerLockPath, dbFingerprint);
          if (discoveredUrl) {
            return createHttpTransport(discoveredUrl, paths.homeDir, paths.dbPath, dbFingerprint);
          }
        }
        throw new CliError('WRITER_LOCK_HELD', err.message, {
          exitCode: EXIT_CODES.CONFLICT,
          details: err.holder,
          hint: 'Wait for the active Tsubasa server or CLI write command to finish.',
        });
      }
      throw err;
    }

    // Re-probe once after acquiring the writer lock to close the TOCTOU window
    // against a concurrently starting Tsubasa server.
    if (!options.local) {
      const discoveredUrl = await probeAutoServer(paths.writerLockPath, dbFingerprint);
      if (discoveredUrl) {
        releaseWriterLock();
        return createHttpTransport(discoveredUrl, paths.homeDir, paths.dbPath, dbFingerprint);
      }
    }
  }

  let openedSqlite: { close(): unknown } | null = null;
  try {
    // Lazy-import server modules strictly after /api/health probing so SQLite
    // is never opened when forwarding to an active HTTP server.
    const [dbMod, initMod, authMod, outboxMod, appMod] = await Promise.all([
      import('../server/db/index.js'),
      import('../server/db/init.js'),
      import('../server/drive/auth.js'),
      import('../server/drive/outbox.js'),
      import('../server/app.js'),
    ]);
    openedSqlite = dbMod.sqlite;

    if (!options.write) {
      authMod.authPool.setReadOnlyMode(true);
      const userVersion = Number(dbMod.sqlite.pragma('user_version', { simple: true }));
      if (userVersion < 6) {
        let migrationLock: WriterLockHandle | null = null;
        try {
          migrationLock = acquireWriterLock({
            homeDir: paths.homeDir,
            command: `${process.argv.join(' ')} (schema-init)`,
            cwd: process.cwd(),
          });
        } catch (err) {
          if (err instanceof WriterLockError) {
            throw new CliError('WRITER_LOCK_HELD', err.message, {
              exitCode: EXIT_CODES.CONFLICT,
              details: err.holder,
              hint: 'Database schema initialization requires the writer lock. Wait for the active process to finish.',
            });
          }
          throw err;
        }
        try {
          initMod.initializeDatabase();
        } finally {
          migrationLock.release();
        }
      }
    } else {
      initMod.initializeDatabase();
    }

    let minOutboxId = 0;
    if (options.write) {
      authMod.authPool.ensureScanned({ readOnly: false });
      if (options.noWaitOutbox) {
        outboxMod.stopOutboxWorker();
      } else {
        minOutboxId = outboxMod.getMaxOutboxId();
      }
    }

    const app = appMod.createApp({
      enableHttpLogger: false,
      enableCompress: false,
    });

    let closed = false;

    const request = async (requestPath: string, init?: RequestInit): Promise<Response> => {
      const normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
      const url = new URL(normalizedPath, 'http://tsubasa.local');
      return app.fetch(new Request(url, init));
    };

    return {
      mode: 'local',
      serverUrl: null,
      homeDir: paths.homeDir,
      dbPath: paths.dbPath,
      dbFingerprint,
      request,
      async requestJson<T = unknown>(requestPath: string, init?: RequestInit): Promise<T> {
        const response = await request(requestPath, init);
        return parseResponseJsonOrThrow<T>(response);
      },
      async close(): Promise<void> {
        if (closed) {
          return;
        }
        closed = true;

        try {
          if (options.write && !options.noWaitOutbox) {
            const drainRes = await outboxMod.drainOutbox({
              minId: minOutboxId,
              timeoutMs: options.outboxTimeoutMs ?? 30_000,
            });
            if (drainRes.timedOut || drainRes.dead > 0) {
              process.stderr.write(
                `Warning: outbox drain finished with ${drainRes.remaining} remaining (${drainRes.pending} pending, ${drainRes.failed} failed, ${drainRes.dead} dead). Run 'tsubasa outbox list' to inspect.\n`
              );
            }
          }
        } finally {
          try {
            outboxMod.stopOutboxWorker();
          } finally {
            try {
              authMod.authPool.stopWatching();
            } finally {
              try {
                dbMod.sqlite.close();
              } finally {
                releaseWriterLock();
              }
            }
          }
        }
      },
    };
  } catch (err) {
    try {
      openedSqlite?.close();
    } catch {
      // Best-effort SQLite close before releasing writer lock.
    }
    releaseWriterLock();
    throw err;
  }
}
