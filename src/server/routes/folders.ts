import path from 'node:path';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { eq, and } from 'drizzle-orm';
import { db, bumpPoolRevision } from '../db/index.js';
import { files, folders } from '../db/schema.js';
import {
  validateItemName,
  trashFolder,
  ensureLocalFolderPath,
  formatFolderId,
  isSharePoolId,
} from '../drive/index.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import {
  INVALID_POOL_ID_ERROR,
  parsePoolIdWithDefault,
  parseOptionalPoolId,
  sharePoolReadOnlyError,
  checkPoolEtag,
  mapDomainErrorToResponse,
  projectedFolderColumns,
} from './shared.js';

const router = new Hono()
  .get('/api/folders', async (c) => {
    const poolId = parsePoolIdWithDefault(c.req.query('poolId'), 1);
    if (poolId === null) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }

    if (checkPoolEtag(c, `folders-${poolId}`, poolId)) {
      return c.body(null, 304);
    }

    const folderRecords = await db.select(projectedFolderColumns).from(folders).where(eq(folders.poolId, poolId));
    return c.json({ folders: folderRecords }, 200);
  })
  .post(
    '/api/folders',
    validator('json', (value, c): { virtualPath: string; name: string; poolId?: number } | Response => {
      const body = value as Record<string, unknown>;
      if (typeof body?.virtualPath !== 'string' || typeof body?.name !== 'string') {
        return c.json({ error: 'virtualPath (string) and name (string) are required' }, 400);
      }
      const parsedPool = parseOptionalPoolId(body?.poolId);
      if (!parsedPool.ok) {
        return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
      }
      return {
        virtualPath: body.virtualPath,
        name: body.name,
        poolId: parsedPool.poolId,
      };
    }),
    async (c) => {
      const { virtualPath, name, poolId = 1 } = c.req.valid('json');
      if (isSharePoolId(poolId)) {
        return c.json(sharePoolReadOnlyError('Creating folders directly in Share Pool is disabled'), 403);
      }
      let trimmedName: string;
      try {
        trimmedName = validateItemName(name);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Invalid folder name' }, 400);
      }
      const normalizedPath = normalizeVirtualPath(virtualPath);
      if (normalizedPath === '/') {
        return c.json({ error: 'Invalid folder path' }, 400);
      }
      try {
        for (const segment of normalizedPath.split('/').filter(Boolean)) {
          validateItemName(segment);
        }
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Invalid folder path' }, 400);
      }
      if (path.posix.basename(normalizedPath) !== trimmedName) {
        return c.json({ error: 'Folder name does not match the basename of virtualPath' }, 400);
      }
      try {
        const existing = await db.query.folders.findFirst({
          where: and(
            eq(folders.poolId, poolId),
            eq(folders.virtualPath, normalizedPath)
          ),
        });
        if (existing) {
          return c.json(
            {
              error: `A folder named "${trimmedName}" already exists in this directory`,
              code: 'FOLDER_EXISTS',
            },
            409
          );
        }
        const collidingFile = await db.query.files.findFirst({
          where: and(
            eq(files.poolId, poolId),
            eq(files.virtualPath, normalizedPath),
            eq(files.isTrashed, false)
          ),
        });
        if (collidingFile) {
          return c.json(
            {
              error: `A file named "${trimmedName}" already exists in this directory`,
              code: 'ITEM_EXISTS',
            },
            409
          );
        }
        ensureLocalFolderPath(normalizedPath, poolId);
        bumpPoolRevision(poolId);
        return c.json(
          { id: formatFolderId(poolId, normalizedPath), poolId, virtualPath: normalizedPath, name: trimmedName },
          201
        );
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .delete(
    '/api/folders',
    validator('query', (value): { virtualPath?: string; path?: string; id?: string; poolId?: string } => {
      return {
        virtualPath: typeof value.virtualPath === 'string' ? value.virtualPath : undefined,
        path: typeof value.path === 'string' ? value.path : undefined,
        id: typeof value.id === 'string' ? value.id : undefined,
        poolId: typeof value.poolId === 'string' ? value.poolId : undefined,
      };
    }),
    async (c) => {
      const query = c.req.valid('query');
      const poolId = parsePoolIdWithDefault(query.poolId, 1);
      if (poolId === null) {
        return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
      }

      const rawPath = query.virtualPath || query.path;
      let normalizedPath: string;
      if (rawPath) {
        normalizedPath = normalizeVirtualPath(rawPath);
      } else if (query.id) {
        const folderRow = await db.query.folders.findFirst({
          where: and(eq(folders.id, query.id), eq(folders.poolId, poolId)),
          columns: { virtualPath: true },
        });
        if (!folderRow) {
          return c.json({ error: 'Folder not found', code: 'NOT_FOUND' }, 404);
        }
        normalizedPath = folderRow.virtualPath;
      } else {
        return c.json({ error: 'virtualPath query parameter required' }, 400);
      }

      if (normalizedPath === '/') {
        return c.json({ error: 'Cannot delete root folder' }, 400);
      }

      try {
        const result = await trashFolder(normalizedPath, poolId);
        return c.json({ success: true, virtualPath: normalizedPath, trashedCount: result.trashedFilesCount });
      } catch (err) {
        return mapDomainErrorToResponse(c, err);
      }
    }
  );

export default router;
