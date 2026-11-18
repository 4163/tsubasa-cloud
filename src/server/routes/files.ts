import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { files, folders } from '../db/schema.js';
import {
  initiateResumableUpload,
  executeStreamingUpload,
  type UploadConflictMode,
  getStreamingDownload,
  ItemNotFoundError,
  formatFolderId,
  isSharePoolId,
} from '../drive/index.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import { MAX_SINGLE_FILE_BYTES } from '../storage/index.js';
import {
  INVALID_POOL_ID_ERROR,
  parsePoolIdWithDefault,
  parseOptionalPoolId,
  sharePoolReadOnlyError,
  UPLOAD_CONFLICT_MODES,
  parseConflictMode,
  checkPoolEtag,
  mapDomainErrorToResponse,
  buildContentDisposition,
  projectedFileColumns,
  projectedFolderColumns,
} from './shared.js';

const router = new Hono()
  .get(
    '/api/files',
    validator('query', (value): { path?: string; poolId?: string; mode?: 'dir' | 'tree' } => {
      const folderPath = typeof value.path === 'string' ? value.path : undefined;
      const poolId = typeof value.poolId === 'string' ? value.poolId : undefined;
      const mode = value.mode === 'dir' ? 'dir' : value.mode === 'tree' ? 'tree' : undefined;
      return { path: folderPath, poolId, mode };
    }),
    async (c) => {
      const { path: folderPath = '/', poolId: rawPoolId, mode = 'tree' } = c.req.valid('query');
      const poolId = parsePoolIdWithDefault(rawPoolId, 1);
      if (poolId === null) {
        return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
      }

      const normPath = normalizeVirtualPath(folderPath);
      if (checkPoolEtag(c, `files-${poolId}-${mode}-${normPath}`, poolId)) {
        return c.body(null, 304);
      }

      if (mode === 'dir') {
        const targetFolderId = normPath === '/' ? null : formatFolderId(poolId, normPath);
        const fileRecords = await db
          .select(projectedFileColumns)
          .from(files)
          .where(
            and(
              eq(files.poolId, poolId),
              eq(files.isTrashed, false),
              targetFolderId === null ? isNull(files.folderId) : eq(files.folderId, targetFolderId)
            )
          );
        const folderRecords = await db
          .select(projectedFolderColumns)
          .from(folders)
          .where(
            and(
              eq(folders.poolId, poolId),
              targetFolderId === null
                ? isNull(folders.parentFolderId)
                : eq(folders.parentFolderId, targetFolderId)
            )
          );

        return c.json(
          {
            currentPath: normPath,
            folders: folderRecords,
            files: fileRecords,
          },
          200
        );
      }

      const fileRecords = await db
        .select(projectedFileColumns)
        .from(files)
        .where(and(eq(files.poolId, poolId), eq(files.isTrashed, false)));
      const folderRecords = await db
        .select(projectedFolderColumns)
        .from(folders)
        .where(eq(folders.poolId, poolId));

      return c.json(
        {
          currentPath: normPath,
          folders: folderRecords,
          files: fileRecords,
        },
        200
      );
    }
  )
  // Unused by the client UI; client uploads stream directly via /api/files/upload.
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
            conflictMode?: UploadConflictMode;
          }
        | Response => {
        const body = value as Record<string, unknown>;
        if (typeof body?.virtualPath !== 'string' || typeof body?.sizeBytes !== 'number') {
          return c.json({ error: 'virtualPath (string) and sizeBytes (number) are required' }, 400);
        }
        const parsedPool = parseOptionalPoolId(body?.poolId);
        if (!parsedPool.ok) {
          return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
        }
        const parsedMode = parseConflictMode(
          body?.conflictMode,
          UPLOAD_CONFLICT_MODES,
          'Invalid conflictMode: must be reject, replace, or keep_both'
        );
        if (!parsedMode.ok) {
          return c.json({ error: parsedMode.error }, 400);
        }
        return {
          virtualPath: body.virtualPath,
          sizeBytes: body.sizeBytes,
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
          hash: typeof body.hash === 'string' ? body.hash : undefined,
          targetAccountId: typeof body.targetAccountId === 'string' ? body.targetAccountId : undefined,
          poolId: parsedPool.poolId,
          conflictMode: parsedMode.value,
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
        return mapDomainErrorToResponse(c, err);
      }
    }
  )
  .post('/api/files/upload', async (c) => {
    const virtualPath = c.req.query('virtualPath') || c.req.header('x-virtual-path');
    const sizeHeader = c.req.query('sizeBytes') || c.req.header('x-file-size') || c.req.header('content-length');
    const mimeType = c.req.query('mimeType') || c.req.header('content-type') || 'application/octet-stream';
    const hash = c.req.query('hash') || c.req.header('x-file-hash');
    const targetAccountId = c.req.query('accountId') || c.req.header('x-account-id');
    const rawConflictMode = c.req.query('conflictMode') || c.req.header('x-conflict-mode');
    const poolIdHeader = c.req.query('poolId') || c.req.header('x-pool-id');
    const poolId = parsePoolIdWithDefault(poolIdHeader, 1);
    if (poolId === null) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }

    const parsedMode = parseConflictMode(
      rawConflictMode || undefined,
      UPLOAD_CONFLICT_MODES,
      'Invalid conflictMode: must be reject, replace, or keep_both'
    );
    if (!parsedMode.ok) {
      return c.json({ error: parsedMode.error }, 400);
    }
    const conflictMode: UploadConflictMode = parsedMode.value ?? 'reject';

    if (isSharePoolId(poolId)) {
      return c.json(sharePoolReadOnlyError('Uploading directly to Share Pool is disabled'), 403);
    }

    if (!virtualPath || !sizeHeader) {
      return c.json({ error: 'virtualPath and sizeBytes (or Content-Length) required' }, 400);
    }

    if (normalizeVirtualPath(virtualPath) === '/') {
      return c.json({ error: 'Invalid virtualPath: cannot upload to root directory' }, 400);
    }

    const sizeBytes = Number(sizeHeader);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      return c.json({ error: 'sizeBytes must be a valid non-negative integer' }, 400);
    }

    if (sizeBytes > MAX_SINGLE_FILE_BYTES) {
      return c.json(
        {
          error: `File size ${sizeBytes} exceeds maximum single-file ceiling of ${MAX_SINGLE_FILE_BYTES} bytes`,
          code: 'EXCEEDS_CEILING',
        },
        400
      );
    }

    if (sizeBytes > 0 && !c.req.raw.body) {
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
          conflictMode,
        },
        c.req.raw.body ?? null,
        c.req.raw.signal
      );
      return c.json(record);
    } catch (err) {
      return mapDomainErrorToResponse(c, err);
    }
  })
  .get('/api/files/:id/download', async (c) => {
    const fileId = c.req.param('id');
    const parsedPool = parseOptionalPoolId(c.req.query('poolId'));
    if (!parsedPool.ok) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }
    try {
      const { stream, file, status, contentLength, contentRange } = await getStreamingDownload(
        fileId,
        parsedPool.poolId,
        {
          rangeHeader: c.req.header('range') ?? null,
          signal: c.req.raw.signal,
        }
      );
      const headers: Record<string, string> = {
        'Content-Type': file.mimeType || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(contentLength),
        'Content-Disposition': buildContentDisposition(file.name),
        'Cache-Control': 'no-cache, no-transform',
      };
      if (contentRange) {
        headers['Content-Range'] = contentRange;
      }
      return new Response(stream, {
        status,
        headers,
      });
    } catch (err) {
      if (err instanceof ItemNotFoundError) {
        return c.json({ error: err.message, code: 'NOT_FOUND' }, 404);
      }
      const upstreamStatus = (err as { status?: number })?.status;
      if (upstreamStatus === 416) {
        return c.json({ error: 'Requested range not satisfiable' }, 416);
      }
      if (upstreamStatus === 401 || upstreamStatus === 403) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, upstreamStatus);
      }
      if (typeof upstreamStatus === 'number' && upstreamStatus >= 400) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

export default router;
