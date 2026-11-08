import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { validator } from 'hono/validator';
import { db, sqlite } from './db/index.js';
import { accounts, files, folders } from './db/schema.js';
import { eq, like, or } from 'drizzle-orm';
import {
  authPool,
  hydrateAccount,
  runColdReconciliation,
  runIncrementalSync,
  syncAllAccounts,
  initiateResumableUpload,
  executeStreamingUpload,
  getStreamingDownload,
  trashFile,
  restoreFile,
  purgeFile,
  emptyTrash,
  scanAccountDiscrepancies,
  acceptExternalFile,
  ejectFileToDriveRoot,
  rebalanceFile,
  executeAutoRebalance,
} from './drive/index.js';
import {
  getPooledStorageOverview,
  getAccountTransferStats,
  selectPlacementForFile,
  planBatchPlacement,
  FileExceedsCeilingError,
  InsufficientStorageError,
} from './storage/index.js';

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
    const overview = await getPooledStorageOverview();
    return c.json(overview);
  })
  .get('/api/storage/transfer-stats/:id', async (c) => {
    const accountId = c.req.param('id');
    try {
      const stats = await getAccountTransferStats(accountId);
      return c.json(stats);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post(
    '/api/storage/placement/file',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (typeof body?.virtualPath !== 'string' || typeof body?.sizeBytes !== 'number') {
        return c.json({ error: 'Invalid payload: virtualPath (string) and sizeBytes (number) required' }, 400);
      }
      return { virtualPath: body.virtualPath, sizeBytes: body.sizeBytes };
    }),
    async (c) => {
      const item = c.req.valid('json');
      try {
        const decision = await selectPlacementForFile(item);
        return c.json(decision);
      } catch (err) {
        if (err instanceof FileExceedsCeilingError) {
          return c.json({ error: err.message, code: 'EXCEEDS_CEILING' }, 400);
        }
        if (err instanceof InsufficientStorageError) {
          return c.json({ error: err.message, code: 'INSUFFICIENT_STORAGE' }, 507);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/storage/placement/batch',
    validator('json', (value, c) => {
      const body = value as { items?: unknown };
      if (!Array.isArray(body?.items)) {
        return c.json({ error: 'Invalid payload: items (array) required' }, 400);
      }
      for (const item of body.items) {
        if (typeof item?.virtualPath !== 'string' || typeof item?.sizeBytes !== 'number') {
          return c.json({ error: 'Each item requires virtualPath (string) and sizeBytes (number)' }, 400);
        }
      }
      return { items: body.items as Array<{ virtualPath: string; sizeBytes: number }> };
    }),
    async (c) => {
      const { items } = c.req.valid('json');
      try {
        const plan = await planBatchPlacement(items);
        return c.json(plan);
      } catch (err) {
        if (err instanceof FileExceedsCeilingError) {
          return c.json({ error: err.message, code: 'EXCEEDS_CEILING' }, 400);
        }
        if (err instanceof InsufficientStorageError) {
          return c.json({ error: err.message, code: 'INSUFFICIENT_STORAGE' }, 507);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
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
  )
  .post(
    '/api/folders',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (typeof body?.virtualPath !== 'string' || typeof body?.name !== 'string') {
        return c.json({ error: 'virtualPath (string) and name (string) are required' }, 400);
      }
      return {
        virtualPath: body.virtualPath,
        name: body.name,
      };
    }),
    async (c) => {
      const { virtualPath, name } = c.req.valid('json');
      const normalizedPath = virtualPath.startsWith('/') ? virtualPath : '/' + virtualPath;
      try {
        await db
          .insert(folders)
          .values({
            id: normalizedPath,
            virtualPath: normalizedPath,
            name,
          })
          .onConflictDoNothing();

        return c.json({ id: normalizedPath, virtualPath: normalizedPath, name }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .delete('/api/folders', async (c) => {
    const virtualPath = c.req.query('virtualPath') || c.req.query('path') || c.req.query('id');
    if (!virtualPath) {
      return c.json({ error: 'virtualPath query parameter required' }, 400);
    }
    const normalizedPath = virtualPath.startsWith('/') ? virtualPath : '/' + virtualPath;
    try {
      // Soft-trash descendant files
      await db
        .update(files)
        .set({ isTrashed: true, trashedAt: new Date() })
        .where(
          or(
            like(files.virtualPath, `${normalizedPath}/%`),
            eq(files.folderId, normalizedPath),
            eq(files.folderId, virtualPath)
          )
        );

      // Delete folder and nested folders
      await db
        .delete(folders)
        .where(
          or(
            eq(folders.virtualPath, normalizedPath),
            like(folders.virtualPath, `${normalizedPath}/%`),
            eq(folders.id, normalizedPath),
            eq(folders.id, virtualPath)
          )
        );

      return c.json({ success: true, virtualPath: normalizedPath });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post(
    '/api/files/upload/session',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (typeof body?.virtualPath !== 'string' || typeof body?.sizeBytes !== 'number') {
        return c.json({ error: 'virtualPath (string) and sizeBytes (number) are required' }, 400);
      }
      return {
        virtualPath: body.virtualPath,
        sizeBytes: body.sizeBytes,
        mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
        hash: typeof body.hash === 'string' ? body.hash : undefined,
      };
    }),
    async (c) => {
      const payload = c.req.valid('json');
      try {
        const session = await initiateResumableUpload(payload);
        return c.json(session);
      } catch (err) {
        if (err instanceof FileExceedsCeilingError) {
          return c.json({ error: err.message, code: 'EXCEEDS_CEILING' }, 400);
        }
        if (err instanceof InsufficientStorageError) {
          return c.json({ error: err.message, code: 'INSUFFICIENT_STORAGE' }, 507);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post('/api/files/upload', async (c) => {
    const virtualPath = c.req.query('virtualPath') || c.req.header('x-virtual-path');
    const sizeHeader = c.req.query('sizeBytes') || c.req.header('x-file-size') || c.req.header('content-length');
    const mimeType = c.req.query('mimeType') || c.req.header('content-type') || 'application/octet-stream';
    const hash = c.req.query('hash') || c.req.header('x-file-hash');

    if (!virtualPath || !sizeHeader) {
      return c.json({ error: 'virtualPath and sizeBytes (or Content-Length) required' }, 400);
    }

    const sizeBytes = Number(sizeHeader);
    if (isNaN(sizeBytes) || sizeBytes < 0) {
      return c.json({ error: 'sizeBytes must be a valid positive number' }, 400);
    }

    if (!c.req.raw.body) {
      return c.json({ error: 'Request body stream is missing' }, 400);
    }

    try {
      const record = await executeStreamingUpload(
        { virtualPath, sizeBytes, mimeType, hash: hash || undefined },
        c.req.raw.body
      );
      return c.json(record);
    } catch (err) {
      if (err instanceof FileExceedsCeilingError) {
        return c.json({ error: err.message, code: 'EXCEEDS_CEILING' }, 400);
      }
      if (err instanceof InsufficientStorageError) {
        return c.json({ error: err.message, code: 'INSUFFICIENT_STORAGE' }, 507);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .get('/api/files/:id/download', async (c) => {
    const fileId = c.req.param('id');
    try {
      const { stream, file } = await getStreamingDownload(fileId);
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': file.mimeType || 'application/octet-stream',
          'Content-Length': String(file.sizeBytes),
          'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  })
  .post('/api/files/:id/trash', async (c) => {
    const fileId = c.req.param('id');
    try {
      const updated = await trashFile(fileId);
      return c.json(updated);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post('/api/files/:id/restore', async (c) => {
    const fileId = c.req.param('id');
    try {
      const updated = await restoreFile(fileId);
      return c.json(updated);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .delete('/api/files/:id/permanent', async (c) => {
    const fileId = c.req.param('id');
    try {
      const purged = await purgeFile(fileId);
      return c.json(purged);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .delete('/api/trash/empty', async (c) => {
    try {
      const report = await emptyTrash();
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .get('/api/trash', async (c) => {
    const trashedFiles = await db.select().from(files).where(eq(files.isTrashed, true));
    return c.json({ files: trashedFiles });
  })
  .get('/api/sync/external-changes/:accountId', async (c) => {
    const accountId = c.req.param('accountId');
    try {
      const report = await scanAccountDiscrepancies(accountId);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post(
    '/api/sync/resolve/accept',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (typeof body?.accountId !== 'string' || typeof body?.driveFileId !== 'string') {
        return c.json({ error: 'accountId and driveFileId required' }, 400);
      }
      return {
        accountId: body.accountId,
        driveFileId: body.driveFileId,
        targetVirtualPath: typeof body.targetVirtualPath === 'string' ? body.targetVirtualPath : undefined,
      };
    }),
    async (c) => {
      const { accountId, driveFileId, targetVirtualPath } = c.req.valid('json');
      try {
        const record = await acceptExternalFile(accountId, driveFileId, targetVirtualPath);
        return c.json(record);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/sync/resolve/move-to-root',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (typeof body?.accountId !== 'string' || typeof body?.driveFileId !== 'string') {
        return c.json({ error: 'accountId and driveFileId required' }, 400);
      }
      return { accountId: body.accountId, driveFileId: body.driveFileId };
    }),
    async (c) => {
      const { accountId, driveFileId } = c.req.valid('json');
      try {
        await ejectFileToDriveRoot(accountId, driveFileId);
        return c.json({ success: true, accountId, driveFileId });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/sync/rebalance/file',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (typeof body?.fileId !== 'string' || typeof body?.targetAccountId !== 'string') {
        return c.json({ error: 'fileId and targetAccountId required' }, 400);
      }
      return { fileId: body.fileId, targetAccountId: body.targetAccountId };
    }),
    async (c) => {
      const { fileId, targetAccountId } = c.req.valid('json');
      try {
        const result = await rebalanceFile(fileId, targetAccountId);
        return c.json(result);
      } catch (err) {
        if (err instanceof InsufficientStorageError) {
          return c.json({ error: err.message, code: 'INSUFFICIENT_STORAGE' }, 507);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post('/api/sync/rebalance/auto/:accountId', async (c) => {
    const accountId = c.req.param('accountId');
    try {
      const results = await executeAutoRebalance(accountId);
      return c.json({ results });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

export type AppType = typeof app;
export default app;
