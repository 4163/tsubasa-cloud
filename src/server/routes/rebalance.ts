import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { sqlite, bumpPoolRevision, chunkArray } from '../db/index.js';
import {
  rebalanceFile,
  rebalanceFilesBatch,
  executeAutoRebalance,
  isSharePoolId,
} from '../drive/index.js';
import {
  getAccountPoolId,
  isAccountInSharePool,
  mapDomainErrorToResponse,
  sharePoolReadOnlyError,
} from './shared.js';

const router = new Hono()
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
        bumpPoolRevision(fileRow?.poolId);
        return c.json(result);
      } catch (err) {
        return mapDomainErrorToResponse(c, err);
      }
    }
  )
  .post(
    '/api/sync/rebalance/batch',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (
        !Array.isArray(body?.fileIds) ||
        body.fileIds.length === 0 ||
        !body.fileIds.every((id) => typeof id === 'string' && id.trim().length > 0) ||
        typeof body?.targetAccountId !== 'string' ||
        !body.targetAccountId.trim()
      ) {
        return c.json({ error: 'fileIds (non-empty array of strings) and targetAccountId (string) required' }, 400);
      }
      return { fileIds: body.fileIds as string[], targetAccountId: body.targetAccountId };
    }),
    async (c) => {
      const { fileIds, targetAccountId } = c.req.valid('json');
      for (const idChunk of chunkArray(fileIds, 400)) {
        const placeholders = idChunk.map(() => '?').join(',');
        const shareRows = sqlite
          .prepare(
            `SELECT 1 FROM files f INNER JOIN pools p ON p.id = f.pool_id WHERE f.id IN (${placeholders}) AND p.is_share_pool = 1 LIMIT 1`
          )
          .get(...idChunk);
        if (shareRows) {
          return c.json(sharePoolReadOnlyError('Moving Share Pool files in batches is disabled'), 403);
        }
      }
      try {
        const result = await rebalanceFilesBatch(fileIds, targetAccountId);
        bumpPoolRevision(getAccountPoolId(targetAccountId));
        return c.json(result);
      } catch (err) {
        return mapDomainErrorToResponse(c, err);
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
      bumpPoolRevision(getAccountPoolId(accountId));
      return c.json({ results });
    } catch (err) {
      return mapDomainErrorToResponse(c, err);
    }
  });

export default router;
