import type React from 'react';

export interface DragMoveItem {
  kind: 'file' | 'folder';
  id: string;
  virtualPath?: string;
}

const INTERNAL_DRAG_MIME = 'application/x-tsubasa-items';
const handledDropEvents = new WeakSet<Event>();

function unwrapNativeEvent(event: Event | React.SyntheticEvent): Event {
  return 'nativeEvent' in event ? event.nativeEvent : event;
}

/** Marks a drop event as handled so parent drop zones skip duplicate processing. */
export function markDropHandled(event: Event | React.SyntheticEvent): void {
  handledDropEvents.add(unwrapNativeEvent(event));
}

export function isDropHandled(event: Event | React.SyntheticEvent): boolean {
  return handledDropEvents.has(unwrapNativeEvent(event));
}

let activeInternalDragPayload: DragMoveItem[] | null = null;

/** Stores the active internal drag payload for synchronous dragover validation. */
export function setActiveInternalDragPayload(payload: DragMoveItem[] | null): void {
  activeInternalDragPayload = payload;
}

export function normalizeVirtualPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const stripped = withLeading.replace(/\/+$/, '');
  return stripped || '/';
}

export function getParentDir(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  return `/${parts.slice(0, -1).join('/')}`;
}

export function getItemNameError(trimmedName: string, label = 'Name'): string | null {
  if (!trimmedName) {
    return `${label} cannot be empty`;
  }
  if (trimmedName === '.' || trimmedName === '..') {
    return `${label} cannot be "." or ".."`;
  }
  if (trimmedName.includes('/') || trimmedName.includes('\\')) {
    return `${label} cannot contain slashes`;
  }
  if (/[\x00-\x1f\x7f]/.test(trimmedName)) {
    return `${label} contains invalid control characters`;
  }
  return null;
}

export function canDropInternalItemsToPath(
  targetVirtualPath: string,
  payload: ReadonlyArray<Pick<DragMoveItem, 'kind' | 'virtualPath'>> | null = activeInternalDragPayload,
  allowSameParent = false,
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

  if (allowSameParent) return true;

  return payload.some(
    (item) => !item.virtualPath || getParentDir(normalizeVirtualPath(item.virtualPath)) !== target,
  );
}

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

export function rejectInvalidInternalDragOver(
  e: React.DragEvent,
  targetVirtualPath: string,
  onClearDragOver?: () => void,
  allowSameParent = false,
): boolean {
  if (!e.dataTransfer?.types?.includes(INTERNAL_DRAG_MIME)) return false;
  if (canDropInternalItemsToPath(targetVirtualPath, activeInternalDragPayload, allowSameParent)) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'none';
  }
  onClearDragOver?.();
  return true;
}

export function parseInternalDropItems(
  e: React.DragEvent,
  targetVirtualPath: string,
  allowSameParent = false,
): DragMoveItem[] | null {
  const raw = e.dataTransfer?.getData(INTERNAL_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      canDropInternalItemsToPath(targetVirtualPath, parsed as DragMoveItem[], allowSameParent)
    ) {
      return parsed as DragMoveItem[];
    }
    return null;
  } catch {
    return null;
  }
}
