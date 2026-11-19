import { createHash } from 'node:crypto';

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SCRUB_MESSAGE_KEYS = new Set(['message', 'error', 'lastError', 'hint']);

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
    if (typeof entry === 'string' && !showEmails && SCRUB_MESSAGE_KEYS.has(key)) {
      out[key] = scrubEmailsInString(entry);
    } else {
      out[key] = redactPayload(entry, options);
    }
  }

  const rawAccountId = typeof value.accountId === 'string' && value.accountId.length > 0
    ? value.accountId
    : undefined;
  const rawEmail = typeof value.email === 'string' && value.email.length > 0
    ? value.email
    : undefined;
  const rawId = typeof value.id === 'string' && value.id.length > 0
    ? value.id
    : undefined;

  if (rawAccountId !== undefined) {
    if (typeof out.accountRef !== 'string' || out.accountRef.length === 0) {
      out.accountRef = toAccountRef(rawAccountId);
    }
    if (!showEmails) {
      out.accountId = maskEmail(rawAccountId);
    }
  }

  if (rawEmail !== undefined) {
    if (!showEmails) {
      out.email = maskEmail(rawEmail);
    }
    if (rawId !== undefined && rawId.includes('@')) {
      if (typeof out.accountRef !== 'string' || out.accountRef.length === 0) {
        out.accountRef = toAccountRef(rawId);
      }
      if (!showEmails) {
        out.id = maskEmail(rawId);
      }
    }
  }

  if (!showEmails && typeof out.sourceFile === 'string') {
    out.sourceFile = scrubEmailsInString(out.sourceFile);
  }

  return out as T;
}
