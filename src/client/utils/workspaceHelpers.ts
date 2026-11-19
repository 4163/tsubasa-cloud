import type { ActionPortalClipboard, MoveConflictItem } from '../types.js';

export interface ItemOperationResult {
  id?: string;
  kind?: 'file' | 'folder';
  oldPath?: string;
  newPath?: string;
  success?: boolean;
  skipped?: boolean;
  error?: string;
}

export interface MoveConflictPayload {
  code: 'MOVE_CONFLICT';
  conflicts: MoveConflictItem[];
  cleanCount?: number;
}

export function reportDevError(context: string, err: unknown): void {
  if (import.meta.env.DEV) {
    console.error(`[tsubasa] ${context}:`, err);
  }
}

export function extractErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'string' && err.trim().length > 0) return err;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  if (
    err &&
    typeof err === 'object' &&
    'error' in err &&
    typeof err.error === 'string' &&
    err.error.trim().length > 0
  ) {
    return err.error;
  }
  return fallback;
}

export async function readResponseError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return extractErrorMessage(body, res.statusText || fallback);
}

export function remapPathPrefix(virtualPath: string, oldPrefix: string, newPrefix: string): string | null {
  if (virtualPath === oldPrefix) return newPrefix;
  if (virtualPath.startsWith(`${oldPrefix}/`)) {
    return `${newPrefix}${virtualPath.slice(oldPrefix.length)}`;
  }
  return null;
}

export function applyMoveResultsToClipboard(
  clipboard: ActionPortalClipboard | null,
  poolId: number,
  results: ItemOperationResult[]
): ActionPortalClipboard | null {
  if (!clipboard) return null;
  const movedNonSkipped = results.filter((r) => r.success && !r.skipped);
  const movedIds = new Set(
    movedNonSkipped.map((r) => r.id).filter((id): id is string => Boolean(id))
  );
  const movedFolders = movedNonSkipped.filter(
    (r): r is ItemOperationResult & { oldPath: string; newPath: string } =>
      r.kind === 'folder' && Boolean(r.oldPath && r.newPath && r.oldPath !== r.newPath)
  );
  const movedFilesById = new Map<string, string>();
  for (const r of movedNonSkipped) {
    if (r.kind === 'file' && r.id && r.newPath) {
      movedFilesById.set(r.id, r.newPath);
    }
  }

  const baseItems =
    clipboard.mode === 'cut'
      ? clipboard.items.filter((item) => !movedIds.has(item.id))
      : clipboard.items;
  if (baseItems.length === 0) return null;

  const nextItems = baseItems.map((item) => {
    const directFilePath = item.kind === 'file' ? movedFilesById.get(item.id) : undefined;
    if (directFilePath) {
      const updatedName = directFilePath.split('/').pop() || item.name;
      return { ...item, virtualPath: directFilePath, name: updatedName };
    }
    for (const folderMove of movedFolders) {
      const remapped = remapPathPrefix(item.virtualPath, folderMove.oldPath, folderMove.newPath);
      if (remapped !== null) {
        return {
          ...item,
          virtualPath: remapped,
          ...(item.kind === 'folder' ? { id: `${poolId}:${remapped}` } : {}),
        };
      }
    }
    return item;
  });

  return { ...clipboard, items: nextItems };
}

export function parseItemOperationResults(data: unknown): ItemOperationResult[] {
  if (Array.isArray(data)) return data as ItemOperationResult[];
  if (data && typeof data === 'object' && 'results' in data && Array.isArray(data.results)) {
    return data.results as ItemOperationResult[];
  }
  return [];
}

export function isMoveConflictPayload(data: unknown): data is MoveConflictPayload {
  if (!data || typeof data !== 'object') return false;
  const candidate = data as Record<string, unknown>;
  return candidate.code === 'MOVE_CONFLICT' && Array.isArray(candidate.conflicts);
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

export function safeStorageGet(storage: Storage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function safeStorageSet(storage: Storage | undefined, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore storage access errors in restricted browser contexts.
  }
}

export function safeStorageRemove(storage: Storage | undefined, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage access errors in restricted browser contexts.
  }
}

export function runWithViewTransition(update: () => void): void {
  if (
    typeof document !== 'undefined' &&
    'startViewTransition' in document &&
    typeof document.startViewTransition === 'function' &&
    window.matchMedia('(prefers-reduced-motion: no-preference)').matches
  ) {
    document.startViewTransition(update);
  } else {
    update();
  }
}

export function isModalActive(): boolean {
  return typeof document !== 'undefined' && Boolean(document.querySelector('dialog[open], [role="dialog"]'));
}

/** Sets `title` only while single-line text overflows its element. */
export function syncOverflowTitle(
  e: { currentTarget: HTMLElement },
  text?: string
): void {
  const el = e.currentTarget;
  if (el.scrollWidth > el.clientWidth) {
    const resolved = text !== undefined ? text : (el.textContent ?? '');
    if (resolved && el.title !== resolved) {
      el.title = resolved;
    }
    return;
  }
  if (el.hasAttribute('title')) {
    el.removeAttribute('title');
  }
}
