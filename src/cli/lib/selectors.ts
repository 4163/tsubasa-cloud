import {
  RESERVED_POOL_SLUGS,
  deriveUniquePoolSlug,
  slugifyPoolName as serverSlugifyPoolName,
  validatePoolSlug as serverValidatePoolSlug,
} from '../../server/storage/poolSlug.js';
export {
  RESERVED_POOL_SLUGS,
  deriveUniquePoolSlug,
} from '../../server/storage/poolSlug.js';
export {
  type AccountCandidate,
  AmbiguousAccountSelectorError,
  resolveAccountSelector,
} from '../../server/storage/redact.js';

const REMOTE_PREFIX_PATTERN = /^([a-zA-Z0-9][a-zA-Z0-9-]{1,62}):\/(.*)$/;

export function validatePoolSlug(
  slug: string,
  options?: { allowReserved?: boolean; allowReservedShare?: boolean }
): { ok: true; slug: string } | { ok: false; error: string } {
  const res = serverValidatePoolSlug(slug, {
    allowReservedShare: options?.allowReservedShare ?? options?.allowReserved,
  });
  if (res.ok) {
    return { ok: true, slug: res.slug };
  }
  if (options?.allowReserved && RESERVED_POOL_SLUGS.has(slug.trim())) {
    return { ok: true, slug: slug.trim() };
  }
  return { ok: false, error: res.error };
}

export function slugifyPoolName(name: string, existingSlugs?: Iterable<string>): string {
  if (existingSlugs) {
    return deriveUniquePoolSlug(name, existingSlugs);
  }
  return serverSlugifyPoolName(name);
}

export function parseRemoteSelector(input: string): {
  pool?: string;
  path: string;
  isRemote: boolean;
} {
  const match = REMOTE_PREFIX_PATTERN.exec(input);
  if (!match) {
    return { path: input, isRemote: false };
  }

  const rawPool = match[1];
  const rawRest = match[2] ?? '';
  if (!rawPool || rawPool.length < 2) {
    return { path: input, isRemote: false };
  }

  const normalizedRest = rawRest.replace(/^\/+/, '');
  const normalizedPath = normalizedRest.length > 0 ? `/${normalizedRest}` : '/';

  return {
    pool: rawPool.toLowerCase(),
    path: normalizedPath,
    isRemote: true,
  };
}
