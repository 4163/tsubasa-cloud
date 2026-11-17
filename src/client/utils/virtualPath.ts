import type React from 'react';

export interface DragMoveItem {
  kind: 'file' | 'folder';
  id: string;
  virtualPath?: string;
}

const INTERNAL_DRAG_MIME = 'application/x-tsubasa-items';

let activeInternalDragPayload: DragMoveItem[] | null = null;

/** Stores the active internal drag payload for synchronous dragover validation. */
export function setActiveInternalDragPayload(payload: DragMoveItem[] | null): void {
  activeInternalDragPayload = payload;
}

/** Normalizes a virtual path with a single leading slash and no trailing slashes. */
export function normalizeVirtualPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const stripped = withLeading.replace(/\/+$/, '');
  return stripped || '/';
}

/** Returns the parent directory of a virtual path, defaulting to '/'. */
export function getParentDir(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  return `/${parts.slice(0, -1).join('/')}`;
}

/** Checks whether the dragged items can be dropped onto targetVirtualPath. */
export function canDropInternalItemsToPath(
  targetVirtualPath: string,
  payload: ReadonlyArray<Pick<DragMoveItem, 'kind' | 'virtualPath'>> | null = activeInternalDragPayload,
): boolean {
  if (!payload || payload.length === 0) return false;
  const target = normalizeVirtualPath(targetVirtualPath);

  for (const item of payload) {
    if (item.kind === 'folder' && item.virtualPath) {
      const folderPath = normalizeVirtualPath(item.virtualPath);
      if (target === folderPath || target.startsWith(`${folderPath}/`)) {
        return false;
      }
    }
  }

  return payload.some(
    (item) => !item.virtualPath || getParentDir(normalizeVirtualPath(item.virtualPath)) !== target,
  );
}

/** Filters out items that cannot be moved to targetVirtualPath (same parent or folder descendant). */
export function filterMovableItemsToPath<T extends { kind: 'file' | 'folder'; id: string }>(
  items: ReadonlyArray<T>,
  targetVirtualPath: string,
  getVirtualPath: (item: T) => string | undefined,
): { normalizedTarget: string; validItems: T[] } {
  const normalizedTarget = normalizeVirtualPath(targetVirtualPath);
  const validItems = items.filter((item) => {
    const rawPath = getVirtualPath(item);
    if (rawPath === undefined) return true;
    const itemPath = normalizeVirtualPath(rawPath);
    if (
      item.kind === 'folder' &&
      (normalizedTarget === itemPath || normalizedTarget.startsWith(`${itemPath}/`))
    ) {
      return false;
    }
    return getParentDir(itemPath) !== normalizedTarget;
  });
  return { normalizedTarget, validItems };
}

/** Rejects an invalid internal dragover event by setting dropEffect to 'none'. */
export function rejectInvalidInternalDragOver(
  e: React.DragEvent,
  targetVirtualPath: string,
  onClearDragOver?: () => void,
): boolean {
  if (!e.dataTransfer?.types?.includes(INTERNAL_DRAG_MIME)) return false;
  if (canDropInternalItemsToPath(targetVirtualPath)) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'none';
  }
  onClearDragOver?.();
  return true;
}

/** Parses and validates internal drag-and-drop items from a drop event. */
export function parseInternalDropItems(
  e: React.DragEvent,
  targetVirtualPath: string,
): DragMoveItem[] | null {
  const raw = e.dataTransfer?.getData(INTERNAL_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      canDropInternalItemsToPath(targetVirtualPath, parsed as DragMoveItem[])
    ) {
      return parsed as DragMoveItem[];
    }
    return null;
  } catch {
    return null;
  }
}
