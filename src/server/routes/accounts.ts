import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { sqlite } from '../db/index.js';
import {
  authPool,
  hydrateAccount,
  runColdReconciliation,
  switchAccountPool,
  isSharePoolId,
  startBackgroundJob,
  getAccountsList,
  disableDriveAccount,
  enableDriveAccount,
} from '../drive/index.js';
import {
  EvacuationInProgressError,
  startAccountEvacuation,
} from '../drive/accountEvacuate.js';
import {
  calculateUsableLimit,
  calculateHeadroom,
  invalidatePooledStorageOverview,
} from '../storage/index.js';
import { refreshAccountLiveQuota } from '../drive/client.js';
import {
  INVALID_POOL_ID_ERROR,
  parseStrictPoolId,
  parseOptionalPoolId,
  mapDomainErrorToResponse,
} from './shared.js';

export interface AuthCompletedEvent {
  account: string;
  poolId: number;
  conflicts: number;
}

export interface AccountsRouterOptions {
  serveStatic?: boolean;
  onAuthCompleted?: (payload: AuthCompletedEvent) => void;
}

export function createAccountsRouter(options: AccountsRouterOptions = {}) {
  return new Hono()
  .get('/api/accounts', async (c) => {
    const parsedPool = parseOptionalPoolId(c.req.query('poolId'));
    if (!parsedPool.ok) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }
    const list = await getAccountsList(parsedPool.poolId);
    return c.json({ accounts: list });
  })
  .get('/api/accounts/pool', async (c) => {
    const parsedPool = parseOptionalPoolId(c.req.query('poolId'));
    if (!parsedPool.ok) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }
    const list = await getAccountsList(parsedPool.poolId);
    return c.json({ accounts: list });
  })
  .post(
    '/api/accounts/oauth/import',
    validator('json', (value, c): { filename: string; content: string; poolId?: number } | Response => {
      const body = value as Record<string, unknown>;
      if (typeof body?.filename !== 'string' || typeof body?.content !== 'string') {
        return c.json({ error: 'filename (string) and content (string) are required' }, 400);
      }
      const parsedPool = parseOptionalPoolId(body?.poolId);
      if (!parsedPool.ok) {
        return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
      }
      return {
        filename: body.filename,
        content: body.content,
        poolId: parsedPool.poolId,
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
        // Initial OAuth import returns 0 because cold sync runs asynchronously in a background job.
        const filesIndexed = 0;
        const conflictsCount = 0;
        if (result.authorized && result.accountId) {
          const hydRes = await hydrateAccount(result.accountId, poolId);
          result.accountId = hydRes.accountId;
          resolvedPoolId = hydRes.poolId;
          if (!isSharePoolId(hydRes.poolId)) {
            startBackgroundJob('oauth_cold_sync', hydRes.accountId, () => runColdReconciliation(hydRes.accountId));
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
      const trimmedRedirectUri = redirectUri?.trim();
      const effectiveRedirectUri =
        trimmedRedirectUri && trimmedRedirectUri.length > 0
          ? trimmedRedirectUri
          : `${new URL(c.req.url).origin}/api/auth/callback`;
      try {
        const url = authPool.generateAuthUrl(accountId, effectiveRedirectUri);
        return c.json({ url });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
  )
  .post('/api/accounts/hydrate/:id', async (c) => {
    const accountId = c.req.param('id');
    const parsedPool = parseOptionalPoolId(c.req.query('poolId'));
    if (!parsedPool.ok) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }
    try {
      const result = await hydrateAccount(accountId, parsedPool.poolId);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post('/api/accounts/:id/disable', async (c) => {
    const accountId = c.req.param('id');
    try {
      const result = await disableDriveAccount(accountId);
      return c.json(result);
    } catch (err) {
      return mapDomainErrorToResponse(c, err);
    }
  })
  .post('/api/accounts/:id/enable', async (c) => {
    const accountId = c.req.param('id');
    try {
      const result = await enableDriveAccount(accountId);
      return c.json(result);
    } catch (err) {
      return mapDomainErrorToResponse(c, err);
    }
  })
  .post('/api/accounts/:id/quota/refresh', async (c) => {
    const accountId = c.req.param('id');
    const existing = sqlite
      .prepare(
        `SELECT id, email, pool_id as poolId, quota_limit_bytes as quotaLimitBytes, quota_used_bytes as quotaUsedBytes, sync_state as syncState
         FROM accounts WHERE id = ? LIMIT 1`
      )
      .get(accountId) as
      | {
          id: string;
          email: string;
          poolId: number;
          quotaLimitBytes: number;
          quotaUsedBytes: number;
          syncState: string;
        }
      | undefined;

    if (!existing) {
      return c.json({ error: `Account '${accountId}' not found`, code: 'NOT_FOUND' }, 404);
    }

    if (!authPool.getRecord(accountId)?.authorized) {
      return c.json(
        { error: `Account '${accountId}' is not authorized`, code: 'AUTH_ERROR' },
        401
      );
    }

    try {
      const updatedUsage = await refreshAccountLiveQuota(accountId);
      if (updatedUsage === null) {
        return c.json(
          { error: `Failed to refresh live quota for account '${accountId}'`, code: 'UPSTREAM_ERROR' },
          502
        );
      }
      invalidatePooledStorageOverview(existing.poolId);

      const refreshed = sqlite
        .prepare(
          `SELECT id, email, pool_id as poolId, quota_limit_bytes as quotaLimitBytes, quota_used_bytes as quotaUsedBytes, sync_state as syncState
           FROM accounts WHERE id = ? LIMIT 1`
        )
        .get(accountId) as {
        id: string;
        email: string;
        poolId: number;
        quotaLimitBytes: number;
        quotaUsedBytes: number;
        syncState: string;
      };

      const usableLimitBytes = calculateUsableLimit(refreshed.quotaLimitBytes);
      const headroomBytes = calculateHeadroom(refreshed.quotaLimitBytes, refreshed.quotaUsedBytes);

      return c.json({
        accountId: refreshed.id,
        email: refreshed.email,
        poolId: refreshed.poolId,
        quotaLimitBytes: refreshed.quotaLimitBytes,
        quotaUsedBytes: refreshed.quotaUsedBytes,
        usableLimitBytes,
        headroomBytes,
        syncState: refreshed.syncState,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err), code: 'UPSTREAM_ERROR' },
        502
      );
    }
  })
  .post(
    '/api/accounts/:id/pool',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      const poolId = parseStrictPoolId(body?.poolId);
      if (poolId === null) {
        return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
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
        return mapDomainErrorToResponse(c, err);
      }
    }
  )
  .post('/api/accounts/:id/evacuate', async (c) => {
    const accountId = c.req.param('id');
    let wait = false;
    let removeAfterEvacuate = false;

    try {
      const rawBody = await c.req.text();
      if (rawBody.trim()) {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        wait = parsed.wait === true;
        removeAfterEvacuate = parsed.removeAfter === true || parsed.removeAfterEvacuate === true;
      }
    } catch {
      return c.json({ error: 'Invalid JSON request body', code: 'VALIDATION_ERROR' }, 400);
    }

    if (c.req.query('wait') === 'true' || c.req.query('wait') === '1') {
      wait = true;
    }

    try {
      const result = await startAccountEvacuation(accountId, {
        removeAfterEvacuate,
        wait,
      });
      return c.json(result, result.queued ? 202 : 200);
    } catch (err) {
      if (err instanceof EvacuationInProgressError) {
        return c.json(
          { error: err.message, code: err.code, jobId: err.jobId },
          409
        );
      }
      return mapDomainErrorToResponse(c, err);
    }
  })
  .delete('/api/accounts/:id', async (c) => {
    const accountId = c.req.param('id');
    const wait = c.req.query('wait') === 'true' || c.req.query('wait') === '1';

    try {
      const result = await startAccountEvacuation(accountId, {
        removeAfterEvacuate: true,
        wait,
      });

      if (result.queued) {
        return c.json(
          {
            sourceAccountId: result.sourceAccountId,
            filesMoved: result.filesMoved,
            bytesMoved: result.bytesMoved,
            transfers: [],
            removed: false,
            queued: true,
            jobId: result.jobId,
            filesQueued: result.totalItems,
          },
          202
        );
      }

      return c.json(
        {
          sourceAccountId: result.sourceAccountId,
          filesMoved: result.filesMoved,
          bytesMoved: result.bytesMoved,
          transfers: [],
          removed: result.removed,
          queued: false,
          jobId: result.jobId,
        },
        200
      );
    } catch (err) {
      if (err instanceof EvacuationInProgressError) {
        return c.json(
          {
            error: err.message,
            code: err.code,
            jobId: err.jobId,
          },
          409
        );
      }
      return mapDomainErrorToResponse(c, err);
    }
  })
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
      // Initial OAuth callback returns 0 because cold sync runs asynchronously in a background job.
      const conflictsCount = 0;
      if (!isSharePoolId(hydRes.poolId)) {
        startBackgroundJob('oauth_cold_sync', hydRes.accountId, () => runColdReconciliation(hydRes.accountId));
      }

      if (options.onAuthCompleted) {
        try {
          options.onAuthCompleted({
            account: hydRes.accountId,
            poolId: hydRes.poolId,
            conflicts: conflictsCount,
          });
        } catch (callbackErr) {
          console.warn(
            'onAuthCompleted listener error:',
            callbackErr instanceof Error ? callbackErr.message : String(callbackErr)
          );
        }
      }

      const envClientUrl = process.env.CLIENT_URL?.trim();
      const clientOrigin = envClientUrl
        ? envClientUrl
        : options.serveStatic
          ? url.origin
          : url.port === '3000'
            ? 'http://localhost:5173'
            : url.origin;
      return c.redirect(
        `${clientOrigin}/?auth=success&account=${encodeURIComponent(hydRes.accountId)}&poolId=${hydRes.poolId}&conflicts=${conflictsCount}`
      );
    } catch (err) {
      return c.text(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
  });
}

export default createAccountsRouter();
