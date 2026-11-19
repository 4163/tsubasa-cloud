import { maskEmail, toAccountRef } from './redact.js';

const POOL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const NON_DIGIT_PATTERN = /[a-z-]/;
const REMOTE_PREFIX_PATTERN = /^([a-zA-Z0-9][a-zA-Z0-9-]{1,62}):\/(.*)$/;

export const RESERVED_POOL_SLUGS = new Set<string>(['share', 'all']);

export function validatePoolSlug(
  slug: string,
  options?: { allowReserved?: boolean },
): { ok: true; slug: string } | { ok: false; error: string } {
  const normalized = slug.trim();

  if (normalized.length < 2 || normalized.length > 63) {
    return {
      ok: false,
      error: 'Pool slug must be between 2 and 63 characters.',
    };
  }

  if (!POOL_SLUG_PATTERN.test(normalized)) {
    return {
      ok: false,
      error: 'Pool slug must start with a lowercase letter or digit and contain only lowercase letters, digits, or hyphens.',
    };
  }

  if (!NON_DIGIT_PATTERN.test(normalized)) {
    return {
      ok: false,
      error: 'Pool slug cannot be purely numeric.',
    };
  }

  if (!options?.allowReserved && RESERVED_POOL_SLUGS.has(normalized)) {
    return {
      ok: false,
      error: `Pool slug "${normalized}" is reserved.`,
    };
  }

  return { ok: true, slug: normalized };
}

function trimTrailingHyphens(value: string): string {
  return value.replace(/-+$/g, '');
}

export function slugifyPoolName(name: string, existingSlugs?: Iterable<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (base.length === 0) {
    base = 'pool';
  } else if (!NON_DIGIT_PATTERN.test(base) || base.length < 2) {
    base = `pool-${base}`;
  }

  base = trimTrailingHyphens(base.slice(0, 63));
  if (base.length < 2) {
    base = 'pool';
  }

  if (RESERVED_POOL_SLUGS.has(base)) {
    base = `${base}-pool`;
  }

  const taken = new Set<string>();
  if (existingSlugs) {
    for (const s of existingSlugs) {
      taken.add(s.toLowerCase());
    }
  }

  if (!taken.has(base)) {
    return base;
  }

  let counter = 2;
  while (true) {
    const suffix = `-${counter}`;
    const maxBaseLen = 63 - suffix.length;
    const truncatedBase = trimTrailingHyphens(base.slice(0, maxBaseLen)) || 'pool';
    const candidate = `${truncatedBase}${suffix}`;
    if (!taken.has(candidate) && !RESERVED_POOL_SLUGS.has(candidate)) {
      return candidate;
    }
    counter += 1;
  }
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

export interface AccountCandidate {
  id: string;
  email: string;
  accountRef?: string;
}

export class AmbiguousAccountSelectorError extends Error {
  readonly code = 'AMBIGUOUS_ACCOUNT_SELECTOR' as const;
  readonly selector: string;
  readonly candidates: Array<{ accountRef: string; maskedEmail: string }>;

  constructor(
    selector: string,
    candidates: Array<{ accountRef: string; maskedEmail: string }>,
  ) {
    const list = candidates.map((c) => `${c.accountRef} (${c.maskedEmail})`).join(', ');
    super(`Ambiguous account selector "${selector}" matches multiple accounts: ${list}`);
    this.name = 'AmbiguousAccountSelectorError';
    this.selector = selector;
    this.candidates = candidates;
  }
}

export function resolveAccountSelector<T extends AccountCandidate>(
  selector: string,
  accounts: readonly T[],
): T | null {
  const query = selector.trim().toLowerCase();
  if (query.length === 0) return null;

  for (const account of accounts) {
    const ref = (account.accountRef ?? toAccountRef(account.id)).toLowerCase();
    if (ref === query) {
      return account;
    }
  }

  for (const account of accounts) {
    if (account.id.toLowerCase() === query || account.email.toLowerCase() === query) {
      return account;
    }
  }

  const prefixMatches = accounts.filter((account) =>
    account.email.toLowerCase().startsWith(query),
  );

  if (prefixMatches.length === 1) {
    return prefixMatches[0] ?? null;
  }

  if (prefixMatches.length > 1) {
    const candidates = prefixMatches.map((account) => ({
      accountRef: account.accountRef ?? toAccountRef(account.id),
      maskedEmail: maskEmail(account.email),
    }));
    throw new AmbiguousAccountSelectorError(selector, candidates);
  }

  return null;
}
