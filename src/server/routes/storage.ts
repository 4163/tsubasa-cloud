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
  buildCanonicalExport,
  ExportValidationError,
  isExportEntityName,
  iterateExportJsonl,
  type ExportEntityName,
  type ExportOptions,
  type ExportPreset,
  type ExportTrashedMode,
} from '../storage/export.js';
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
  )
  .get('/api/export', async (c) => {
    const rawFormat = (c.req.query('format') || 'json').trim().toLowerCase();
    if (rawFormat !== 'json' && rawFormat !== 'jsonl') {
      return c.json(
        { error: `Invalid format '${rawFormat}'. Expected json or jsonl.`, code: 'VALIDATION_ERROR' },
        400
      );
    }

    const rawPreset = c.req.query('preset')?.trim().toLowerCase();
    if (rawPreset && rawPreset !== 'minimal' && rawPreset !== 'standard' && rawPreset !== 'full') {
      return c.json(
        { error: `Invalid preset '${rawPreset}'. Expected minimal, standard, or full.`, code: 'VALIDATION_ERROR' },
        400
      );
    }

    const rawTrashed = c.req.query('trashed')?.trim().toLowerCase();
    if (rawTrashed && rawTrashed !== 'exclude' && rawTrashed !== 'include' && rawTrashed !== 'only') {
      return c.json(
        { error: `Invalid trashed mode '${rawTrashed}'. Expected exclude, include, or only.`, code: 'VALIDATION_ERROR' },
        400
      );
    }

    const rawInclude = c.req.query('include')?.trim();
    let include: ExportEntityName[] | undefined;
    if (rawInclude) {
      const parts = rawInclude
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const part of parts) {
        if (!isExportEntityName(part)) {
          return c.json(
            { error: `Unknown export entity '${part}'.`, code: 'VALIDATION_ERROR' },
            400
          );
        }
      }
      include = parts as ExportEntityName[];
    }

    const rawShowEmails = c.req.query('showEmails')?.trim().toLowerCase();
    const showEmails = rawShowEmails === 'true' || rawShowEmails === '1';

    const options: ExportOptions = {
      preset: (rawPreset as ExportPreset | undefined) ?? 'standard',
      include,
      pool: c.req.query('pool')?.trim() || undefined,
      account: c.req.query('account')?.trim() || undefined,
      path: c.req.query('path')?.trim() || undefined,
      trashed: (rawTrashed as ExportTrashedMode | undefined) ?? 'exclude',
      showEmails,
    };

    try {
      if (rawFormat === 'jsonl') {
        const generator = iterateExportJsonl(options);
        const first = await generator.next();
        const encoder = new TextEncoder();

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (!first.done) {
              controller.enqueue(encoder.encode(first.value));
            } else {
              controller.close();
            }
          },
          async pull(controller) {
            try {
              const next = await generator.next();
              if (next.done) {
                controller.close();
              } else {
                controller.enqueue(encoder.encode(next.value));
              }
            } catch (err) {
              controller.error(err);
            }
          },
          async cancel() {
            await generator.return?.(undefined);
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
          },
        });
      }

      const payload = await buildCanonicalExport(options);
      return c.json(payload);
    } catch (err) {
      if (err instanceof ExportValidationError) {
        return c.json(
          { error: err.message, code: err.code },
          err.status === 404 ? 404 : 400
        );
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

export default router;
