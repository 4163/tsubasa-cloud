import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { sqlite } from '../db/index.js';
import { getPoolDriveFolderName } from '../drive/index.js';
import { deriveUniquePoolSlug, validatePoolSlug } from '../storage/poolSlug.js';
import { INVALID_POOL_ID_ERROR, parseStrictPoolId } from './shared.js';

const router = new Hono()
  .get('/api/pools', async (c) => {
    const allPools = sqlite
      .prepare(
        `SELECT
           p.id,
           p.name,
           p.slug,
           p.sort_order as sortOrder,
           p.drive_folder_name as driveFolderName,
           p.is_share_pool as isSharePool,
           COALESCE(acc.cnt, 0) as accountCount,
           COALESCE(fil.cnt, 0) as fileCount,
           COALESCE(fil.total_bytes, 0) as totalBytes
         FROM pools p
         LEFT JOIN (SELECT pool_id, COUNT(*) as cnt FROM accounts GROUP BY pool_id) acc ON acc.pool_id = p.id
         LEFT JOIN (SELECT pool_id, COUNT(*) as cnt, SUM(size_bytes) as total_bytes FROM files WHERE is_trashed = 0 GROUP BY pool_id) fil ON fil.pool_id = p.id
         ORDER BY p.is_share_pool ASC, p.sort_order ASC, p.id ASC`
      )
      .all() as Array<{
      id: number;
      name: string;
      slug: string;
      sortOrder: number;
      driveFolderName: string;
      isSharePool: number;
      accountCount: number;
      fileCount: number;
      totalBytes: number;
    }>;
    return c.json({
      pools: allPools.map((r) => ({
        ...r,
        isSharePool: Boolean(r.isSharePool),
      })),
    });
  })
  .post(
    '/api/pools',
    validator('json', (value, c): { name?: string; slug?: string } | Response => {
      const body = value as Record<string, unknown> | null | undefined;
      const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
      let slug: string | undefined;
      if (body?.slug !== undefined) {
        const validated = validatePoolSlug(body.slug);
        if (!validated.ok) {
          return c.json({ error: validated.error, code: validated.code }, 400);
        }
        slug = validated.slug;
      }
      return { name, slug };
    }),
    async (c) => {
      const { name, slug } = c.req.valid('json');
      const created = sqlite
        .transaction(() => {
          if (slug !== undefined) {
            const existingSlug = sqlite
              .prepare('SELECT id FROM pools WHERE slug = ? LIMIT 1')
              .get(slug) as { id: number } | undefined;
            if (existingSlug) {
              return { conflict: true as const };
            }
          }

          const maxRow = sqlite
            .prepare('SELECT MAX(id) as maxId FROM pools WHERE is_share_pool = 0')
            .get() as { maxId: number | null } | undefined;
          let nextId = (maxRow?.maxId ?? 0) + 1;
          while (sqlite.prepare('SELECT 1 FROM pools WHERE id = ? LIMIT 1').get(nextId)) {
            nextId += 1;
          }
          const poolName = name || `Pool ${nextId}`;
          const driveFolderName = getPoolDriveFolderName(nextId);

          const resolvedSlug =
            slug ??
            deriveUniquePoolSlug(
              poolName,
              (
                sqlite
                  .prepare('SELECT slug FROM pools WHERE slug IS NOT NULL')
                  .all() as Array<{ slug: string }>
              ).map((row) => row.slug),
              nextId
            );

          const maxSortRow = sqlite
            .prepare('SELECT MAX(sort_order) as maxSort FROM pools WHERE is_share_pool = 0')
            .get() as { maxSort: number | null } | undefined;
          const sortOrder = (maxSortRow?.maxSort ?? 0) + 1;

          sqlite
            .prepare(
              'INSERT INTO pools (id, name, slug, sort_order, drive_folder_name) VALUES (?, ?, ?, ?, ?)'
            )
            .run(nextId, poolName, resolvedSlug, sortOrder, driveFolderName);

          return {
            conflict: false as const,
            id: nextId,
            name: poolName,
            slug: resolvedSlug,
            sortOrder,
            driveFolderName,
          };
        })
        .immediate();

      if (created.conflict) {
        return c.json({ error: `Pool slug '${slug}' is already in use`, code: 'ITEM_EXISTS' }, 409);
      }

      return c.json(
        {
          id: created.id,
          name: created.name,
          slug: created.slug,
          sortOrder: created.sortOrder,
          driveFolderName: created.driveFolderName,
          isSharePool: false,
          accountCount: 0,
          fileCount: 0,
          totalBytes: 0,
        },
        201
      );
    }
  )
  .patch(
    '/api/pools/:id',
    validator('json', (value, c): { name: string; slug?: string } | Response => {
      const body = value as Record<string, unknown> | null | undefined;
      if (typeof body?.name !== 'string' || !body.name.trim()) {
        return c.json({ error: 'name (string) is required' }, 400);
      }
      let slug: string | undefined;
      if (body?.slug !== undefined) {
        const validated = validatePoolSlug(body.slug);
        if (!validated.ok) {
          return c.json({ error: validated.error, code: validated.code }, 400);
        }
        slug = validated.slug;
      }
      return { name: body.name.trim(), slug };
    }),
    async (c) => {
      const poolId = parseStrictPoolId(c.req.param('id'));
      if (poolId === null) {
        return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
      }
      const { name, slug } = c.req.valid('json');

      const result = sqlite
        .transaction(() => {
          const existing = sqlite
            .prepare(
              'SELECT id, name, slug, sort_order as sortOrder, drive_folder_name as driveFolderName, is_share_pool as isSharePool FROM pools WHERE id = ?'
            )
            .get(poolId) as
            | {
                id: number;
                name: string;
                slug: string;
                sortOrder: number;
                driveFolderName: string;
                isSharePool: number;
              }
            | undefined;

          if (!existing) {
            return { status: 'not_found' as const };
          }
          if (Boolean(existing.isSharePool)) {
            return { status: 'share_protected' as const };
          }

          const nextSlug = slug ?? existing.slug;
          if (slug !== undefined && slug !== existing.slug) {
            const conflict = sqlite
              .prepare('SELECT id FROM pools WHERE slug = ? AND id != ? LIMIT 1')
              .get(slug, poolId) as { id: number } | undefined;
            if (conflict) {
              return { status: 'slug_conflict' as const };
            }
            sqlite
              .prepare('UPDATE pools SET name = ?, slug = ?, updated_at = unixepoch() WHERE id = ?')
              .run(name, nextSlug, poolId);
          } else {
            sqlite
              .prepare('UPDATE pools SET name = ?, updated_at = unixepoch() WHERE id = ?')
              .run(name, poolId);
          }

          return {
            status: 'ok' as const,
            id: poolId,
            name,
            slug: nextSlug,
            sortOrder: existing.sortOrder,
            driveFolderName: existing.driveFolderName,
            isSharePool: Boolean(existing.isSharePool),
          };
        })
        .immediate();

      if (result.status === 'not_found') {
        return c.json({ error: `Pool ${poolId} not found` }, 404);
      }
      if (result.status === 'share_protected') {
        return c.json(
          { error: 'Share Pool cannot be renamed or modified', code: 'SHARE_POOL_PROTECTED' },
          403
        );
      }
      if (result.status === 'slug_conflict') {
        return c.json({ error: `Pool slug '${slug}' is already in use`, code: 'ITEM_EXISTS' }, 409);
      }

      return c.json({
        id: result.id,
        name: result.name,
        slug: result.slug,
        sortOrder: result.sortOrder,
        driveFolderName: result.driveFolderName,
        isSharePool: result.isSharePool,
      });
    }
  )
  .delete('/api/pools/:id', async (c) => {
    const poolId = parseStrictPoolId(c.req.param('id'));
    if (poolId === null) {
      return c.json({ error: INVALID_POOL_ID_ERROR }, 400);
    }

    const existing = sqlite
      .prepare('SELECT id, name, drive_folder_name as driveFolderName, is_share_pool as isSharePool FROM pools WHERE id = ?')
      .get(poolId) as { id: number; name: string; driveFolderName: string; isSharePool: number } | undefined;
    if (!existing) {
      return c.json({ error: `Pool ${poolId} not found` }, 404);
    }

    if (Boolean(existing.isSharePool)) {
      return c.json(
        { error: 'Share Pool cannot be deleted', code: 'SHARE_POOL_PROTECTED' },
        403
      );
    }

    const totalPoolsRow = sqlite.prepare('SELECT count(*) as count FROM pools WHERE is_share_pool = 0').get() as
      | { count: number }
      | undefined;
    if ((totalPoolsRow?.count ?? 0) <= 1) {
      return c.json({ error: 'Cannot delete the only remaining storage pool', code: 'LAST_POOL' }, 409);
    }

    const accCountRow = sqlite
      .prepare('SELECT count(*) as count FROM accounts WHERE pool_id = ?')
      .get(poolId) as { count: number } | undefined;
    if ((accCountRow?.count ?? 0) > 0) {
      return c.json({ error: 'Cannot delete pool: pool contains accounts', code: 'POOL_NOT_EMPTY' }, 409);
    }

    const fileCountRow = sqlite
      .prepare('SELECT count(*) as count FROM files WHERE pool_id = ?')
      .get(poolId) as { count: number } | undefined;
    if ((fileCountRow?.count ?? 0) > 0) {
      return c.json({ error: 'Cannot delete pool: pool contains files', code: 'POOL_NOT_EMPTY' }, 409);
    }

    sqlite.prepare('DELETE FROM folders WHERE pool_id = ?').run(poolId);
    sqlite.prepare('DELETE FROM pools WHERE id = ?').run(poolId);

    return c.json({
      success: true,
      id: poolId,
      name: existing.name,
    });
  });

export default router;
