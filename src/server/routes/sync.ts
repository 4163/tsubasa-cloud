import { Hono } from 'hono';
import {
  runColdReconciliation,
  runIncrementalSync,
  syncAllAccounts,
  isSharePoolId,
  getOutboxStatusSummary,
  retryOutboxEntries,
} from '../drive/index.js';
import {
  INVALID_POOL_ID_ERROR,
  parsePoolIdWithDefault,
  sharePoolReadOnlyError,
  isAccountInSharePool,
} from './shared.js';

const router = new Hono()
  .get('/api/sync/status', (c) => {
    return c.json(getOutboxStatusSummary());
  })
  .post('/api/sync/outbox/retry', async (c) => {
    let accountId: string | undefined;
    try {
      const raw = await c.req.text();
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed?.accountId !== undefined) {
          if (typeof parsed.accountId !== 'string' || !parsed.accountId.trim()) {
            return c.json({ error: 'accountId must be a non-empty string' }, 400);
          }
          accountId = parsed.accountId.trim();
        }
      }
    } catch {
      return c.json({ error: 'Invalid JSON payload' }, 400);
    }
    return c.json(retryOutboxEntries(accountId));
  })
  .post('/api/sync/all', async (c) => {
    const poolId = parsePoolIdWithDefault(c.req.query('poolId'), 1);
    if (poolId === null) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }
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
  });

export default router;
