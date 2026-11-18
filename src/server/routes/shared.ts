import type { Context } from 'hono';
import { sqlite, getPoolRevision } from '../db/index.js';
import { files, folders } from '../db/schema.js';
import {
  UploadConflictError,
  UploadValidationError,
  SharePoolReadOnlyError,
  type UploadConflictMode,
  MoveConflictError,
  type MoveConflictMode,
  ItemConflictError,
  ItemNotFoundError,
  AccountPoolLockedError,
  isSharePoolId,
  RebalanceValidationError,
  ShareValidationError,
  SharePoolNotFoundError,
  type ShareTargetInput,
} from '../drive/index.js';
import {
  FileExceedsCeilingError,
  InsufficientStorageError,
} from '../storage/index.js';

export const INVALID_POOL_ID_ERROR = 'poolId must be a positive integer';

export function parseStrictPoolId(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

export function parsePoolIdWithDefault(raw: unknown, defaultValue = 1): number | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return defaultValue;
  }
  return parseStrictPoolId(raw);
}

export function parseOptionalPoolId(raw: unknown): { ok: true; poolId: number | undefined } | { ok: false } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, poolId: undefined };
  }
  const parsed = parseStrictPoolId(raw);
  if (parsed === null) return { ok: false };
  return { ok: true, poolId: parsed };
}

export function sharePoolReadOnlyError(message: string) {
  return { error: message, code: 'SHARE_POOL_READ_ONLY' } as const;
}

export const UPLOAD_CONFLICT_MODES: readonly UploadConflictMode[] = ['reject', 'replace', 'keep_both'];
export const MOVE_CONFLICT_MODES: readonly MoveConflictMode[] = ['reject', 'skip', 'keep_both', 'overwrite'];

export function parseConflictMode<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  errorMessage: string
): { ok: true; value: T | undefined } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    return { ok: false, error: errorMessage };
  }
  return { ok: true, value: raw as T };
}

export function checkPoolEtag(c: Context, key: string, poolId: number): boolean {
  const etag = `W/"${key}-r${getPoolRevision(poolId)}"`;
  c.header('ETag', etag);
  c.header('Cache-Control', 'no-cache');
  return c.req.header('if-none-match') === etag;
}

export function mapDomainErrorToResponse(c: Context, err: unknown) {
  if (err instanceof SharePoolReadOnlyError) {
    return c.json(sharePoolReadOnlyError(err.message), 403);
  }
  if (err instanceof UploadValidationError) {
    return c.json({ error: err.message }, 400);
  }
  if (err instanceof UploadConflictError || err instanceof ItemConflictError) {
    return c.json({ error: err.message, code: 'ITEM_EXISTS' }, 409);
  }
  if (err instanceof MoveConflictError) {
    return c.json(
      {
        error: err.message,
        code: 'MOVE_CONFLICT',
        conflicts: err.conflicts,
        cleanCount: err.cleanCount,
      },
      409
    );
  }
  if (err instanceof ItemNotFoundError || err instanceof SharePoolNotFoundError) {
    return c.json({ error: err.message, code: 'NOT_FOUND' }, 404);
  }
  if (err instanceof FileExceedsCeilingError) {
    return c.json({ error: err.message, code: 'EXCEEDS_CEILING' }, 400);
  }
  if (err instanceof InsufficientStorageError) {
    return c.json({ error: err.message, code: 'INSUFFICIENT_STORAGE' }, 507);
  }
  if (err instanceof AccountPoolLockedError) {
    return c.json({ error: err.message, code: 'ACCOUNT_POOL_LOCKED' }, 409);
  }
  if (err instanceof RebalanceValidationError || err instanceof ShareValidationError) {
    return c.json({ error: err.message, code: 'VALIDATION_ERROR' }, 400);
  }
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
}

export function getAccountPoolId(accountId: string): number | undefined {
  const acc = sqlite.prepare('SELECT pool_id as poolId FROM accounts WHERE id = ? LIMIT 1').get(accountId) as
    | { poolId: number }
    | undefined;
  return acc?.poolId;
}

export function isAccountInSharePool(accountId: string): boolean {
  const poolId = getAccountPoolId(accountId);
  return poolId !== undefined && isSharePoolId(poolId);
}

export function buildContentDisposition(filename: string): string {
  const asciiSafe =
    filename
      .replace(/[\r\n"\\]/g, '_')
      .replace(/[^\x20-\x7E]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(
    /['()*!]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`;
}

export const projectedFileColumns = {
  id: files.id,
  poolId: files.poolId,
  virtualPath: files.virtualPath,
  name: files.name,
  sizeBytes: files.sizeBytes,
  mimeType: files.mimeType,
  accountId: files.accountId,
  folderId: files.folderId,
  isTrashed: files.isTrashed,
  trashedAt: files.trashedAt,
  createdAt: files.createdAt,
  updatedAt: files.updatedAt,
};

export const projectedFolderColumns = {
  id: folders.id,
  poolId: folders.poolId,
  virtualPath: folders.virtualPath,
  name: folders.name,
  parentFolderId: folders.parentFolderId,
  createdAt: folders.createdAt,
  updatedAt: folders.updatedAt,
};

export function parseItemTargets(raw: unknown): ShareTargetInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parsed: ShareTargetInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if ((rec.kind !== 'file' && rec.kind !== 'folder') || typeof rec.id !== 'string' || !rec.id.trim()) {
      return null;
    }
    parsed.push({ kind: rec.kind, id: rec.id });
  }
  return parsed;
}

export function parseStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}
