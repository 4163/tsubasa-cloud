import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { validator } from 'hono/validator';
import { db, sqlite } from './db/index.js';
import { accounts, files, folders } from './db/schema.js';
import { eq } from 'drizzle-orm';
import {
  authPool,
  hydrateAccount,
  runColdReconciliation,
  runIncrementalSync,
  syncAllAccounts,
} from './drive/index.js';

const app = new Hono()
  .use('*', logger())
  .use('*', cors())
  .get('/api/health', (c) => {
    const pragmaRes = sqlite.pragma('journal_mode', { simple: true });
    return c.json({
      status: 'ok',
      service: 'tsubasa-backend',
      timestamp: Date.now(),
      sqlite: {
        journalMode: String(pragmaRes ?? 'wal'),
      },
    });
  })
  .get('/api/storage/overview', async (c) => {
    const allAccounts = await db.select().from(accounts);

    // Safety buffer is 750MB per account
    const safetyBufferBytes = 750 * 1024 * 1024;

    let totalLimit = 0;
    let totalUsed = 0;
    let totalHeadroom = 0;

    const accountSummaries = allAccounts.map((acc) => {
      totalLimit += acc.quotaLimitBytes;
      totalUsed += acc.quotaUsedBytes;
      const usableLimit = Math.max(0, acc.quotaLimitBytes - safetyBufferBytes);
      const headroom = Math.max(0, usableLimit - acc.quotaUsedBytes);
      totalHeadroom += headroom;
      return {
        id: acc.id,
        email: acc.email,
        displayName: acc.displayName,
        avatarUrl: acc.avatarUrl,
        quotaLimitBytes: acc.quotaLimitBytes,
        quotaUsedBytes: acc.quotaUsedBytes,
        usableLimitBytes: usableLimit,
        headroomBytes: headroom,
        syncState: acc.syncState,
      };
    });

    return c.json({
      totalAccounts: allAccounts.length,
      totalLimitBytes: totalLimit,
      totalUsedBytes: totalUsed,
      totalHeadroomBytes: totalHeadroom,
      accounts: accountSummaries,
    });
  })
  .get('/api/accounts/pool', (c) => {
    authPool.scan();
    const records = authPool.getAll();
    const list = records.map((r) => ({
      accountId: r.config.accountId,
      clientId: r.config.clientId,
      authorized: r.authorized,
      sourceFile: r.config.sourceFile,
    }));
    return c.json({ accounts: list });
  })
  .get(
    '/api/accounts/auth-url/:id',
    validator('query', (value): { redirect_uri?: string } => {
      return typeof value.redirect_uri === 'string' ? { redirect_uri: value.redirect_uri } : {};
    }),
    (c) => {
      const accountId = c.req.param('id');
      const { redirect_uri: redirectUri } = c.req.valid('query');
      try {
        const url = authPool.generateAuthUrl(accountId, redirectUri);
        return c.json({ url });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
  )
  .get('/api/auth/callback', async (c) => {
    const code = c.req.query('code');
    const accountId = c.req.query('state');

    if (!code || !accountId) {
      return c.text('Missing required OAuth parameters: code or state', 400);
    }

    try {
      const url = new URL(c.req.url);
      const redirectUri = `${url.origin}/api/auth/callback`;
      await authPool.handleCallback(accountId, code, redirectUri);

      await hydrateAccount(accountId);

      const clientOrigin = process.env.CLIENT_URL || (url.port === '3000' ? 'http://localhost:5173' : url.origin);
      return c.redirect(`${clientOrigin}/?auth=success&account=` + encodeURIComponent(accountId));
    } catch (err) {
      return c.text(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
  })
  .post('/api/sync/all', async (c) => {
    try {
      const report = await syncAllAccounts();
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post('/api/sync/:id', async (c) => {
    const accountId = c.req.param('id');
    try {
      const report = await runIncrementalSync(accountId);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post('/api/sync/:id/cold', async (c) => {
    const accountId = c.req.param('id');
    try {
      const report = await runColdReconciliation(accountId);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post('/api/accounts/hydrate/:id', async (c) => {
    const accountId = c.req.param('id');
    try {
      const result = await hydrateAccount(accountId);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .get(
    '/api/files',
    validator('query', (value) => {
      const folderPath = typeof value.path === 'string' ? value.path : undefined;
      return { path: folderPath };
    }),
    async (c) => {
      const { path: folderPath = '/' } = c.req.valid('query');
      const fileRecords = await db.select().from(files).where(eq(files.isTrashed, false));
      const folderRecords = await db.select().from(folders);

      return c.json({
        currentPath: folderPath,
        folders: folderRecords,
        files: fileRecords,
      });
    }
  );

export type AppType = typeof app;
export default app;
