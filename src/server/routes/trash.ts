import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { files } from '../db/schema.js';
import { trashFile, restoreFile, purgeFile, emptyTrash } from '../drive/index.js';
import {
  INVALID_POOL_ID_ERROR,
  parsePoolIdWithDefault,
  checkPoolEtag,
  mapDomainErrorToResponse,
  projectedFileColumns,
} from './shared.js';

const router = new Hono()
  .post('/api/files/:id/trash', async (c) => {
    const fileId = c.req.param('id');
    try {
      const updated = await trashFile(fileId);
      return c.json(updated);
    } catch (err) {
      return mapDomainErrorToResponse(c, err);
    }
  })
  .post('/api/files/:id/restore', async (c) => {
    const fileId = c.req.param('id');
    try {
      const updated = await restoreFile(fileId);
      return c.json(updated);
    } catch (err) {
      return mapDomainErrorToResponse(c, err);
    }
  })
  .delete('/api/files/:id/permanent', async (c) => {
    const fileId = c.req.param('id');
    try {
      const purged = await purgeFile(fileId);
      return c.json(purged);
    } catch (err) {
      return mapDomainErrorToResponse(c, err);
    }
  })
  .delete('/api/trash/empty', async (c) => {
    const poolId = parsePoolIdWithDefault(c.req.query('poolId'), 1);
    if (poolId === null) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }
    try {
      const report = await emptyTrash(poolId);
      return c.json(report);
    } catch (err) {
      return mapDomainErrorToResponse(c, err);
    }
  })
  .get('/api/trash', async (c) => {
    const poolId = parsePoolIdWithDefault(c.req.query('poolId'), 1);
    if (poolId === null) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }

    if (checkPoolEtag(c, `trash-${poolId}`, poolId)) {
      return c.body(null, 304);
    }

    const trashedFiles = await db
      .select(projectedFileColumns)
      .from(files)
      .where(and(eq(files.poolId, poolId), eq(files.isTrashed, true)));
    return c.json({ files: trashedFiles }, 200);
  });

export default router;
