import { Hono } from 'hono';
import { sqlite } from '../db/index.js';
import {
  cancelAccountEvacuationJob,
  EvacuationInProgressError,
  resumeAccountEvacuationJob,
} from '../drive/accountEvacuate.js';
import { listBackgroundJobs } from '../drive/backgroundJobs.js';
import {
  cancelCrossPoolMoveJob,
  resumeCrossPoolMoveJob,
  revokeJobShares,
  startCrossPoolMove,
  type CrossPoolMoveTarget,
} from '../drive/crossPoolMove.js';
import {
  cancelImportDriveJob,
  planImportDrive,
  resumeImportDriveJob,
  startImportDrive,
  type ImportDriveConflictMode,
  type ImportDriveMode,
} from '../drive/importDrive.js';
import { clearSourceTokens, listCachedSourceTokens } from '../drive/sourceAuth.js';
import {
  cancelUploadJob,
  initChunkedResumableUpload,
  LocalFileChangedError,
  probeOrResumeUploadJob,
  UploadIntegrityError,
  UploadJobStateError,
  UploadSessionExpiredError,
  uploadResumableChunk,
  type ResumableUploadConflictMode,
} from '../drive/resumableUpload.js';
import type { MoveConflictMode } from '../drive/operationsMovePlan.js';
import { isSharePoolId } from '../drive/poolRegistry.js';
import {
  planDryRunUpload,
  type UploadPlanCandidateItem,
  type UploadPlanConflictPolicy,
} from '../storage/uploadPlan.js';
import {
  INVALID_POOL_ID_ERROR,
  mapDomainErrorToResponse,
  MOVE_CONFLICT_MODES,
  parseConflictMode,
  parseOptionalPoolId,
  parseStrictPoolId,
  sharePoolReadOnlyError,
} from './shared.js';

const RESUMABLE_CONFLICT_MODES: readonly ResumableUploadConflictMode[] = [
  'reject',
  'replace',
  'keep_both',
  'skip',
];

const IMPORT_DRIVE_MODES: readonly ImportDriveMode[] = ['copy', 'stream'];
const IMPORT_CONFLICT_MODES: readonly ImportDriveConflictMode[] = [
  'skip',
  'reject',
  'replace',
  'keep_both',
];

function mapTransferError(c: Parameters<typeof mapDomainErrorToResponse>[0], err: unknown) {
  if (err instanceof UploadSessionExpiredError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        jobId: err.jobId,
        restartRequired: true,
      },
      410
    );
  }
  if (err instanceof LocalFileChangedError) {
    return c.json({ error: err.message, code: err.code }, 409);
  }
  if (err instanceof UploadJobStateError) {
    return c.json({ error: err.message, code: err.code }, 409);
  }
  if (err instanceof EvacuationInProgressError) {
    return c.json({ error: err.message, code: err.code, jobId: err.jobId }, 409);
  }
  if (err instanceof UploadIntegrityError) {
    return c.json({ error: err.message, code: err.code }, 502);
  }
  return mapDomainErrorToResponse(c, err);
}

interface TransferJobRow {
  id: string;
  kind: string;
  status: string;
  poolId: number | null;
  sourcePoolId: number | null;
  accountId: string | null;
  conflictPolicy: string;
  mode: string | null;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  skippedItems: number;
  totalBytes: number;
  transferredBytes: number;
  pauseReason: string | null;
  lastError: string | null;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

function formatPersistedJob(row: TransferJobRow) {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadataJson) {
    try {
      metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    source: 'persisted' as const,
    poolId: row.poolId,
    sourcePoolId: row.sourcePoolId,
    accountId: row.accountId,
    conflictPolicy: row.conflictPolicy,
    mode: row.mode,
    totalItems: row.totalItems,
    completedItems: row.completedItems,
    failedItems: row.failedItems,
    skippedItems: row.skippedItems,
    totalBytes: row.totalBytes,
    transferredBytes: row.transferredBytes,
    pauseReason: row.pauseReason,
    lastError: row.lastError,
    metadata,
    createdAt: row.createdAt * 1000,
    updatedAt: row.updatedAt * 1000,
    completedAt: row.completedAt !== null ? row.completedAt * 1000 : null,
  };
}

const router = new Hono()
  .post('/api/transfers/upload/plan', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body', code: 'VALIDATION_ERROR' }, 400);
    }

    const parsedPool = parseOptionalPoolId(body.poolId);
    if (!parsedPool.ok) {
      return c.json({ error: INVALID_POOL_ID_ERROR, code: 'VALIDATION_ERROR' }, 400);
    }
    const poolId = parsedPool.poolId ?? 1;
    if (isSharePoolId(poolId)) {
      return c.json(sharePoolReadOnlyError('Uploading directly to Share Pool is disabled'), 403);
    }

    const parsedDefaultConflict = parseConflictMode(
      body.conflictMode ?? body.conflict ?? body.defaultConflict,
      RESUMABLE_CONFLICT_MODES,
      'Invalid conflict policy: must be reject, replace, keep_both, or skip'
    );
    if (!parsedDefaultConflict.ok) {
      return c.json({ error: parsedDefaultConflict.error, code: 'VALIDATION_ERROR' }, 400);
    }

    if (!Array.isArray(body.items)) {
      return c.json({ error: 'items (array) is required', code: 'VALIDATION_ERROR' }, 400);
    }

    const candidateItems: UploadPlanCandidateItem[] = [];
    for (const raw of body.items) {
      if (!raw || typeof raw !== 'object') {
        return c.json({ error: 'Each item must be an object', code: 'VALIDATION_ERROR' }, 400);
      }
      const rec = raw as Record<string, unknown>;
      if (typeof rec.virtualPath !== 'string' || typeof rec.sizeBytes !== 'number') {
        return c.json(
          { error: 'Each item requires virtualPath (string) and sizeBytes (number)', code: 'VALIDATION_ERROR' },
          400
        );
      }
      const itemConflict = parseConflictMode(
        rec.conflict,
        RESUMABLE_CONFLICT_MODES,
        'Invalid item conflict policy: must be reject, replace, keep_both, or skip'
      );
      if (!itemConflict.ok) {
        return c.json({ error: itemConflict.error, code: 'VALIDATION_ERROR' }, 400);
      }
      candidateItems.push({
        relativePath: typeof rec.relativePath === 'string' ? rec.relativePath : rec.virtualPath,
        virtualPath: rec.virtualPath,
        sizeBytes: rec.sizeBytes,
        conflict: itemConflict.value as UploadPlanConflictPolicy | undefined,
      });
    }

    try {
      const summary = await planDryRunUpload(poolId, candidateItems, {
        defaultConflict: parsedDefaultConflict.value as UploadPlanConflictPolicy | undefined,
      });
      return c.json(summary, 200);
    } catch (err) {
      return mapTransferError(c, err);
    }
  })
  .post('/api/transfers/upload', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body', code: 'VALIDATION_ERROR' }, 400);
    }

    if (typeof body?.virtualPath !== 'string' || typeof body?.sizeBytes !== 'number') {
      return c.json(
        { error: 'virtualPath (string) and sizeBytes (number) are required', code: 'VALIDATION_ERROR' },
        400
      );
    }

    const parsedPool = parseOptionalPoolId(body.poolId);
    if (!parsedPool.ok) {
      return c.json({ error: INVALID_POOL_ID_ERROR, code: 'VALIDATION_ERROR' }, 400);
    }

    const parsedConflict = parseConflictMode(
      body.conflictMode ?? body.conflict,
      RESUMABLE_CONFLICT_MODES,
      'Invalid conflictMode: must be reject, replace, keep_both, or skip'
    );
    if (!parsedConflict.ok) {
      return c.json({ error: parsedConflict.error, code: 'VALIDATION_ERROR' }, 400);
    }

    const chunkSizeBytes =
      typeof body.chunkSizeBytes === 'number' ? body.chunkSizeBytes : undefined;
    const mtimeMs = typeof body.mtimeMs === 'number' ? body.mtimeMs : undefined;

    try {
      const result = await initChunkedResumableUpload({
        virtualPath: body.virtualPath,
        sizeBytes: body.sizeBytes,
        mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
        poolId: parsedPool.poolId,
        targetAccountId:
          typeof body.targetAccountId === 'string'
            ? body.targetAccountId
            : typeof body.accountId === 'string'
              ? body.accountId
              : undefined,
        localPath: typeof body.localPath === 'string' ? body.localPath : undefined,
        mtimeMs,
        chunkSizeBytes,
        conflictMode: parsedConflict.value,
        expectedMd5:
          typeof body.expectedMd5 === 'string'
            ? body.expectedMd5
            : typeof body.hash === 'string'
              ? body.hash
              : undefined,
      });

      return c.json(result, result.skipped ? 200 : 201);
    } catch (err) {
      return mapTransferError(c, err);
    }
  })
  .get('/api/transfers/:jobId/probe', async (c) => {
    const jobId = c.req.param('jobId');
    const rawSize = c.req.query('sizeBytes');
    const rawMtime = c.req.query('mtimeMs');
    const localMd5 = c.req.query('localMd5') || undefined;

    const sizeBytes = rawSize !== undefined && rawSize !== '' ? Number(rawSize) : undefined;
    const mtimeMs = rawMtime !== undefined && rawMtime !== '' ? Number(rawMtime) : undefined;

    if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
      return c.json({ error: 'sizeBytes must be a non-negative integer', code: 'VALIDATION_ERROR' }, 400);
    }
    if (mtimeMs !== undefined && !Number.isFinite(mtimeMs)) {
      return c.json({ error: 'mtimeMs must be a finite number', code: 'VALIDATION_ERROR' }, 400);
    }

    try {
      const result = await probeOrResumeUploadJob(jobId, { sizeBytes, mtimeMs, localMd5 });
      return c.json(result, 200);
    } catch (err) {
      return mapTransferError(c, err);
    }
  })
  .put('/api/transfers/:jobId/chunk', async (c) => {
    const jobId = c.req.param('jobId');
    const contentRangeHeader = c.req.header('content-range');
    const localMd5Header = c.req.header('x-tsubasa-local-md5') ?? c.req.header('x-file-hash') ?? null;

    try {
      const result = await uploadResumableChunk({
        jobId,
        contentRangeHeader,
        localMd5Header,
        bodyStream: c.req.raw.body ?? null,
        signal: c.req.raw.signal,
      });
      return c.json(result, 200);
    } catch (err) {
      return mapTransferError(c, err);
    }
  })
  .post('/api/transfers/cross-pool-move', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body', code: 'VALIDATION_ERROR' }, 400);
    }

    const sourcePoolId = parseStrictPoolId(body?.sourcePoolId);
    const destPoolId = parseStrictPoolId(body?.destPoolId);
    if (sourcePoolId === null || destPoolId === null) {
      return c.json(
        { error: 'sourcePoolId and destPoolId must be positive integers', code: 'VALIDATION_ERROR' },
        400
      );
    }

    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return c.json({ error: 'items (non-empty array) is required', code: 'VALIDATION_ERROR' }, 400);
    }

    const parsedItems: CrossPoolMoveTarget[] = [];
    for (const rawItem of body.items) {
      if (!rawItem || typeof rawItem !== 'object') {
        return c.json({ error: 'Each item must be an object with id or path', code: 'VALIDATION_ERROR' }, 400);
      }
      const rec = rawItem as Record<string, unknown>;
      const kind = rec.kind === 'file' || rec.kind === 'folder' ? rec.kind : undefined;
      const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : undefined;
      const itemPath = typeof rec.path === 'string' && rec.path.trim() ? rec.path.trim() : undefined;
      if (!id && !itemPath) {
        return c.json({ error: 'Each item must specify id or path', code: 'VALIDATION_ERROR' }, 400);
      }
      parsedItems.push({ kind, id, path: itemPath });
    }

    const parsedConflict = parseConflictMode(
      body.conflictMode ?? body.conflict,
      MOVE_CONFLICT_MODES,
      'Invalid conflictMode: must be reject, skip, keep_both, or overwrite'
    );
    if (!parsedConflict.ok) {
      return c.json({ error: parsedConflict.error, code: 'VALIDATION_ERROR' }, 400);
    }

    try {
      const result = await startCrossPoolMove({
        sourcePoolId,
        destPoolId,
        items: parsedItems,
        destDir: typeof body.destDir === 'string' ? body.destDir : undefined,
        destPath: typeof body.destPath === 'string' ? body.destPath : undefined,
        conflictMode: (parsedConflict.value as MoveConflictMode | undefined) ?? 'reject',
        wait: typeof body.wait === 'boolean' ? body.wait : undefined,
      });
      return c.json(result, result.queued ? 202 : 200);
    } catch (err) {
      return mapTransferError(c, err);
    }
  })
  .post('/api/transfers/import-drive/plan', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body', code: 'VALIDATION_ERROR' }, 400);
    }

    const folderIdOrUrl =
      typeof body.folderIdOrUrl === 'string'
        ? body.folderIdOrUrl.trim()
        : typeof body.source === 'string'
          ? body.source.trim()
          : '';
    const sourceAuthPath =
      typeof body.sourceAuthPath === 'string'
        ? body.sourceAuthPath.trim()
        : typeof body.sourceAuth === 'string'
          ? body.sourceAuth.trim()
          : '';

    if (!folderIdOrUrl || !sourceAuthPath) {
      return c.json(
        { error: 'folderIdOrUrl and sourceAuthPath are required', code: 'VALIDATION_ERROR' },
        400
      );
    }

    const parsedPool = parseOptionalPoolId(body.poolId);
    if (!parsedPool.ok) {
      return c.json({ error: INVALID_POOL_ID_ERROR, code: 'VALIDATION_ERROR' }, 400);
    }
    const poolId = parsedPool.poolId ?? 1;
    if (isSharePoolId(poolId)) {
      return c.json(sharePoolReadOnlyError('Importing directly into Share Pool is disabled'), 403);
    }

    const parsedMode = parseConflictMode(
      body.mode,
      IMPORT_DRIVE_MODES,
      'Invalid mode: must be copy or stream'
    );
    if (!parsedMode.ok) {
      return c.json({ error: parsedMode.error, code: 'VALIDATION_ERROR' }, 400);
    }

    const parsedConflict = parseConflictMode(
      body.conflictMode ?? body.conflict,
      IMPORT_CONFLICT_MODES,
      'Invalid conflictMode: must be skip, reject, replace, or keep_both'
    );
    if (!parsedConflict.ok) {
      return c.json({ error: parsedConflict.error, code: 'VALIDATION_ERROR' }, 400);
    }

    try {
      const summary = await planImportDrive({
        folderIdOrUrl,
        destPath: typeof body.destPath === 'string' ? body.destPath : undefined,
        poolId,
        sourceAuthPath,
        mode: parsedMode.value,
        conflictMode: parsedConflict.value,
        noBrowser: body.noBrowser === true,
      });
      return c.json(summary, 200);
    } catch (err) {
      return mapTransferError(c, err);
    }
  })
  .post('/api/transfers/import-drive', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body', code: 'VALIDATION_ERROR' }, 400);
    }

    const folderIdOrUrl =
      typeof body.folderIdOrUrl === 'string'
        ? body.folderIdOrUrl.trim()
        : typeof body.source === 'string'
          ? body.source.trim()
          : '';
    const sourceAuthPath =
      typeof body.sourceAuthPath === 'string'
        ? body.sourceAuthPath.trim()
        : typeof body.sourceAuth === 'string'
          ? body.sourceAuth.trim()
          : '';

    if (!folderIdOrUrl || !sourceAuthPath) {
      return c.json(
        { error: 'folderIdOrUrl and sourceAuthPath are required', code: 'VALIDATION_ERROR' },
        400
      );
    }

    const parsedPool = parseOptionalPoolId(body.poolId);
    if (!parsedPool.ok) {
      return c.json({ error: INVALID_POOL_ID_ERROR, code: 'VALIDATION_ERROR' }, 400);
    }
    const poolId = parsedPool.poolId ?? 1;
    if (isSharePoolId(poolId)) {
      return c.json(sharePoolReadOnlyError('Importing directly into Share Pool is disabled'), 403);
    }

    const parsedMode = parseConflictMode(
      body.mode,
      IMPORT_DRIVE_MODES,
      'Invalid mode: must be copy or stream'
    );
    if (!parsedMode.ok) {
      return c.json({ error: parsedMode.error, code: 'VALIDATION_ERROR' }, 400);
    }

    const parsedConflict = parseConflictMode(
      body.conflictMode ?? body.conflict,
      IMPORT_CONFLICT_MODES,
      'Invalid conflictMode: must be skip, reject, replace, or keep_both'
    );
    if (!parsedConflict.ok) {
      return c.json({ error: parsedConflict.error, code: 'VALIDATION_ERROR' }, 400);
    }

    const wait = body.detach === true ? false : body.wait !== false;

    try {
      const result = await startImportDrive({
        folderIdOrUrl,
        destPath: typeof body.destPath === 'string' ? body.destPath : undefined,
        poolId,
        sourceAuthPath,
        mode: parsedMode.value,
        conflictMode: parsedConflict.value,
        noBrowser: body.noBrowser === true,
        wait,
      });
      return c.json(result, result.queued ? 202 : 200);
    } catch (err) {
      return mapTransferError(c, err);
    }
  })
  .get('/api/transfers/source-tokens', (c) => {
    const tokens = listCachedSourceTokens();
    return c.json({ tokens });
  })
  .delete('/api/transfers/source-tokens', (c) => {
    const cacheKey = c.req.query('cacheKey')?.trim() || undefined;
    const emailFilter = c.req.query('email')?.trim().toLowerCase() || undefined;
    const clientId = c.req.query('clientId')?.trim() || undefined;

    if (emailFilter) {
      const matching = listCachedSourceTokens().filter(
        (t) =>
          (t.email?.toLowerCase() === emailFilter) &&
          (!cacheKey || t.cacheKey === cacheKey) &&
          (!clientId || t.clientId === clientId)
      );
      let removedCount = 0;
      const deletedKeys: string[] = [];
      for (const token of matching) {
        const res = clearSourceTokens({ cacheKey: token.cacheKey });
        removedCount += res.deletedCount;
        deletedKeys.push(...res.deletedKeys);
      }
      return c.json({ removedCount, deletedKeys });
    }

    const res = clearSourceTokens({ cacheKey, clientId });
    return c.json({ removedCount: res.deletedCount, deletedKeys: res.deletedKeys });
  })
  .get('/api/jobs', (c) => {
    const kindFilter = c.req.query('kind')?.trim() || undefined;
    const statusFilter = c.req.query('status')?.trim() || undefined;
    const rawLimit = c.req.query('limit');

    let limit = 100;
    if (rawLimit !== undefined && rawLimit !== '') {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 500) {
        return c.json({ error: 'limit must be an integer between 1 and 500', code: 'VALIDATION_ERROR' }, 400);
      }
      limit = parsed;
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (kindFilter) {
      conditions.push('kind = ?');
      params.push(kindFilter);
    }
    if (statusFilter) {
      conditions.push('status = ?');
      params.push(statusFilter);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const persistedRows = sqlite
      .prepare(
        `SELECT id, kind, status, pool_id as poolId, source_pool_id as sourcePoolId,
                account_id as accountId, conflict_policy as conflictPolicy, mode,
                total_items as totalItems, completed_items as completedItems,
                failed_items as failedItems, skipped_items as skippedItems,
                total_bytes as totalBytes, transferred_bytes as transferredBytes,
                pause_reason as pauseReason, last_error as lastError,
                metadata_json as metadataJson,
                created_at as createdAt, updated_at as updatedAt, completed_at as completedAt
         FROM transfer_jobs
         ${whereClause}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(...params, limit) as TransferJobRow[];

    const persistedJobs = persistedRows.map(formatPersistedJob);

    const liveColdSyncJobs = listBackgroundJobs()
      .filter((bg) => bg.kind === 'oauth_cold_sync')
      .filter((bg) => (!kindFilter || kindFilter === bg.kind) && (!statusFilter || statusFilter === bg.status))
      .map((bg) => ({
        id: bg.id,
        kind: bg.kind,
        status: bg.status,
        source: 'memory' as const,
        poolId: null,
        sourcePoolId: null,
        accountId: bg.targetId,
        conflictPolicy: null,
        mode: null,
        totalItems: 0,
        completedItems: 0,
        failedItems: 0,
        skippedItems: 0,
        totalBytes: 0,
        transferredBytes: 0,
        pauseReason: null,
        lastError: bg.error ?? null,
        metadata: bg.result !== undefined ? { result: bg.result } : null,
        createdAt: bg.startedAt,
        updatedAt: bg.finishedAt ?? bg.startedAt,
        completedAt: bg.finishedAt,
      }));

    const jobs = [...liveColdSyncJobs, ...persistedJobs]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);

    return c.json({ jobs });
  })
  .get('/api/jobs/:id', (c) => {
    const jobId = c.req.param('id');
    const itemStatusFilter = c.req.query('itemStatus')?.trim() || undefined;
    const rawItemsLimit = c.req.query('itemsLimit');

    let itemsLimit = 100;
    if (rawItemsLimit !== undefined && rawItemsLimit !== '') {
      const parsed = Number(rawItemsLimit);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 500) {
        return c.json({ error: 'itemsLimit must be an integer between 1 and 500', code: 'VALIDATION_ERROR' }, 400);
      }
      itemsLimit = parsed;
    }

    const row = sqlite
      .prepare(
        `SELECT id, kind, status, pool_id as poolId, source_pool_id as sourcePoolId,
                account_id as accountId, conflict_policy as conflictPolicy, mode,
                total_items as totalItems, completed_items as completedItems,
                failed_items as failedItems, skipped_items as skippedItems,
                total_bytes as totalBytes, transferred_bytes as transferredBytes,
                pause_reason as pauseReason, last_error as lastError,
                metadata_json as metadataJson,
                created_at as createdAt, updated_at as updatedAt, completed_at as completedAt
         FROM transfer_jobs
         WHERE id = ?
         LIMIT 1`
      )
      .get(jobId) as TransferJobRow | undefined;

    if (row) {
      const countRows = sqlite
        .prepare(
          `SELECT status, COUNT(*) as cnt
           FROM transfer_job_items
           WHERE job_id = ?
           GROUP BY status`
        )
        .all(jobId) as Array<{ status: string; cnt: number }>;

      const itemSummary: Record<string, number> = {
        pending: 0,
        running: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      };
      for (const cr of countRows) {
        itemSummary[cr.status] = Number(cr.cnt);
      }

      const activeSharesRow = sqlite
        .prepare(
          `SELECT COUNT(*) as cnt FROM transfer_job_shares WHERE job_id = ? AND revoked_at IS NULL`
        )
        .get(jobId) as { cnt: number } | undefined;

      const items = sqlite
        .prepare(
          `SELECT id, status, source_account_id as sourceAccountId, target_account_id as targetAccountId,
                  source_file_id as sourceFileId, source_drive_file_id as sourceDriveFileId,
                  dest_drive_file_id as destDriveFileId, local_path as localPath,
                  virtual_path as virtualPath, file_name as fileName, mime_type as mimeType,
                  size_bytes as sizeBytes, transferred_bytes as transferredBytes,
                  expected_hash as expectedHash, verified_hash as verifiedHash,
                  transfer_mode as transferMode, skip_reason as skipReason,
                  attempts, last_error as lastError,
                  created_at as createdAt, updated_at as updatedAt
           FROM transfer_job_items
           WHERE job_id = ? ${itemStatusFilter ? 'AND status = ?' : ''}
           ORDER BY updated_at DESC, rowid ASC
           LIMIT ?`
        )
        .all(...(itemStatusFilter ? [jobId, itemStatusFilter, itemsLimit] : [jobId, itemsLimit])) as Array<
        Record<string, unknown> & { createdAt: number; updatedAt: number }
      >;

      return c.json({
        job: formatPersistedJob(row),
        itemSummary,
        activeShareCount: Number(activeSharesRow?.cnt ?? 0),
        items: items.map((it) => ({
          ...it,
          createdAt: Number(it.createdAt) * 1000,
          updatedAt: Number(it.updatedAt) * 1000,
        })),
      });
    }

    const liveBg = listBackgroundJobs().find((bg) => bg.id === jobId);
    if (liveBg) {
      return c.json({
        job: {
          id: liveBg.id,
          kind: liveBg.kind,
          status: liveBg.status,
          source: 'memory' as const,
          poolId: null,
          sourcePoolId: null,
          accountId: liveBg.targetId,
          conflictPolicy: null,
          mode: null,
          totalItems: 0,
          completedItems: 0,
          failedItems: 0,
          skippedItems: 0,
          totalBytes: 0,
          transferredBytes: 0,
          pauseReason: null,
          lastError: liveBg.error ?? null,
          metadata: liveBg.result !== undefined ? { result: liveBg.result } : null,
          createdAt: liveBg.startedAt,
          updatedAt: liveBg.finishedAt ?? liveBg.startedAt,
          completedAt: liveBg.finishedAt,
        },
        itemSummary: {},
        activeShareCount: 0,
        items: [],
      });
    }

    return c.json({ error: `Job '${jobId}' not found`, code: 'NOT_FOUND' }, 404);
  })
  .post('/api/jobs/:id/cancel', async (c) => {
    const jobId = c.req.param('id');
    const row = sqlite
      .prepare('SELECT id, kind, status FROM transfer_jobs WHERE id = ? LIMIT 1')
      .get(jobId) as { id: string; kind: string; status: string } | undefined;

    if (!row) {
      const liveBg = listBackgroundJobs().find((bg) => bg.id === jobId);
      if (liveBg) {
        return c.json(
          { error: `In-memory job '${jobId}' (${liveBg.kind}) cannot be cancelled`, code: 'JOB_NOT_CANCELLABLE' },
          409
        );
      }
      return c.json({ error: `Job '${jobId}' not found`, code: 'NOT_FOUND' }, 404);
    }

    try {
      if (row.kind === 'upload') {
        const result = await cancelUploadJob(jobId);
        return c.json(result, 200);
      }
      if (row.kind === 'cross_pool_move') {
        const result = await cancelCrossPoolMoveJob(jobId);
        return c.json(result, 200);
      }
      if (row.kind === 'account_evacuate') {
        const result = await cancelAccountEvacuationJob(jobId);
        return c.json(result, 200);
      }
      if (row.kind === 'import_drive') {
        const result = await cancelImportDriveJob(jobId);
        return c.json(result, 200);
      }

      const shareRevoke = await revokeJobShares(jobId);
      sqlite.transaction(() => {
        sqlite
          .prepare(
            `UPDATE transfer_job_items SET status = 'cancelled', updated_at = unixepoch()
             WHERE job_id = ? AND status NOT IN ('completed', 'skipped')`
          )
          .run(jobId);
        sqlite
          .prepare(
            `UPDATE transfer_jobs SET status = 'cancelled', pause_reason = NULL, updated_at = unixepoch()
             WHERE id = ? AND status != 'completed'`
          )
          .run(jobId);
      }).immediate();

      return c.json({ jobId, status: 'cancelled', ...shareRevoke }, 200);
    } catch (err) {
      return mapTransferError(c, err);
    }
  })
  .post('/api/jobs/:id/resume', async (c) => {
    const jobId = c.req.param('id');
    let body: Record<string, unknown> = {};
    try {
      const text = await c.req.text();
      if (text.trim()) {
        body = JSON.parse(text) as Record<string, unknown>;
      }
    } catch {
      return c.json({ error: 'Invalid JSON request body', code: 'VALIDATION_ERROR' }, 400);
    }

    const row = sqlite
      .prepare('SELECT id, kind, status FROM transfer_jobs WHERE id = ? LIMIT 1')
      .get(jobId) as { id: string; kind: string; status: string } | undefined;

    if (!row) {
      return c.json({ error: `Job '${jobId}' not found`, code: 'NOT_FOUND' }, 404);
    }

    const wait = body.wait === true;

    try {
      if (row.kind === 'upload') {
        const result = await probeOrResumeUploadJob(jobId, {
          sizeBytes: typeof body.sizeBytes === 'number' ? body.sizeBytes : undefined,
          mtimeMs: typeof body.mtimeMs === 'number' ? body.mtimeMs : undefined,
          localMd5: typeof body.localMd5 === 'string' ? body.localMd5 : undefined,
        });
        return c.json(result, 200);
      }
      if (row.kind === 'cross_pool_move') {
        const result = await resumeCrossPoolMoveJob(jobId, wait);
        return c.json(result, result.queued ? 202 : 200);
      }
      if (row.kind === 'account_evacuate') {
        const result = await resumeAccountEvacuationJob(jobId, wait);
        return c.json(result, result.queued ? 202 : 200);
      }
      if (row.kind === 'import_drive') {
        const result = await resumeImportDriveJob(jobId, wait);
        return c.json(result, result.queued ? 202 : 200);
      }

      return c.json(
        {
          error: `Resume for job kind '${row.kind}' is not available yet`,
          code: 'VALIDATION_ERROR',
        },
        400
      );
    } catch (err) {
      return mapTransferError(c, err);
    }
  });

export default router;
