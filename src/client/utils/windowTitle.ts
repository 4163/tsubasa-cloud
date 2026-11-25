export const BASE_WINDOW_TITLE = 'Tsubasa~ Cloud';
export const TITLE_SEPARATOR = ' ◦ ';

export interface WorkspaceTitleInput {
  poolName?: string | null;
  isSharePool?: boolean;
  currentNav?: 'files' | 'trash';
  currentPath?: string | null;
}

function getDeepestPathSegment(currentPath?: string | null): string | null {
  if (!currentPath) return null;
  const segments = currentPath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

export function formatWorkspaceTitle({
  poolName,
  isSharePool = false,
  currentNav = 'files',
  currentPath,
}: WorkspaceTitleInput): string {
  const leaf = getDeepestPathSegment(currentPath);

  if (isSharePool) {
    return leaf
      ? `${leaf}${TITLE_SEPARATOR}Share Pool${TITLE_SEPARATOR}${BASE_WINDOW_TITLE}`
      : `Share Pool${TITLE_SEPARATOR}${BASE_WINDOW_TITLE}`;
  }

  const trimmedPoolName = poolName?.trim();
  if (!trimmedPoolName) {
    return BASE_WINDOW_TITLE;
  }

  if (currentNav === 'trash') {
    return `Trash${TITLE_SEPARATOR}${trimmedPoolName}${TITLE_SEPARATOR}${BASE_WINDOW_TITLE}`;
  }

  if (leaf) {
    return `${leaf}${TITLE_SEPARATOR}${trimmedPoolName}${TITLE_SEPARATOR}${BASE_WINDOW_TITLE}`;
  }

  return `${trimmedPoolName}${TITLE_SEPARATOR}${BASE_WINDOW_TITLE}`;
}

let lastAppliedTitle: string | null = null;

export function applyWindowTitle(title: string): void {
  if (typeof document === 'undefined') return;
  if (lastAppliedTitle === title && document.title === title) {
    return;
  }
  lastAppliedTitle = title;
  if (document.title !== title) {
    document.title = title;
  }
  window.tsubasaDesktop?.setTitle(title);
}
