import { google, type drive_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { authPool } from './auth.js';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface AccountHydrationResult {
  accountId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  rootFolderId: string;
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

export async function hydrateAccount(accountId: string): Promise<AccountHydrationResult> {
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

  const rootFolderId = await ensureRootFolder(drive);

  const quotaLimit = storage?.limit ? Number(storage.limit) : 16106127360; // 15 GB fallback
  const quotaUsed = storage?.usage ? Number(storage.usage) : 0;

  await db
    .insert(accounts)
    .values({
      id: canonicalAccountId,
      email: user.emailAddress,
      displayName: user.displayName || user.emailAddress.split('@')[0],
      avatarUrl: user.photoLink || null,
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
    quotaLimitBytes: quotaLimit,
    quotaUsedBytes: quotaUsed,
    rootFolderId,
  };
}

export const ROOT_FOLDER_NAME = '_Tsubasa~ Cloud';
export const LEGACY_ROOT_FOLDER_NAME = 'Tsubasa Storage';

export async function ensureRootFolder(drive: drive_v3.Drive): Promise<string> {
  const query = `mimeType = 'application/vnd.google-apps.folder' and (name = '${ROOT_FOLDER_NAME}' or name = '${LEGACY_ROOT_FOLDER_NAME}') and 'root' in parents and trashed = false`;
  const searchRes = await drive.files.list({
    q: query,
    spaces: 'drive',
    fields: 'files(id, name)',
    pageSize: 2,
  });

  if (searchRes.data.files && searchRes.data.files.length > 0) {
    const existing =
      searchRes.data.files.find((f) => f.name === ROOT_FOLDER_NAME) || searchRes.data.files[0];
    if (existing.id) {
      if (existing.name === LEGACY_ROOT_FOLDER_NAME) {
        try {
          await drive.files.update({
            fileId: existing.id,
            requestBody: { name: ROOT_FOLDER_NAME },
          });
        } catch {
          // Non-fatal if rename cannot be applied immediately
        }
      }
      return existing.id;
    }
  }

  const createRes = await drive.files.create({
    requestBody: {
      name: ROOT_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
      appProperties: {
        tsubasa_root: 'true',
      },
    },
    fields: 'id, name',
  });

  if (!createRes.data.id) {
    throw new Error(`Failed to create ${ROOT_FOLDER_NAME} root folder in Google Drive`);
  }

  return createRes.data.id;
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
 * Recursively resolves the remote folder tree inside an account's root folder (_Tsubasa~ Cloud).
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
  const rootId = await ensureRootFolder(drive);

  await db
    .update(accounts)
    .set({ rootFolderId: rootId, updatedAt: new Date() })
    .where(eq(accounts.id, accountId));

  return rootId;
}



