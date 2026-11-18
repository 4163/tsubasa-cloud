import type { drive_v3 } from 'googleapis';
import path from 'node:path';
import { isDriveNotFoundError, withDriveRetry } from './client.js';

// In-memory cache mapping `${rootFolderId}:${normalizedVirtualPath}` to Google Drive folder ID
const remoteFolderCache = new Map<string, string>();
const driveIdToPathCache = new Map<string, { rootFolderId: string; virtualPath: string }>();
const inFlightFolderPromises = new Map<string, { generation: number; promise: Promise<string> }>();
const rootCacheGeneration = new Map<string, number>();
let globalCacheGeneration = 0;

function getCacheGeneration(rootFolderId: string): number {
  return rootCacheGeneration.get(rootFolderId) ?? globalCacheGeneration;
}

function bumpCacheGeneration(rootFolderId?: string): void {
  if (!rootFolderId) {
    globalCacheGeneration += 1;
    for (const [rootId, gen] of rootCacheGeneration.entries()) {
      rootCacheGeneration.set(rootId, gen + 1);
    }
    return;
  }
  rootCacheGeneration.set(rootFolderId, getCacheGeneration(rootFolderId) + 1);
}

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
    bumpCacheGeneration();
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
  bumpCacheGeneration(rootFolderId);
}

export function evictRemoteFolderByDriveId(rootFolderId: string, driveFolderId: string): void {
  const driveKey = `${rootFolderId}:${driveFolderId}`;
  const entry = driveIdToPathCache.get(driveKey);
  if (!entry) {
    return;
  }

  driveIdToPathCache.delete(driveKey);
  remoteFolderCache.delete(`${rootFolderId}:${entry.virtualPath}`);

  const descendantPrefix = entry.virtualPath === '/' ? '/' : `${entry.virtualPath}/`;
  const rootPrefix = `${rootFolderId}:`;
  for (const key of remoteFolderCache.keys()) {
    if (!key.startsWith(rootPrefix)) continue;
    const cachedPath = key.slice(rootPrefix.length);
    if (cachedPath === entry.virtualPath || cachedPath.startsWith(descendantPrefix)) {
      remoteFolderCache.delete(key);
    }
  }
  for (const [key, item] of driveIdToPathCache.entries()) {
    if (
      item.rootFolderId === rootFolderId &&
      (item.virtualPath === entry.virtualPath || item.virtualPath.startsWith(descendantPrefix))
    ) {
      driveIdToPathCache.delete(key);
    }
  }

  bumpCacheGeneration(rootFolderId);
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

  for (let attempt = 0; attempt < 2; attempt++) {
    const startGeneration = getCacheGeneration(rootFolderId);
    let currentParentId = rootFolderId;
    let accumulatedPath = '';
    let shouldRetryFromRoot = false;

    for (const segment of segments) {
      accumulatedPath += `/${segment}`;
      const segmentCacheKey = `${rootFolderId}:${accumulatedPath}`;
      const segmentCachedId = remoteFolderCache.get(segmentCacheKey);

      if (segmentCachedId) {
        currentParentId = segmentCachedId;
        continue;
      }

      const currentGeneration = getCacheGeneration(rootFolderId);
      const existingInFlight = inFlightFolderPromises.get(segmentCacheKey);
      let folderPromise: Promise<string>;

      if (existingInFlight && existingInFlight.generation === currentGeneration) {
        folderPromise = existingInFlight.promise;
      } else {
        const capturedGeneration = currentGeneration;
        const parentIdForSegment = currentParentId;
        const pathForSegment = accumulatedPath;

        const newPromise = (async () => {
          const recheckedId = remoteFolderCache.get(segmentCacheKey);
          if (recheckedId) {
            return recheckedId;
          }

          const escapedName = segment.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const query = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and '${parentIdForSegment}' in parents`;

          const searchRes = await withDriveRetry(() =>
            drive.files.list({
              q: query,
              spaces: 'drive',
              fields: 'files(id, name, trashed)',
              pageSize: 10,
              supportsAllDrives: false,
            })
          );

          const matchedFiles = searchRes.data.files ?? [];
          const selectedMatch =
            matchedFiles.find((f) => f.id && !f.trashed) ?? matchedFiles.find((f) => f.id && f.trashed);

          const matchedId = selectedMatch?.id ?? null;
          let folderId: string | null = matchedId;

          if (matchedId && selectedMatch?.trashed === true) {
            await withDriveRetry(() =>
              drive.files.update({
                fileId: matchedId,
                requestBody: {
                  trashed: false,
                  appProperties: {
                    tsubasa_managed: 'true',
                    tsubasa_folder_path: pathForSegment,
                  },
                },
                supportsAllDrives: false,
              })
            );
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

          if (getCacheGeneration(rootFolderId) === capturedGeneration) {
            setCachedRemoteFolder(rootFolderId, pathForSegment, folderId);
          }
          return folderId;
        })().finally(() => {
          const active = inFlightFolderPromises.get(segmentCacheKey);
          if (active?.promise === newPromise) {
            inFlightFolderPromises.delete(segmentCacheKey);
          }
        });

        inFlightFolderPromises.set(segmentCacheKey, {
          generation: capturedGeneration,
          promise: newPromise,
        });
        folderPromise = newPromise;
      }

      try {
        currentParentId = await folderPromise;
      } catch (err) {
        if (attempt === 0 && currentParentId !== rootFolderId && isDriveNotFoundError(err)) {
          clearRemoteFolderCache(rootFolderId);
          shouldRetryFromRoot = true;
          break;
        }
        throw err;
      }
    }

    if (shouldRetryFromRoot) {
      continue;
    }

    if (getCacheGeneration(rootFolderId) === startGeneration) {
      setCachedRemoteFolder(rootFolderId, normalized, currentParentId);
    }
    return currentParentId;
  }

  throw new Error(`Failed to ensure remote directory "${normalized}" in Google Drive`);
}

