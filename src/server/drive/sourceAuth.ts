import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { google, type drive_v3 } from 'googleapis';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { resolveSourceTokensDir } from '../paths.js';
import { extractEmailFromIdToken } from './auth.js';

export type SourceAuthScopeMode = 'drive' | 'drive.readonly';

export interface SourceOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  sourceFile: string;
}

export interface CachedSourceTokenRecord {
  cacheKey: string;
  clientId: string;
  scopeMode: SourceAuthScopeMode;
  email: string | null;
  tokens: Credentials;
  updatedAtMs: number;
}

export interface CachedSourceTokenSummary {
  cacheKey: string;
  tokenPath: string;
  clientId: string;
  scopeMode: SourceAuthScopeMode;
  email: string | null;
  expiryDate: number | null;
  hasRefreshToken: boolean;
  updatedAtMs: number;
}

export interface AcquireSourceDriveClientOptions {
  credPath: string;
  scopeMode?: SourceAuthScopeMode;
  noBrowser?: boolean;
  homeDir?: string;
  timeoutMs?: number;
  onAuthUrl?: (url: string) => void;
}

export interface AcquiredSourceDriveClient {
  client: OAuth2Client;
  drive: drive_v3.Drive;
  email: string | null;
  cacheKey: string;
  tokenPath: string;
  reusedCache: boolean;
}

function getScopesForMode(scopeMode: SourceAuthScopeMode): string[] {
  const driveScope =
    scopeMode === 'drive.readonly'
      ? 'https://www.googleapis.com/auth/drive.readonly'
      : 'https://www.googleapis.com/auth/drive';
  return [driveScope, 'https://www.googleapis.com/auth/userinfo.email'];
}

export function parseSourceCredentialFile(credPath: string): SourceOAuthClientConfig {
  const resolvedPath = path.resolve(credPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Source OAuth credential file not found: ${resolvedPath}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Invalid JSON in source OAuth credential file ${resolvedPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const section =
    (parsed.installed as Record<string, unknown> | undefined) ??
    (parsed.web as Record<string, unknown> | undefined) ??
    parsed;

  const clientId = typeof section.client_id === 'string' ? section.client_id.trim() : '';
  const clientSecret =
    typeof section.client_secret === 'string' ? section.client_secret.trim() : '';
  const redirectUris = Array.isArray(section.redirect_uris)
    ? section.redirect_uris.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    : [];

  if (!clientId || !clientSecret) {
    throw new Error(
      `Source OAuth credential file ${resolvedPath} is missing client_id or client_secret`
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUris,
    sourceFile: resolvedPath,
  };
}

export function getSourceTokenCacheKey(
  clientId: string,
  scopeMode: SourceAuthScopeMode
): string {
  const digest = createHash('sha256')
    .update(`${clientId.trim()}|${scopeMode}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  const prefix = scopeMode === 'drive.readonly' ? 'readonly' : 'drive';
  return `${prefix}_${digest}`;
}

export function getSourceTokenPath(
  clientId: string,
  scopeMode: SourceAuthScopeMode,
  homeDir?: string
): string {
  const dir = resolveSourceTokensDir(homeDir);
  const key = getSourceTokenCacheKey(clientId, scopeMode);
  return path.join(dir, `${key}.json`);
}

function writeTokenRecordAtomic(tokenPath: string, record: CachedSourceTokenRecord): void {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const tmpPath = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmpPath, tokenPath);
}

function readTokenRecord(tokenPath: string): CachedSourceTokenRecord | null {
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8')) as Partial<CachedSourceTokenRecord>;
    if (
      typeof parsed.cacheKey !== 'string' ||
      typeof parsed.clientId !== 'string' ||
      (parsed.scopeMode !== 'drive' && parsed.scopeMode !== 'drive.readonly') ||
      !parsed.tokens ||
      typeof parsed.tokens !== 'object'
    ) {
      return null;
    }
    return {
      cacheKey: parsed.cacheKey,
      clientId: parsed.clientId,
      scopeMode: parsed.scopeMode,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      tokens: parsed.tokens,
      updatedAtMs: typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : Date.now(),
    };
  } catch {
    return null;
  }
}

export function listCachedSourceTokens(homeDir?: string): CachedSourceTokenSummary[] {
  const dir = resolveSourceTokensDir(homeDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const summaries: CachedSourceTokenSummary[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) {
      continue;
    }
    const tokenPath = path.join(dir, name);
    const record = readTokenRecord(tokenPath);
    if (!record) {
      continue;
    }
    summaries.push({
      cacheKey: record.cacheKey,
      tokenPath,
      clientId: record.clientId,
      scopeMode: record.scopeMode,
      email: record.email,
      expiryDate: typeof record.tokens.expiry_date === 'number' ? record.tokens.expiry_date : null,
      hasRefreshToken: Boolean(record.tokens.refresh_token),
      updatedAtMs: record.updatedAtMs,
    });
  }

  summaries.sort((a, b) => a.cacheKey.localeCompare(b.cacheKey));
  return summaries;
}

export function clearSourceTokens(filter?: {
  cacheKey?: string;
  clientId?: string;
  scopeMode?: SourceAuthScopeMode;
  homeDir?: string;
}): { deletedCount: number; deletedKeys: string[] } {
  const cached = listCachedSourceTokens(filter?.homeDir);
  const deletedKeys: string[] = [];

  for (const item of cached) {
    if (filter?.cacheKey && item.cacheKey !== filter.cacheKey) {
      continue;
    }
    if (filter?.clientId && item.clientId !== filter.clientId) {
      continue;
    }
    if (filter?.scopeMode && item.scopeMode !== filter.scopeMode) {
      continue;
    }
    try {
      fs.unlinkSync(item.tokenPath);
      deletedKeys.push(item.cacheKey);
    } catch {
      // Ignore already-removed token files.
    }
  }

  return {
    deletedCount: deletedKeys.length,
    deletedKeys,
  };
}

function tryOpenBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    }
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // Best-effort browser launch; auth URL is always emitted to stderr.
  }
}

function startLoopbackServer(expectedState: string): Promise<{
  redirectUri: string;
  waitForCode: (timeoutMs: number) => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolveStart, rejectStart) => {
    let settled = false;
    let resolveCode: ((code: string) => void) | null = null;
    let rejectCode: ((err: Error) => void) | null = null;

    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const errorParam = reqUrl.searchParams.get('error');
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');

      if (errorParam) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Source Drive authorization failed</h1><p>You may close this tab.</p>');
        if (!settled) {
          settled = true;
          rejectCode?.(new Error(`Google OAuth error: ${errorParam}`));
        }
        return;
      }

      if (!code || (state && state !== expectedState)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Invalid callback parameters</h1><p>You may close this tab.</p>');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Source Drive authorization complete</h1><p>Return to your terminal.</p>');
      if (!settled) {
        settled = true;
        resolveCode?.(code);
      }
    });

    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        rejectCode?.(err);
      }
      rejectStart(err);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectStart(new Error('Failed to bind ephemeral loopback port'));
        return;
      }
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;

      resolveStart({
        redirectUri,
        waitForCode: (timeoutMs: number) =>
          new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                reject(new Error('Timed out waiting for source Drive OAuth callback'));
              }
            }, timeoutMs);
            timer.unref?.();

            codePromise.then(
              (code) => {
                clearTimeout(timer);
                resolve(code);
              },
              (err) => {
                clearTimeout(timer);
                reject(err);
              }
            );
          }),
        close: () => {
          try {
            server.close();
          } catch {
            // Ignore close errors.
          }
        },
      });
    });
  });
}

async function promptForManualCode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const raw = (await rl.question('Paste the authorization code or callback URL: ')).trim();
    if (!raw) {
      throw new Error('Authorization code is required');
    }
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const parsed = new URL(raw);
      const code = parsed.searchParams.get('code');
      if (!code) {
        throw new Error('Callback URL is missing the code query parameter');
      }
      return code;
    }
    return raw;
  } finally {
    rl.close();
  }
}

export async function acquireSourceOAuthClient(
  options: AcquireSourceDriveClientOptions
): Promise<AcquiredSourceDriveClient> {
  const scopeMode: SourceAuthScopeMode = options.scopeMode ?? 'drive';
  const config = parseSourceCredentialFile(options.credPath);
  const cacheKey = getSourceTokenCacheKey(config.clientId, scopeMode);
  const tokenPath = getSourceTokenPath(config.clientId, scopeMode, options.homeDir);

  const attachTokenPersistence = (
    client: OAuth2Client,
    initialRecord: CachedSourceTokenRecord
  ): void => {
    let current = initialRecord;
    client.on('tokens', (newTokens) => {
      const merged: Credentials = {
        ...current.tokens,
        ...newTokens,
        refresh_token: newTokens.refresh_token || current.tokens.refresh_token,
      };
      const email = extractEmailFromIdToken(merged.id_token) ?? current.email;
      current = {
        ...current,
        email,
        tokens: merged,
        updatedAtMs: Date.now(),
      };
      try {
        writeTokenRecordAtomic(tokenPath, current);
      } catch {
        // Best-effort token cache refresh persistence.
      }
    });
  };

  const cached = readTokenRecord(tokenPath);
  const nowMs = Date.now();
  const isCacheUsable =
    cached !== null &&
    (Boolean(cached.tokens.refresh_token) ||
      (typeof cached.tokens.expiry_date === 'number' && cached.tokens.expiry_date > nowMs + 60_000));

  if (cached && isCacheUsable) {
    const client = new OAuth2Client(config.clientId, config.clientSecret);
    client.setCredentials(cached.tokens);
    attachTokenPersistence(client, cached);
    await client.getAccessToken();
    const drive = google.drive({ version: 'v3', auth: client });
    return {
      client,
      drive,
      email: cached.email,
      cacheKey,
      tokenPath,
      reusedCache: true,
    };
  }

  const state = cacheKey;
  const loopback = await startLoopbackServer(state);
  try {
    const client = new OAuth2Client(config.clientId, config.clientSecret, loopback.redirectUri);
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: getScopesForMode(scopeMode),
      state,
    });

    if (options.onAuthUrl) {
      options.onAuthUrl(authUrl);
    } else {
      process.stderr.write(`Open this URL to authorize the source Drive account:\n${authUrl}\n`);
    }

    const timeoutMs = options.timeoutMs ?? 300_000;
    let code: string;
    if (options.noBrowser) {
      if (process.stdin.isTTY) {
        code = await Promise.race([
          loopback.waitForCode(timeoutMs),
          promptForManualCode(),
        ]);
      } else {
        code = await loopback.waitForCode(timeoutMs);
      }
    } else {
      tryOpenBrowser(authUrl);
      code = await loopback.waitForCode(timeoutMs);
    }

    const tokenRes = await client.getToken({
      code,
      redirect_uri: loopback.redirectUri,
    });
    const tokens = tokenRes.tokens;
    client.setCredentials(tokens);

    const email = extractEmailFromIdToken(tokens.id_token);
    const record: CachedSourceTokenRecord = {
      cacheKey,
      clientId: config.clientId,
      scopeMode,
      email,
      tokens,
      updatedAtMs: Date.now(),
    };
    writeTokenRecordAtomic(tokenPath, record);
    attachTokenPersistence(client, record);

    const drive = google.drive({ version: 'v3', auth: client });
    return {
      client,
      drive,
      email,
      cacheKey,
      tokenPath,
      reusedCache: false,
    };
  } finally {
    loopback.close();
  }
}
