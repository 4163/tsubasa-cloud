import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { resolveOAuthsDir } from '../../server/paths.js';
import {
  emitSuccess,
  readFlagValue,
  resolvePoolArg,
  type CliContext,
} from '../context.js';
import { CliError, EXIT_CODES } from '../lib/errors.js';
import { renderTable } from '../lib/format.js';
import { maskEmail, toAccountRef } from '../lib/redact.js';
import { resolveAccountSelector } from '../lib/selectors.js';

interface AccountListItem {
  accountId: string;
  clientId?: string;
  email?: string;
  displayName?: string;
  poolId: number;
  authorized: boolean;
  syncState?: string;
  isDisabled: boolean;
  sourceFile?: string;
  canSwitchPool?: boolean;
}

interface AuthCheckRow {
  accountId: string;
  accountRef: string;
  email: string;
  poolId: number;
  authorized: boolean;
  syncState: string;
  hasCredentialFile: boolean;
  hasTokenFile: boolean;
  status: 'ok' | 'unauthorized' | 'error';
  [key: string]: unknown;
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
    // Browser launch is best-effort; URL is always printed to stderr.
  }
}

function scanOauthDirReadOnly(oauthDir: string): {
  credentialBaseNames: Set<string>;
  tokenBaseNames: Set<string>;
} {
  const credentialBaseNames = new Set<string>();
  const tokenBaseNames = new Set<string>();

  if (!fs.existsSync(oauthDir)) {
    return { credentialBaseNames, tokenBaseNames };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(oauthDir);
  } catch {
    return { credentialBaseNames, tokenBaseNames };
  }

  for (const name of entries) {
    if (name.startsWith('.') || name.endsWith('.tmp')) {
      continue;
    }
    if (name.endsWith('.tokens.json')) {
      tokenBaseNames.add(name.slice(0, -'.tokens.json'.length).toLowerCase());
      continue;
    }
    const base = path.basename(name, path.extname(name)).toLowerCase();
    credentialBaseNames.add(base);
  }

  return { credentialBaseNames, tokenBaseNames };
}

async function handleAuthCheck(ctx: CliContext, args: string[]): Promise<void> {
  const selector = args[0]?.trim();
  const res = await ctx.transport.requestJson<{ accounts: AccountListItem[] }>('/api/accounts');
  const normalizedAccounts = (res.accounts ?? []).map((acc) => ({
    ...acc,
    id: acc.accountId,
    email: acc.email ?? acc.accountId,
    syncState: acc.syncState ?? 'idle',
  }));

  let targetAccounts = normalizedAccounts;
  if (selector) {
    const matched = resolveAccountSelector(selector, normalizedAccounts);
    if (!matched) {
      throw new CliError('ACCOUNT_NOT_FOUND', `Account '${selector}' not found.`, {
        exitCode: EXIT_CODES.NOT_FOUND,
      });
    }
    targetAccounts = [matched];
  }

  const oauthDir = resolveOAuthsDir(ctx.transport.homeDir);
  const { credentialBaseNames, tokenBaseNames } = scanOauthDirReadOnly(oauthDir);

  const rows: AuthCheckRow[] = targetAccounts.map((acc) => {
    const key = acc.id.toLowerCase();
    const emailKey = acc.email.toLowerCase();
    const hasCredentialFile =
      Boolean(acc.sourceFile) ||
      credentialBaseNames.has(key) ||
      credentialBaseNames.has(emailKey);
    const hasTokenFile = tokenBaseNames.has(key) || tokenBaseNames.has(emailKey);
    const status: AuthCheckRow['status'] =
      !acc.authorized
        ? 'unauthorized'
        : acc.syncState === 'error'
          ? 'error'
          : 'ok';

    return {
      accountId: acc.id,
      accountRef: toAccountRef(acc.id),
      email: acc.email,
      poolId: acc.poolId,
      authorized: acc.authorized,
      syncState: acc.syncState,
      hasCredentialFile,
      hasTokenFile,
      status,
    };
  });

  const ok = rows.every((r) => r.status === 'ok');
  const table = renderTable(
    rows,
    [
      { key: 'accountRef', header: 'REF' },
      {
        key: 'email',
        header: 'ACCOUNT',
        format: (row) => (ctx.flags.showEmails ? row.email : maskEmail(row.email)),
      },
      { key: 'poolId', header: 'POOL', align: 'right' },
      {
        key: 'authorized',
        header: 'AUTH',
        format: (row) => (row.authorized ? 'yes' : 'no'),
      },
      { key: 'syncState', header: 'SYNC' },
      { key: 'status', header: 'STATUS' },
    ],
    { emptyMessage: 'No accounts configured.' }
  );

  emitSuccess(ctx, { ok, accounts: rows }, table);
}

interface LoopbackResult {
  code: string;
  state: string | null;
}

function startLoopbackCallbackServer(expectedState: string): Promise<{
  redirectUri: string;
  waitForCode: (timeoutMs?: number) => Promise<LoopbackResult>;
  close: () => void;
}> {
  return new Promise((resolveStart, rejectStart) => {
    let settleCode: ((res: LoopbackResult) => void) | null = null;
    let failCode: ((err: Error) => void) | null = null;
    let settled = false;

    const codePromise = new Promise<LoopbackResult>((resolve, reject) => {
      settleCode = resolve;
      failCode = reject;
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
        res.end('<h1>Authorization failed</h1><p>You may close this tab.</p>');
        if (!settled) {
          settled = true;
          failCode?.(new CliError('AUTH_ERROR', `Google OAuth error: ${errorParam}`, { exitCode: EXIT_CODES.AUTH_UPSTREAM }));
        }
        return;
      }

      if (!code || (state && state !== expectedState)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Invalid callback parameters</h1><p>You may close this tab.</p>');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Tsubasa authorization complete</h1><p>You may close this tab and return to the terminal.</p>');
      if (!settled) {
        settled = true;
        settleCode?.({ code, state });
      }
    });

    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        failCode?.(err);
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
        waitForCode: (timeoutMs = 300_000) => {
          return new Promise<LoopbackResult>((resolve, reject) => {
            const timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                reject(
                  new CliError('AUTH_ERROR', 'Timed out waiting for OAuth callback.', {
                    exitCode: EXIT_CODES.AUTH_UPSTREAM,
                  })
                );
              }
            }, timeoutMs);
            timer.unref?.();

            codePromise.then(
              (result) => {
                clearTimeout(timer);
                resolve(result);
              },
              (err) => {
                clearTimeout(timer);
                reject(err);
              }
            );
          });
        },
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

async function promptForManualCode(ctx: CliContext): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: ctx.stderr });
  try {
    const raw = (await rl.question('Paste the authorization code or full callback URL: ')).trim();
    if (!raw) {
      throw new CliError('USAGE_ERROR', 'Authorization code is required.', {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const parsed = new URL(raw);
      const code = parsed.searchParams.get('code');
      if (!code) {
        throw new CliError('USAGE_ERROR', 'Callback URL does not contain a code query parameter.', {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      return code;
    }
    return raw;
  } finally {
    rl.close();
  }
}

async function handleAuthAdd(ctx: CliContext, args: string[]): Promise<void> {
  let noBrowser = false;
  let credFilePath: string | null = null;
  let explicitPool: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--no-browser') {
      noBrowser = true;
      continue;
    }
    if (token === '--pool') {
      explicitPool = readFlagValue(args, i, '--pool');
      i += 1;
      continue;
    }
    if (token.startsWith('--pool=')) {
      explicitPool = token.slice('--pool='.length);
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag for auth add: ${token}`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    if (!credFilePath) {
      credFilePath = token;
    } else {
      throw new CliError('USAGE_ERROR', `Unexpected positional argument: ${token}`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
  }

  if (!credFilePath) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa auth add <credentials-file.json> [--no-browser]', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const resolvedFile = path.resolve(process.cwd(), credFilePath);
  if (!fs.existsSync(resolvedFile)) {
    throw new CliError('NOT_FOUND', `Credential file not found: ${resolvedFile}`, {
      exitCode: EXIT_CODES.NOT_FOUND,
    });
  }

  const content = fs.readFileSync(resolvedFile, 'utf8');
  const pool = await resolvePoolArg(ctx, explicitPool);

  const imported = await ctx.transport.requestJson<{
    success: boolean;
    accountId: string;
    authorized: boolean;
    poolId: number;
  }>('/api/accounts/oauth/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: path.basename(resolvedFile),
      content,
      poolId: pool.id,
    }),
  });

  if (imported.authorized) {
    const accountRef = toAccountRef(imported.accountId);
    emitSuccess(
      ctx,
      {
        accountId: imported.accountId,
        accountRef,
        poolId: imported.poolId,
        authorized: true,
      },
      `Account ${accountRef} imported and authorized in pool ${pool.slug} (id=${imported.poolId}).`
    );
    return;
  }

  if (ctx.transport.mode === 'http' && ctx.transport.serverUrl) {
    const redirectUri = `${ctx.transport.serverUrl}/api/auth/callback`;
    const authUrlRes = await ctx.transport.requestJson<{ url: string }>(
      `/api/accounts/auth-url/${encodeURIComponent(imported.accountId)}?redirect_uri=${encodeURIComponent(redirectUri)}`
    );
    ctx.stderr.write(`Open this URL to authorize:\n${authUrlRes.url}\n`);
    if (!noBrowser) {
      tryOpenBrowser(authUrlRes.url);
    }

    emitSuccess(
      ctx,
      {
        accountId: imported.accountId,
        accountRef: toAccountRef(imported.accountId),
        poolId: imported.poolId,
        authorized: false,
        authUrl: authUrlRes.url,
      },
      `Authorization URL generated. Complete sign-in in your browser to finish linking the account.`
    );
    return;
  }

  // Standalone local mode: run ephemeral loopback OAuth server on 127.0.0.1:0.
  const loopback = await startLoopbackCallbackServer(imported.accountId);
  try {
    const authUrlRes = await ctx.transport.requestJson<{ url: string }>(
      `/api/accounts/auth-url/${encodeURIComponent(imported.accountId)}?redirect_uri=${encodeURIComponent(loopback.redirectUri)}`
    );
    ctx.stderr.write(`Open this URL to authorize:\n${authUrlRes.url}\n`);

    let code: string;
    if (noBrowser) {
      if (ctx.isTTY) {
        const result = await Promise.race([
          loopback.waitForCode().then((r) => r.code),
          promptForManualCode(ctx),
        ]);
        code = result;
      } else {
        const result = await loopback.waitForCode();
        code = result.code;
      }
    } else {
      tryOpenBrowser(authUrlRes.url);
      const result = await loopback.waitForCode();
      code = result.code;
    }

    const { authPool } = await import('../../server/drive/auth.js');
    const callbackRes = await authPool.handleCallback(
      imported.accountId,
      code,
      loopback.redirectUri
    );
    const hydrated = await ctx.transport.requestJson<{ accountId: string; poolId: number }>(
      `/api/accounts/hydrate/${encodeURIComponent(callbackRes.accountId)}?poolId=${pool.id}`,
      { method: 'POST' }
    );

    const accountRef = toAccountRef(hydrated.accountId);
    emitSuccess(
      ctx,
      {
        accountId: hydrated.accountId,
        accountRef,
        poolId: hydrated.poolId,
        authorized: true,
      },
      `Account ${accountRef} authorized and linked to pool ${pool.slug} (id=${hydrated.poolId}).`
    );
  } finally {
    loopback.close();
  }
}

export async function runAuthCommand(ctx: CliContext, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa auth <check|add> [args...]', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (sub === 'check') {
    await handleAuthCheck(ctx, args.slice(1));
    return;
  }
  if (sub === 'add') {
    await handleAuthAdd(ctx, args.slice(1));
    return;
  }

  throw new CliError('USAGE_ERROR', `Unknown auth subcommand '${sub}'. Expected: check, add.`, {
    exitCode: EXIT_CODES.USAGE,
  });
}
