export const SHARE_POOL_SLUG = 'share';
export const SHARE_POOL_SORT_ORDER = 1_000_000;
export const POOL_SLUG_MIN_LENGTH = 2;
export const POOL_SLUG_MAX_LENGTH = 63;
export const POOL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const RESERVED_POOL_SLUGS: ReadonlySet<string> = new Set(['share', 'all']);

export interface ValidatePoolSlugOptions {
  allowReservedShare?: boolean;
}

export type PoolSlugValidationResult =
  | { ok: true; slug: string }
  | { ok: false; code: 'INVALID_POOL_SLUG' | 'RESERVED_POOL_SLUG'; error: string };

export function validatePoolSlug(
  raw: unknown,
  options: ValidatePoolSlugOptions = {}
): PoolSlugValidationResult {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'INVALID_POOL_SLUG',
      error: 'Pool slug must be a string',
    };
  }

  const slug = raw.trim();
  if (slug.length < POOL_SLUG_MIN_LENGTH || slug.length > POOL_SLUG_MAX_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_POOL_SLUG',
      error: `Pool slug must be between ${POOL_SLUG_MIN_LENGTH} and ${POOL_SLUG_MAX_LENGTH} characters`,
    };
  }

  if (!POOL_SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      code: 'INVALID_POOL_SLUG',
      error: 'Pool slug must match ^[a-z0-9][a-z0-9-]{1,62}$',
    };
  }

  if (!/[^0-9]/.test(slug)) {
    return {
      ok: false,
      code: 'INVALID_POOL_SLUG',
      error: 'Pool slug cannot be purely numeric',
    };
  }

  if (RESERVED_POOL_SLUGS.has(slug)) {
    if (slug === SHARE_POOL_SLUG && options.allowReservedShare) {
      return { ok: true, slug };
    }
    return {
      ok: false,
      code: 'RESERVED_POOL_SLUG',
      error: `Pool slug '${slug}' is reserved`,
    };
  }

  return { ok: true, slug };
}

export function isValidPoolSlug(
  slug: string,
  options: ValidatePoolSlugOptions = {}
): boolean {
  return validatePoolSlug(slug, options).ok;
}

function trimToMaxSlugLength(value: string, maxLength: number): string {
  const sliced = value.slice(0, maxLength).replace(/-+$/g, '');
  return sliced;
}

export function slugifyPoolName(name: string, fallbackId?: number): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  let candidate = normalized;

  if (!candidate) {
    candidate = fallbackId !== undefined ? `pool-${fallbackId}` : 'pool';
  } else if (/^\d+$/.test(candidate)) {
    candidate = `pool-${candidate}`;
  } else if (candidate.length < POOL_SLUG_MIN_LENGTH) {
    candidate = `pool-${candidate}`;
  } else if (RESERVED_POOL_SLUGS.has(candidate)) {
    candidate = `pool-${candidate}`;
  }

  candidate = trimToMaxSlugLength(candidate, POOL_SLUG_MAX_LENGTH);

  if (
    candidate.length < POOL_SLUG_MIN_LENGTH ||
    !/[^0-9]/.test(candidate) ||
    RESERVED_POOL_SLUGS.has(candidate)
  ) {
    const prefixed = `pool-${candidate || (fallbackId !== undefined ? String(fallbackId) : 'default')}`;
    candidate = trimToMaxSlugLength(prefixed, POOL_SLUG_MAX_LENGTH);
  }

  return candidate;
}

export function deduplicatePoolSlug(
  baseSlug: string,
  existingSlugs: Iterable<string>
): string {
  const taken = new Set<string>();
  for (const slug of existingSlugs) {
    taken.add(slug.toLowerCase());
  }

  const normalizedBase = isValidPoolSlug(baseSlug) ? baseSlug : slugifyPoolName(baseSlug);

  if (!taken.has(normalizedBase) && !RESERVED_POOL_SLUGS.has(normalizedBase)) {
    return normalizedBase;
  }

  let suffix = 2;
  while (true) {
    const suffixText = `-${suffix}`;
    const maxBaseLen = POOL_SLUG_MAX_LENGTH - suffixText.length;
    const trimmedBase = trimToMaxSlugLength(normalizedBase, maxBaseLen) || 'pool';
    const candidate = `${trimmedBase}${suffixText}`;
    if (!taken.has(candidate) && !RESERVED_POOL_SLUGS.has(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

export function deriveUniquePoolSlug(
  name: string,
  existingSlugs: Iterable<string>,
  fallbackId?: number
): string {
  return deduplicatePoolSlug(slugifyPoolName(name, fallbackId), existingSlugs);
}
