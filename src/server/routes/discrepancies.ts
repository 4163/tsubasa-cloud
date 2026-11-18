import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { bumpPoolRevision } from '../db/index.js';
import {
  scanAccountDiscrepancies,
  acceptExternalFile,
  acceptAllExternalFiles,
  ejectAllExternalFiles,
  ejectFileToDriveRoot,
  removeMissingFile,
  resolvePathConflict,
  resolvePathConflictsBatch,
  type ConflictResolutionAction,
  type PreScannedBatchItem,
} from '../drive/index.js';
import {
  getAccountPoolId,
  isAccountInSharePool,
  mapDomainErrorToResponse,
  sharePoolReadOnlyError,
} from './shared.js';

const router = new Hono()
  .get(
    '/api/sync/external-changes/:accountId',
    validator('query', (value): { refresh?: string } => ({
      refresh: typeof value.refresh === 'string' ? value.refresh : undefined,
    })),
    async (c) => {
      const accountId = c.req.param('accountId');
      const { refresh } = c.req.valid('query');
      const forceRefresh = refresh === '1' || refresh === 'true';
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const report = await scanAccountDiscrepancies(accountId, forceRefresh);
        return c.json(report);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/sync/resolve/accept',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            accountId: string;
            driveFileId: string;
            targetVirtualPath?: string;
            name?: string;
            sizeBytes?: number;
            mimeType?: string;
            hash?: string | null;
          }
        | Response => {
        const body = value as Record<string, unknown>;
        if (typeof body?.accountId !== 'string' || typeof body?.driveFileId !== 'string') {
          return c.json({ error: 'accountId and driveFileId required' }, 400);
        }
        return {
          accountId: body.accountId,
          driveFileId: body.driveFileId,
          targetVirtualPath: typeof body.targetVirtualPath === 'string' ? body.targetVirtualPath : undefined,
          name: typeof body.name === 'string' ? body.name : undefined,
          sizeBytes: typeof body.sizeBytes === 'number' && Number.isFinite(body.sizeBytes) ? body.sizeBytes : undefined,
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
          hash: typeof body.hash === 'string' || body.hash === null ? body.hash : undefined,
        };
      }
    ),
    async (c) => {
      const { accountId, driveFileId, targetVirtualPath, name, sizeBytes, mimeType, hash } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const preScanned =
          name !== undefined || sizeBytes !== undefined || mimeType !== undefined || hash !== undefined
            ? { name, sizeBytes, mimeType, hash }
            : undefined;
        const record = await acceptExternalFile(accountId, driveFileId, targetVirtualPath, preScanned);
        bumpPoolRevision(record.poolId);
        return c.json(record);
      } catch (err) {
        return mapDomainErrorToResponse(c, err);
      }
    }
  )
  .post(
    '/api/sync/resolve/accept-all',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            accountId: string;
            items?: PreScannedBatchItem[];
          }
        | Response => {
        const body = value as Record<string, unknown>;
        if (typeof body?.accountId !== 'string') {
          return c.json({ error: 'accountId required' }, 400);
        }
        let items: PreScannedBatchItem[] | undefined;
        if (Array.isArray(body.items)) {
          items = [];
          for (const raw of body.items) {
            if (!raw || typeof raw !== 'object') {
              return c.json({ error: 'Invalid item in items array' }, 400);
            }
            const rec = raw as Record<string, unknown>;
            if (
              typeof rec.driveFileId !== 'string' ||
              typeof rec.virtualPath !== 'string' ||
              typeof rec.sizeBytes !== 'number' ||
              !Number.isFinite(rec.sizeBytes)
            ) {
              return c.json({ error: 'Each item requires driveFileId, virtualPath, and sizeBytes' }, 400);
            }
            items.push({
              driveFileId: rec.driveFileId,
              virtualPath: rec.virtualPath,
              sizeBytes: rec.sizeBytes,
              mimeType: typeof rec.mimeType === 'string' ? rec.mimeType : undefined,
              hash: typeof rec.hash === 'string' || rec.hash === null ? rec.hash : undefined,
            });
          }
        }
        return { accountId: body.accountId, items };
      }
    ),
    async (c) => {
      const { accountId, items } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const result = await acceptAllExternalFiles(accountId, items);
        bumpPoolRevision(getAccountPoolId(accountId));
        return c.json(result);
      } catch (err) {
        return mapDomainErrorToResponse(c, err);
      }
    }
  )
  .post(
    '/api/sync/resolve/eject-all',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (typeof body?.accountId !== 'string') {
        return c.json({ error: 'accountId required' }, 400);
      }
      return { accountId: body.accountId };
    }),
    async (c) => {
      const { accountId } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const result = await ejectAllExternalFiles(accountId);
        bumpPoolRevision(getAccountPoolId(accountId));
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/sync/resolve/conflict',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            accountId: string;
            driveFileId: string;
            resolution: ConflictResolutionAction;
            targetVirtualPath?: string;
          }
        | Response => {
        const body = value as Record<string, unknown>;
        const resolution = body?.resolution;
        if (
          typeof body?.accountId !== 'string' ||
          typeof body?.driveFileId !== 'string' ||
          (resolution !== 'keep_both' &&
            resolution !== 'deduplicate' &&
            resolution !== 'replace_existing' &&
            resolution !== 'eject')
        ) {
          return c.json(
            {
              error:
                'accountId, driveFileId, and valid resolution (keep_both | deduplicate | replace_existing | eject) required',
            },
            400
          );
        }
        return {
          accountId: body.accountId,
          driveFileId: body.driveFileId,
          resolution,
          targetVirtualPath: typeof body.targetVirtualPath === 'string' ? body.targetVirtualPath : undefined,
        };
      }
    ),
    async (c) => {
      const { accountId, driveFileId, resolution, targetVirtualPath } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('Conflict resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const res = await resolvePathConflict(accountId, driveFileId, resolution, targetVirtualPath);
        bumpPoolRevision(getAccountPoolId(accountId));
        return c.json(res);
      } catch (err) {
        return mapDomainErrorToResponse(c, err);
      }
    }
  )
  .post(
    '/api/sync/resolve/conflicts-batch',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            accountId: string;
            items: Array<{ driveFileId: string; targetVirtualPath?: string }>;
            resolution: 'keep_both' | 'deduplicate';
          }
        | Response => {
        const body = value as Record<string, unknown>;
        const resolution = body?.resolution;
        if (
          typeof body?.accountId !== 'string' ||
          !Array.isArray(body?.items) ||
          (resolution !== 'keep_both' && resolution !== 'deduplicate')
        ) {
          return c.json(
            {
              error: 'accountId, items array, and valid resolution (keep_both | deduplicate) required',
            },
            400
          );
        }
        const items: Array<{ driveFileId: string; targetVirtualPath?: string }> = [];
        for (const raw of body.items) {
          if (!raw || typeof raw !== 'object') {
            return c.json({ error: 'Invalid item in items array' }, 400);
          }
          const rec = raw as Record<string, unknown>;
          if (typeof rec.driveFileId !== 'string') {
            return c.json({ error: 'Each item requires driveFileId (string)' }, 400);
          }
          items.push({
            driveFileId: rec.driveFileId,
            targetVirtualPath: typeof rec.targetVirtualPath === 'string' ? rec.targetVirtualPath : undefined,
          });
        }
        return {
          accountId: body.accountId,
          items,
          resolution,
        };
      }
    ),
    async (c) => {
      const { accountId, items, resolution } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('Conflict resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        const res = await resolvePathConflictsBatch(accountId, items, resolution);
        bumpPoolRevision(getAccountPoolId(accountId));
        return c.json(res);
      } catch (err) {
        return mapDomainErrorToResponse(c, err);
      }
    }
  )
  .post(
    '/api/sync/resolve/move-to-root',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (typeof body?.accountId !== 'string' || typeof body?.driveFileId !== 'string') {
        return c.json({ error: 'accountId and driveFileId required' }, 400);
      }
      return { accountId: body.accountId, driveFileId: body.driveFileId };
    }),
    async (c) => {
      const { accountId, driveFileId } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        await ejectFileToDriveRoot(accountId, driveFileId);
        bumpPoolRevision(getAccountPoolId(accountId));
        return c.json({ success: true, accountId, driveFileId });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  )
  .post(
    '/api/sync/resolve/remove-missing',
    validator('json', (value, c) => {
      const body = value as Record<string, unknown>;
      if (typeof body?.accountId !== 'string' || typeof body?.driveFileId !== 'string') {
        return c.json({ error: 'accountId and driveFileId required' }, 400);
      }
      return { accountId: body.accountId, driveFileId: body.driveFileId };
    }),
    async (c) => {
      const { accountId, driveFileId } = c.req.valid('json');
      if (isAccountInSharePool(accountId)) {
        return c.json(
          sharePoolReadOnlyError('External change resolution is disabled for Share Pool accounts'),
          403
        );
      }
      try {
        await removeMissingFile(accountId, driveFileId);
        bumpPoolRevision(getAccountPoolId(accountId));
        return c.json({ success: true, accountId, driveFileId });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
  );

export default router;
