import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { db, sqlite } from './db/index.js';
import { accounts, files, folders, transferLogs } from './db/schema.js';
import { eq, sql } from 'drizzle-orm';

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
        journalMode: pragmaRes,
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
  .get('/api/files', async (c) => {
    const folderPath = c.req.query('path') || '/';
    const fileRecords = await db.select().from(files).where(eq(files.isTrashed, false));
    const folderRecords = await db.select().from(folders);

    return c.json({
      currentPath: folderPath,
      folders: folderRecords,
      files: fileRecords,
    });
  });

export type AppType = typeof app;
export default app;

