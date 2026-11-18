import path from 'node:path';

/**
 * Normalizes a virtual path to posix format with leading slash and no trailing slash.
 */
export function normalizeVirtualPath(rawPath: string): string {
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '') return '/';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}
