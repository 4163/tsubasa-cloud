export const DEFAULT_SERVER_PORT = 28300;
export const DEFAULT_WEB_DEV_PORT = 28301;
export const DEFAULT_AUDIT_PORT = 28302;

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function parsePort(raw: string | undefined, allowZero = false): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (allowZero && parsed === 0) {
    return 0;
  }
  return isValidPort(parsed) ? parsed : null;
}

export function getDefaultServerPort(allowZero = false): number {
  return parsePort(process.env.PORT, allowZero) ?? DEFAULT_SERVER_PORT;
}

export function getDefaultWebDevUrl(): string {
  return `http://localhost:${DEFAULT_WEB_DEV_PORT}`;
}

export function getDefaultAuthCallbackUrl(port = DEFAULT_SERVER_PORT): string {
  return `http://localhost:${port}/api/auth/callback`;
}
