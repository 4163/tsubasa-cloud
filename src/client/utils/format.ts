export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return email;
  const [user, domain] = email.split('@');
  if (!user || user.length <= 4) return email;

  const startCount = user.length >= 8 ? 3 : 2;
  const endCount = user.length >= 6 ? 2 : 1;
  const dotCount = Math.max(1, user.length - startCount - endCount);

  const start = user.slice(0, startCount);
  const end = user.slice(user.length - endCount);
  const dots = '•'.repeat(dotCount);

  return `${start}${dots}${end}@${domain}`;
}

export const SHARE_POOL_RESERVE_ID = 1_000_000;
export const COPY_FEEDBACK_DURATION_MS = 2000;

export function sortPools<T extends { isSharePool?: boolean }>(pools: T[]): T[] {
  return [...pools].sort((a, b) => Number(Boolean(a.isSharePool)) - Number(Boolean(b.isSharePool)));
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
