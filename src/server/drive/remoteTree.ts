import type { drive_v3 } from 'googleapis';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { getDriveClient } from './client.js';
import {
  ensurePoolExistsInDb,
  ensureSharePoolExistsInDb,
  parsePoolFolderDescriptor,
  resolvePoolDriveFolderName,
  SHARE_POOL_RESERVE_ID,
} from './poolRegistry.js';
import { isDriveNotFoundError, runBoundedConcurrency, withDriveRetry } from './errors.js';
import {
  clearRemoteFolderCache,
  getCachedVirtualPathByDriveId,
  setCachedRemoteFolder,
} from './mirror.js';

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

export async function checkRemoteRootFolderEmpty(
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

export async function retargetRemoteRootFolder(
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
