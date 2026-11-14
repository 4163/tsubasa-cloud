import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { validator } from 'hono/validator';
import { db, sqlite } from './db/index.js';
import { accounts, files, folders, pools } from './db/schema.js';
import { eq, and, asc, sql } from 'drizzle-orm';
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
  acceptAllExternalFiles,
  ejectAllExternalFiles,
  ejectFileToDriveRoot,
  removeMissingFile,
  resolvePathConflict,
  resolvePathConflictsBatch,
  type ConflictResolutionAction,
  type PreScannedBatchItem,
  rebalanceFile,
  rebalanceFilesBatch,
  RebalanceValidationError,
  executeAutoRebalance,
  disableDriveAccount,
  enableDriveAccount,
  removeDriveAccount,
  moveItems,
  copyItems,
  renameItem,
  trashFolder,
  ensureLocalFolderHierarchy,
  AccountPoolLockedError,
  switchAccountPool,
  getPoolDriveFolderName,
  formatFolderId,
  isSharePoolId,
} from './drive/index.js';
import {
  getPooledStorageOverview,
  getAccountTransferStats,
  selectPlacementForFile,
  planBatchPlacement,
  FileExceedsCeilingError,
  InsufficientStorageError,
} from './storage/index.js';
import {
  inspectSharePlan,
  validateShareSelection,
  executeShare,
  clearSharePool,
  listSharePoolLinks,
  ShareValidationError,
  SharePoolNotFoundError,
  type ShareTargetInput,
} from './drive/share.js';

function parsePoolId(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function sharePoolReadOnlyError(message: string) {
  return { error: message, code: 'SHARE_POOL_READ_ONLY' } as const;
}

function isAccountInSharePool(accountId: string): boolean {
  const acc = sqlite.prepare('SELECT pool_id as poolId FROM accounts WHERE id = ? LIMIT 1').get(accountId) as
    | { poolId: number }
    | undefined;
  return Boolean(acc && isSharePoolId(acc.poolId));
}

const INSTANCE_LEASE_TTL_MS = 15_000;

type InstanceOwnerKind = 'browser' | 'electron';

interface ActiveInstanceLease {
  instanceId: string;
  ownerKind: InstanceOwnerKind;
  expiresAt: number;
}

let activeInstanceLease: ActiveInstanceLease | null = null;

function getLiveInstanceLease(now = Date.now()): ActiveInstanceLease | null {
  if (!activeInstanceLease) return null;
  if (activeInstanceLease.expiresAt <= now) {
    activeInstanceLease = null;
    return null;
  }
  return activeInstanceLease;
}

function parseInstanceOwnerKind(raw: unknown): InstanceOwnerKind {
  return raw === 'electron' ? 'electron' : 'browser';
}

function parseNonEmptyInstanceId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : undefined;
}

function parseShareTargetItems(raw: unknown): ShareTargetInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parsed: ShareTargetInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if ((rec.kind !== 'file' && rec.kind !== 'folder') || typeof rec.id !== 'string' || !rec.id.trim()) {
      return null;
    }
    parsed.push({ kind: rec.kind, id: rec.id });
  }
  return parsed;
}

function parseStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

async function getAccountsList(poolId?: number) {
  authPool.scan();
  const records = authPool.getAll();
  const dbAccounts = await db.select().from(accounts);
  const dbMap = new Map(dbAccounts.map((a) => [a.id, a]));

  const accountsWithFiles = new Set(
    (
      sqlite
        .prepare('SELECT DISTINCT account_id FROM files')
        .all() as Array<{ account_id: string }>
    ).map((row) => row.account_id)
  );

  const list = records.map((r) => {
    const dbAcc = dbMap.get(r.config.accountId);
    const accountPoolId = dbAcc?.poolId ?? authPool.getPreferredPool(r.config.accountId) ?? 1;
    const canSwitchPool = !accountsWithFiles.has(r.config.accountId);

    return {
      accountId: r.config.accountId,
      clientId: r.config.clientId,
      authorized: r.authorized,
      sourceFile: r.config.sourceFile,
      isDisabled: dbAcc?.isDisabled ?? false,
      mtimeMs: r.config.mtimeMs ?? 0,
      poolId: accountPoolId,
      canSwitchPool,
    };
  });

  list.sort((a, b) => {
    if (!a.authorized && b.authorized) return -1;
    if (a.authorized && !b.authorized) return 1;

    if (!a.authorized && !b.authorized) {
      if (a.mtimeMs !== b.mtimeMs) {
        return b.mtimeMs - a.mtimeMs;
      }
      return a.accountId.localeCompare(b.accountId);
    }

    const dbA = dbMap.get(a.accountId);
    const dbB = dbMap.get(b.accountId);
    const emailA = (dbA?.email || a.accountId).toLowerCase();
    const emailB = (dbB?.email || b.accountId).toLowerCase();
    return emailA.localeCompare(emailB, undefined, { numeric: true, sensitivity: 'base' });
  });

  if (poolId !== undefined) {
    return list.filter((item) => item.poolId === poolId);
  }

  return list;
}

const app = new Hono();

app.use('*', logger());
app.use('*', cors());

const routes = app
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
  .post(
    '/api/instance/claim',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            instanceId: string;
            ownerKind: InstanceOwnerKind;
            replaceInstanceId?: string;
          }
        | Response => {
        const body = value as Record<string, unknown>;
        const instanceId = parseNonEmptyInstanceId(body?.instanceId);
        if (!instanceId) {
          return c.json({ error: 'instanceId (non-empty string) is required' }, 400);
        }
        return {
          instanceId,
          ownerKind: parseInstanceOwnerKind(body?.ownerKind),
          replaceInstanceId: parseNonEmptyInstanceId(body?.replaceInstanceId),
        };
      }
    ),
    (c) => {
      const payload = c.req.valid('json');
      const now = Date.now();
      const live = getLiveInstanceLease(now);

      const canReplace =
        live !== null &&
        (live.instanceId === payload.instanceId ||
          (payload.replaceInstanceId !== undefined && live.instanceId === payload.replaceInstanceId) ||
          (payload.ownerKind === 'electron' && live.ownerKind !== 'electron'));

      if (live && !canReplace) {
        return c.json(
          {
            acquired: false,
            ownerKind: live.ownerKind,
            leaseTtlMs: INSTANCE_LEASE_TTL_MS,
          },
          409
        );
      }

      activeInstanceLease = {
        instanceId: payload.instanceId,
        ownerKind: payload.ownerKind,
        expiresAt: now + INSTANCE_LEASE_TTL_MS,
      };

      return c.json(
        {
          acquired: true,
          ownerKind: activeInstanceLease.ownerKind,
          leaseTtlMs: INSTANCE_LEASE_TTL_MS,
        },
        200
      );
    }
  )
  .post(
    '/api/instance/heartbeat',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            instanceId: string;
            ownerKind: InstanceOwnerKind;
          }
        | Response => {
        const body = value as Record<string, unknown>;
        const instanceId = parseNonEmptyInstanceId(body?.instanceId);
        if (!instanceId) {
          return c.json({ error: 'instanceId (non-empty string) is required' }, 400);
        }
        return {
          instanceId,
          ownerKind: parseInstanceOwnerKind(body?.ownerKind),
        };
      }
    ),
    (c) => {
      const payload = c.req.valid('json');
      const now = Date.now();
      const live = getLiveInstanceLease(now);

      if (live && live.instanceId !== payload.instanceId) {
        return c.json(
          {
            active: false,
            ownerKind: live.ownerKind,
            leaseTtlMs: INSTANCE_LEASE_TTL_MS,
          },
          409
        );
      }

      activeInstanceLease = {
        instanceId: payload.instanceId,
        ownerKind: payload.ownerKind,
        expiresAt: now + INSTANCE_LEASE_TTL_MS,
      };

      return c.json(
        {
          active: true,
          ownerKind: activeInstanceLease.ownerKind,
          leaseTtlMs: INSTANCE_LEASE_TTL_MS,
        },
        200
      );
    }
  )
  .post('/api/instance/release', async (c) => {
    let instanceId: string | undefined;
    try {
      const raw = await c.req.text();
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        instanceId = parseNonEmptyInstanceId(parsed?.instanceId);
      }
    } catch {
      return c.json({ released: false }, 400);
    }

    if (!instanceId) {
      return c.json({ released: false }, 400);
    }

    if (activeInstanceLease && activeInstanceLease.instanceId === instanceId) {
      activeInstanceLease = null;
      return c.json({ released: true });
    }

    return c.json({ released: false });
  })
  .get('/api/pools', async (c) => {
    const allPools = sqlite
      .prepare(
        `SELECT
           p.id,
           p.name,
           p.drive_folder_name as driveFolderName,
           p.is_share_pool as isSharePool,
           COALESCE(acc.cnt, 0) as accountCount,
           COALESCE(fil.cnt, 0) as fileCount,
           COALESCE(fil.total_bytes, 0) as totalBytes
         FROM pools p
         LEFT JOIN (SELECT pool_id, COUNT(*) as cnt FROM accounts GROUP BY pool_id) acc ON acc.pool_id = p.id
         LEFT JOIN (SELECT pool_id, COUNT(*) as cnt, SUM(size_bytes) as total_bytes FROM files WHERE is_trashed = 0 GROUP BY pool_id) fil ON fil.pool_id = p.id
         ORDER BY p.is_share_pool ASC, p.id ASC`
      )
      .all() as Array<{
      id: number;
      name: string;
      driveFolderName: string;
      isSharePool: number;
      accountCount: number;
      fileCount: number;
      totalBytes: number;
    }>;
    return c.json({
      pools: allPools.map((r) => ({
        ...r,
        isSharePool: Boolean(r.isSharePool),
      })),
    });
  })
  .post(
    '/api/pools',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
      return { name };
    }),
    async (c) => {
      const { name } = c.req.valid('json');
      const maxRow = sqlite
        .prepare('SELECT MAX(id) as maxId FROM pools WHERE is_share_pool = 0')
        .get() as { maxId: number | null } | undefined;
      let nextId = (maxRow?.maxId ?? 0) + 1;
      while (sqlite.prepare('SELECT 1 FROM pools WHERE id = ? LIMIT 1').get(nextId)) {
        nextId += 1;
      }
      const poolName = name || `Pool ${nextId}`;
      const driveFolderName = getPoolDriveFolderName(nextId);

      sqlite
        .prepare('INSERT INTO pools (id, name, drive_folder_name) VALUES (?, ?, ?)')
        .run(nextId, poolName, driveFolderName);

      return c.json(
        {
          id: nextId,
          name: poolName,
          driveFolderName,
          isSharePool: false,
          accountCount: 0,
          fileCount: 0,
          totalBytes: 0,
        },
        201
      );
    }
  )
  .patch(
    '/api/pools/:id',
    validator('json', (value, c): { name: string } | Response => {
      const body = value as Record<string, unknown>;
      if (typeof body?.name !== 'string' || !body.name.trim()) {
        return c.json({ error: 'name (string) is required' }, 400);
      }
      return { name: body.name.trim() };
    }),
    async (c) => {
      const poolId = parsePoolId(c.req.param('id'));
      const { name } = c.req.valid('json');

      const existing = sqlite
        .prepare('SELECT id, name, drive_folder_name as driveFolderName, is_share_pool as isSharePool FROM pools WHERE id = ?')
        .get(poolId) as { id: number; name: string; driveFolderName: string; isSharePool: number } | undefined;
      if (!existing) {
        return c.json({ error: `Pool ${poolId} not found` }, 404);
      }

      if (Boolean(existing.isSharePool)) {
        return c.json(
          { error: 'Share Pool cannot be renamed or modified', code: 'SHARE_POOL_PROTECTED' },
          403
        );
      }

      sqlite.prepare('UPDATE pools SET name = ?, updated_at = unixepoch() WHERE id = ?').run(name, poolId);

      return c.json({
        id: poolId,
        name,
        driveFolderName: existing.driveFolderName,
        isSharePool: Boolean(existing.isSharePool),
      });
    }
  )
  .delete('/api/pools/:id', async (c) => {
    const poolId = parsePoolId(c.req.param('id'));

    const existing = sqlite
      .prepare('SELECT id, name, drive_folder_name as driveFolderName, is_share_pool as isSharePool FROM pools WHERE id = ?')
      .get(poolId) as { id: number; name: string; driveFolderName: string; isSharePool: number } | undefined;
    if (!existing) {
      return c.json({ error: `Pool ${poolId} not found` }, 404);
    }

    if (Boolean(existing.isSharePool)) {
      return c.json(
        { error: 'Share Pool cannot be deleted', code: 'SHARE_POOL_PROTECTED' },
        403
      );
    }

    const totalPoolsRow = sqlite.prepare('SELECT count(*) as count FROM pools WHERE is_share_pool = 0').get() as
      | { count: number }
      | undefined;
    if ((totalPoolsRow?.count ?? 0) <= 1) {
      return c.json({ error: 'Cannot delete the only remaining storage pool', code: 'LAST_POOL' }, 409);
    }

    const accCountRow = sqlite
      .prepare('SELECT count(*) as count FROM accounts WHERE pool_id = ?')
      .get(poolId) as { count: number } | undefined;
    if ((accCountRow?.count ?? 0) > 0) {
      return c.json({ error: 'Cannot delete pool: pool contains accounts', code: 'POOL_NOT_EMPTY' }, 409);
    }

    const fileCountRow = sqlite
      .prepare('SELECT count(*) as count FROM files WHERE pool_id = ?')
      .get(poolId) as { count: number } | undefined;
    if ((fileCountRow?.count ?? 0) > 0) {
      return c.json({ error: 'Cannot delete pool: pool contains files', code: 'POOL_NOT_EMPTY' }, 409);
    }

    sqlite.prepare('DELETE FROM folders WHERE pool_id = ?').run(poolId);
    sqlite.prepare('DELETE FROM pools WHERE id = ?').run(poolId);

    return c.json({
      success: true,
      id: poolId,
      name: existing.name,
    });
  })
  .get('/api/storage', async (c) => {
    const rawPoolId = c.req.query('poolId');
    const poolId = rawPoolId !== undefined ? parsePoolId(rawPoolId) : 1;
    const overview = await getPooledStorageOverview(poolId);
    return c.json(overview);
  })
  .get('/api/storage/overview', async (c) => {
    const rawPoolId = c.req.query('poolId');
    const poolId = rawPoolId !== undefined ? parsePoolId(rawPoolId) : 1;
    const overview = await getPooledStorageOverview(poolId);
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
    validator('json', (value, c): { virtualPath: string; sizeBytes: number; poolId?: number } | Response => {
      const body = value as Record<string, unknown>;
      if (typeof body?.virtualPath !== 'string' || typeof body?.sizeBytes !== 'number') {
        return c.json({ error: 'Invalid payload: virtualPath (string) and sizeBytes (number) required' }, 400);
      }
      return {
        virtualPath: body.virtualPath,
        sizeBytes: body.sizeBytes,
        poolId: body?.poolId !== undefined ? parsePoolId(body.poolId) : undefined,
      };
    }),
    async (c) => {
      const { virtualPath, sizeBytes, poolId = 1 } = c.req.valid('json');
      try {
        const decision = await selectPlacementForFile(
          { virtualPath, sizeBytes },
          undefined,
          undefined,
          undefined,
          poolId
        );
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
    validator(
      'json',
      (
        value,
        c
      ): { items: Array<{ virtualPath: string; sizeBytes: number }>; poolId?: number } | Response => {
        const body = value as { items?: unknown; poolId?: unknown };
        if (!Array.isArray(body?.items)) {
          return c.json({ error: 'Invalid payload: items (array) required' }, 400);
        }
        for (const item of body.items) {
          if (typeof item?.virtualPath !== 'string' || typeof item?.sizeBytes !== 'number') {
            return c.json({ error: 'Each item requires virtualPath (string) and sizeBytes (number)' }, 400);
          }
        }
        return {
          items: body.items as Array<{ virtualPath: string; sizeBytes: number }>,
          poolId: body?.poolId !== undefined ? parsePoolId(body.poolId) : undefined,
        };
      }
    ),
    async (c) => {
      const { items, poolId = 1 } = c.req.valid('json');
      try {
        const plan = await planBatchPlacement(items, undefined, poolId);
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
  .get('/api/accounts', async (c) => {
    const rawPoolId = c.req.query('poolId');
    const poolId = rawPoolId !== undefined ? parsePoolId(rawPoolId) : undefined;
    const list = await getAccountsList(poolId);
    return c.json({ accounts: list });
  })
  .get('/api/accounts/pool', async (c) => {
    const rawPoolId = c.req.query('poolId');
    const poolId = rawPoolId !== undefined ? parsePoolId(rawPoolId) : undefined;
    const list = await getAccountsList(poolId);
    return c.json({ accounts: list });
  })
  .post('/api/accounts/:id/disable', async (c) => {
    const accountId = c.req.param('id');
    try {
      const result = await disableDriveAccount(accountId);
      return c.json(result);
    } catch (err) {
      if (err instanceof InsufficientStorageError) {
        return c.json({ error: err.message, code: 'INSUFFICIENT_STORAGE' }, 507);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post('/api/accounts/:id/enable', async (c) => {
    const accountId = c.req.param('id');
    try {
      const result = await enableDriveAccount(accountId);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .delete('/api/accounts/:id', async (c) => {
    const accountId = c.req.param('id');
    try {
      const result = await removeDriveAccount(accountId);
      return c.json(result);
    } catch (err) {
      if (err instanceof InsufficientStorageError) {
        return c.json({ error: err.message, code: 'INSUFFICIENT_STORAGE' }, 507);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post(
    '/api/accounts/:id/pool',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      const poolId = Number(body?.poolId);
      if (!Number.isInteger(poolId) || poolId < 1) {
        return c.json({ error: 'poolId must be a positive integer' }, 400);
      }
      return { poolId };
    }),
    async (c) => {
      const accountId = c.req.param('id');
      const { poolId } = c.req.valid('json');
      try {
        const result = await switchAccountPool(accountId, poolId);
        return c.json(result);
      } catch (err) {
        if (err instanceof AccountPoolLockedError) {
          return c.json({ error: err.message, code: 'ACCOUNT_POOL_LOCKED' }, 409);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/accounts/oauth/import',
    validator('json', (value, c): { filename: string; content: string; poolId?: number } | Response => {
      const body = value as Record<string, unknown>;
      if (typeof body?.filename !== 'string' || typeof body?.content !== 'string') {
        return c.json({ error: 'filename (string) and content (string) are required' }, 400);
      }
      return {
        filename: body.filename,
        content: body.content,
        poolId: body?.poolId !== undefined ? parsePoolId(body.poolId) : undefined,
      };
    }),
    async (c) => {
      const { filename, content, poolId = 1 } = c.req.valid('json');
      try {
        const result = await authPool.importCredentials(filename, content, poolId);
        if (!result.success) {
          return c.json({ error: result.error || 'Failed to import credentials' }, 400);
        }
        let resolvedPoolId = poolId;
        let filesIndexed = 0;
        let conflictsCount = 0;
        if (result.authorized && result.accountId) {
          try {
            const hydRes = await hydrateAccount(result.accountId, poolId);
            result.accountId = hydRes.accountId;
            resolvedPoolId = hydRes.poolId;
            if (!isSharePoolId(hydRes.poolId)) {
              const syncReport = await runColdReconciliation(hydRes.accountId);
              filesIndexed = syncReport.filesIndexed;
              conflictsCount = syncReport.conflictsDetected;
            }
          } catch (err) {
            console.warn(`Hydration or cold sync deferred for ${result.accountId}:`, err);
          }
        }
        return c.json(
          {
            ...result,
            poolId: resolvedPoolId,
            filesIndexed,
            conflictsCount,
          },
          201
        );
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
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
      const { accountId: targetAccountId } = await authPool.handleCallback(accountId, code, redirectUri);

      const hydRes = await hydrateAccount(targetAccountId);
      let conflictsCount = 0;
      if (!isSharePoolId(hydRes.poolId)) {
        try {
          const syncReport = await runColdReconciliation(hydRes.accountId);
          conflictsCount = syncReport.conflictsDetected;
        } catch (syncErr) {
          console.warn(`Cold sync deferred on auth callback for ${hydRes.accountId}:`, syncErr);
        }
      }

      const clientOrigin = process.env.CLIENT_URL || (url.port === '3000' ? 'http://localhost:5173' : url.origin);
      return c.redirect(
        `${clientOrigin}/?auth=success&account=${encodeURIComponent(hydRes.accountId)}&poolId=${hydRes.poolId}&conflicts=${conflictsCount}`
      );
    } catch (err) {
      return c.text(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
  })
  .post('/api/sync/all', async (c) => {
    const rawPoolId = c.req.query('poolId');
    const poolId = parsePoolId(rawPoolId);
    if (isSharePoolId(poolId)) {
      return c.json(sharePoolReadOnlyError('Fetching Drive changes is disabled on Share Pool'), 403);
    }
    try {
      const report = await syncAllAccounts(poolId);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post('/api/sync/:id', async (c) => {
    const accountId = c.req.param('id');
    if (isAccountInSharePool(accountId)) {
      return c.json(sharePoolReadOnlyError('Syncing Drive changes is disabled for Share Pool accounts'), 403);
    }
    try {
      const report = await runIncrementalSync(accountId);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post('/api/sync/:id/cold', async (c) => {
    const accountId = c.req.param('id');
    if (isAccountInSharePool(accountId)) {
      return c.json(sharePoolReadOnlyError('Cold reconciliation is disabled for Share Pool accounts'), 403);
    }
    try {
      const report = await runColdReconciliation(accountId);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post('/api/accounts/hydrate/:id', async (c) => {
    const accountId = c.req.param('id');
    const rawPoolId = c.req.query('poolId');
    const preferredPoolId = rawPoolId !== undefined ? parsePoolId(rawPoolId) : undefined;
    try {
      const result = await hydrateAccount(accountId, preferredPoolId);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .get(
    '/api/files',
    validator('query', (value): { path?: string; poolId?: string } => {
      const folderPath = typeof value.path === 'string' ? value.path : undefined;
      const poolId = typeof value.poolId === 'string' ? value.poolId : undefined;
      return { path: folderPath, poolId };
    }),
    async (c) => {
      const { path: folderPath = '/', poolId: rawPoolId } = c.req.valid('query');
      const poolId = rawPoolId !== undefined ? parsePoolId(rawPoolId) : 1;
      const fileRecords = await db
        .select()
        .from(files)
        .where(and(eq(files.poolId, poolId), eq(files.isTrashed, false)));
      const folderRecords = await db
        .select()
        .from(folders)
        .where(eq(folders.poolId, poolId));

      return c.json({
        currentPath: folderPath,
        folders: folderRecords,
        files: fileRecords,
      });
    }
  )
  .get('/api/folders', async (c) => {
    const rawPoolId = c.req.query('poolId');
    const poolId = rawPoolId !== undefined ? parsePoolId(rawPoolId) : 1;
    const folderRecords = await db.select().from(folders).where(eq(folders.poolId, poolId));
    return c.json({ folders: folderRecords });
  })
  .post(
    '/api/folders',
    validator('json', (value, c): { virtualPath: string; name: string; poolId?: number } | Response => {
      const body = value as Record<string, unknown>;
      if (typeof body?.virtualPath !== 'string' || typeof body?.name !== 'string') {
        return c.json({ error: 'virtualPath (string) and name (string) are required' }, 400);
      }
      return {
        virtualPath: body.virtualPath,
        name: body.name,
        poolId: body?.poolId !== undefined ? parsePoolId(body.poolId) : undefined,
      };
    }),
    async (c) => {
      const { virtualPath, name, poolId = 1 } = c.req.valid('json');
      if (isSharePoolId(poolId)) {
        return c.json(sharePoolReadOnlyError('Creating folders directly in Share Pool is disabled'), 403);
      }
      const normalizedPath = virtualPath.startsWith('/') ? virtualPath : '/' + virtualPath;
      try {
        ensureLocalFolderHierarchy(normalizedPath, poolId);
        return c.json({ id: formatFolderId(poolId, normalizedPath), poolId, virtualPath: normalizedPath, name }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .delete(
    '/api/folders',
    validator('query', (value): { virtualPath?: string; path?: string; id?: string; poolId?: string } => {
      return {
        virtualPath: typeof value.virtualPath === 'string' ? value.virtualPath : undefined,
        path: typeof value.path === 'string' ? value.path : undefined,
        id: typeof value.id === 'string' ? value.id : undefined,
        poolId: typeof value.poolId === 'string' ? value.poolId : undefined,
      };
    }),
    async (c) => {
      const query = c.req.valid('query');
      const virtualPath = query.virtualPath || query.path || query.id;
      if (!virtualPath) {
        return c.json({ error: 'virtualPath query parameter required' }, 400);
      }
      const poolId = query.poolId ? parsePoolId(query.poolId) : 1;
      const normalizedPath = virtualPath.startsWith('/') ? virtualPath : '/' + virtualPath;
      try {
        const result = await trashFolder(normalizedPath, poolId);
        return c.json({ success: true, virtualPath: normalizedPath, trashedCount: result.trashedFilesCount });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/items/move',
    validator(
      'json',
      (
        value,
        c
      ): { items: Array<{ kind: 'file' | 'folder'; id: string }>; targetFolderPath: string; poolId?: number } | Response => {
        const body = value as Record<string, unknown>;
        if (!Array.isArray(body?.items) || typeof body?.targetFolderPath !== 'string') {
          return c.json({ error: 'items (array) and targetFolderPath (string) are required' }, 400);
        }
        return {
          items: body.items as Array<{ kind: 'file' | 'folder'; id: string }>,
          targetFolderPath: body.targetFolderPath,
          poolId: body?.poolId !== undefined ? parsePoolId(body.poolId) : undefined,
        };
      }
    ),
    async (c) => {
      const { items, targetFolderPath, poolId = 1 } = c.req.valid('json');
      if (isSharePoolId(poolId)) {
        return c.json(sharePoolReadOnlyError('Moving items inside Share Pool is disabled'), 403);
      }
      try {
        const result = await moveItems(items, targetFolderPath, poolId);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/items/copy',
    validator(
      'json',
      (
        value,
        c
      ): { items: Array<{ kind: 'file' | 'folder'; id: string }>; targetFolderPath: string; poolId?: number } | Response => {
        const body = value as Record<string, unknown>;
        if (!Array.isArray(body?.items) || typeof body?.targetFolderPath !== 'string') {
          return c.json({ error: 'items (array) and targetFolderPath (string) are required' }, 400);
        }
        return {
          items: body.items as Array<{ kind: 'file' | 'folder'; id: string }>,
          targetFolderPath: body.targetFolderPath,
          poolId: body?.poolId !== undefined ? parsePoolId(body.poolId) : undefined,
        };
      }
    ),
    async (c) => {
      const { items, targetFolderPath, poolId = 1 } = c.req.valid('json');
      if (isSharePoolId(poolId)) {
        return c.json(sharePoolReadOnlyError('Copying items inside Share Pool is disabled'), 403);
      }
      try {
        const result = await copyItems(items, targetFolderPath, poolId);
        return c.json(result);
      } catch (err) {
        if (err instanceof InsufficientStorageError) {
          return c.json({ error: err.message, code: 'INSUFFICIENT_STORAGE' }, 507);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/items/rename',
    validator(
      'json',
      (
        value,
        c
      ): { kind: 'file' | 'folder'; id: string; name: string; poolId?: number } | Response => {
        const body = value as Record<string, unknown>;
        const candidateName =
          typeof body?.name === 'string' ? body.name : typeof body?.newName === 'string' ? body.newName : undefined;
        if (
          (body?.kind !== 'file' && body?.kind !== 'folder') ||
          typeof body?.id !== 'string' ||
          typeof candidateName !== 'string'
        ) {
          return c.json({ error: 'kind ("file"|"folder"), id (string), and name (string) are required' }, 400);
        }
        return {
          kind: body.kind as 'file' | 'folder',
          id: body.id,
          name: candidateName.trim(),
          poolId: body?.poolId !== undefined ? parsePoolId(body.poolId) : undefined,
        };
      }
    ),
    async (c) => {
      const { kind, id, name, poolId = 1 } = c.req.valid('json');
      if (isSharePoolId(poolId)) {
        return c.json(sharePoolReadOnlyError('Renaming items inside Share Pool is disabled'), 403);
      }
      if (!name || name.includes('/') || name.includes('\\')) {
        return c.json({ error: 'Invalid name: cannot be empty or contain slashes' }, 400);
      }
      try {
        const result = await renameItem(kind, id, name, poolId);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/files/upload/session',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            virtualPath: string;
            sizeBytes: number;
            mimeType?: string;
            hash?: string;
            targetAccountId?: string;
            poolId?: number;
          }
        | Response => {
        const body = value as Record<string, unknown>;
        if (typeof body?.virtualPath !== 'string' || typeof body?.sizeBytes !== 'number') {
          return c.json({ error: 'virtualPath (string) and sizeBytes (number) are required' }, 400);
        }
        return {
          virtualPath: body.virtualPath,
          sizeBytes: body.sizeBytes,
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
          hash: typeof body.hash === 'string' ? body.hash : undefined,
          targetAccountId: typeof body.targetAccountId === 'string' ? body.targetAccountId : undefined,
          poolId: body?.poolId !== undefined ? parsePoolId(body.poolId) : undefined,
        };
      }
    ),
    async (c) => {
      const payload = c.req.valid('json');
      if (isSharePoolId(payload.poolId ?? 1)) {
        return c.json(sharePoolReadOnlyError('Uploading directly to Share Pool is disabled'), 403);
      }
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
    const targetAccountId = c.req.query('accountId') || c.req.header('x-account-id');
    const poolIdHeader = c.req.query('poolId') || c.req.header('x-pool-id');
    const poolId = poolIdHeader ? parsePoolId(poolIdHeader) : 1;

    if (isSharePoolId(poolId)) {
      return c.json(sharePoolReadOnlyError('Uploading directly to Share Pool is disabled'), 403);
    }

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
        {
          virtualPath,
          sizeBytes,
          mimeType,
          hash: hash || undefined,
          targetAccountId: targetAccountId || undefined,
          poolId,
        },
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
    const rawPoolId = c.req.query('poolId');
    const poolId = rawPoolId !== undefined ? parsePoolId(rawPoolId) : undefined;
    try {
      const { stream, file } = await getStreamingDownload(fileId, poolId);
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
    const rawPoolId = c.req.query('poolId');
    const poolId = rawPoolId !== undefined ? parsePoolId(rawPoolId) : 1;
    try {
      const report = await emptyTrash(poolId);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .get('/api/trash', async (c) => {
    const rawPoolId = c.req.query('poolId');
    const poolId = rawPoolId !== undefined ? parsePoolId(rawPoolId) : 1;
    const trashedFiles = await db
      .select()
      .from(files)
      .where(and(eq(files.poolId, poolId), eq(files.isTrashed, true)));
    return c.json({ files: trashedFiles });
  })
  .get(
    '/api/sync/external-changes/:accountId',
    validator('query', (value): { refresh?: string } => ({
      refresh: typeof value.refresh === 'string' ? value.refresh : undefined,
    })),
    async (c) => {
      const accountId = c.req.param('accountId');
      const { refresh } = c.req.valid('query');
      const forceRefresh = refresh === '1' || refresh === 'true';
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const report = await scanAccountDiscrepancies(accountId, forceRefresh);
        return c.json(report);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/sync/resolve/accept',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            accountId: string;
            driveFileId: string;
            targetVirtualPath?: string;
            name?: string;
            sizeBytes?: number;
            mimeType?: string;
            hash?: string | null;
          }
        | Response => {
        const body = value as Record<string, unknown>;
        if (typeof body?.accountId !== 'string' || typeof body?.driveFileId !== 'string') {
          return c.json({ error: 'accountId and driveFileId required' }, 400);
        }
        return {
          accountId: body.accountId,
          driveFileId: body.driveFileId,
          targetVirtualPath: typeof body.targetVirtualPath === 'string' ? body.targetVirtualPath : undefined,
          name: typeof body.name === 'string' ? body.name : undefined,
          sizeBytes: typeof body.sizeBytes === 'number' && Number.isFinite(body.sizeBytes) ? body.sizeBytes : undefined,
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
          hash: typeof body.hash === 'string' || body.hash === null ? body.hash : undefined,
        };
      }
    ),
    async (c) => {
      const { accountId, driveFileId, targetVirtualPath, name, sizeBytes, mimeType, hash } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const preScanned =
          name !== undefined || sizeBytes !== undefined || mimeType !== undefined || hash !== undefined
            ? { name, sizeBytes, mimeType, hash }
            : undefined;
        const record = await acceptExternalFile(accountId, driveFileId, targetVirtualPath, preScanned);
        return c.json(record);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/sync/resolve/accept-all',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            accountId: string;
            items?: PreScannedBatchItem[];
          }
        | Response => {
        const body = value as Record<string, unknown>;
        if (typeof body?.accountId !== 'string') {
          return c.json({ error: 'accountId required' }, 400);
        }
        let items: PreScannedBatchItem[] | undefined;
        if (Array.isArray(body.items)) {
          items = [];
          for (const raw of body.items) {
            if (!raw || typeof raw !== 'object') {
              return c.json({ error: 'Invalid item in items array' }, 400);
            }
            const rec = raw as Record<string, unknown>;
            if (
              typeof rec.driveFileId !== 'string' ||
              typeof rec.virtualPath !== 'string' ||
              typeof rec.sizeBytes !== 'number' ||
              !Number.isFinite(rec.sizeBytes)
            ) {
              return c.json({ error: 'Each item requires driveFileId, virtualPath, and sizeBytes' }, 400);
            }
            items.push({
              driveFileId: rec.driveFileId,
              virtualPath: rec.virtualPath,
              sizeBytes: rec.sizeBytes,
              mimeType: typeof rec.mimeType === 'string' ? rec.mimeType : undefined,
              hash: typeof rec.hash === 'string' || rec.hash === null ? rec.hash : undefined,
            });
          }
        }
        return { accountId: body.accountId, items };
      }
    ),
    async (c) => {
      const { accountId, items } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const result = await acceptAllExternalFiles(accountId, items);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/sync/resolve/eject-all',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (typeof body?.accountId !== 'string') {
        return c.json({ error: 'accountId required' }, 400);
      }
      return { accountId: body.accountId };
    }),
    async (c) => {
      const { accountId } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const result = await ejectAllExternalFiles(accountId);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/sync/resolve/conflict',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            accountId: string;
            driveFileId: string;
            resolution: ConflictResolutionAction;
            targetVirtualPath?: string;
          }
        | Response => {
        const body = value as Record<string, unknown>;
        const resolution = body?.resolution;
        if (
          typeof body?.accountId !== 'string' ||
          typeof body?.driveFileId !== 'string' ||
          (resolution !== 'keep_both' &&
            resolution !== 'deduplicate' &&
            resolution !== 'replace_existing' &&
            resolution !== 'eject')
        ) {
          return c.json(
            {
              error:
                'accountId, driveFileId, and valid resolution (keep_both | deduplicate | replace_existing | eject) required',
            },
            400
          );
        }
        return {
          accountId: body.accountId,
          driveFileId: body.driveFileId,
          resolution,
          targetVirtualPath: typeof body.targetVirtualPath === 'string' ? body.targetVirtualPath : undefined,
        };
      }
    ),
    async (c) => {
      const { accountId, driveFileId, resolution, targetVirtualPath } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('Conflict resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const res = await resolvePathConflict(accountId, driveFileId, resolution, targetVirtualPath);
        return c.json(res);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/sync/resolve/conflicts-batch',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            accountId: string;
            items: Array<{ driveFileId: string; targetVirtualPath?: string }>;
            resolution: 'keep_both' | 'deduplicate';
          }
        | Response => {
        const body = value as Record<string, unknown>;
        const resolution = body?.resolution;
        if (
          typeof body?.accountId !== 'string' ||
          !Array.isArray(body?.items) ||
          (resolution !== 'keep_both' && resolution !== 'deduplicate')
        ) {
          return c.json(
            {
              error: 'accountId, items array, and valid resolution (keep_both | deduplicate) required',
            },
            400
          );
        }
        const items: Array<{ driveFileId: string; targetVirtualPath?: string }> = [];
        for (const raw of body.items) {
          if (!raw || typeof raw !== 'object') {
            return c.json({ error: 'Invalid item in items array' }, 400);
          }
          const rec = raw as Record<string, unknown>;
          if (typeof rec.driveFileId !== 'string') {
            return c.json({ error: 'Each item requires driveFileId (string)' }, 400);
          }
          items.push({
            driveFileId: rec.driveFileId,
            targetVirtualPath: typeof rec.targetVirtualPath === 'string' ? rec.targetVirtualPath : undefined,
          });
        }
        return {
          accountId: body.accountId,
          items,
          resolution,
        };
      }
    ),
    async (c) => {
      const { accountId, items, resolution } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('Conflict resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const res = await resolvePathConflictsBatch(accountId, items, resolution);
        return c.json(res);
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
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        await ejectFileToDriveRoot(accountId, driveFileId);
        return c.json({ success: true, accountId, driveFileId });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/sync/resolve/remove-missing',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (typeof body?.accountId !== 'string' || typeof body?.driveFileId !== 'string') {
        return c.json({ error: 'accountId and driveFileId required' }, 400);
      }
      return { accountId: body.accountId, driveFileId: body.driveFileId };
    }),
    async (c) => {
      const { accountId, driveFileId } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        await removeMissingFile(accountId, driveFileId);
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
      const fileRow = sqlite.prepare('SELECT pool_id as poolId FROM files WHERE id = ? LIMIT 1').get(fileId) as
        | { poolId: number }
        | undefined;
      if (fileRow && isSharePoolId(fileRow.poolId)) {
        return c.json(sharePoolReadOnlyError('Moving Share Pool files between accounts is disabled'), 403);
      }
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
  .post(
    '/api/sync/rebalance/batch',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (!Array.isArray(body?.fileIds) || body.fileIds.length === 0 || typeof body?.targetAccountId !== 'string') {
        return c.json({ error: 'fileIds (non-empty array) and targetAccountId (string) required' }, 400);
      }
      return { fileIds: body.fileIds as string[], targetAccountId: body.targetAccountId };
    }),
    async (c) => {
      const { fileIds, targetAccountId } = c.req.valid('json');
      const placeholders = fileIds.map(() => '?').join(',');
      const shareRows = sqlite
        .prepare(
          `SELECT 1 FROM files f INNER JOIN pools p ON p.id = f.pool_id WHERE f.id IN (${placeholders}) AND p.is_share_pool = 1 LIMIT 1`
        )
        .get(...fileIds);
      if (shareRows) {
        return c.json(sharePoolReadOnlyError('Moving Share Pool files in batches is disabled'), 403);
      }
      try {
        const result = await rebalanceFilesBatch(fileIds, targetAccountId);
        return c.json(result);
      } catch (err) {
        if (err instanceof RebalanceValidationError) {
          return c.json({ error: err.message, code: 'VALIDATION_ERROR' }, 400);
        }
        if (err instanceof InsufficientStorageError) {
          return c.json({ error: err.message, code: 'INSUFFICIENT_STORAGE' }, 507);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post('/api/sync/rebalance/auto/:accountId', async (c) => {
    const accountId = c.req.param('accountId');
    if (isAccountInSharePool(accountId)) {
      return c.json(sharePoolReadOnlyError('Auto-rebalance is disabled for Share Pool accounts'), 403);
    }
    try {
      const results = await executeAutoRebalance(accountId);
      return c.json({ results });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post(
    '/api/share/inspect',
    validator(
      'json',
      (value, c): { sourcePoolId: number; items: ShareTargetInput[] } | Response => {
        const body = value as Record<string, unknown>;
        const items = parseShareTargetItems(body?.items);
        if (!items) {
          return c.json({ error: 'items (non-empty array of { kind: "file" | "folder", id: string }) is required' }, 400);
        }
        const sourcePoolId = parsePoolId(body?.sourcePoolId ?? body?.poolId);
        return { sourcePoolId, items };
      }
    ),
    async (c) => {
      const { sourcePoolId, items } = c.req.valid('json');
      if (isSharePoolId(sourcePoolId)) {
        return c.json(sharePoolReadOnlyError('Items inside Share Pool cannot be shared again'), 403);
      }
      try {
        const plan = await inspectSharePlan(sourcePoolId, items);
        return c.json(plan);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/share/validate',
    validator(
      'json',
      (value, c): { sourcePoolId: number; items: ShareTargetInput[]; selectedAccountIds: string[] } | Response => {
        const body = value as Record<string, unknown>;
        const items = parseShareTargetItems(body?.items);
        if (!items) {
          return c.json({ error: 'items (non-empty array of { kind: "file" | "folder", id: string }) is required' }, 400);
        }
        const selectedAccountIds = parseStringArray(body?.selectedAccountIds ?? []);
        if (!selectedAccountIds) {
          return c.json({ error: 'selectedAccountIds must be an array of strings' }, 400);
        }
        const sourcePoolId = parsePoolId(body?.sourcePoolId ?? body?.poolId);
        return { sourcePoolId, items, selectedAccountIds };
      }
    ),
    async (c) => {
      const { sourcePoolId, items, selectedAccountIds } = c.req.valid('json');
      if (isSharePoolId(sourcePoolId)) {
        return c.json(sharePoolReadOnlyError('Items inside Share Pool cannot be shared again'), 403);
      }
      try {
        const result = await validateShareSelection(sourcePoolId, items, selectedAccountIds);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/share/execute',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            sourcePoolId: number;
            items: ShareTargetInput[];
            selectedAccountIds: string[];
          }
        | Response => {
        const body = value as Record<string, unknown>;
        const items = parseShareTargetItems(body?.items);
        if (!items) {
          return c.json({ error: 'items (non-empty array of { kind: "file" | "folder", id: string }) is required' }, 400);
        }
        const selectedAccountIds = parseStringArray(body?.selectedAccountIds ?? []);
        if (!selectedAccountIds) {
          return c.json({ error: 'selectedAccountIds must be an array of strings' }, 400);
        }
        const sourcePoolId = parsePoolId(body?.sourcePoolId ?? body?.poolId);
        return {
          sourcePoolId,
          items,
          selectedAccountIds,
        };
      }
    ),
    async (c) => {
      const payload = c.req.valid('json');
      if (isSharePoolId(payload.sourcePoolId)) {
        return c.json(sharePoolReadOnlyError('Items inside Share Pool cannot be shared again'), 403);
      }
      try {
        const result = await executeShare(payload);
        return c.json(result);
      } catch (err) {
        if (err instanceof ShareValidationError) {
          return c.json({ error: err.message, code: 'VALIDATION_ERROR' }, 400);
        }
        if (err instanceof FileExceedsCeilingError) {
          return c.json({ error: err.message, code: 'EXCEEDS_CEILING' }, 400);
        }
        if (err instanceof InsufficientStorageError) {
          return c.json({ error: err.message, code: 'INSUFFICIENT_STORAGE' }, 507);
        }
        if (err instanceof AccountPoolLockedError) {
          return c.json({ error: err.message, code: 'ACCOUNT_POOL_LOCKED' }, 409);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .get('/api/share/links', (c) => {
    const rawPoolId = c.req.query('poolId');
    const poolId = rawPoolId !== undefined ? parsePoolId(rawPoolId) : undefined;
    const links = listSharePoolLinks(poolId);
    return c.json({ links });
  })
  .post('/api/pools/:id/clear-share', async (c) => {
    const rawId = Number(c.req.param('id'));
    if (!Number.isInteger(rawId) || rawId < 1) {
      return c.json({ error: 'Invalid pool id' }, 400);
    }

    try {
      const result = await clearSharePool(rawId);
      return c.json(result);
    } catch (err) {
      if (err instanceof SharePoolNotFoundError) {
        return c.json({ error: err.message, code: 'NOT_FOUND' }, 404);
      }
      if (err instanceof ShareValidationError) {
        return c.json({ error: err.message, code: 'VALIDATION_ERROR' }, 400);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

export type AppType = typeof routes;
export default routes;
