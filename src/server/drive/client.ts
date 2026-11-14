import { google, type drive_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { authPool } from './auth.js';
import { db, sqlite } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';

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
  const aboutRes = await drive.about.get({ fields: 'storageQuota' });
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
  if (typeof clientOrId === 'string') {
    const authClient = authPool.getClient(clientOrId);
    if (!authClient) {
      throw new Error(`Account ${clientOrId} not found in auth pool`);
    }
    return google.drive({ version: 'v3', auth: authClient });
  }

  return google.drive({ version: 'v3', auth: clientOrId });
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
  const folderName = getPoolDriveFolderName(poolId);
  sqlite
    .prepare(
      `INSERT INTO pools (id, name, drive_folder_name) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`
    )
    .run(poolId, `Pool ${poolId}`, folderName);
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

export async function ensureRootFolder(
  drive: drive_v3.Drive,
  preferredPoolId = 1
): Promise<{ rootFolderId: string; poolId: number }> {
  const query = `mimeType = 'application/vnd.google-apps.folder' and name contains '_Tsubasa~ Pool ' and 'root' in parents and trashed = false`;
  const searchRes = await drive.files.list({
    q: query,
    spaces: 'drive',
    fields: 'files(id, name, appProperties)',
    pageSize: 20,
    supportsAllDrives: false,
  });

  const matchingFolders: Array<{
    id: string;
    name: string;
    poolId: number | null;
    isSharePool: boolean;
  }> = [];

  for (const f of searchRes.data.files || []) {
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

  if (matchingFolders.length > 0) {
    const existingSharePool = sqlite
      .prepare('SELECT id FROM pools WHERE is_share_pool = 1 LIMIT 1')
      .get() as { id: number } | undefined;

    const chosen =
      matchingFolders.find((f) =>
        f.isSharePool
          ? existingSharePool?.id === preferredPoolId
          : f.poolId === preferredPoolId
      ) || matchingFolders[0];

    if (chosen.isSharePool) {
      const sharePoolId = ensureSharePoolExistsInDb();
      return { rootFolderId: chosen.id, poolId: sharePoolId };
    }

    ensurePoolExistsInDb(chosen.poolId!);
    return { rootFolderId: chosen.id, poolId: chosen.poolId! };
  }

  ensurePoolExistsInDb(preferredPoolId);
  const folderName = resolvePoolDriveFolderName(preferredPoolId);
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
      appProperties: {
        tsubasa_root: 'true',
        tsubasa_pool_id: String(preferredPoolId),
      },
    },
    fields: 'id, name',
    supportsAllDrives: false,
  });

  if (!createRes.data.id) {
    throw new Error(`Failed to create ${folderName} root folder in Google Drive`);
  }

  return { rootFolderId: createRes.data.id, poolId: preferredPoolId };
}

export async function hydrateAccount(
  accountId: string,
  preferredPoolId?: number
): Promise<AccountHydrationResult> {
  const drive = getDriveClient(accountId);

  const aboutRes = await drive.about.get({
    fields: 'user,storageQuota',
  });

  const user = aboutRes.data.user;
  const storage = aboutRes.data.storageQuota;

  if (!user?.emailAddress) {
    throw new Error(`Failed to retrieve user profile for account ${accountId}`);
  }

  const email = user.emailAddress.toLowerCase().trim();
  let canonicalAccountId = accountId;

  if (accountId.toLowerCase() !== email) {
    authPool.renameAccount(accountId, email);
    canonicalAccountId = email;
  }

  const existingAccount = await db.query.accounts.findFirst({
    where: eq(accounts.id, canonicalAccountId),
  });

  const targetPoolId =
    preferredPoolId ?? existingAccount?.poolId ?? authPool.getPreferredPool(canonicalAccountId) ?? 1;

  const { rootFolderId, poolId } = await ensureRootFolder(drive, targetPoolId);
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

  let pageToken: string | undefined = undefined;
  const rawFolders: Array<{ id: string; name: string; parents: string[]; appProperties?: Record<string, string> }> = [];

  do {
    const res: any = await drive.files.list({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'nextPageToken, files(id, name, parents, appProperties)',
      pageSize: 1000,
      pageToken,
      spaces: 'drive',
      supportsAllDrives: false,
    });

    for (const folder of res.data.files || []) {
      if (folder.id && folder.name) {
        rawFolders.push({
          id: folder.id,
          name: folder.name,
          parents: folder.parents || [],
          appProperties: folder.appProperties || {},
        });
      }
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  const childrenByParent = new Map<string, Array<{ id: string; name: string; appProperties?: Record<string, string> }>>();
  for (const item of rawFolders) {
    for (const p of item.parents) {
      if (!childrenByParent.has(p)) {
        childrenByParent.set(p, []);
      }
      childrenByParent.get(p)!.push(item);
    }
  }

  const queue: Array<{ id: string; parentVirtualPath: string }> = [
    { id: rootFolderId, parentVirtualPath: '/' },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = childrenByParent.get(current.id) || [];

    for (const child of children) {
      if (folderIds.has(child.id)) {
        continue;
      }
      folderIds.add(child.id);

      const computedPath =
        current.parentVirtualPath === '/'
          ? `/${child.name}`
          : `${current.parentVirtualPath}/${child.name}`;

      const virtualPath = child.appProperties?.tsubasa_folder_path || computedPath;

      folderPathById.set(child.id, virtualPath);
      folderIdByPath.set(virtualPath, child.id);

      const parentVirtual = current.parentVirtualPath === '/' ? null : current.parentVirtualPath;
      folders.push({
        id: child.id,
        virtualPath,
        name: child.name,
        parentId: parentVirtual,
      });

      queue.push({ id: child.id, parentVirtualPath: virtualPath });
    }
  }

  return {
    folderIds,
    folderPathById,
    folderIdByPath,
    folders,
  };
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

export async function getAccountRootFolderId(accountId: string): Promise<string> {
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
}

export async function switchAccountPool(
  accountId: string,
  targetPoolId: number
): Promise<{ accountId: string; poolId: number; rootFolderId: string | null }> {
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

  if (!accountRecord) {
    authPool.setPreferredPool(accountId, targetPoolId);
    return { accountId, poolId: targetPoolId, rootFolderId: null };
  }

  if (accountRecord.poolId === targetPoolId) {
    authPool.setPreferredPool(accountId, targetPoolId);
    return { accountId, poolId: targetPoolId, rootFolderId: accountRecord.rootFolderId };
  }

  let resolvedRootFolderId = accountRecord.rootFolderId;

  const authRecord = authPool.getRecord(accountId);
  if (authRecord?.authorized) {
    const drive = getDriveClient(accountId);

    const managedCheck: any = await drive.files.list({
      q: "appProperties has { key='tsubasa_managed' and value='true' } and mimeType != 'application/vnd.google-apps.folder' and trashed = false",
      pageSize: 1,
      fields: 'files(id, name)',
      spaces: 'drive',
      supportsAllDrives: false,
    });

    if ((managedCheck.data.files || []).length > 0) {
      throw new AccountPoolLockedError(
        'Cannot switch pool: this account already has Tsubasa files in Google Drive.'
      );
    }

    if (resolvedRootFolderId) {
      const tree = await resolveRemoteFolderTree(drive, resolvedRootFolderId);
      const folderIdArray = Array.from(tree.folderIds);
      for (let i = 0; i < folderIdArray.length; i += 20) {
        const chunk = folderIdArray.slice(i, i + 20);
        const parentQuery = chunk.map((fid) => `'${fid}' in parents`).join(' or ');
        const checkRes: any = await drive.files.list({
          q: `(${parentQuery}) and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
          pageSize: 1,
          fields: 'files(id, name)',
          spaces: 'drive',
          supportsAllDrives: false,
        });

        if ((checkRes.data.files || []).length > 0) {
          throw new AccountPoolLockedError(
            'Cannot switch pool: this account has files inside its Tsubasa folder on Google Drive.'
          );
        }
      }

      const childFoldersRes: any = await drive.files.list({
        q: `'${resolvedRootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder'`,
        fields: 'files(id, name)',
        pageSize: 100,
        spaces: 'drive',
        supportsAllDrives: false,
      });

      for (const folder of childFoldersRes.data.files || []) {
        if (folder.id) {
          try {
            await drive.files.delete({ fileId: folder.id, supportsAllDrives: false });
          } catch (delErr) {
            console.warn(`Failed to clean empty subfolder ${folder.id} during pool switch:`, delErr);
          }
        }
      }

      await drive.files.update({
        fileId: resolvedRootFolderId,
        requestBody: {
          name: resolvePoolDriveFolderName(targetPoolId),
          appProperties: {
            tsubasa_root: 'true',
            tsubasa_pool_id: String(targetPoolId),
          },
        },
        supportsAllDrives: false,
      });
    } else {
      const ensured = await ensureRootFolder(drive, targetPoolId);
      resolvedRootFolderId = ensured.rootFolderId;
    }
  }

  await db
    .update(accounts)
    .set({ poolId: targetPoolId, rootFolderId: resolvedRootFolderId, updatedAt: new Date() })
    .where(eq(accounts.id, accountId));

  authPool.setPreferredPool(accountId, targetPoolId);

  if (authRecord?.authorized) {
    await refreshAccountLiveQuota(accountId).catch((err) => {
      console.warn(`Quota refresh warning for ${accountId} during pool switch:`, err);
    });
  }

  return { accountId, poolId: targetPoolId, rootFolderId: resolvedRootFolderId };
}



