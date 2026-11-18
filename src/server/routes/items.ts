import { Hono } from 'hono';
import { validator } from 'hono/validator';
import {
  moveItems,
  type MoveConflictMode,
  copyItems,
  renameItem,
  validateItemName,
  isSharePoolId,
} from '../drive/index.js';
import {
  INVALID_POOL_ID_ERROR,
  parseOptionalPoolId,
  sharePoolReadOnlyError,
  MOVE_CONFLICT_MODES,
  parseConflictMode,
  mapDomainErrorToResponse,
  parseItemTargets,
} from './shared.js';

const router = new Hono()
  .post(
    '/api/items/move',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            items: Array<{ kind: 'file' | 'folder'; id: string }>;
            targetFolderPath: string;
            poolId?: number;
            conflictMode?: MoveConflictMode;
          }
        | Response => {
        const body = value as Record<string, unknown>;
        const items = parseItemTargets(body?.items);
        if (!items || typeof body?.targetFolderPath !== 'string') {
          return c.json(
            { error: 'items (non-empty array of { kind: "file" | "folder", id: string }) and targetFolderPath (string) are required' },
            400
          );
        }
        const parsedPool = parseOptionalPoolId(body?.poolId);
        if (!parsedPool.ok) {
          return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
        }
        const parsedMode = parseConflictMode(
          body?.conflictMode,
          MOVE_CONFLICT_MODES,
          'Invalid conflictMode: must be reject, skip, keep_both, or overwrite'
        );
        if (!parsedMode.ok) {
          return c.json({ error: parsedMode.error }, 400);
        }
        return {
          items,
          targetFolderPath: body.targetFolderPath,
          poolId: parsedPool.poolId,
          conflictMode: parsedMode.value,
        };
      }
    ),
    async (c) => {
      const { items, targetFolderPath, poolId = 1, conflictMode } = c.req.valid('json');
      if (isSharePoolId(poolId)) {
        return c.json(sharePoolReadOnlyError('Moving items inside Share Pool is disabled'), 403);
      }
      try {
        const result = await moveItems(items, targetFolderPath, poolId, conflictMode ?? 'reject');
        return c.json(result);
      } catch (err) {
        return mapDomainErrorToResponse(c, err);
      }
    }
  )
  .post(
    '/api/items/copy',
    validator(
      'json',
      (
        value,
        c
      ): { items: Array<{ kind: 'file' | 'folder'; id: string }>; targetFolderPath: string; poolId?: number } | Response => {
        const body = value as Record<string, unknown>;
        const items = parseItemTargets(body?.items);
        if (!items || typeof body?.targetFolderPath !== 'string') {
          return c.json(
            { error: 'items (non-empty array of { kind: "file" | "folder", id: string }) and targetFolderPath (string) are required' },
            400
          );
        }
        const parsedPool = parseOptionalPoolId(body?.poolId);
        if (!parsedPool.ok) {
          return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
        }
        return {
          items,
          targetFolderPath: body.targetFolderPath,
          poolId: parsedPool.poolId,
        };
      }
    ),
    async (c) => {
      const { items, targetFolderPath, poolId = 1 } = c.req.valid('json');
      if (isSharePoolId(poolId)) {
        return c.json(sharePoolReadOnlyError('Copying items inside Share Pool is disabled'), 403);
      }
      try {
        const result = await copyItems(items, targetFolderPath, poolId);
        return c.json(result);
      } catch (err) {
        return mapDomainErrorToResponse(c, err);
      }
    }
  )
  .post(
    '/api/items/rename',
    validator(
      'json',
      (
        value,
        c
      ): { kind: 'file' | 'folder'; id: string; name: string; poolId?: number } | Response => {
        const body = value as Record<string, unknown>;
        const candidateName =
          typeof body?.name === 'string' ? body.name : typeof body?.newName === 'string' ? body.newName : undefined;
        if (
          (body?.kind !== 'file' && body?.kind !== 'folder') ||
          typeof body?.id !== 'string' ||
          typeof candidateName !== 'string'
        ) {
          return c.json({ error: 'kind ("file"|"folder"), id (string), and name (string) are required' }, 400);
        }
        const parsedPool = parseOptionalPoolId(body?.poolId);
        if (!parsedPool.ok) {
          return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
        }
        return {
          kind: body.kind as 'file' | 'folder',
          id: body.id,
          name: candidateName.trim(),
          poolId: parsedPool.poolId,
        };
      }
    ),
    async (c) => {
      const { kind, id, name, poolId = 1 } = c.req.valid('json');
      if (isSharePoolId(poolId)) {
        return c.json(sharePoolReadOnlyError('Renaming items inside Share Pool is disabled'), 403);
      }
      let validatedName: string;
      try {
        validatedName = validateItemName(name);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Invalid name' }, 400);
      }
      try {
        const result = await renameItem(kind, id, validatedName, poolId);
        return c.json(result);
      } catch (err) {
        return mapDomainErrorToResponse(c, err);
      }
    }
  );

export default router;
