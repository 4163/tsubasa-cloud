import { Hono } from 'hono';
import { sqlite } from '../db/index.js';
import {
  runColdReconciliation,
  runIncrementalSync,
  syncAllAccounts,
  isSharePoolId,
  getOutboxStatusSummary,
  retryOutboxEntries,
} from '../drive/index.js';
import { calculateUsableLimit } from '../storage/index.js';
import {
  INVALID_POOL_ID_ERROR,
  parsePoolIdWithDefault,
  sharePoolReadOnlyError,
  isAccountInSharePool,
} from './shared.js';

const VALID_OUTBOX_STATUSES = new Set(['pending', 'processing', 'failed', 'dead']);

interface OutboxRow {
  id: string;
  accountId: string;
  poolId: number | null;
  opType: string;
  driveFileId: string | null;
  payloadJson: string;
  status: string;
  attempts: number;
  nextRetryAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

const router = new Hono()
  .get('/api/sync/status', (c) => {
    return c.json(getOutboxStatusSummary());
  })
  .get('/api/sync/outbox', (c) => {
    const rawStatus = c.req.query('status')?.trim();
    if (rawStatus && !VALID_OUTBOX_STATUSES.has(rawStatus)) {
      return c.json(
        { error: 'status must be one of pending, processing, failed, or dead', code: 'VALIDATION_ERROR' },
        400
      );
    }
    const rawAccountId = c.req.query('accountId')?.trim();
    const rawLimit = c.req.query('limit');
    let limit = 200;
    if (rawLimit !== undefined && rawLimit !== '') {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1000) {
        return c.json({ error: 'limit must be an integer between 1 and 1000', code: 'VALIDATION_ERROR' }, 400);
      }
      limit = parsed;
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (rawStatus) {
      conditions.push('status = ?');
      params.push(rawStatus);
    }
    if (rawAccountId) {
      conditions.push('account_id = ?');
      params.push(rawAccountId);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const entries = sqlite
      .prepare(
        `SELECT
           id,
           account_id as accountId,
           pool_id as poolId,
           op_type as opType,
           drive_file_id as driveFileId,
           payload_json as payloadJson,
           status,
           attempts,
           next_retry_at as nextRetryAt,
           last_error as lastError,
           created_at as createdAt,
           updated_at as updatedAt
         FROM drive_outbox
         ${whereClause}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(...params) as OutboxRow[];

    return c.json({
      entries,
      summary: getOutboxStatusSummary(),
    });
  })
  .delete('/api/sync/outbox/:id', (c) => {
    const id = c.req.param('id');
    const force = c.req.query('force') === 'true' || c.req.query('force') === '1';

    const existing = sqlite
      .prepare('SELECT id, status FROM drive_outbox WHERE id = ? LIMIT 1')
      .get(id) as { id: string; status: string } | undefined;

    if (!existing) {
      return c.json({ error: `Outbox entry '${id}' not found`, code: 'NOT_FOUND' }, 404);
    }

    const isPending = existing.status === 'pending' || existing.status === 'processing';
    if (isPending && !force) {
      return c.json(
        {
          error: `Outbox entry '${id}' has status '${existing.status}'. Pass force=true to drop pending items.`,
          code: 'CONFLICT',
        },
        409
      );
    }

    sqlite.prepare('DELETE FROM drive_outbox WHERE id = ?').run(id);
    return c.json({
      deleted: true,
      id: existing.id,
      status: existing.status,
      warning: isPending
        ? 'Dropped a pending outbox item. Run `tsubasa sync cold` to reconcile Drive metadata.'
        : null,
    });
  })
  .delete('/api/sync/outbox', (c) => {
    const force = c.req.query('force') === 'true' || c.req.query('force') === '1';
    const accountId = c.req.query('accountId')?.trim();

    const result = sqlite
      .transaction(() => {
        const statuses = force ? ['dead', 'failed', 'pending'] : ['dead', 'failed'];
        const placeholders = statuses.map(() => '?').join(', ');
        const params: unknown[] = [...statuses];
        let accountClause = '';
        if (accountId) {
          accountClause = ' AND account_id = ?';
          params.push(accountId);
        }

        let droppedPendingCount = 0;
        if (force) {
          const pendingParams: unknown[] = accountId ? [accountId] : [];
          const pendingRow = sqlite
            .prepare(
              `SELECT COUNT(*) as cnt FROM drive_outbox WHERE status = 'pending'${
                accountId ? ' AND account_id = ?' : ''
              }`
            )
            .get(...pendingParams) as { cnt: number } | undefined;
          droppedPendingCount = Number(pendingRow?.cnt ?? 0);
        }

        const info = sqlite
          .prepare(`DELETE FROM drive_outbox WHERE status IN (${placeholders})${accountClause}`)
          .run(...params);

        return {
          deletedCount: info.changes,
          droppedPendingCount,
        };
      })
      .immediate();

    return c.json({
      deletedCount: result.deletedCount,
      droppedPendingCount: result.droppedPendingCount,
      warning:
        result.droppedPendingCount > 0
          ? 'Dropped pending outbox items. Run `tsubasa sync cold` to reconcile Drive metadata.'
          : null,
    });
  })
  .get('/api/sync/audit/local', (c) => {
    const integrityRows = sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const integrityMessages = integrityRows.map((row) => String(row.integrity_check));
    const integrityOk = integrityMessages.length === 1 && integrityMessages[0] === 'ok';

    const orphanFolderFiles = sqlite
      .prepare(
        `SELECT id, pool_id as poolId, virtual_path as virtualPath, folder_id as folderId
         FROM files
         WHERE folder_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.id = files.folder_id)`
      )
      .all() as Array<{ id: string; poolId: number; virtualPath: string; folderId: string }>;

    const orphanAccountFiles = sqlite
      .prepare(
        `SELECT id, pool_id as poolId, virtual_path as virtualPath, account_id as accountId
         FROM files
         WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = files.account_id)`
      )
      .all() as Array<{ id: string; poolId: number; virtualPath: string; accountId: string }>;

    const accountRows = sqlite
      .prepare(
        `SELECT
           a.id as accountId,
           a.email,
           a.pool_id as poolId,
           a.quota_limit_bytes as quotaLimitBytes,
           a.quota_used_bytes as quotaUsedBytes,
           COALESCE(f.total_bytes, 0) as indexedBytes
         FROM accounts a
         LEFT JOIN (
           SELECT account_id, SUM(size_bytes) as total_bytes
           FROM files
           GROUP BY account_id
         ) f ON f.account_id = a.id
         ORDER BY a.pool_id ASC, a.email ASC`
      )
      .all() as Array<{
      accountId: string;
      email: string;
      poolId: number;
      quotaLimitBytes: number;
      quotaUsedBytes: number;
      indexedBytes: number;
    }>;

    const accountQuotaChecks = accountRows.map((row) => {
      const usableLimitBytes = calculateUsableLimit(row.quotaLimitBytes);
      const overCeilingBytes = Math.max(0, row.quotaUsedBytes - usableLimitBytes);
      return {
        accountId: row.accountId,
        email: row.email,
        poolId: row.poolId,
        quotaLimitBytes: row.quotaLimitBytes,
        quotaUsedBytes: row.quotaUsedBytes,
        usableLimitBytes,
        indexedBytes: Number(row.indexedBytes),
        driftBytes: row.quotaUsedBytes - Number(row.indexedBytes),
        overCeilingBytes,
        isOverCeiling: overCeilingBytes > 0,
      };
    });

    const overCeilingAccounts = accountQuotaChecks.filter((acc) => acc.isOverCeiling);
    const outbox = getOutboxStatusSummary();

    const ok =
      integrityOk &&
      orphanFolderFiles.length === 0 &&
      orphanAccountFiles.length === 0 &&
      overCeilingAccounts.length === 0 &&
      outbox.counts.dead === 0;

    return c.json({
      ok,
      integrity: {
        ok: integrityOk,
        messages: integrityMessages,
      },
      orphanFolderFiles,
      orphanAccountFiles,
      accountQuotaChecks,
      overCeilingAccounts,
      outbox,
    });
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
