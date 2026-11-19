import { redactPayload, scrubEmailsInString } from './redact.js';
import { AmbiguousAccountSelectorError } from './selectors.js';

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const EXIT_CODES = {
  SUCCESS: 0,
  RUNTIME: 1,
  USAGE: 2,
  QUOTA: 3,
  CONFLICT: 4,
  AUTH_UPSTREAM: 5,
  NOT_FOUND: 6,
} as const;

export interface CliErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    exitCode: ExitCode;
    details: unknown;
    hint: string | null;
  };
}

const USAGE_CODES = new Set<string>([
  'AMBIGUOUS_ACCOUNT_SELECTOR',
  'CONFIRMATION_REQUIRED',
  'USAGE_ERROR',
  'VALIDATION_ERROR',
  'INVALID_ARGUMENT',
  'INVALID_POOL_SLUG',
]);

const QUOTA_CODES = new Set<string>([
  'EXCEEDS_CEILING',
  'INSUFFICIENT_STORAGE',
  'TRANSFER_QUOTA_EXCEEDED',
  'QUOTA_EXCEEDED',
]);

const CONFLICT_CODES = new Set<string>([
  'WRITER_LOCK_HELD',
  'SHARE_POOL_READ_ONLY',
  'SHARE_POOL_PROTECTED',
  'ITEM_EXISTS',
  'MOVE_CONFLICT',
  'ACCOUNT_POOL_LOCKED',
  'POOL_NOT_EMPTY',
  'CONFLICT',
]);

const AUTH_UPSTREAM_CODES = new Set<string>([
  'AUTH_ERROR',
  'UPSTREAM_ERROR',
  'SERVER_UNREACHABLE',
  'UNAUTHORIZED',
]);

const NOT_FOUND_CODES = new Set<string>([
  'NOT_FOUND',
  'POOL_NOT_FOUND',
  'ACCOUNT_NOT_FOUND',
  'FILE_NOT_FOUND',
]);

export function mapErrorCodeToExitCode(code: string | undefined, httpStatus?: number): ExitCode {
  if (code) {
    const normalized = code.toUpperCase();
    if (USAGE_CODES.has(normalized)) return EXIT_CODES.USAGE;
    if (QUOTA_CODES.has(normalized)) return EXIT_CODES.QUOTA;
    if (CONFLICT_CODES.has(normalized)) return EXIT_CODES.CONFLICT;
    if (AUTH_UPSTREAM_CODES.has(normalized)) return EXIT_CODES.AUTH_UPSTREAM;
    if (NOT_FOUND_CODES.has(normalized)) return EXIT_CODES.NOT_FOUND;
  }

  if (typeof httpStatus === 'number') {
    if (httpStatus === 400 || httpStatus === 422) return EXIT_CODES.USAGE;
    if (httpStatus === 401 || httpStatus === 403) return EXIT_CODES.AUTH_UPSTREAM;
    if (httpStatus === 404) return EXIT_CODES.NOT_FOUND;
    if (httpStatus === 409 || httpStatus === 423) return EXIT_CODES.CONFLICT;
    if (httpStatus === 507 || httpStatus === 429) return EXIT_CODES.QUOTA;
    if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
      return EXIT_CODES.AUTH_UPSTREAM;
    }
  }

  return EXIT_CODES.RUNTIME;
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly details: unknown;
  readonly hint: string | null;

  constructor(
    code: string,
    message: string,
    options?: {
      exitCode?: ExitCode;
      details?: unknown;
      hint?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = options?.exitCode ?? mapErrorCodeToExitCode(code);
    this.details = options?.details ?? null;
    this.hint = options?.hint ?? null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function toCliErrorEnvelope(
  err: unknown,
  options?: { showEmails?: boolean },
): CliErrorEnvelope {
  const showEmails = options?.showEmails === true;
  const scrub = (text: string): string => (showEmails ? text : scrubEmailsInString(text));
  const redactDetails = (details: unknown): unknown => {
    if (details === null || details === undefined || showEmails) {
      return details ?? null;
    }
    if (typeof details === 'string') {
      return scrubEmailsInString(details);
    }
    return redactPayload(details, { showEmails: false });
  };

  if (err instanceof CliError) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: scrub(err.message),
        exitCode: err.exitCode,
        details: redactDetails(err.details),
        hint: err.hint ? scrub(err.hint) : null,
      },
    };
  }

  if (err instanceof AmbiguousAccountSelectorError) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: scrub(err.message),
        exitCode: EXIT_CODES.USAGE,
        details: {
          selector: scrub(err.selector),
          candidates: err.candidates,
        },
        hint: 'Pass the exact accountRef (acc_<8-hex>) or a longer email prefix.',
      },
    };
  }

  if (isRecord(err) && !(err instanceof Error)) {
    const rawCode = typeof err.code === 'string' && err.code.length > 0 ? err.code : undefined;
    const rawStatus = typeof err.status === 'number' ? err.status : undefined;
    const rawMessage =
      typeof err.error === 'string' && err.error.length > 0
        ? err.error
        : typeof err.message === 'string' && err.message.length > 0
          ? err.message
          : 'Command failed.';
    const rawHint = typeof err.hint === 'string' && err.hint.length > 0 ? err.hint : null;

    let details: unknown = err.details ?? null;
    if (details === null && ('conflicts' in err || 'cleanCount' in err)) {
      details = {
        ...(err.conflicts !== undefined ? { conflicts: err.conflicts } : {}),
        ...(err.cleanCount !== undefined ? { cleanCount: err.cleanCount } : {}),
      };
    }

    const inferredCode =
      rawCode ??
      (err.conflicts !== undefined ? 'MOVE_CONFLICT' : undefined) ??
      'RUNTIME_ERROR';
    const exitCode = mapErrorCodeToExitCode(inferredCode, rawStatus);

    return {
      ok: false,
      error: {
        code: inferredCode,
        message: scrub(rawMessage),
        exitCode,
        details: redactDetails(details),
        hint: rawHint ? scrub(rawHint) : null,
      },
    };
  }

  if (err instanceof Error) {
    const anyErr = err as Error & {
      code?: unknown;
      status?: unknown;
      details?: unknown;
      hint?: unknown;
    };
    const code =
      typeof anyErr.code === 'string' && anyErr.code.length > 0
        ? anyErr.code
        : 'RUNTIME_ERROR';
    const status = typeof anyErr.status === 'number' ? anyErr.status : undefined;
    const hint = typeof anyErr.hint === 'string' && anyErr.hint.length > 0 ? anyErr.hint : null;

    return {
      ok: false,
      error: {
        code,
        message: scrub(err.message || 'Unexpected error.'),
        exitCode: mapErrorCodeToExitCode(code, status),
        details: redactDetails(anyErr.details),
        hint: hint ? scrub(hint) : null,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: 'RUNTIME_ERROR',
      message: scrub(typeof err === 'string' ? err : 'Unexpected runtime error.'),
      exitCode: EXIT_CODES.RUNTIME,
      details: null,
      hint: null,
    },
  };
}

export function formatCliError(
  err: unknown,
  options?: { json?: boolean; showEmails?: boolean },
): { text: string; exitCode: ExitCode } {
  const envelope = toCliErrorEnvelope(err, { showEmails: options?.showEmails });

  if (options?.json) {
    return {
      text: `${JSON.stringify(envelope)}\n`,
      exitCode: envelope.error.exitCode,
    };
  }

  const lines = [`Error [${envelope.error.code}]: ${envelope.error.message}`];
  if (envelope.error.hint) {
    lines.push(`Hint: ${envelope.error.hint}`);
  }

  return {
    text: `${lines.join('\n')}\n`,
    exitCode: envelope.error.exitCode,
  };
}
