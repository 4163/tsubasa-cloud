import { Hono } from 'hono';
import { validator } from 'hono/validator';
import {
  isSharePoolId,
  inspectSharePlan,
  validateShareSelection,
  executeShare,
  clearSharePool,
  listSharePoolLinks,
  type ShareTargetInput,
} from '../drive/index.js';
import {
  INVALID_POOL_ID_ERROR,
  mapDomainErrorToResponse,
  parseItemTargets,
  parseOptionalPoolId,
  parsePoolIdWithDefault,
  parseStrictPoolId,
  parseStringArray,
  sharePoolReadOnlyError,
} from './shared.js';

const router = new Hono()
  .post(
    '/api/share/inspect',
    validator(
      'json',
      (value, c): { sourcePoolId: number; items: ShareTargetInput[] } | Response => {
        const body = value as Record<string, unknown>;
        const items = parseItemTargets(body?.items);
        if (!items) {
          return c.json({ error: 'items (non-empty array of { kind: "file" | "folder", id: string }) is required' }, 400);
        }
        const sourcePoolId = parsePoolIdWithDefault(body?.sourcePoolId ?? body?.poolId, 1);
        if (sourcePoolId === null) {
          return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
        }
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
        return mapDomainErrorToResponse(c, err);
      }
    }
  )
  .post(
    '/api/share/validate',
    validator(
      'json',
      (value, c): { sourcePoolId: number; items: ShareTargetInput[]; selectedAccountIds: string[] } | Response => {
        const body = value as Record<string, unknown>;
        const items = parseItemTargets(body?.items);
        if (!items) {
          return c.json({ error: 'items (non-empty array of { kind: "file" | "folder", id: string }) is required' }, 400);
        }
        const selectedAccountIds = parseStringArray(body?.selectedAccountIds ?? []);
        if (!selectedAccountIds) {
          return c.json({ error: 'selectedAccountIds must be an array of strings' }, 400);
        }
        const sourcePoolId = parsePoolIdWithDefault(body?.sourcePoolId ?? body?.poolId, 1);
        if (sourcePoolId === null) {
          return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
        }
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
        return mapDomainErrorToResponse(c, err);
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
        const items = parseItemTargets(body?.items);
        if (!items) {
          return c.json({ error: 'items (non-empty array of { kind: "file" | "folder", id: string }) is required' }, 400);
        }
        const selectedAccountIds = parseStringArray(body?.selectedAccountIds ?? []);
        if (!selectedAccountIds) {
          return c.json({ error: 'selectedAccountIds must be an array of strings' }, 400);
        }
        const sourcePoolId = parsePoolIdWithDefault(body?.sourcePoolId ?? body?.poolId, 1);
        if (sourcePoolId === null) {
          return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
        }
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
        return mapDomainErrorToResponse(c, err);
      }
    }
  )
  .get('/api/share/links', (c) => {
    const parsedPool = parseOptionalPoolId(c.req.query('poolId'));
    if (!parsedPool.ok) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }
    const links = listSharePoolLinks(parsedPool.poolId);
    return c.json({ links });
  })
  .post('/api/pools/:id/clear-share', async (c) => {
    const poolId = parseStrictPoolId(c.req.param('id'));
    if (poolId === null) {
      return c.json({ error: 'Invalid pool id' }, 400);
    }

    try {
      const result = await clearSharePool(poolId);
      return c.json(result);
    } catch (err) {
      return mapDomainErrorToResponse(c, err);
    }
  });

export default router;
