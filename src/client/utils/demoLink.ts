export const DEMO_EXTERNAL_URL = 'https://tsubasa.moe.page/demo/';
export const DEMO_EXTERNAL_LABEL = 'Pop out';
export const GITHUB_REPO_URL = 'https://github.com/4163/tsubasa-cloud';

const DEMO_PATHNAME_PATTERN = /(?:^|\/)demo(?:\/(?:index\.html)?)?$/i;

export function getDemoExternalUrl(): string {
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol;
    if (protocol === 'http:' || protocol === 'https:') {
      try {
        return new URL('./', window.location.href).href;
      } catch {
        // Fall back to canonical production demo URL.
      }
    }
  }
  return DEMO_EXTERNAL_URL;
}

export function isEmbeddedDemo(): boolean {
  if (!__DEMO_MODE__ || typeof window === 'undefined') {
    return false;
  }
  if (window.self === window.top) {
    return false;
  }
  try {
    const topPathname = window.top?.location.pathname ?? '';
    return !DEMO_PATHNAME_PATTERN.test(topPathname);
  } catch {
    // Cross-origin iframe prevents reading window.top.location; treat as embedded.
    return true;
  }
}
