import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { eq, and, isNull } from 'drizzle-orm';
import { db, sqlite, buildDirectoryPrefixBounds } from '../db/index.js';
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
import {
  executeVerifiedSmallUpload,
  SMALL_UPLOAD_FAST_PATH_BYTES,
  UploadIntegrityError,
} from '../drive/resumableUpload.js';
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
      const uploadOpts = {
        virtualPath,
        sizeBytes,
        mimeType,
        hash: hash || undefined,
        targetAccountId: targetAccountId || undefined,
        poolId,
        conflictMode,
      };
      const record =
        sizeBytes <= SMALL_UPLOAD_FAST_PATH_BYTES
          ? await executeVerifiedSmallUpload(uploadOpts, c.req.raw.body ?? null, c.req.raw.signal)
          : await executeStreamingUpload(uploadOpts, c.req.raw.body ?? null, c.req.raw.signal);
      return c.json(record);
    } catch (err) {
      if (err instanceof UploadIntegrityError) {
        return c.json({ error: err.message, code: err.code }, 502);
      }
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
      // Handle 0-byte active files directly with HTTP 200 and an empty body so Drive never returns HTTP 416.
      const zeroByteCandidate = (
        parsedPool.poolId !== undefined
          ? sqlite
              .prepare(
                `SELECT id, name, size_bytes as sizeBytes, mime_type as mimeType, hash
                 FROM files
                 WHERE (id = ? OR virtual_path = ? OR drive_file_id = ?)
                   AND is_trashed = 0 AND pool_id = ?
                 LIMIT 1`
              )
              .get(fileId, fileId, fileId, parsedPool.poolId)
          : sqlite
              .prepare(
                `SELECT id, name, size_bytes as sizeBytes, mime_type as mimeType, hash
                 FROM files
                 WHERE (id = ? OR virtual_path = ? OR drive_file_id = ?)
                   AND is_trashed = 0
                 LIMIT 1`
              )
              .get(fileId, fileId, fileId)
      ) as
        | { id: string; name: string; sizeBytes: number; mimeType: string; hash: string | null }
        | undefined;

      if (zeroByteCandidate && zeroByteCandidate.sizeBytes === 0) {
        const headers: Record<string, string> = {
          'Content-Type': zeroByteCandidate.mimeType || 'application/octet-stream',
          'Accept-Ranges': 'bytes',
          'Content-Length': '0',
          'Content-Disposition': buildContentDisposition(zeroByteCandidate.name),
          'Cache-Control': 'no-cache, no-transform',
          'X-Tsubasa-File-Id': zeroByteCandidate.id,
          'X-Tsubasa-Size': '0',
          'Access-Control-Expose-Headers':
            'X-Tsubasa-Hash, X-Tsubasa-File-Id, X-Tsubasa-Size, Content-Range, Content-Length, Content-Disposition',
        };
        if (zeroByteCandidate.hash) {
          headers['X-Tsubasa-Hash'] = zeroByteCandidate.hash;
        }
        return new Response(null, { status: 200, headers });
      }

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
        'X-Tsubasa-File-Id': file.id,
        'X-Tsubasa-Size': String(file.sizeBytes),
        'Access-Control-Expose-Headers':
          'X-Tsubasa-Hash, X-Tsubasa-File-Id, X-Tsubasa-Size, Content-Range, Content-Length, Content-Disposition',
      };
      if (file.hash) {
        headers['X-Tsubasa-Hash'] = file.hash;
      }
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
  })
  .get('/api/files/dupes', (c) => {
    const parsedPool = parseOptionalPoolId(c.req.query('poolId'));
    if (!parsedPool.ok) {
      return c.json({ error: INVALID_POOL_ID_ERROR, code: 'VALIDATION_ERROR' }, 400);
    }
    const rawBy = (c.req.query('by') || 'hash').trim().toLowerCase();
    if (rawBy !== 'hash' && rawBy !== 'name-size') {
      return c.json({ error: 'by must be hash or name-size', code: 'VALIDATION_ERROR' }, 400);
    }

    const poolId = parsedPool.poolId;
    const poolClause = poolId !== undefined ? 'AND pool_id = ?' : '';
    const poolParams = poolId !== undefined ? [poolId] : [];

    type DupeFileRow = {
      id: string;
      poolId: number;
      virtualPath: string;
      name: string;
      sizeBytes: number;
      mimeType: string;
      hash: string | null;
      accountId: string;
      folderId: string | null;
      updatedAt: number;
    };

    const groups: Array<{
      key: string;
      hash: string | null;
      name: string | null;
      sizeBytes: number;
      count: number;
      wastedBytes: number;
      files: DupeFileRow[];
    }> = [];

    if (rawBy === 'hash') {
      const dupeHashes = sqlite
        .prepare(
          `SELECT hash, COUNT(*) as cnt
           FROM files
           WHERE is_trashed = 0 AND hash IS NOT NULL AND hash != '' ${poolClause}
           GROUP BY hash
           HAVING COUNT(*) > 1
           ORDER BY SUM(size_bytes) DESC, hash ASC`
        )
        .all(...poolParams) as Array<{ hash: string; cnt: number }>;

      const membersStmt = sqlite.prepare(
        `SELECT
           id,
           pool_id as poolId,
           virtual_path as virtualPath,
           name,
           size_bytes as sizeBytes,
           mime_type as mimeType,
           hash,
           account_id as accountId,
           folder_id as folderId,
           updated_at as updatedAt
         FROM files
         WHERE is_trashed = 0 AND hash = ? ${poolClause}
         ORDER BY pool_id ASC, virtual_path ASC`
      );

      for (const row of dupeHashes) {
        const members = membersStmt.all(row.hash, ...poolParams) as DupeFileRow[];
        const sizeBytes = members[0]?.sizeBytes ?? 0;
        const wastedBytes = Math.max(0, (members.length - 1) * sizeBytes);
        groups.push({
          key: row.hash,
          hash: row.hash,
          name: null,
          sizeBytes,
          count: members.length,
          wastedBytes,
          files: members,
        });
      }
    } else {
      const dupeKeys = sqlite
        .prepare(
          `SELECT name, size_bytes as sizeBytes, COUNT(*) as cnt
           FROM files
           WHERE is_trashed = 0 ${poolClause}
           GROUP BY name, size_bytes
           HAVING COUNT(*) > 1
           ORDER BY (COUNT(*) - 1) * size_bytes DESC, name ASC`
        )
        .all(...poolParams) as Array<{ name: string; sizeBytes: number; cnt: number }>;

      const membersStmt = sqlite.prepare(
        `SELECT
           id,
           pool_id as poolId,
           virtual_path as virtualPath,
           name,
           size_bytes as sizeBytes,
           mime_type as mimeType,
           hash,
           account_id as accountId,
           folder_id as folderId,
           updated_at as updatedAt
         FROM files
         WHERE is_trashed = 0 AND name = ? AND size_bytes = ? ${poolClause}
         ORDER BY pool_id ASC, virtual_path ASC`
      );

      for (const row of dupeKeys) {
        const members = membersStmt.all(row.name, row.sizeBytes, ...poolParams) as DupeFileRow[];
        const wastedBytes = Math.max(0, (members.length - 1) * row.sizeBytes);
        groups.push({
          key: `${row.name}:${row.sizeBytes}`,
          hash: null,
          name: row.name,
          sizeBytes: row.sizeBytes,
          count: members.length,
          wastedBytes,
          files: members,
        });
      }
    }

    const duplicateFileCount = groups.reduce((acc, g) => acc + g.count, 0);
    const wastedBytes = groups.reduce((acc, g) => acc + g.wastedBytes, 0);

    return c.json({
      by: rawBy,
      poolId: poolId ?? null,
      groupCount: groups.length,
      duplicateFileCount,
      wastedBytes,
      groups,
    });
  })
  .get('/api/files/:id/meta', (c) => {
    const fileId = c.req.param('id');
    const parsedPool = parseOptionalPoolId(c.req.query('poolId'));
    if (!parsedPool.ok) {
      return c.json({ error: INVALID_POOL_ID_ERROR, code: 'VALIDATION_ERROR' }, 400);
    }

    const row = (
      parsedPool.poolId !== undefined
        ? sqlite
            .prepare(
              `SELECT
                 id,
                 pool_id as poolId,
                 virtual_path as virtualPath,
                 name,
                 size_bytes as sizeBytes,
                 mime_type as mimeType,
                 hash,
                 account_id as accountId,
                 drive_file_id as driveFileId,
                 folder_id as folderId,
                 is_trashed as isTrashed,
                 trashed_at as trashedAt,
                 created_at as createdAt,
                 updated_at as updatedAt
               FROM files
               WHERE id = ? AND pool_id = ?
               LIMIT 1`
            )
            .get(fileId, parsedPool.poolId)
        : sqlite
            .prepare(
              `SELECT
                 id,
                 pool_id as poolId,
                 virtual_path as virtualPath,
                 name,
                 size_bytes as sizeBytes,
                 mime_type as mimeType,
                 hash,
                 account_id as accountId,
                 drive_file_id as driveFileId,
                 folder_id as folderId,
                 is_trashed as isTrashed,
                 trashed_at as trashedAt,
                 created_at as createdAt,
                 updated_at as updatedAt
               FROM files
               WHERE id = ?
               LIMIT 1`
            )
            .get(fileId)
    ) as
      | {
          id: string;
          poolId: number;
          virtualPath: string;
          name: string;
          sizeBytes: number;
          mimeType: string;
          hash: string | null;
          accountId: string;
          driveFileId: string;
          folderId: string | null;
          isTrashed: number;
          trashedAt: number | null;
          createdAt: number;
          updatedAt: number;
        }
      | undefined;

    if (!row) {
      return c.json({ error: `File '${fileId}' not found`, code: 'NOT_FOUND' }, 404);
    }

    return c.json({
      file: {
        ...row,
        isTrashed: Boolean(row.isTrashed),
      },
    });
  })
  .get('/api/items/stat', (c) => {
    const poolId = parsePoolIdWithDefault(c.req.query('poolId'), 1);
    if (poolId === null) {
      return c.json({ error: INVALID_POOL_ID_ERROR, code: 'VALIDATION_ERROR' }, 400);
    }
    const rawPath = c.req.query('path');
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      return c.json({ error: 'path query parameter is required', code: 'VALIDATION_ERROR' }, 400);
    }
    const normPath = normalizeVirtualPath(rawPath);

    if (normPath === '/') {
      return c.json({
        kind: 'folder' as const,
        item: {
          id: null,
          poolId,
          virtualPath: '/',
          name: '/',
          parentFolderId: null,
          createdAt: null,
          updatedAt: null,
        },
      });
    }

    const fileRow = sqlite
      .prepare(
        `SELECT
           id,
           pool_id as poolId,
           virtual_path as virtualPath,
           name,
           size_bytes as sizeBytes,
           mime_type as mimeType,
           hash,
           account_id as accountId,
           drive_file_id as driveFileId,
           folder_id as folderId,
           is_trashed as isTrashed,
           trashed_at as trashedAt,
           created_at as createdAt,
           updated_at as updatedAt
         FROM files
         WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0
         LIMIT 1`
      )
      .get(poolId, normPath) as
      | {
          id: string;
          poolId: number;
          virtualPath: string;
          name: string;
          sizeBytes: number;
          mimeType: string;
          hash: string | null;
          accountId: string;
          driveFileId: string;
          folderId: string | null;
          isTrashed: number;
          trashedAt: number | null;
          createdAt: number;
          updatedAt: number;
        }
      | undefined;

    if (fileRow) {
      return c.json({
        kind: 'file' as const,
        item: {
          ...fileRow,
          isTrashed: Boolean(fileRow.isTrashed),
        },
      });
    }

    const folderRow = sqlite
      .prepare(
        `SELECT
           id,
           pool_id as poolId,
           virtual_path as virtualPath,
           name,
           parent_folder_id as parentFolderId,
           created_at as createdAt,
           updated_at as updatedAt
         FROM folders
         WHERE pool_id = ? AND virtual_path = ?
         LIMIT 1`
      )
      .get(poolId, normPath) as
      | {
          id: string;
          poolId: number;
          virtualPath: string;
          name: string;
          parentFolderId: string | null;
          createdAt: number;
          updatedAt: number;
        }
      | undefined;

    if (folderRow) {
      return c.json({
        kind: 'folder' as const,
        item: folderRow,
      });
    }

    return c.json({ error: `Path '${normPath}' not found in pool ${poolId}`, code: 'NOT_FOUND' }, 404);
  })
  .get('/api/items/find', (c) => {
    const poolId = parsePoolIdWithDefault(c.req.query('poolId'), 1);
    if (poolId === null) {
      return c.json({ error: INVALID_POOL_ID_ERROR, code: 'VALIDATION_ERROR' }, 400);
    }

    const q = c.req.query('q')?.trim() ?? '';
    const glob = c.req.query('glob')?.trim() ?? '';
    const rawPath = c.req.query('path')?.trim() || '/';
    const normPath = normalizeVirtualPath(rawPath);
    const recursive = c.req.query('recursive') !== 'false' && c.req.query('recursive') !== '0';
    const afterPath = c.req.query('afterPath')?.trim() || '';

    const rawLimit = c.req.query('limit');
    let limit = 100;
    if (rawLimit !== undefined && rawLimit !== '') {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1000) {
        return c.json({ error: 'limit must be an integer between 1 and 1000', code: 'VALIDATION_ERROR' }, 400);
      }
      limit = parsed;
    }

    const globRegex = glob ? compileGlobRegex(glob) : null;
    const qLower = q.toLowerCase();

    const matchesFilter = (name: string, virtualPath: string): boolean => {
      if (qLower) {
        if (!name.toLowerCase().includes(qLower) && !virtualPath.toLowerCase().includes(qLower)) {
          return false;
        }
      }
      if (globRegex) {
        if (!globRegex.test(name) && !globRegex.test(virtualPath)) {
          return false;
        }
      }
      return true;
    };

    type FindItem = {
      kind: 'folder' | 'file';
      id: string;
      poolId: number;
      virtualPath: string;
      name: string;
      sizeBytes: number | null;
      mimeType: string | null;
      accountId: string | null;
      updatedAt: number;
    };

    let folderRows: Array<{
      id: string;
      poolId: number;
      virtualPath: string;
      name: string;
      updatedAt: number;
    }>;
    let fileRows: Array<{
      id: string;
      poolId: number;
      virtualPath: string;
      name: string;
      sizeBytes: number;
      mimeType: string;
      accountId: string;
      updatedAt: number;
    }>;

    if (!recursive) {
      const targetFolderId = normPath === '/' ? null : formatFolderId(poolId, normPath);
      folderRows = sqlite
        .prepare(
          `SELECT id, pool_id as poolId, virtual_path as virtualPath, name, updated_at as updatedAt
           FROM folders
           WHERE pool_id = ? AND ${targetFolderId === null ? 'parent_folder_id IS NULL' : 'parent_folder_id = ?'}
             ${afterPath ? 'AND virtual_path > ?' : ''}
           ORDER BY virtual_path ASC`
        )
        .all(
          ...(targetFolderId === null
            ? afterPath
              ? [poolId, afterPath]
              : [poolId]
            : afterPath
              ? [poolId, targetFolderId, afterPath]
              : [poolId, targetFolderId])
        ) as typeof folderRows;

      fileRows = sqlite
        .prepare(
          `SELECT id, pool_id as poolId, virtual_path as virtualPath, name, size_bytes as sizeBytes, mime_type as mimeType, account_id as accountId, updated_at as updatedAt
           FROM files
           WHERE pool_id = ? AND is_trashed = 0 AND ${targetFolderId === null ? 'folder_id IS NULL' : 'folder_id = ?'}
             ${afterPath ? 'AND virtual_path > ?' : ''}
           ORDER BY virtual_path ASC`
        )
        .all(
          ...(targetFolderId === null
            ? afterPath
              ? [poolId, afterPath]
              : [poolId]
            : afterPath
              ? [poolId, targetFolderId, afterPath]
              : [poolId, targetFolderId])
        ) as typeof fileRows;
    } else if (normPath !== '/') {
      const { lower, upper } = buildDirectoryPrefixBounds(normPath);
      const effectiveLower = afterPath && afterPath > lower ? afterPath : lower;
      const cmp = afterPath && afterPath >= lower ? '>' : '>=';

      folderRows = sqlite
        .prepare(
          `SELECT id, pool_id as poolId, virtual_path as virtualPath, name, updated_at as updatedAt
           FROM folders
           WHERE pool_id = ? AND virtual_path ${cmp} ? AND virtual_path < ?
           ORDER BY virtual_path ASC`
        )
        .all(poolId, effectiveLower, upper) as typeof folderRows;

      fileRows = sqlite
        .prepare(
          `SELECT id, pool_id as poolId, virtual_path as virtualPath, name, size_bytes as sizeBytes, mime_type as mimeType, account_id as accountId, updated_at as updatedAt
           FROM files
           WHERE pool_id = ? AND is_trashed = 0 AND virtual_path ${cmp} ? AND virtual_path < ?
           ORDER BY virtual_path ASC`
        )
        .all(poolId, effectiveLower, upper) as typeof fileRows;
    } else {
      folderRows = sqlite
        .prepare(
          `SELECT id, pool_id as poolId, virtual_path as virtualPath, name, updated_at as updatedAt
           FROM folders
           WHERE pool_id = ? ${afterPath ? 'AND virtual_path > ?' : ''}
           ORDER BY virtual_path ASC`
        )
        .all(...(afterPath ? [poolId, afterPath] : [poolId])) as typeof folderRows;

      fileRows = sqlite
        .prepare(
          `SELECT id, pool_id as poolId, virtual_path as virtualPath, name, size_bytes as sizeBytes, mime_type as mimeType, account_id as accountId, updated_at as updatedAt
           FROM files
           WHERE pool_id = ? AND is_trashed = 0 ${afterPath ? 'AND virtual_path > ?' : ''}
           ORDER BY virtual_path ASC`
        )
        .all(...(afterPath ? [poolId, afterPath] : [poolId])) as typeof fileRows;
    }

    const merged: FindItem[] = [];
    for (const f of folderRows) {
      if (matchesFilter(f.name, f.virtualPath)) {
        merged.push({
          kind: 'folder',
          id: f.id,
          poolId: f.poolId,
          virtualPath: f.virtualPath,
          name: f.name,
          sizeBytes: null,
          mimeType: null,
          accountId: null,
          updatedAt: f.updatedAt,
        });
      }
    }
    for (const f of fileRows) {
      if (matchesFilter(f.name, f.virtualPath)) {
        merged.push({
          kind: 'file',
          id: f.id,
          poolId: f.poolId,
          virtualPath: f.virtualPath,
          name: f.name,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          accountId: f.accountId,
          updatedAt: f.updatedAt,
        });
      }
    }

    merged.sort((a, b) => {
      if (a.virtualPath < b.virtualPath) return -1;
      if (a.virtualPath > b.virtualPath) return 1;
      return a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1;
    });

    const hasMore = merged.length > limit;
    const items = hasMore ? merged.slice(0, limit) : merged;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].virtualPath : null;

    return c.json({
      poolId,
      path: normPath,
      items,
      nextCursor,
      hasMore,
    });
  });

function compileGlobRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexBody = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${regexBody}$`, 'i');
}

export default router;
