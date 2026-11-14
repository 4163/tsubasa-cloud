import type { drive_v3 } from 'googleapis';
import path from 'node:path';
import { withDriveRetry } from './client.js';

// In-memory cache mapping `${rootFolderId}:${normalizedVirtualPath}` to Google Drive folder ID
const remoteFolderCache = new Map<string, string>();
const driveIdToPathCache = new Map<string, { rootFolderId: string; virtualPath: string }>();
const inFlightFolderPromises = new Map<string, Promise<string>>();

export function setCachedRemoteFolder(
  rootFolderId: string,
  virtualPath: string,
  driveFolderId: string
): void {
  const normalized = normalizeVirtualPath(virtualPath);
  remoteFolderCache.set(`${rootFolderId}:${normalized}`, driveFolderId);
  driveIdToPathCache.set(`${rootFolderId}:${driveFolderId}`, {
    rootFolderId,
    virtualPath: normalized,
  });
}

export function getCachedVirtualPathByDriveId(
  rootFolderId: string,
  driveFolderId: string
): string | null {
  return driveIdToPathCache.get(`${rootFolderId}:${driveFolderId}`)?.virtualPath ?? null;
}

export function clearRemoteFolderCache(rootFolderId?: string): void {
  if (!rootFolderId) {
    remoteFolderCache.clear();
    driveIdToPathCache.clear();
    return;
  }

  const prefix = `${rootFolderId}:`;
  for (const key of remoteFolderCache.keys()) {
    if (key.startsWith(prefix)) {
      remoteFolderCache.delete(key);
    }
  }
  for (const [key, entry] of driveIdToPathCache.entries()) {
    if (entry.rootFolderId === rootFolderId || key.startsWith(prefix)) {
      driveIdToPathCache.delete(key);
    }
  }
}

/**
 * Normalizes a virtual path to posix format with leading slash and no trailing slash.
 */
export function normalizeVirtualPath(rawPath: string): string {
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '') return '/';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/**
 * Recursively creates and mirrors a directory structure under the account's _Tsubasa~ Pool <N> root folder.
 * Returns the Google Drive folder ID for the leaf directory.
 */
export async function ensureRemoteFolderHierarchy(
  drive: drive_v3.Drive,
  rootFolderId: string,
  virtualFolderPath: string
): Promise<string> {
  const normalized = normalizeVirtualPath(virtualFolderPath);
  if (normalized === '/') {
    return rootFolderId;
  }

  const cacheKey = `${rootFolderId}:${normalized}`;
  const cachedId = remoteFolderCache.get(cacheKey);
  if (cachedId) {
    return cachedId;
  }

  const segments = normalized.split('/').filter(Boolean);
  let currentParentId = rootFolderId;
  let accumulatedPath = '';

  for (const segment of segments) {
    accumulatedPath += `/${segment}`;
    const segmentCacheKey = `${rootFolderId}:${accumulatedPath}`;
    const segmentCachedId = remoteFolderCache.get(segmentCacheKey);

    if (segmentCachedId) {
      currentParentId = segmentCachedId;
      continue;
    }

    let folderPromise = inFlightFolderPromises.get(segmentCacheKey);
    if (!folderPromise) {
      const parentIdForSegment = currentParentId;
      const pathForSegment = accumulatedPath;

      folderPromise = (async () => {
        const recheckedId = remoteFolderCache.get(segmentCacheKey);
        if (recheckedId) {
          return recheckedId;
        }

        const escapedName = segment.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const query = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and '${parentIdForSegment}' in parents and trashed = false`;

        const searchRes = await withDriveRetry(() =>
          drive.files.list({
            q: query,
            spaces: 'drive',
            fields: 'files(id, name)',
            pageSize: 1,
            supportsAllDrives: false,
          })
        );

        let folderId: string | null = null;
        if (searchRes.data.files && searchRes.data.files.length > 0) {
          folderId = searchRes.data.files[0]?.id || null;
        }

        if (!folderId) {
          const createRes = await withDriveRetry(() =>
            drive.files.create({
              requestBody: {
                name: segment,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentIdForSegment],
                appProperties: {
                  tsubasa_managed: 'true',
                  tsubasa_folder_path: pathForSegment,
                },
              },
              fields: 'id',
              supportsAllDrives: false,
            })
          );

          folderId = createRes.data.id || null;
          if (!folderId) {
            throw new Error(`Failed to create remote directory "${segment}" in Google Drive`);
          }
        }

        setCachedRemoteFolder(rootFolderId, pathForSegment, folderId);
        return folderId;
      })().finally(() => {
        inFlightFolderPromises.delete(segmentCacheKey);
      });

      inFlightFolderPromises.set(segmentCacheKey, folderPromise);
    }

    currentParentId = await folderPromise;
  }

  setCachedRemoteFolder(rootFolderId, normalized, currentParentId);
  return currentParentId;
}

