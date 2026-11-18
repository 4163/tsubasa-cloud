import { google, type drive_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { authPool } from './auth.js';
import {
  clearRemoteFolderCache,
  getCachedVirtualPathByDriveId,
  setCachedRemoteFolder,
} from './mirror.js';
import { drainOutboxForAccount } from './outbox.js';
import { db, sqlite, bumpPoolRevision } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const MAX_RETRY_AFTER_MS = 60_000;

const driveClientCache = new WeakMap<OAuth2Client, drive_v3.Drive>();

export function getDriveErrorStatus(err: unknown): number | null {
  const e = err as { status?: unknown; response?: { status?: unknown }; code?: unknown } | null | undefined;
  const candidates = [e?.status, e?.response?.status, e?.code];
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }
  return null;
}

export function isDriveNotFoundError(err: unknown): boolean {
  const status = getDriveErrorStatus(err);
  return status === 404 || status === 410;
}

export function isAuthInvalidError(err: unknown): boolean {
  if (getDriveErrorStatus(err) === 401) {
    return true;
  }

  const e = err as {
    message?: unknown;
    response?: { data?: { error?: unknown; error_description?: unknown } };
    data?: { error?: unknown };
  } | null | undefined;

  const candidates = [
    e?.message,
    e?.response?.data?.error,
    e?.response?.data?.error_description,
    e?.data?.error,
  ];
  for (const val of candidates) {
    if (typeof val === 'string' && val.includes('invalid_grant')) {
      return true;
    }
    if (
      val &&
      typeof val === 'object' &&
      'message' in val &&
      typeof (val as { message?: unknown }).message === 'string' &&
      (val as { message: string }).message.includes('invalid_grant')
    ) {
      return true;
    }
  }
  return false;
}

async function markAccountSyncError(accountId: string): Promise<void> {
  await db
    .update(accounts)
    .set({ syncState: 'error', updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
}

function isRateLimit403(err: any): boolean {
  const lists = [err?.errors, err?.response?.data?.error?.errors];
  for (const list of lists) {
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item?.reason === 'rateLimitExceeded' || item?.reason === 'userRateLimitExceeded') {
          return true;
        }
      }
    }
  }
  const msg = String(err?.message || '');
  return msg.includes('rateLimitExceeded') || msg.includes('userRateLimitExceeded');
}

function isRetryableDriveError(err: any): boolean {
  const status = getDriveErrorStatus(err);
  if (status === 429 || (status !== null && status >= 500 && status <= 599)) {
    return true;
  }
  if (status === 403 && isRateLimit403(err)) {
    return true;
  }
  const code = err?.code ?? err?.cause?.code;
  return typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code);
}

function parseRetryAfterMs(err: any): number | null {
  const headers = err?.response?.headers;
  if (!headers) {
    return null;
  }

  let raw: unknown;
  if (typeof headers.get === 'function') {
    raw = headers.get('retry-after');
  } else {
    raw = headers['retry-after'] ?? headers['Retry-After'];
  }

  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }

  const value = String(raw).trim();
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const targetMs = Date.parse(value);
  if (Number.isFinite(targetMs)) {
    return Math.max(0, targetMs - Date.now());
  }

  return null;
}

export async function withDriveRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; baseDelayMs?: number }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 5;
  const baseDelayMs = options?.baseDelayMs ?? 500;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableDriveError(err)) {
        throw err;
      }

      const retryAfterMs = parseRetryAfterMs(err);
      if (retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS) {
        throw err;
      }

      let delayMs: number;
      if (retryAfterMs === 0) {
        delayMs = Math.round(baseDelayMs * (0.5 + Math.random() * 0.5));
      } else if (retryAfterMs !== null) {
        delayMs = retryAfterMs;
      } else {
        delayMs = Math.round(baseDelayMs * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5));
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function runBoundedConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  let hasError = false;
  let firstError: unknown;

  const runners = Array.from({ length: limit }, async () => {
    while (!hasError && nextIndex < items.length) {
      const idx = nextIndex++;
      try {
        await worker(items[idx]);
      } catch (err) {
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
        return;
      }
    }
  });

  await Promise.allSettled(runners);
  if (hasError) {
    throw firstError;
  }
}

export class AccountPoolLockedError extends Error {
  constructor(message = 'Account already has files linked to its current pool and cannot be switched') {
    super(message);
    this.name = 'AccountPoolLockedError';
  }
}

export interface AccountHydrationResult {
  accountId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  poolId: number;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  rootFolderId: string;
}

const RECENT_DELETION_COOLDOWN_MS = 15_000;
const recentDeletionUntilMs = new Map<string, number>();

export function markAccountQuotaDecreased(
  accountId: string,
  cooldownMs = RECENT_DELETION_COOLDOWN_MS
): void {
  recentDeletionUntilMs.set(accountId, Date.now() + cooldownMs);
}

export async function refreshAccountLiveQuota(accountId: string): Promise<number | null> {
  if (!authPool.getRecord(accountId)?.authorized) {
    return null;
  }

  const drive = getDriveClient(accountId);
  let aboutRes: { data: drive_v3.Schema$About };
  try {
    aboutRes = await withDriveRetry(() => drive.about.get({ fields: 'storageQuota' }));
  } catch (err) {
    if (isAuthInvalidError(err)) {
      await markAccountSyncError(accountId);
    }
    throw err;
  }
  const storage = aboutRes.data.storageQuota;

  const liveUsage = Number(storage?.usage ?? NaN);
  if (!Number.isFinite(liveUsage)) {
    return null;
  }

  const existing = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });
  if (!existing) {
    return null;
  }

  const untilMs = recentDeletionUntilMs.get(accountId) ?? 0;
  let nextUsage: number;
  if (Date.now() < untilMs) {
    // Clamp against stale pre-deletion Drive quota while Google's backend settles.
    nextUsage = Math.min(existing.quotaUsedBytes, liveUsage);
  } else {
    if (untilMs > 0) {
      recentDeletionUntilMs.delete(accountId);
    }
    nextUsage = liveUsage;
  }

  const liveLimit = storage?.limit ? Number(storage.limit) : NaN;
  const nextLimit =
    Number.isFinite(liveLimit) && liveLimit > 0 ? liveLimit : existing.quotaLimitBytes;

  await db
    .update(accounts)
    .set({
      quotaUsedBytes: nextUsage,
      quotaLimitBytes: nextLimit,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));

  return nextUsage;
}

export function getDriveClient(clientOrId: string | OAuth2Client): drive_v3.Drive {
  const authClient =
    typeof clientOrId === 'string' ? authPool.getClient(clientOrId) : clientOrId;

  if (!authClient) {
    throw new Error(`Account ${String(clientOrId)} not found in auth pool`);
  }

  let cached = driveClientCache.get(authClient);
  if (!cached) {
    cached = google.drive({ version: 'v3', auth: authClient });
    driveClientCache.set(authClient, cached);
  }
  return cached;
}

export const POOL_FOLDER_PREFIX = '_Tsubasa~ Pool ';
export const SHARE_POOL_FOLDER_NAME = '_Tsubasa~ Pool share';
// Reserve a high positive ID range so Share Pool never shifts sequential standard Pool IDs (Pool 2, Pool 3, ...).
export const SHARE_POOL_RESERVE_ID = 1_000_000;

export interface PoolFolderDescriptor {
  kind: 'share' | 'standard';
  poolNumber: number | null;
}

export function getPoolDriveFolderName(poolId: number): string {
  return `_Tsubasa~ Pool ${poolId}`;
}

export function resolvePoolDriveFolderName(poolId: number): string {
  const row = sqlite
    .prepare('SELECT drive_folder_name FROM pools WHERE id = ?')
    .get(poolId) as { drive_folder_name: string } | undefined;
  return row?.drive_folder_name || getPoolDriveFolderName(poolId);
}

export function parsePoolFolderDescriptor(name: string): PoolFolderDescriptor | null {
  const trimmed = name.trim();
  if (trimmed === SHARE_POOL_FOLDER_NAME) {
    return { kind: 'share', poolNumber: null };
  }

  const match = /^_Tsubasa~ Pool ([1-9]\d*)$/.exec(trimmed);
  if (!match) return null;
  return { kind: 'standard', poolNumber: Number(match[1]) };
}

export function parsePoolIdFromFolderName(name: string): number | null {
  const descriptor = parsePoolFolderDescriptor(name);
  if (!descriptor || descriptor.kind !== 'standard') return null;
  return descriptor.poolNumber;
}

export function ensurePoolExistsInDb(poolId: number): void {
  if (poolId === SHARE_POOL_RESERVE_ID) {
    ensureSharePoolExistsInDb();
    return;
  }
  const folderName = getPoolDriveFolderName(poolId);
  sqlite
    .prepare(
      `INSERT INTO pools (id, name, drive_folder_name) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`
    )
    .run(poolId, `Pool ${poolId}`, folderName);
}

export function isSharePoolId(poolId: number): boolean {
  if (poolId === SHARE_POOL_RESERVE_ID) {
    return true;
  }
  const row = sqlite
    .prepare('SELECT is_share_pool as isSharePool FROM pools WHERE id = ? LIMIT 1')
    .get(poolId) as { isSharePool: number } | undefined;
  return Boolean(row?.isSharePool);
}

export function ensureSharePoolExistsInDb(): number {
  return sqlite.transaction(() => {
    const existing = sqlite
      .prepare('SELECT id FROM pools WHERE is_share_pool = 1 OR drive_folder_name = ? LIMIT 1')
      .get(SHARE_POOL_FOLDER_NAME) as { id: number } | undefined;
    if (existing) {
      return existing.id;
    }

    const maxRow = sqlite
      .prepare('SELECT MAX(id) as maxId FROM pools')
      .get() as { maxId: number | null } | undefined;
    const nextId = Math.max(SHARE_POOL_RESERVE_ID, (maxRow?.maxId ?? 0) + 1);

    sqlite
      .prepare(
        `INSERT INTO pools (id, name, drive_folder_name, is_share_pool) VALUES (?, ?, ?, 1)`
      )
      .run(nextId, 'Share Pool', SHARE_POOL_FOLDER_NAME);

    return nextId;
  })();
}

async function checkRemoteRootFolderEmpty(
  drive: drive_v3.Drive,
  rootFolderId: string | null
): Promise<{ empty: true } | { empty: false; reason: 'managed' | 'folder_files' }> {
  const managedCheck = await withDriveRetry(() =>
    drive.files.list({
      q: "appProperties has { key='tsubasa_managed' and value='true' } and mimeType != 'application/vnd.google-apps.folder'",
      pageSize: 1,
      fields: 'files(id, name)',
      spaces: 'drive',
      supportsAllDrives: false,
    })
  );

  if ((managedCheck.data.files || []).length > 0) {
    return { empty: false, reason: 'managed' };
  }

  if (rootFolderId) {
    const tree = await resolveRemoteFolderTree(drive, rootFolderId);
    const folderIdArray = Array.from(tree.folderIds);
    for (let i = 0; i < folderIdArray.length; i += 20) {
      const chunk = folderIdArray.slice(i, i + 20);
      const parentQuery = chunk.map((fid) => `'${fid}' in parents`).join(' or ');
      const checkRes = await withDriveRetry(() =>
        drive.files.list({
          q: `(${parentQuery}) and mimeType != 'application/vnd.google-apps.folder'`,
          pageSize: 1,
          fields: 'files(id, name)',
          spaces: 'drive',
          supportsAllDrives: false,
        })
      );

      if ((checkRes.data.files || []).length > 0) {
        return { empty: false, reason: 'folder_files' };
      }
    }
  }

  return { empty: true };
}

async function retargetRemoteRootFolder(
  drive: drive_v3.Drive,
  rootFolderId: string,
  targetPoolId: number
): Promise<void> {
  const childFolders: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined = undefined;
  do {
    const childFoldersRes: { data: drive_v3.Schema$FileList } = await withDriveRetry(() =>
      drive.files.list({
        q: `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'nextPageToken, files(id, name)',
        pageSize: 100,
        pageToken,
        spaces: 'drive',
        supportsAllDrives: false,
      })
    );
    childFolders.push(...(childFoldersRes.data.files || []));
    pageToken = childFoldersRes.data.nextPageToken || undefined;
  } while (pageToken);

  for (const folder of childFolders) {
    if (folder.id) {
      try {
        await withDriveRetry(() =>
          drive.files.update({
            fileId: folder.id!,
            requestBody: { trashed: true },
            supportsAllDrives: false,
          })
        );
      } catch (delErr) {
        console.warn(`Failed to clean empty subfolder ${folder.id} during pool switch:`, delErr);
      }
    }
  }

  await withDriveRetry(() =>
    drive.files.update({
      fileId: rootFolderId,
      requestBody: {
        name: resolvePoolDriveFolderName(targetPoolId),
        appProperties: {
          tsubasa_root: 'true',
          tsubasa_pool_id: String(targetPoolId),
        },
      },
      supportsAllDrives: false,
    })
  );

  clearRemoteFolderCache(rootFolderId);
}

const ensureRootFolderQueues = new WeakMap<drive_v3.Drive, Promise<unknown>>();

export function ensureRootFolder(
  drive: drive_v3.Drive,
  preferredPoolId = 1,
  preferTargetWhenEmpty = false
): Promise<{ rootFolderId: string; poolId: number }> {
  const prev = ensureRootFolderQueues.get(drive) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => ensureRootFolderInternal(drive, preferredPoolId, preferTargetWhenEmpty));
  ensureRootFolderQueues.set(drive, next);
  return next;
}

async function ensureRootFolderInternal(
  drive: drive_v3.Drive,
  preferredPoolId = 1,
  preferTargetWhenEmpty = false
): Promise<{ rootFolderId: string; poolId: number }> {
  const query = `mimeType = 'application/vnd.google-apps.folder' and name contains '_Tsubasa~ Pool ' and 'root' in parents and trashed = false`;
  const listedFiles: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined = undefined;
  do {
    const searchRes: { data: drive_v3.Schema$FileList } = await withDriveRetry(() =>
      drive.files.list({
        q: query,
        spaces: 'drive',
        fields: 'nextPageToken, files(id, name, appProperties)',
        pageSize: 100,
        pageToken,
        supportsAllDrives: false,
      })
    );
    listedFiles.push(...(searchRes.data.files || []));
    pageToken = searchRes.data.nextPageToken || undefined;
  } while (pageToken);

  const matchingFolders: Array<{
    id: string;
    name: string;
    poolId: number | null;
    isSharePool: boolean;
  }> = [];

  for (const f of listedFiles) {
    if (f.id && f.name) {
      const descriptor = parsePoolFolderDescriptor(f.name);
      if (!descriptor) continue;
      if (descriptor.kind === 'share') {
        matchingFolders.push({ id: f.id, name: f.name, poolId: null, isSharePool: true });
      } else if (descriptor.poolNumber !== null && descriptor.poolNumber > 0) {
        matchingFolders.push({
          id: f.id,
          name: f.name,
          poolId: descriptor.poolNumber,
          isSharePool: false,
        });
      }
    }
  }

  const existingSharePool = sqlite
    .prepare('SELECT id FROM pools WHERE is_share_pool = 1 LIMIT 1')
    .get() as { id: number } | undefined;
  const isPreferredSharePool =
    preferredPoolId === SHARE_POOL_RESERVE_ID || existingSharePool?.id === preferredPoolId;

  if (matchingFolders.length > 0) {
    const exactMatch = matchingFolders.find((f) =>
      f.isSharePool ? isPreferredSharePool : f.poolId === preferredPoolId
    );

    if (!exactMatch && preferTargetWhenEmpty) {
      const emptyCheck = await checkRemoteRootFolderEmpty(drive, matchingFolders[0].id);
      if (emptyCheck.empty) {
        const resolvedPoolId = isPreferredSharePool
          ? ensureSharePoolExistsInDb()
          : (ensurePoolExistsInDb(preferredPoolId), preferredPoolId);
        await retargetRemoteRootFolder(drive, matchingFolders[0].id, resolvedPoolId);
        return { rootFolderId: matchingFolders[0].id, poolId: resolvedPoolId };
      }
    }

    const chosen = exactMatch || matchingFolders[0];

    if (chosen.isSharePool) {
      const sharePoolId = ensureSharePoolExistsInDb();
      return { rootFolderId: chosen.id, poolId: sharePoolId };
    }

    ensurePoolExistsInDb(chosen.poolId!);
    return { rootFolderId: chosen.id, poolId: chosen.poolId! };
  }

  const resolvedPoolId = isPreferredSharePool
    ? ensureSharePoolExistsInDb()
    : (ensurePoolExistsInDb(preferredPoolId), preferredPoolId);
  const folderName = resolvePoolDriveFolderName(resolvedPoolId);
  const createRes = await withDriveRetry(() =>
    drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
        appProperties: {
          tsubasa_root: 'true',
          tsubasa_pool_id: String(resolvedPoolId),
        },
      },
      fields: 'id, name',
      supportsAllDrives: false,
    })
  );

  if (!createRes.data.id) {
    throw new Error(`Failed to create ${folderName} root folder in Google Drive`);
  }

  return { rootFolderId: createRes.data.id, poolId: resolvedPoolId };
}

export async function hydrateAccount(
  accountId: string,
  preferredPoolId?: number
): Promise<AccountHydrationResult> {
  let canonicalAccountId = accountId;
  try {
    const drive = getDriveClient(accountId);

    const aboutRes = await withDriveRetry(() =>
      drive.about.get({
        fields: 'user,storageQuota',
      })
    );

    const user = aboutRes.data.user;
    const storage = aboutRes.data.storageQuota;

    if (!user?.emailAddress) {
      throw new Error(`Failed to retrieve user profile for account ${accountId}`);
    }

    const email = user.emailAddress.toLowerCase().trim();

    if (accountId.toLowerCase() !== email) {
      authPool.renameAccount(accountId, email);
      canonicalAccountId = email;
    }

    const existingAccount = await db.query.accounts.findFirst({
      where: eq(accounts.id, canonicalAccountId),
    });

    const fileCountRow = sqlite
      .prepare('SELECT count(*) as c FROM files WHERE account_id = ?')
      .get(canonicalAccountId) as { c: number } | undefined;
    const hasLocalFiles = (fileCountRow?.c ?? 0) > 0;

    const explicitPoolId =
      preferredPoolId ??
      (authPool.hasPreferredPool(canonicalAccountId)
        ? authPool.getPreferredPool(canonicalAccountId)
        : undefined);

    const targetPoolId = existingAccount
      ? existingAccount.poolId
      : (explicitPoolId ?? 1);
    const preferTargetWhenEmpty =
      !hasLocalFiles && (existingAccount !== undefined || explicitPoolId !== undefined);

    const { rootFolderId, poolId } = await ensureRootFolder(
      drive,
      targetPoolId,
      preferTargetWhenEmpty
    );
    authPool.setPreferredPool(canonicalAccountId, poolId);

    const quotaLimit = storage?.limit ? Number(storage.limit) : 16106127360; // 15 GB fallback
    const quotaUsed = storage?.usage ? Number(storage.usage) : 0;

    await db
      .insert(accounts)
      .values({
        id: canonicalAccountId,
        email: user.emailAddress,
        displayName: user.displayName || user.emailAddress.split('@')[0],
        avatarUrl: user.photoLink || null,
        poolId,
        quotaLimitBytes: quotaLimit,
        quotaUsedBytes: quotaUsed,
        syncState: 'idle',
        rootFolderId,
      })
      .onConflictDoUpdate({
        target: accounts.id,
        set: {
          email: user.emailAddress,
          displayName: user.displayName || user.emailAddress.split('@')[0],
          avatarUrl: user.photoLink || null,
          poolId,
          quotaLimitBytes: quotaLimit,
          quotaUsedBytes: quotaUsed,
          rootFolderId,
          updatedAt: new Date(),
        },
      });

    return {
      accountId: canonicalAccountId,
      email: user.emailAddress,
      displayName: user.displayName || user.emailAddress.split('@')[0],
      avatarUrl: user.photoLink || null,
      poolId,
      quotaLimitBytes: quotaLimit,
      quotaUsedBytes: quotaUsed,
      rootFolderId,
    };
  } catch (err) {
    if (isAuthInvalidError(err)) {
      await markAccountSyncError(canonicalAccountId);
    }
    throw err;
  }
}

export interface RemoteFolderItem {
  id: string;
  virtualPath: string;
  name: string;
  parentId: string | null;
}

export interface RemoteFolderTree {
  folderIds: Set<string>;
  folderPathById: Map<string, string>;
  folderIdByPath: Map<string, string>;
  folders: RemoteFolderItem[];
}

/**
 * Recursively resolves the remote folder tree inside an account's pool root folder (_Tsubasa~ Pool <N>).
 * Discovers subfolders created directly in Google Drive as well as Tsubasa-created folders.
 */
export async function resolveRemoteFolderTree(
  drive: drive_v3.Drive,
  rootFolderId: string
): Promise<RemoteFolderTree> {
  const folderPathById = new Map<string, string>([[rootFolderId, '/']]);
  const folderIdByPath = new Map<string, string>([['/', rootFolderId]]);
  const folderIds = new Set<string>([rootFolderId]);
  const folders: RemoteFolderItem[] = [];

  let frontier: string[] = [rootFolderId];

  while (frontier.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < frontier.length; i += 20) {
      chunks.push(frontier.slice(i, i + 20));
    }

    const nextFrontier: string[] = [];

    await runBoundedConcurrency(chunks, 5, async (chunk) => {
      const parentQuery = chunk.map((id) => `'${id}' in parents`).join(' or ');
      const query = `(${parentQuery}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      let pageToken: string | undefined = undefined;

      do {
        const res: any = await withDriveRetry(() =>
          drive.files.list({
            q: query,
            fields: 'nextPageToken, files(id, name, parents, appProperties)',
            pageSize: 1000,
            pageToken,
            spaces: 'drive',
            supportsAllDrives: false,
          })
        );

        for (const child of res.data.files || []) {
          if (!child.id || !child.name || folderIds.has(child.id)) {
            continue;
          }

          const parentId = (child.parents || []).find((pid: string) => folderPathById.has(pid));
          if (!parentId) {
            continue;
          }

          folderIds.add(child.id);
          const parentVirtualPath = folderPathById.get(parentId)!;
          const computedPath =
            parentVirtualPath === '/'
              ? `/${child.name}`
              : `${parentVirtualPath}/${child.name}`;
          const virtualPath = child.appProperties?.tsubasa_folder_path || computedPath;

          folderPathById.set(child.id, virtualPath);
          folderIdByPath.set(virtualPath, child.id);
          setCachedRemoteFolder(rootFolderId, virtualPath, child.id);

          folders.push({
            id: child.id,
            virtualPath,
            name: child.name,
            parentId: parentVirtualPath === '/' ? null : parentVirtualPath,
          });
          nextFrontier.push(child.id);
        }

        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken);
    });

    frontier = nextFrontier;
  }

  return {
    folderIds,
    folderPathById,
    folderIdByPath,
    folders,
  };
}

export async function resolveRemoteParentPath(
  drive: drive_v3.Drive,
  rootFolderId: string,
  parentFolderId: string,
  cache: Map<string, string | null>,
  options?: { onResolvedFolder?: (virtualPath: string) => void; visiting?: Set<string> }
): Promise<{ isInsidePool: boolean; path: string }> {
  if (parentFolderId === rootFolderId) {
    return { isInsidePool: true, path: '/' };
  }

  if (cache.has(parentFolderId)) {
    const cached = cache.get(parentFolderId);
    return cached ? { isInsidePool: true, path: cached } : { isInsidePool: false, path: '/' };
  }

  const cachedByDriveId = getCachedVirtualPathByDriveId(rootFolderId, parentFolderId);
  if (cachedByDriveId) {
    cache.set(parentFolderId, cachedByDriveId);
    return { isInsidePool: true, path: cachedByDriveId };
  }

  const visiting = options?.visiting ?? new Set<string>();
  if (visiting.has(parentFolderId)) {
    return { isInsidePool: false, path: '/' };
  }

  visiting.add(parentFolderId);
  try {
    const res = await withDriveRetry(() =>
      drive.files.get({
        fileId: parentFolderId,
        fields: 'id, name, parents, appProperties, trashed',
        supportsAllDrives: false,
      })
    );

    const folder = res.data;
    if (!folder.id || !folder.name || folder.trashed || !folder.parents?.length) {
      cache.set(parentFolderId, null);
      return { isInsidePool: false, path: '/' };
    }

    const parentResult = await resolveRemoteParentPath(
      drive,
      rootFolderId,
      folder.parents[0],
      cache,
      { onResolvedFolder: options?.onResolvedFolder, visiting }
    );

    if (!parentResult.isInsidePool) {
      cache.set(parentFolderId, null);
      return { isInsidePool: false, path: '/' };
    }

    const fallbackPath =
      parentResult.path === '/' ? `/${folder.name}` : `${parentResult.path}/${folder.name}`;
    const computedPath = folder.appProperties?.tsubasa_folder_path || fallbackPath;

    setCachedRemoteFolder(rootFolderId, computedPath, parentFolderId);
    cache.set(parentFolderId, computedPath);
    options?.onResolvedFolder?.(computedPath);

    return { isInsidePool: true, path: computedPath };
  } catch (err) {
    if (isDriveNotFoundError(err)) {
      cache.set(parentFolderId, null);
      return { isInsidePool: false, path: '/' };
    }
    throw err;
  } finally {
    visiting.delete(parentFolderId);
  }
}

/**
 * Resolves all folder IDs descendant from rootFolderId (including rootFolderId itself).
 * Used to verify whether files reside inside the Tsubasa storage pool.
 */
export async function getDescendantFolderIds(
  drive: drive_v3.Drive,
  rootFolderId: string
): Promise<Set<string>> {
  const tree = await resolveRemoteFolderTree(drive, rootFolderId);
  return tree.folderIds;
}

const inFlightRootFolderIds = new Map<string, Promise<string>>();

export async function getAccountRootFolderId(accountId: string): Promise<string> {
  const existing = inFlightRootFolderIds.get(accountId);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const accountRecord = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
    });

    if (accountRecord?.rootFolderId) {
      return accountRecord.rootFolderId;
    }

    const drive = getDriveClient(accountId);
    const { rootFolderId } = await ensureRootFolder(drive, accountRecord?.poolId ?? 1);

    await db
      .update(accounts)
      .set({ rootFolderId, updatedAt: new Date() })
      .where(eq(accounts.id, accountId));

    return rootFolderId;
  })().finally(() => {
    inFlightRootFolderIds.delete(accountId);
  });

  inFlightRootFolderIds.set(accountId, promise);
  return promise;
}

async function inspectRemoteRootFolder(
  drive: drive_v3.Drive,
  folderId: string | null
): Promise<{ exists: boolean; name: string | null }> {
  if (!folderId) {
    return { exists: false, name: null };
  }
  try {
    const res = await withDriveRetry(() =>
      drive.files.get({
        fileId: folderId,
        fields: 'id, name, trashed',
        supportsAllDrives: false,
      })
    );
    if (!res.data.id || res.data.trashed) {
      return { exists: false, name: null };
    }
    return { exists: true, name: res.data.name ?? null };
  } catch (err) {
    if (isDriveNotFoundError(err)) {
      return { exists: false, name: null };
    }
    throw err;
  }
}

function assertNoDeadOutboxEntries(accountId: string): void {
  const deadOutboxRow = sqlite
    .prepare("SELECT count(*) as c FROM drive_outbox WHERE account_id = ? AND status = 'dead'")
    .get(accountId) as { c: number } | undefined;
  if ((deadOutboxRow?.c ?? 0) > 0) {
    throw new AccountPoolLockedError(
      'Cannot switch pool: unresolved failed Drive operations remain in the outbox for this account.'
    );
  }
}

export async function switchAccountPool(
  accountId: string,
  targetPoolId: number
): Promise<{ accountId: string; poolId: number; rootFolderId: string | null }> {
  if (targetPoolId === SHARE_POOL_RESERVE_ID) {
    ensureSharePoolExistsInDb();
  }

  const poolRow = sqlite
    .prepare('SELECT id FROM pools WHERE id = ?')
    .get(targetPoolId) as { id: number } | undefined;
  if (!poolRow) {
    throw new Error(`Target storage pool ${targetPoolId} does not exist`);
  }

  const fileCountRow = sqlite
    .prepare('SELECT count(*) as c FROM files WHERE account_id = ?')
    .get(accountId) as { c: number } | undefined;
  if ((fileCountRow?.c ?? 0) > 0) {
    throw new AccountPoolLockedError(
      'Cannot switch pool: this account already has files linked to its current pool.'
    );
  }

  const accountRecord = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });
  const authRecord = authPool.getRecord(accountId);

  if (!accountRecord) {
    authPool.setPreferredPool(accountId, targetPoolId);
    if (authRecord?.authorized) {
      const ensured = await ensureRootFolder(getDriveClient(accountId), targetPoolId, true);
      if (ensured.poolId !== targetPoolId) {
        throw new AccountPoolLockedError(
          'Cannot switch pool: this account already has files inside its Tsubasa folder on Google Drive.'
        );
      }
      return { accountId, poolId: targetPoolId, rootFolderId: ensured.rootFolderId };
    }
    return { accountId, poolId: targetPoolId, rootFolderId: null };
  }

  let resolvedRootFolderId = accountRecord.rootFolderId;

  if (authRecord?.authorized) {
    const drive = getDriveClient(accountId);
    const expectedFolderName = resolvePoolDriveFolderName(targetPoolId);
    const remoteFolder = await inspectRemoteRootFolder(drive, resolvedRootFolderId);

    if (
      accountRecord.poolId === targetPoolId &&
      remoteFolder.exists &&
      remoteFolder.name === expectedFolderName
    ) {
      authPool.setPreferredPool(accountId, targetPoolId);
      return { accountId, poolId: targetPoolId, rootFolderId: resolvedRootFolderId };
    }

    if (!remoteFolder.exists) {
      resolvedRootFolderId = null;
    }

    await drainOutboxForAccount(accountId);
    assertNoDeadOutboxEntries(accountId);

    const emptyCheck = await checkRemoteRootFolderEmpty(drive, resolvedRootFolderId);
    if (!emptyCheck.empty) {
      throw new AccountPoolLockedError(
        emptyCheck.reason === 'managed'
          ? 'Cannot switch pool: this account already has Tsubasa files in Google Drive.'
          : 'Cannot switch pool: this account has files inside its Tsubasa folder on Google Drive.'
      );
    }

    if (resolvedRootFolderId) {
      await retargetRemoteRootFolder(drive, resolvedRootFolderId, targetPoolId);
    } else {
      const ensured = await ensureRootFolder(drive, targetPoolId, true);
      if (ensured.poolId !== targetPoolId) {
        throw new AccountPoolLockedError(
          'Cannot switch pool: this account already has files inside its Tsubasa folder on Google Drive.'
        );
      }
      resolvedRootFolderId = ensured.rootFolderId;
    }
  } else if (accountRecord.poolId === targetPoolId) {
    authPool.setPreferredPool(accountId, targetPoolId);
    return { accountId, poolId: targetPoolId, rootFolderId: accountRecord.rootFolderId };
  } else {
    assertNoDeadOutboxEntries(accountId);
  }

  await db
    .update(accounts)
    .set({ poolId: targetPoolId, rootFolderId: resolvedRootFolderId, updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
  sqlite.prepare('DELETE FROM share_links WHERE account_id = ?').run(accountId);

  if (accountRecord.poolId !== targetPoolId) {
    bumpPoolRevision(accountRecord.poolId);
  }
  bumpPoolRevision(targetPoolId);

  authPool.setPreferredPool(accountId, targetPoolId);

  if (authRecord?.authorized) {
    await refreshAccountLiveQuota(accountId).catch((err) => {
      console.warn(`Quota refresh warning for ${accountId} during pool switch:`, err);
    });
  }

  return { accountId, poolId: targetPoolId, rootFolderId: resolvedRootFolderId };
}

export type FileContentMatchStatus = 'identical' | 'different' | 'unverified';

export function normalizeContentHash(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/^(sha256-|md5-)/, '');
  return cleaned || null;
}

/**
 * Compares file sizes and normalized hashes of matching digest length.
 * Returns 'unverified' when sizes match but no comparable hash pair is present.
 */
export function evaluateFileContentMatch(
  sizeA: number,
  hashesA: Array<string | null | undefined>,
  sizeB: number,
  hashB: string | null | undefined
): FileContentMatchStatus {
  if (sizeA !== sizeB) return 'different';

  const setA = new Set<string>();
  for (const h of hashesA) {
    const nh = normalizeContentHash(h);
    if (nh) setA.add(nh);
  }
  const normB = normalizeContentHash(hashB);

  if (sizeA === 0 && setA.size === 0 && !normB) {
    return 'identical';
  }
  if (setA.size === 0 || !normB) {
    return 'unverified';
  }

  let hasSameLengthCandidate = false;
  for (const cand of setA) {
    if (cand.length === normB.length) {
      hasSameLengthCandidate = true;
      if (cand === normB) {
        return 'identical';
      }
    }
  }

  return hasSameLengthCandidate ? 'different' : 'unverified';
}

export const CLEARED_TSUBASA_APP_PROPERTIES = {
  tsubasa_managed: null,
  tsubasa_virtual_path: null,
  tsubasa_virtual_id: null,
  tsubasa_checksum: null,
} as const;

export async function clearOrphanAppProperties(
  drive: drive_v3.Drive,
  orphanDriveIds: string[]
): Promise<void> {
  await runBoundedConcurrency(orphanDriveIds, 5, async (orphanId) => {
    try {
      await withDriveRetry(() =>
        drive.files.update({
          fileId: orphanId,
          requestBody: {
            appProperties: CLEARED_TSUBASA_APP_PROPERTIES as any,
          },
          supportsAllDrives: false,
        })
      );
    } catch (err) {
      console.warn(`Failed to clear orphan appProperties for ${orphanId}:`, err);
    }
  });
}




