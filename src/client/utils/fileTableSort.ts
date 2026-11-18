import type {
  AccountItem,
  ClientFileRecord,
  ClientFolder,
  SortColumn,
  SortDirection,
} from '../types.js';

export function formatDate(dateValue: Date | number | string | null | undefined): string {
  if (!dateValue) return '—';
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortFolders(
  foldersList: ClientFolder[],
  column: SortColumn,
  direction: SortDirection
): ClientFolder[] {
  return [...foldersList].sort((a, b) => {
    if (column === 'name') {
      const cmp = nameCollator.compare(a.name, b.name);
      return direction === 'asc' ? cmp : -cmp;
    }
    if (column === 'date') {
      const timeA = new Date(a.updatedAt).getTime() || 0;
      const timeB = new Date(b.updatedAt).getTime() || 0;
      const diff = timeA - timeB;
      if (diff !== 0) return direction === 'asc' ? diff : -diff;
      return nameCollator.compare(a.name, b.name);
    }
    return nameCollator.compare(a.name, b.name);
  });
}

export function sortFiles(
  filesList: ClientFileRecord[],
  column: SortColumn,
  direction: SortDirection,
  isTrash: boolean
): ClientFileRecord[] {
  return [...filesList].sort((a, b) => {
    if (column === 'name') {
      const cmp = nameCollator.compare(a.name, b.name);
      return direction === 'asc' ? cmp : -cmp;
    }
    if (column === 'account') {
      const cmp = nameCollator.compare(a.accountId, b.accountId);
      if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
      return nameCollator.compare(a.name, b.name);
    }
    if (column === 'size') {
      const diff = a.sizeBytes - b.sizeBytes;
      if (diff !== 0) return direction === 'asc' ? diff : -diff;
      return nameCollator.compare(a.name, b.name);
    }
    if (column === 'date') {
      const dateA = isTrash ? (a.trashedAt || a.updatedAt) : a.updatedAt;
      const dateB = isTrash ? (b.trashedAt || b.updatedAt) : b.updatedAt;
      const timeA = new Date(dateA).getTime() || 0;
      const timeB = new Date(dateB).getTime() || 0;
      const diff = timeA - timeB;
      if (diff !== 0) return direction === 'asc' ? diff : -diff;
      return nameCollator.compare(a.name, b.name);
    }
    return 0;
  });
}

export const SESSION_SORT_COL_KEY = 'tsubasa-filetable-sort-column';
export const SESSION_SORT_DIR_KEY = 'tsubasa-filetable-sort-direction';

export function getSessionSortColumn(fallback: SortColumn = 'name'): SortColumn {
  if (typeof window === 'undefined') return fallback;
  try {
    const val = window.sessionStorage.getItem(SESSION_SORT_COL_KEY);
    if (val === 'name' || val === 'account' || val === 'size' || val === 'date') {
      return val;
    }
  } catch {
    // sessionStorage not accessible
  }
  return fallback;
}

export function getSessionSortDirection(fallback: SortDirection = 'asc'): SortDirection {
  if (typeof window === 'undefined') return fallback;
  try {
    const val = window.sessionStorage.getItem(SESSION_SORT_DIR_KEY);
    if (val === 'asc' || val === 'desc') {
      return val;
    }
  } catch {
    // sessionStorage not accessible
  }
  return fallback;
}

export function getAccountTooltip(accountId: string, fileAcc?: AccountItem): string {
  const email = fileAcc?.email || accountId;
  if (fileAcc?.displayName && fileAcc.displayName !== email) {
    return `${fileAcc.displayName} (${email})`;
  }
  return email;
}
