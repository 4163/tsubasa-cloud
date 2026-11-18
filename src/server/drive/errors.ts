export type FileContentMatchStatus = 'identical' | 'different' | 'unverified';

export class ItemConflictError extends Error {}
export class ItemNotFoundError extends Error {}

export function validateItemName(rawName: string): string {
  const trimmed = rawName.trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(trimmed)
  ) {
    throw new Error('Invalid name: cannot be empty, ".", "..", or contain slashes or control characters');
  }
  return trimmed;
}

export interface MoveConflictItem {
  sourceFileId: string;
  sourcePath: string;
  sourceName: string;
  sourceSizeBytes: number;
  sourceUpdatedAt: number;
  destPath: string;
  existingFileId?: string;
  existingSizeBytes?: number;
  existingUpdatedAt?: number;
  contentMatch?: FileContentMatchStatus;
  canOverwrite?: boolean;
}

export class MoveConflictError extends Error {
  readonly conflicts: MoveConflictItem[];
  readonly cleanCount: number;

  constructor(conflicts: MoveConflictItem[], cleanCount: number) {
    super(
      conflicts.length === 1
        ? `"${conflicts[0].sourceName}" already exists in the destination folder`
        : `${conflicts.length} files already exist in the destination folder`
    );
    this.conflicts = conflicts;
    this.cleanCount = cleanCount;
  }
}

export class AccountPoolLockedError extends Error {
  constructor(message = 'Account already has files linked to its current pool and cannot be switched') {
    super(message);
    this.name = 'AccountPoolLockedError';
  }
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const MAX_RETRY_AFTER_MS = 60_000;

export function getDriveErrorStatus(err: unknown): number | null {
  const e = err as { status?: unknown; response?: { status?: unknown }; code?: unknown } | null | undefined;
  const candidates = [e?.status, e?.response?.status, e?.code];
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }
  return null;
}

export function isDriveNotFoundError(err: unknown): boolean {
  const status = getDriveErrorStatus(err);
  return status === 404 || status === 410;
}

export function isAuthInvalidError(err: unknown): boolean {
  if (getDriveErrorStatus(err) === 401) {
    return true;
  }

  const e = err as {
    message?: unknown;
    response?: { data?: { error?: unknown; error_description?: unknown } };
    data?: { error?: unknown };
  } | null | undefined;

  const candidates = [
    e?.message,
    e?.response?.data?.error,
    e?.response?.data?.error_description,
    e?.data?.error,
  ];
  for (const val of candidates) {
    if (typeof val === 'string' && val.includes('invalid_grant')) {
      return true;
    }
    if (
      val &&
      typeof val === 'object' &&
      'message' in val &&
      typeof (val as { message?: unknown }).message === 'string' &&
      (val as { message: string }).message.includes('invalid_grant')
    ) {
      return true;
    }
  }
  return false;
}

function isRateLimit403(err: any): boolean {
  const lists = [err?.errors, err?.response?.data?.error?.errors];
  for (const list of lists) {
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item?.reason === 'rateLimitExceeded' || item?.reason === 'userRateLimitExceeded') {
          return true;
        }
      }
    }
  }
  const msg = String(err?.message || '');
  return msg.includes('rateLimitExceeded') || msg.includes('userRateLimitExceeded');
}

function isRetryableDriveError(err: any): boolean {
  const status = getDriveErrorStatus(err);
  if (status === 429 || (status !== null && status >= 500 && status <= 599)) {
    return true;
  }
  if (status === 403 && isRateLimit403(err)) {
    return true;
  }
  const code = err?.code ?? err?.cause?.code;
  return typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code);
}

function parseRetryAfterMs(err: any): number | null {
  const headers = err?.response?.headers;
  if (!headers) {
    return null;
  }

  let raw: unknown;
  if (typeof headers.get === 'function') {
    raw = headers.get('retry-after');
  } else {
    raw = headers['retry-after'] ?? headers['Retry-After'];
  }

  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }

  const value = String(raw).trim();
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const targetMs = Date.parse(value);
  if (Number.isFinite(targetMs)) {
    return Math.max(0, targetMs - Date.now());
  }

  return null;
}

export async function withDriveRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; baseDelayMs?: number }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 5;
  const baseDelayMs = options?.baseDelayMs ?? 500;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableDriveError(err)) {
        throw err;
      }

      const retryAfterMs = parseRetryAfterMs(err);
      if (retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS) {
        throw err;
      }

      let delayMs: number;
      if (retryAfterMs === 0) {
        delayMs = Math.round(baseDelayMs * (0.5 + Math.random() * 0.5));
      } else if (retryAfterMs !== null) {
        delayMs = retryAfterMs;
      } else {
        delayMs = Math.round(baseDelayMs * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5));
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function runBoundedConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  let hasError = false;
  let firstError: unknown;

  const runners = Array.from({ length: limit }, async () => {
    while (!hasError && nextIndex < items.length) {
      const idx = nextIndex++;
      try {
        await worker(items[idx]);
      } catch (err) {
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
        return;
      }
    }
  });

  await Promise.allSettled(runners);
  if (hasError) {
    throw firstError;
  }
}

export function normalizeContentHash(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/^(sha256-|md5-)/, '');
  return cleaned || null;
}

/**
 * Compares file sizes and normalized hashes of matching digest length.
 * Returns 'unverified' when sizes match but no comparable hash pair is present.
 */
export function evaluateFileContentMatch(
  sizeA: number,
  hashesA: Array<string | null | undefined>,
  sizeB: number,
  hashB: string | null | undefined
): FileContentMatchStatus {
  if (sizeA !== sizeB) return 'different';

  const setA = new Set<string>();
  for (const h of hashesA) {
    const nh = normalizeContentHash(h);
    if (nh) setA.add(nh);
  }
  const normB = normalizeContentHash(hashB);

  if (sizeA === 0 && setA.size === 0 && !normB) {
    return 'identical';
  }
  if (setA.size === 0 || !normB) {
    return 'unverified';
  }

  let hasSameLengthCandidate = false;
  for (const cand of setA) {
    if (cand.length === normB.length) {
      hasSameLengthCandidate = true;
      if (cand === normB) {
        return 'identical';
      }
    }
  }

  return hasSameLengthCandidate ? 'different' : 'unverified';
}
