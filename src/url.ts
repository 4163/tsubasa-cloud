/// <reference types="vite/client" />

export function siteUrl(path: string): string {
  const rawBase = import.meta.env.BASE_URL || '/';
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  const trimmed = path.replace(/^\/+/, '');
  return `${base}${trimmed}`;
}
