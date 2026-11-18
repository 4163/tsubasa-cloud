import { Hono } from 'hono';
import { validator } from 'hono/validator';
import {
  getAccountTransferStats,
  getPooledStorageOverview,
  planUploadBatchWithConflicts,
  selectPlacementForFile,
  type UploadConflictAction,
  type UploadPlacementRequestItem,
} from '../storage/index.js';
import {
  INVALID_POOL_ID_ERROR,
  mapDomainErrorToResponse,
  parseOptionalPoolId,
  parsePoolIdWithDefault,
} from './shared.js';

const router = new Hono()
  .get('/api/storage', async (c) => {
    const poolId = parsePoolIdWithDefault(c.req.query('poolId'), 1);
    if (poolId === null) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }
    const overview = await getPooledStorageOverview(poolId);
    return c.json(overview);
  })
  .get('/api/storage/overview', async (c) => {
    const poolId = parsePoolIdWithDefault(c.req.query('poolId'), 1);
    if (poolId === null) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }
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
      const parsedPool = parseOptionalPoolId(body?.poolId);
      if (!parsedPool.ok) {
        return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
      }
      return {
        virtualPath: body.virtualPath,
        sizeBytes: body.sizeBytes,
        poolId: parsedPool.poolId,
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
        return mapDomainErrorToResponse(c, err);
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
      ): { items: UploadPlacementRequestItem[]; poolId?: number } | Response => {
        const body = value as { items?: unknown; poolId?: unknown };
        if (!Array.isArray(body?.items)) {
          return c.json({ error: 'Invalid payload: items (array) required' }, 400);
        }
        const validatedItems: UploadPlacementRequestItem[] = [];
        for (const rawItem of body.items) {
          const item = rawItem as Record<string, unknown> | null;
          if (!item || typeof item.virtualPath !== 'string' || typeof item.sizeBytes !== 'number') {
            return c.json({ error: 'Each item requires virtualPath (string) and sizeBytes (number)' }, 400);
          }
          let conflictAction: UploadConflictAction | undefined;
          if (item.conflictAction !== undefined) {
            if (
              item.conflictAction !== 'skip' &&
              item.conflictAction !== 'replace' &&
              item.conflictAction !== 'keep_both'
            ) {
              return c.json(
                { error: 'Invalid conflictAction: must be skip, replace, or keep_both' },
                400
              );
            }
            conflictAction = item.conflictAction;
          }
          validatedItems.push({
            virtualPath: item.virtualPath,
            sizeBytes: item.sizeBytes,
            conflictAction,
          });
        }
        const parsedPool = parseOptionalPoolId(body?.poolId);
        if (!parsedPool.ok) {
          return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
        }
        return {
          items: validatedItems,
          poolId: parsedPool.poolId,
        };
      }
    ),
    async (c) => {
      const { items, poolId = 1 } = c.req.valid('json');
      try {
        const plan = await planUploadBatchWithConflicts(items, undefined, poolId);
        return c.json(plan);
      } catch (err) {
        return mapDomainErrorToResponse(c, err);
      }
    }
  );

export default router;
