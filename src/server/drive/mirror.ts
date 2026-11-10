import type { drive_v3 } from 'googleapis';
import path from 'node:path';

// In-memory cache mapping `${rootFolderId}:${normalizedVirtualPath}` to Google Drive folder ID
const remoteFolderCache = new Map<string, string>();

export function clearRemoteFolderCache(): void {
  remoteFolderCache.clear();
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

    // Escape single quotes for Google Drive search query
    const escapedName = segment.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const query = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and '${currentParentId}' in parents and trashed = false`;

    const searchRes = await drive.files.list({
      q: query,
      spaces: 'drive',
      fields: 'files(id, name)',
      pageSize: 1,
      supportsAllDrives: false,
    });

    let folderId: string | null = null;
    if (searchRes.data.files && searchRes.data.files.length > 0) {
      folderId = searchRes.data.files[0]?.id || null;
    }

    if (!folderId) {
      const createRes = await drive.files.create({
        requestBody: {
          name: segment,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [currentParentId],
          appProperties: {
            tsubasa_managed: 'true',
            tsubasa_folder_path: accumulatedPath,
          },
        },
        fields: 'id',
        supportsAllDrives: false,
      });

      folderId = createRes.data.id || null;
      if (!folderId) {
        throw new Error(`Failed to create remote directory "${segment}" in Google Drive`);
      }
    }

    remoteFolderCache.set(segmentCacheKey, folderId);
    currentParentId = folderId;
  }

  remoteFolderCache.set(cacheKey, currentParentId);
  return currentParentId;
}

