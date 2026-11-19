import { createHash } from 'node:crypto';

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const ACCOUNT_REF_RE = /^acc_[0-9a-f]{8}$/;
const SCRUB_TEXT_KEYS = new Set([
  'message',
  'error',
  'lastError',
  'hint',
  'pauseReason',
  'sourceFile',
  'command',
]);
const EMAIL_STRING_ARRAY_KEYS = new Set(['hydrated', 'synced']);

function isValidAccountRef(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_REF_RE.test(value);
}

function canDeriveAccountRef(raw: string): boolean {
  // Never hash an already-masked email string into a bogus accountRef.
  return raw.length > 0 && !raw.includes('*');
}

export function toAccountRef(accountId: string): string {
  const normalized = accountId.trim().toLowerCase();
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `acc_${digest.slice(0, 8)}`;
}

function maskLocalPart(local: string): string {
  const len = local.length;
  if (len <= 1) return '*';
  if (len === 2) return `${local[0]}*`;
  return `${local[0]}***${local[len - 1]}`;
}

function maskDomainLabel(label: string): string {
  if (label.length <= 1) return '*';
  return `${label[0]}***`;
}

export function maskEmail(email: string): string {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return email;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const maskedLocal = maskLocalPart(local);

  const labels = domain.split('.');
  if (labels.length <= 1) {
    return `${maskedLocal}@${maskDomainLabel(domain)}`;
  }

  const [firstLabel = '', ...restLabels] = labels;
  return `${maskedLocal}@${maskDomainLabel(firstLabel)}.${restLabels.join('.')}`;
}

export function scrubEmailsInString(text: string): string {
  return text.replace(EMAIL_PATTERN, (match) => maskEmail(match));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function redactPayload<T>(value: T, options?: { showEmails?: boolean }): T {
  const showEmails = options?.showEmails === true;

  if (Array.isArray(value)) {
    return value.map((item) => redactPayload(item, options)) as unknown as T;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && !showEmails && SCRUB_TEXT_KEYS.has(key)) {
      out[key] = scrubEmailsInString(entry);
    } else if (Array.isArray(entry) && !showEmails && EMAIL_STRING_ARRAY_KEYS.has(key)) {
      out[key] = entry.map((item) =>
        typeof item === 'string'
          ? item.includes('@')
            ? maskEmail(item)
            : scrubEmailsInString(item)
          : redactPayload(item, options)
      );
    } else {
      out[key] = redactPayload(entry, options);
    }
  }

  const rawAccountId =
    typeof value.accountId === 'string' && value.accountId.length > 0 ? value.accountId : undefined;
  const rawAccountEmail =
    typeof value.accountEmail === 'string' && value.accountEmail.length > 0
      ? value.accountEmail
      : undefined;
  const rawAccountDisplayName =
    typeof value.accountDisplayName === 'string' && value.accountDisplayName.length > 0
      ? value.accountDisplayName
      : undefined;
  const rawSourceAccountId =
    typeof value.sourceAccountId === 'string' && value.sourceAccountId.length > 0
      ? value.sourceAccountId
      : undefined;
  const rawTargetAccountId =
    typeof value.targetAccountId === 'string' && value.targetAccountId.length > 0
      ? value.targetAccountId
      : undefined;
  const rawEmail =
    typeof value.email === 'string' && value.email.length > 0 ? value.email : undefined;
  const rawSourceEmail =
    typeof value.sourceEmail === 'string' && value.sourceEmail.length > 0
      ? value.sourceEmail
      : undefined;
  const rawId = typeof value.id === 'string' && value.id.length > 0 ? value.id : undefined;

  if (rawAccountId !== undefined) {
    if (!isValidAccountRef(out.accountRef) && canDeriveAccountRef(rawAccountId)) {
      out.accountRef = toAccountRef(rawAccountId);
    }
    if (!showEmails) {
      out.accountId = maskEmail(rawAccountId);
    }
  }

  if (rawAccountEmail !== undefined) {
    if (!isValidAccountRef(out.accountRef) && canDeriveAccountRef(rawAccountEmail)) {
      out.accountRef = toAccountRef(rawAccountEmail);
    }
    if (!showEmails) {
      out.accountEmail = maskEmail(rawAccountEmail);
    }
  }

  if (rawAccountDisplayName !== undefined && !showEmails && rawAccountDisplayName.includes('@')) {
    out.accountDisplayName = rawAccountDisplayName.includes(' ')
      ? scrubEmailsInString(rawAccountDisplayName)
      : maskEmail(rawAccountDisplayName);
  }

  if (rawSourceAccountId !== undefined) {
    if (!isValidAccountRef(out.sourceAccountRef) && canDeriveAccountRef(rawSourceAccountId)) {
      out.sourceAccountRef = toAccountRef(rawSourceAccountId);
    }
    if (!showEmails) {
      out.sourceAccountId = maskEmail(rawSourceAccountId);
    }
  }

  if (rawTargetAccountId !== undefined) {
    if (!isValidAccountRef(out.targetAccountRef) && canDeriveAccountRef(rawTargetAccountId)) {
      out.targetAccountRef = toAccountRef(rawTargetAccountId);
    }
    if (!showEmails) {
      out.targetAccountId = maskEmail(rawTargetAccountId);
    }
  }

  if (rawEmail !== undefined) {
    if (!showEmails) {
      out.email = maskEmail(rawEmail);
    }
    if (rawId !== undefined && rawId.includes('@')) {
      if (!isValidAccountRef(out.accountRef) && canDeriveAccountRef(rawId)) {
        out.accountRef = toAccountRef(rawId);
      }
      if (!showEmails) {
        out.id = maskEmail(rawId);
      }
    }
  }

  if (rawSourceEmail !== undefined && !showEmails) {
    out.sourceEmail = maskEmail(rawSourceEmail);
  }

  return out as T;
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
    candidates: Array<{ accountRef: string; maskedEmail: string }>
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
  accounts: readonly T[]
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
    account.email.toLowerCase().startsWith(query)
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
