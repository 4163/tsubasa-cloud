import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import {
  IconFolderFilled,
  IconFile,
  IconDownload,
  IconTrash,
  IconChevronRight,
  IconChevronUp,
  IconChevronDown,
  IconRotateCcw,
  IconUpload,
  IconCheck,
  IconMinus,
} from './Icons.js';
import { formatBytes } from '../utils/format.js';
import type { FileRecord, FolderRecord } from '../api.js';
import type { AccountItem } from './Sidebar.js';

export type ClientFileRecord = Omit<FileRecord, 'createdAt' | 'updatedAt' | 'trashedAt'> & {
  createdAt: string | Date;
  updatedAt: string | Date;
  trashedAt?: string | Date | null;
};

export type ClientFolder = Omit<FolderRecord, 'createdAt' | 'updatedAt'> & {
  createdAt: string | Date;
  updatedAt: string | Date;
};

export type SortColumn = 'name' | 'account' | 'size' | 'date';
export type SortDirection = 'asc' | 'desc';

interface FileTableProps {
  files: ClientFileRecord[];
  folders: ClientFolder[];
  currentPath: string;
  searchQuery?: string;
  selectedIds: Set<string>;
  onSelect: (id: string, isMulti: boolean) => void;
  onSelectMultiple?: (ids: string[], mode?: 'set' | 'add' | 'toggle') => void;
  onClearSelection?: () => void;
  onNavigate: (path: string) => void;
  onDownload: (file: ClientFileRecord) => void;
  onTrash: (file: ClientFileRecord) => void;
  onDeleteFolder?: (folder: ClientFolder) => void;
  isTrashView?: boolean;
  onRestore?: (file: ClientFileRecord) => void;
  onPermanentDelete?: (file: ClientFileRecord) => void;
  onDropFiles?: (files: File[]) => void;
  onStageDroppedUpload?: (dropped: { files: Array<{ file: File; virtualPath: string }>; emptyFolders: string[] }) => void;
  onMoveItems?: (items: Array<{ kind: 'file' | 'folder'; id: string }>, targetPath: string) => Promise<void> | void;
  clipboard?: { mode: 'cut' | 'copy'; items: Array<{ kind: 'file' | 'folder'; id: string; name: string; virtualPath: string }> } | null;
  accounts?: AccountItem[];
  onTransferFile?: (fileId: string, targetAccountId: string) => Promise<void>;
  transferringFileId?: string | null;
  sortColumn?: SortColumn;
  sortDirection?: SortDirection;
  onSortChange?: (column: SortColumn, direction: SortDirection) => void;
}

type TableItem =
  | { kind: 'parent'; path: string }
  | { kind: 'folder'; data: ClientFolder }
  | { kind: 'file'; data: ClientFileRecord }
  | { kind: 'trash'; data: ClientFileRecord };

const styles = stylex.create({
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    height: '100%',
    backgroundColor: colors.surfaceContainer,
    overflow: 'hidden',
    position: 'relative',
  },
  headerRow: {
    height: '36px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'transparent',
    backgroundColor: colors.surfaceAlt,
    display: 'grid',
    gridTemplateColumns: '16px 40px minmax(240px, 3fr) 140px 110px 140px 90px',
    alignItems: 'stretch',
    paddingLeft: '0px',
    paddingRight: spacing.space4,
    fontSize: typography.fontSizeTableHeader,
    fontWeight: typography.fontWeightTableHeader,
    color: colors.secondaryText,
    userSelect: 'none',
    boxSizing: 'border-box',
    flexShrink: 0,
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  headerGutter: {
    width: '16px',
    height: '100%',
    boxSizing: 'border-box',
  },
  colRight: {
    textAlign: 'right',
  },
  headerCell: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    boxSizing: 'border-box',
  },
  headerCellRight: {
    justifyContent: 'flex-end',
  },
  headerBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    height: '100%',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    backgroundColor: 'transparent',
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeTableHeader,
    fontWeight: typography.fontWeightTableHeader,
    color: colors.secondaryText,
    cursor: 'pointer',
    userSelect: 'none',
    outline: 'none',
    borderRadius: radius.compact,
    boxSizing: 'border-box',
    transition: motion.transitionFast,
    ':hover': {
      color: colors.primaryText,
      backgroundColor: colors.rowHover,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.accentGold,
      outlineOffset: '-2px',
    },
  },
  headerBtnLeft: {
    marginLeft: '-4px',
  },
  headerBtnRight: {
    marginRight: '-4px',
  },
  headerBtnActive: {
    color: colors.primaryText,
  },
  sortSlot: {
    width: '12px',
    height: '12px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sortIcon: {
    color: 'currentColor',
    flexShrink: 0,
    transition: motion.transitionFast,
  },
  sortIconHidden: {
    visibility: 'hidden',
    pointerEvents: 'none',
  },
  scrollViewport: {
    flex: 1,
    overflowY: 'auto',
    position: 'relative',
    contain: 'strict',
    userSelect: 'none',
  },
  virtualTrack: {
    width: '100%',
    position: 'relative',
    flexShrink: 0,
    userSelect: 'none',
  },
  gutterCell: {
    width: '16px',
    flexShrink: 0,
    height: '100%',
    boxSizing: 'border-box',
    cursor: 'default',
    backgroundColor: 'transparent',
    userSelect: 'none',
    '@media (pointer: coarse)': {
      display: 'none',
    },
  },
  rowWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '36px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'transparent',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
    boxSizing: 'border-box',
    backgroundColor: {
      default: 'transparent',
      ':has([data-row="true"]:hover)': colors.rowHover,
    },
    userSelect: 'none',
    transition: motion.transitionFast,
    '@media (pointer: coarse)': {
      height: layout.mobileRowHeight,
    },
  },
  rowWrapperSelected: {
    borderLeftColor: colors.accentGold,
    backgroundColor: {
      default: colors.selectionBg,
      ':has([data-row="true"]:hover)': colors.selectionBg,
    },
  },
  rowWrapperDragOver: {
    borderLeftColor: colors.accentGold,
    backgroundColor: {
      default: colors.brandAccentSurface,
      ':has([data-row="true"]:hover)': colors.brandAccentSurface,
    },
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    display: 'grid',
    gridTemplateColumns: '40px minmax(240px, 3fr) 140px 110px 140px 90px',
    alignItems: 'center',
    paddingLeft: '0px',
    paddingRight: spacing.space4,
    boxSizing: 'border-box',
    cursor: 'default',
    userSelect: 'none',
    fontSize: typography.fontSizeBody,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    backgroundColor: 'transparent',
    transition: motion.transitionFast,
    '@media (pointer: coarse)': {
      gridTemplateColumns: '36px 32px 1fr 36px',
      paddingLeft: spacing.space2,
      paddingRight: spacing.space3,
      ':active': {
        backgroundColor: colors.rowHover,
        transition: motion.transitionTap,
      },
    },
  },
  rowSelected: {
    backgroundColor: colors.selectionBg,
  },
  rowDragOver: {
    backgroundColor: colors.brandAccentSurface,
  },
  rowCutMuted: {
    opacity: 0.5,
  },
  checkboxCell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
  },
  checkbox: {
    width: '16px',
    height: '16px',
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    backgroundColor: colors.surface,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: '0px',
    color: colors.primary,
    transition: motion.transitionFast,
    outline: 'none',
    boxSizing: 'border-box',
    flexShrink: 0,
    ':hover': {
      borderColor: colors.accentGold,
      backgroundColor: colors.surfaceAlt,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.accentGold,
      outlineOffset: '1px',
    },
  },
  checkboxChecked: {
    backgroundColor: colors.accentGold,
    borderColor: colors.accentGold,
    color: '#111d18',
    ':hover': {
      backgroundColor: colors.accentGold,
      borderColor: colors.accentGold,
      opacity: 0.9,
    },
  },
  checkboxDisabled: {
    opacity: 0.35,
    cursor: 'not-allowed',
    ':hover': {
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
  },
  marqueeBox: {
    position: 'absolute',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.accentGold,
    backgroundColor: 'rgba(222, 183, 108, 0.14)',
    borderRadius: radius.compact,
    pointerEvents: 'none',
    zIndex: 50,
    boxSizing: 'border-box',
  },
  nameCell: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  },
  itemIcon: {
    width: '16px',
    height: '16px',
    flexShrink: 0,
    color: colors.secondaryText,
  },
  folderIcon: {
    color: colors.accentGold,
  },
  itemLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: '400',
    userSelect: 'none',
  },
  accountCell: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    height: '100%',
    paddingLeft: spacing.space1,
    paddingRight: spacing.space1,
    overflow: 'visible',
  },
  selectWrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    maxWidth: '130px',
  },
  selectChevron: {
    position: 'absolute',
    right: '7px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: colors.brandAccent,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountPill: {
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    display: 'inline-flex',
    alignItems: 'center',
    height: '22px',
    lineHeight: '18px',
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccentSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.brandAccent,
    width: 'fit-content',
    boxSizing: 'border-box',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  accountSelect: {
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    height: '22px',
    lineHeight: '18px',
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: spacing.space2,
    paddingRight: '22px',
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccentSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.brandAccent,
    width: '100%',
    maxWidth: '130px',
    outline: 'none',
    cursor: 'pointer',
    boxSizing: 'border-box',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    transition: motion.transitionFast,
    ':hover': {
      borderColor: colors.accentGold,
      backgroundColor: colors.surfaceAlt,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.accentGold,
      outlineOffset: '0px',
    },
  },
  accountSelectTransferring: {
    opacity: 0.5,
    cursor: 'wait',
    pointerEvents: 'none',
  },
  tabularCell: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
  },
  actionsCell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.space2,
  },
  rowBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    padding: spacing.space1,
    color: colors.secondaryText,
    borderRadius: radius.compact,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: motion.transitionFast,
    ':hover': {
      color: colors.primaryText,
      backgroundColor: colors.surfaceAlt,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
  },
  rowBtnDanger: {
    ':hover': {
      color: colors.danger,
      backgroundColor: colors.dangerSurface,
    },
  },
  actionIcon: {
    width: '14px',
    height: '14px',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
    padding: spacing.space10,
    textAlign: 'center',
    color: colors.secondaryText,
    gap: spacing.space2,
    boxSizing: 'border-box',
  },
  emptyTitle: {
    fontFamily: typography.fontFamilyBrand,
    fontSize: typography.fontSizeTitle,
    color: colors.primaryText,
    margin: 0,
  },
  emptyDesc: {
    fontSize: typography.fontSizeBody,
    color: colors.secondaryText,
    maxWidth: '360px',
  },
  emptyStateDragOver: {
    padding: spacing.space2,
  },
  tableBodyContainer: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100%',
    width: '100%',
    position: 'relative',
    boxSizing: 'border-box',
    userSelect: 'none',
  },
  emptyDropZone: {
    flex: 1,
    minHeight: '120px',
    width: '100%',
    position: 'relative',
    boxSizing: 'border-box',
    display: 'flex',
    padding: spacing.space2,
  },
  dropBox: {
    flex: 1,
    width: '100%',
    minHeight: '120px',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.space2,
    borderRadius: radius.card,
    borderWidth: '2px',
    borderStyle: 'dashed',
    borderColor: colors.accentGold,
    backgroundColor: 'rgba(222, 183, 108, 0.10)',
    pointerEvents: 'none',
    userSelect: 'none',
    padding: spacing.space6,
  },
  dropTitle: {
    fontFamily: typography.fontFamilyBrand,
    fontSize: typography.fontSizeTitle,
    fontWeight: typography.fontWeightBrand,
    color: colors.primaryText,
    letterSpacing: '0.02em',
    margin: 0,
    lineHeight: '1.2',
  },
  dropSubtitle: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    margin: 0,
    lineHeight: '1.4',
  },
  dropTargetBadge: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    color: colors.primaryText,
    backgroundColor: colors.selectionBg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    marginTop: spacing.space1,
  },
});

function getParentDir(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  return '/' + parts.slice(0, -1).join('/');
}

function formatGbCompact(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function formatDate(dateValue: Date | number | string | null | undefined): string {
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

function isInternalItemDrag(e: React.DragEvent | DragEvent): boolean {
  return Boolean(e.dataTransfer?.types?.includes('application/x-tsubasa-items'));
}

function isExternalFileDrag(e: React.DragEvent | DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return types.includes('Files') && !types.includes('application/x-tsubasa-items');
}

export async function extractDataTransferEntries(
  dataTransfer: DataTransfer,
  basePath: string
): Promise<{ files: Array<{ file: File; virtualPath: string }>; emptyFolders: string[] }> {
  const cleanBase = basePath === '/' ? '' : basePath;
  const resultFiles: Array<{ file: File; virtualPath: string }> = [];
  const resultEmptyFolders: string[] = [];

  const rawFiles = Array.from(dataTransfer.files || []);
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];

  let hasDirectories = false;
  const entries: any[] = [];
  for (const it of items) {
    if (typeof (it as any).webkitGetAsEntry === 'function') {
      const entry = (it as any).webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
        if (entry.isDirectory) {
          hasDirectories = true;
        }
      }
    }
  }

  // If no directories were dropped, use rawFiles directly (synchronous & 100% reliable)
  if (!hasDirectories && rawFiles.length > 0) {
    for (const f of rawFiles) {
      const rel = (f as any).webkitRelativePath || f.name;
      resultFiles.push({
        file: f,
        virtualPath: `${cleanBase}/${rel}`.replace(/\/+/g, '/'),
      });
    }
    return { files: resultFiles, emptyFolders: resultEmptyFolders };
  }

  // Fallback if entries failed to extract from items
  if (entries.length === 0 && rawFiles.length > 0) {
    for (const f of rawFiles) {
      const rel = (f as any).webkitRelativePath || f.name;
      resultFiles.push({
        file: f,
        virtualPath: `${cleanBase}/${rel}`.replace(/\/+/g, '/'),
      });
    }
    return { files: resultFiles, emptyFolders: resultEmptyFolders };
  }

  async function traverse(entry: any, currentFolder: string) {
    if (entry.isFile) {
      await new Promise<void>((resolve) => {
        try {
          entry.file(
            (f: File) => {
              resultFiles.push({
                file: f,
                virtualPath: `${currentFolder}/${f.name}`.replace(/\/+/g, '/'),
              });
              resolve();
            },
            () => {
              const match = rawFiles.find((rf) => rf.name === entry.name);
              if (match) {
                resultFiles.push({
                  file: match,
                  virtualPath: `${currentFolder}/${match.name}`.replace(/\/+/g, '/'),
                });
              }
              resolve();
            }
          );
        } catch {
          resolve();
        }
      });
    } else if (entry.isDirectory) {
      const nextFolder = `${currentFolder}/${entry.name}`.replace(/\/+/g, '/');
      const dirReader = entry.createReader();
      const childEntries: any[] = [];

      const readBatch = async (): Promise<void> => {
        return new Promise<void>((resolve) => {
          dirReader.readEntries(
            async (results: any[]) => {
              if (results && results.length > 0) {
                childEntries.push(...results);
                await readBatch();
              }
              resolve();
            },
            () => resolve()
          );
        });
      };

      await readBatch();

      if (childEntries.length === 0) {
        resultEmptyFolders.push(nextFolder);
      } else {
        for (const child of childEntries) {
          await traverse(child, nextFolder);
        }
      }
    }
  }

  for (const entry of entries) {
    await traverse(entry, cleanBase);
  }

  return { files: resultFiles, emptyFolders: resultEmptyFolders };
}

function sortFolders(
  foldersList: ClientFolder[],
  column: SortColumn,
  direction: SortDirection
): ClientFolder[] {
  return [...foldersList].sort((a, b) => {
    if (column === 'name') {
      const cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return direction === 'asc' ? cmp : -cmp;
    }
    if (column === 'date') {
      const timeA = new Date(a.updatedAt).getTime() || 0;
      const timeB = new Date(b.updatedAt).getTime() || 0;
      const diff = timeA - timeB;
      if (diff !== 0) return direction === 'asc' ? diff : -diff;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function sortFiles(
  filesList: ClientFileRecord[],
  column: SortColumn,
  direction: SortDirection,
  isTrash: boolean
): ClientFileRecord[] {
  return [...filesList].sort((a, b) => {
    if (column === 'name') {
      const cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return direction === 'asc' ? cmp : -cmp;
    }
    if (column === 'account') {
      const cmp = a.accountId.localeCompare(b.accountId, undefined, { numeric: true, sensitivity: 'base' });
      if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    if (column === 'size') {
      const diff = a.sizeBytes - b.sizeBytes;
      if (diff !== 0) return direction === 'asc' ? diff : -diff;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    if (column === 'date') {
      const dateA = isTrash ? (a.trashedAt || a.updatedAt) : a.updatedAt;
      const dateB = isTrash ? (b.trashedAt || b.updatedAt) : b.updatedAt;
      const timeA = new Date(dateA).getTime() || 0;
      const timeB = new Date(dateB).getTime() || 0;
      const diff = timeA - timeB;
      if (diff !== 0) return direction === 'asc' ? diff : -diff;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    return 0;
  });
}

const SESSION_SORT_COL_KEY = 'tsubasa-filetable-sort-column';
const SESSION_SORT_DIR_KEY = 'tsubasa-filetable-sort-direction';

function getSessionSortColumn(fallback: SortColumn = 'name'): SortColumn {
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

function getSessionSortDirection(fallback: SortDirection = 'asc'): SortDirection {
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

export function FileTable({
  files,
  folders,
  currentPath,
  searchQuery = '',
  selectedIds,
  onSelect,
  onSelectMultiple,
  onClearSelection,
  onNavigate,
  onDownload,
  onTrash,
  onDeleteFolder,
  isTrashView = false,
  onRestore,
  onPermanentDelete,
  onDropFiles,
  onStageDroppedUpload,
  onMoveItems,
  clipboard,
  accounts = [],
  onTransferFile,
  transferringFileId = null,
  sortColumn: sortColumnProp,
  sortDirection: sortDirectionProp,
  onSortChange,
}: FileTableProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [isDropZoneActive, setIsDropZoneActive] = useState(false);
  const [dragOverRowId, setDragOverRowId] = useState<string | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const justFinishedMarquee = useRef(false);
  const lastSelectedIdRef = useRef<string | null>(null);
  const anchorIndexRef = useRef<number>(-1);
  const focusIndexRef = useRef<number>(-1);

  const folderSizeMap = useMemo(() => {
    const folderIdsByPath = new Map<string, string[]>();
    const map = new Map<string, number>();

    for (const folder of folders) {
      map.set(folder.id, 0);
      const canonical = folder.virtualPath === '/'
        ? '/'
        : folder.virtualPath.endsWith('/')
          ? folder.virtualPath.slice(0, -1)
          : folder.virtualPath;
      const existing = folderIdsByPath.get(canonical);
      if (existing) {
        existing.push(folder.id);
      } else {
        folderIdsByPath.set(canonical, [folder.id]);
      }
    }

    for (const file of files) {
      if (file.isTrashed) continue;
      const size = file.sizeBytes || 0;
      if (size === 0) continue;

      const vPath = file.virtualPath.startsWith('/') ? file.virtualPath : '/' + file.virtualPath;
      const touchedFolderIds = new Set<string>();

      const rootIds = folderIdsByPath.get('/');
      if (rootIds) {
        for (const id of rootIds) {
          map.set(id, (map.get(id) || 0) + size);
          touchedFolderIds.add(id);
        }
      }

      let slashIdx = vPath.indexOf('/', 1);
      while (slashIdx !== -1) {
        const subPath = vPath.slice(0, slashIdx);
        const ids = folderIdsByPath.get(subPath);
        if (ids) {
          for (const id of ids) {
            map.set(id, (map.get(id) || 0) + size);
            touchedFolderIds.add(id);
          }
        }
        slashIdx = vPath.indexOf('/', slashIdx + 1);
      }

      if (file.folderId && !touchedFolderIds.has(file.folderId) && map.has(file.folderId)) {
        map.set(file.folderId, (map.get(file.folderId) || 0) + size);
      }
    }

    return map;
  }, [folders, files]);

  const [internalSortColumn, setInternalSortColumn] = useState<SortColumn>(() => getSessionSortColumn('name'));
  const [internalSortDirection, setInternalSortDirection] = useState<SortDirection>(() => getSessionSortDirection('asc'));

  const currentSortColumn = sortColumnProp ?? internalSortColumn;
  const currentSortDirection = sortDirectionProp ?? internalSortDirection;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(SESSION_SORT_COL_KEY, currentSortColumn);
      window.sessionStorage.setItem(SESSION_SORT_DIR_KEY, currentSortDirection);
    } catch {
      // ignore storage errors
    }
  }, [currentSortColumn, currentSortDirection]);

  useEffect(() => {
    const handleGlobalDragEnd = () => {
      setIsDropZoneActive(false);
      setDragOverRowId(null);
      setMarqueeRect(null);
    };

    const handleGlobalDragLeave = (e: DragEvent) => {
      if (
        !e.relatedTarget ||
        e.clientY <= 0 ||
        e.clientX <= 0 ||
        e.clientX >= window.innerWidth ||
        e.clientY >= window.innerHeight
      ) {
        handleGlobalDragEnd();
      }
    };

    const handleGlobalMouseUp = () => {
      setMarqueeRect(null);
    };

    window.addEventListener('dragleave', handleGlobalDragLeave);
    window.addEventListener('dragend', handleGlobalDragEnd);
    window.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      window.removeEventListener('dragleave', handleGlobalDragLeave);
      window.removeEventListener('dragend', handleGlobalDragEnd);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, []);

  const handleSort = (column: SortColumn) => {
    let newDirection: SortDirection = 'asc';
    if (currentSortColumn === column) {
      newDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      if (column === 'date' || column === 'size') {
        newDirection = 'desc';
      } else {
        newDirection = 'asc';
      }
    }
    if (sortColumnProp === undefined) {
      setInternalSortColumn(column);
    }
    if (sortDirectionProp === undefined) {
      setInternalSortDirection(newDirection);
    }
    onSortChange?.(column, newDirection);
  };

  const handleDrop = async (e: React.DragEvent) => {
    if (isTrashView) return;
    e.preventDefault();
    e.stopPropagation();
    (e.nativeEvent as any).__tsubasaHandled = true;
    setIsDropZoneActive(false);
    setDragOverRowId(null);

    if (e.dataTransfer) {
      if (isInternalItemDrag(e)) {
        try {
          const raw = e.dataTransfer.getData('application/x-tsubasa-items');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            onMoveItems?.(parsed, cleanPath);
            return;
          }
        } catch {}
      }

      if (isExternalFileDrag(e)) {
        if (onStageDroppedUpload) {
          const extracted = await extractDataTransferEntries(e.dataTransfer, cleanPath);
          if (extracted.files.length > 0 || extracted.emptyFolders.length > 0) {
            onStageDroppedUpload(extracted);
          }
        } else if (onDropFiles && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          onDropFiles(Array.from(e.dataTransfer.files));
        }
      }
    }
  };

  const handleRowDrop = async (e: React.DragEvent, targetVirtualPath: string) => {
    if (isTrashView) return;
    e.preventDefault();
    e.stopPropagation();
    (e.nativeEvent as any).__tsubasaHandled = true;
    setIsDropZoneActive(false);
    setDragOverRowId(null);

    if (isInternalItemDrag(e)) {
      try {
        const raw = e.dataTransfer.getData('application/x-tsubasa-items');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          onMoveItems?.(parsed, targetVirtualPath);
          return;
        }
      } catch {}
    }

    if (isExternalFileDrag(e)) {
      if (onStageDroppedUpload) {
        const extracted = await extractDataTransferEntries(e.dataTransfer, targetVirtualPath);
        if (extracted.files.length > 0 || extracted.emptyFolders.length > 0) {
          onStageDroppedUpload(extracted);
        }
      } else if (onDropFiles && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        onDropFiles(Array.from(e.dataTransfer.files));
      }
    }
  };

  const cleanPath = currentPath.trim() === '' ? '/' : currentPath;

  useEffect(() => {
    anchorIndexRef.current = -1;
    focusIndexRef.current = -1;
    lastSelectedIdRef.current = null;
  }, [cleanPath]);

  // Build items array
  const items: TableItem[] = [];

  // Filter or search
  const isSearching = searchQuery.trim().length > 0;
  const searchLower = searchQuery.toLowerCase();

  if (isTrashView) {
    const list = isSearching
      ? files.filter(
          (f) =>
            f.name.toLowerCase().includes(searchLower) ||
            (f.virtualPath && f.virtualPath.toLowerCase().includes(searchLower))
        )
      : files;

    const sortedList = sortFiles(list, currentSortColumn, currentSortDirection, true);
    sortedList.forEach((f) => items.push({ kind: 'trash', data: f }));
  } else if (isSearching) {
    const matchedFolders = folders.filter(
      (f) => f.name.toLowerCase().includes(searchLower) || f.virtualPath.toLowerCase().includes(searchLower)
    );
    const sortedFoldersList = sortFolders(matchedFolders, currentSortColumn, currentSortDirection);
    sortedFoldersList.forEach((f) => items.push({ kind: 'folder', data: f }));

    const matchedFiles = files.filter(
      (f) =>
        !f.isTrashed &&
        (f.name.toLowerCase().includes(searchLower) || f.virtualPath.toLowerCase().includes(searchLower))
    );
    const sortedFilesList = sortFiles(matchedFiles, currentSortColumn, currentSortDirection, false);
    sortedFilesList.forEach((f) => items.push({ kind: 'file', data: f }));
  } else {
    // Add ".." if not root
    if (cleanPath !== '/') {
      items.push({ kind: 'parent', path: getParentDir(cleanPath) });
    }

    // Folders in current dir
    const dirFolders = folders.filter((f) => getParentDir(f.virtualPath) === cleanPath);
    const sortedFoldersList = sortFolders(dirFolders, currentSortColumn, currentSortDirection);
    sortedFoldersList.forEach((f) => items.push({ kind: 'folder', data: f }));

    // Files in current dir
    const dirFiles = files.filter((f) => !f.isTrashed && getParentDir(f.virtualPath) === cleanPath);
    const sortedFilesList = sortFiles(dirFiles, currentSortColumn, currentSortDirection, false);
    sortedFilesList.forEach((f) => items.push({ kind: 'file', data: f }));
  }

  // Selectable items in current view
  const selectableItems = items.filter(
    (item): item is { kind: 'folder'; data: ClientFolder } | { kind: 'file'; data: ClientFileRecord } | { kind: 'trash'; data: ClientFileRecord } =>
      item.kind !== 'parent'
  );
  const selectableIds = selectableItems.map((item) => item.data.id);
  const selectedInViewCount = selectableIds.filter((id) => selectedIds.has(id)).length;
  const isAllSelected = selectableIds.length > 0 && selectedInViewCount === selectableIds.length;
  const isIndeterminate = selectedInViewCount > 0 && !isAllSelected;

  const handleToggleSelectAll = () => {
    if (selectableIds.length === 0) return;
    if (isAllSelected) {
      if (onSelectMultiple) {
        onSelectMultiple([], 'set');
      } else {
        onClearSelection?.();
      }
    } else {
      if (onSelectMultiple) {
        onSelectMultiple(selectableIds, 'set');
      } else {
        for (const id of selectableIds) {
          if (!selectedIds.has(id)) onSelect(id, true);
        }
      }
    }
  };

  const handleItemClick = (id: string, e: React.MouseEvent) => {
    if (justFinishedMarquee.current) return;

    if (id === '__parent__') {
      anchorIndexRef.current = 0;
      focusIndexRef.current = 0;
      lastSelectedIdRef.current = null;
      onSelect('__parent__', false);
      return;
    }

    const clickedIdx = items.findIndex((it) => it.kind !== 'parent' && it.data.id === id);
    if (clickedIdx !== -1) {
      if (!e.shiftKey || anchorIndexRef.current === -1) {
        anchorIndexRef.current = clickedIdx;
      }
      focusIndexRef.current = clickedIdx;
    }

    if (e.shiftKey && lastSelectedIdRef.current && onSelectMultiple) {
      const idxA = selectableItems.findIndex((it) => it.data.id === lastSelectedIdRef.current);
      const idxB = selectableItems.findIndex((it) => it.data.id === id);
      if (idxA !== -1 && idxB !== -1) {
        const start = Math.min(idxA, idxB);
        const end = Math.max(idxA, idxB);
        const rangeIds = selectableItems.slice(start, end + 1).map((it) => it.data.id);
        onSelectMultiple(rangeIds, 'add');
        return;
      }
    }

    lastSelectedIdRef.current = id;
    onSelect(id, e.shiftKey || e.ctrlKey || e.metaKey);
  };

  const handleCheckboxToggle = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    lastSelectedIdRef.current = id;
    const clickedIdx = items.findIndex((it) => it.kind !== 'parent' && it.data.id === id);
    if (clickedIdx !== -1) {
      anchorIndexRef.current = clickedIdx;
      focusIndexRef.current = clickedIdx;
    }
    onSelect(id, true);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement | null;
    const isMarqueeGutter = Boolean(target?.closest('[data-marquee-gutter="true"]'));
    if (!isMarqueeGutter) {
      if (
        target?.closest('button') ||
        target?.closest('input') ||
        target?.closest('select') ||
        target?.closest('a') ||
        target?.closest('[data-row="true"]') ||
        target?.closest('[draggable="true"]')
      ) {
        return;
      }
    }

    const viewport = parentRef.current;
    if (!viewport) return;

    const viewportRect = viewport.getBoundingClientRect();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startScrollTop = viewport.scrollTop;
    const startScrollLeft = viewport.scrollLeft;
    const startContentX = startClientX - viewportRect.left + startScrollLeft;
    const startContentY = startClientY - viewportRect.top + startScrollTop;

    const isModifier = e.shiftKey || e.ctrlKey || e.metaKey;
    const initialSelected = new Set(selectedIds);
    initialSelected.delete('__parent__');
    let isDragging = false;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startClientX;
      const dy = moveEvent.clientY - startClientY;

      if (!isDragging) {
        if (Math.hypot(dx, dy) > 5) {
          isDragging = true;
        } else {
          return;
        }
      }

      const curViewportRect = viewport.getBoundingClientRect();

      // Auto-scrolling when dragging near or outside top/bottom edges
      const topDist = moveEvent.clientY - curViewportRect.top;
      const bottomDist = curViewportRect.bottom - moveEvent.clientY;
      if (topDist < 30) {
        viewport.scrollTop = Math.max(0, viewport.scrollTop - 10);
      } else if (bottomDist < 30) {
        viewport.scrollTop = Math.min(
          viewport.scrollHeight - viewport.clientHeight,
          viewport.scrollTop + 10
        );
      }

      // Clamp mouse coordinates strictly within the container's visible bounds
      const clampedClientX = Math.max(
        curViewportRect.left,
        Math.min(curViewportRect.right, moveEvent.clientX)
      );
      const clampedClientY = Math.max(
        curViewportRect.top,
        Math.min(curViewportRect.bottom, moveEvent.clientY)
      );

      const currentContentX = clampedClientX - curViewportRect.left + viewport.scrollLeft;
      const currentContentY = clampedClientY - curViewportRect.top + viewport.scrollTop;

      // Bound content coordinates to scrollable content dimensions
      const maxContentX = viewport.scrollWidth;
      const maxContentY = Math.max(rowVirtualizer.getTotalSize(), viewport.clientHeight);

      const boundedCurrentX = Math.max(0, Math.min(maxContentX, currentContentX));
      const boundedCurrentY = Math.max(0, Math.min(maxContentY, currentContentY));
      const boundedStartX = Math.max(0, Math.min(maxContentX, startContentX));
      const boundedStartY = Math.max(0, Math.min(maxContentY, startContentY));

      const left = Math.min(boundedStartX, boundedCurrentX);
      const top = Math.min(boundedStartY, boundedCurrentY);
      const width = Math.abs(boundedCurrentX - boundedStartX);
      const height = Math.abs(boundedCurrentY - boundedStartY);

      setMarqueeRect({ left, top, width, height });

      const rowHeight = 36;
      const newSelected = isModifier ? new Set(initialSelected) : new Set<string>();

      items.forEach((item, index) => {
        if (item.kind === 'parent') return;
        const rowTop = index * rowHeight;
        const rowBottom = rowTop + rowHeight;

        if (rowBottom >= top && rowTop <= top + height) {
          newSelected.add(item.data.id);
        }
      });

      if (onSelectMultiple) {
        onSelectMultiple(Array.from(newSelected), 'set');
      }
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);

      if (isDragging) {
        justFinishedMarquee.current = true;
        setTimeout(() => {
          justFinishedMarquee.current = false;
        }, 80);
      }
      setMarqueeRect(null);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleRowDragStart = (
    e: React.DragEvent,
    item: { kind: 'file' | 'folder'; id: string; name: string; virtualPath: string; isTrashed?: boolean }
  ) => {
    setMarqueeRect(null);
    const isItemSelected = selectedIds.has(item.id);
    let dragPayload: Array<{
      kind: 'file' | 'folder';
      id: string;
      name: string;
      virtualPath: string;
      isTrashed?: boolean;
    }> = [];

    if (isItemSelected && selectedIds.size > 1) {
      dragPayload = selectableItems
        .filter((it) => selectedIds.has(it.data.id))
        .map((it) => ({
          kind: it.kind === 'folder' ? 'folder' : 'file',
          id: it.data.id,
          name: it.data.name,
          virtualPath: it.data.virtualPath,
          ...(it.kind === 'trash' ? { isTrashed: true } : {}),
        }));
    } else {
      dragPayload = [item];
      if (!isItemSelected) {
        onSelect(item.id, false);
      }
    }

    e.dataTransfer.setData('application/x-tsubasa-items', JSON.stringify(dragPayload));
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  // TanStack Virtualizer
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  const getActiveIndex = useCallback((): number => {
    if (
      focusIndexRef.current >= 0 &&
      focusIndexRef.current < items.length
    ) {
      const focusedItem = items[focusIndexRef.current];
      const focusedId = focusedItem.kind === 'parent' ? '__parent__' : focusedItem.data.id;
      if (selectedIds.has(focusedId)) {
        return focusIndexRef.current;
      }
    }
    return items.findIndex((it) => {
      const itId = it.kind === 'parent' ? '__parent__' : it.data.id;
      return selectedIds.has(itId);
    });
  }, [items, selectedIds]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (
        activeTag === 'input' ||
        activeTag === 'textarea' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      if (document.querySelector('[role="dialog"]')) {
        return;
      }

      // Ctrl+A / Cmd+A Select All
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        if (selectableIds.length > 0) {
          if (onSelectMultiple) {
            onSelectMultiple(selectableIds, 'set');
          } else {
            for (const id of selectableIds) {
              onSelect(id, true);
            }
          }
        }
        return;
      }

      // Arrow navigation
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        if (e.altKey || (e.ctrlKey && !e.shiftKey)) return;
        if (items.length === 0) return;

        e.preventDefault();

        // Single selection movement (without Shift)
        if (!e.shiftKey) {
          const currentIndex = getActiveIndex();
          let nextIndex: number;

          if (e.key === 'Home') {
            nextIndex = 0;
          } else if (e.key === 'End') {
            nextIndex = items.length - 1;
          } else if (e.key === 'ArrowDown') {
            nextIndex = currentIndex === -1 ? 0 : Math.min(items.length - 1, currentIndex + 1);
          } else {
            nextIndex = currentIndex === -1 ? items.length - 1 : Math.max(0, currentIndex - 1);
          }

          const nextItem = items[nextIndex];
          if (!nextItem) return;

          const nextId = nextItem.kind === 'parent' ? '__parent__' : nextItem.data.id;

          anchorIndexRef.current = nextIndex;
          focusIndexRef.current = nextIndex;
          lastSelectedIdRef.current = nextItem.kind === 'parent' ? null : nextId;

          onSelect(nextId, false);
          rowVirtualizer.scrollToIndex(nextIndex, { align: 'auto' });
          return;
        }

        // Multi-selection range extension (with Shift)
        if (e.shiftKey) {
          let anchor = anchorIndexRef.current;
          if (anchor === -1 || (items[anchor] && items[anchor].kind === 'parent')) {
            const active = getActiveIndex();
            if (active !== -1 && items[active] && items[active].kind !== 'parent') {
              anchor = active;
            } else {
              anchor = items[0]?.kind === 'parent' ? 1 : 0;
            }
            anchorIndexRef.current = anchor;
            focusIndexRef.current = anchor;
          }

          if (anchor >= items.length || !items[anchor]) return;

          let currentFocus = focusIndexRef.current >= 0 ? focusIndexRef.current : anchor;
          let newFocus: number;

          if (e.key === 'Home') {
            newFocus = items[0]?.kind === 'parent' ? 1 : 0;
          } else if (e.key === 'End') {
            newFocus = items.length - 1;
          } else if (e.key === 'ArrowDown') {
            newFocus = Math.min(items.length - 1, currentFocus + 1);
          } else {
            const minAllowed = items[0]?.kind === 'parent' ? 1 : 0;
            newFocus = Math.max(minAllowed, currentFocus - 1);
          }

          focusIndexRef.current = newFocus;
          const focusItem = items[newFocus];
          lastSelectedIdRef.current = focusItem && focusItem.kind !== 'parent' ? focusItem.data.id : null;

          const start = Math.min(anchor, newFocus);
          const end = Math.max(anchor, newFocus);
          const rangeIds: string[] = [];

          for (let i = start; i <= end; i++) {
            const it = items[i];
            if (it && it.kind !== 'parent') {
              rangeIds.push(it.data.id);
            }
          }

          if (onSelectMultiple) {
            onSelectMultiple(rangeIds, 'set');
          } else {
            for (const id of rangeIds) {
              onSelect(id, true);
            }
          }

          rowVirtualizer.scrollToIndex(newFocus, { align: 'auto' });
          return;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    items,
    selectableIds,
    onSelect,
    onSelectMultiple,
    rowVirtualizer,
    getActiveIndex,
  ]);

  return (
    <div {...stylex.props(styles.container)}>
      <div {...stylex.props(styles.headerRow)}>
        <div {...stylex.props(styles.headerGutter)} data-marquee-gutter="true" aria-hidden="true" />
        <div {...stylex.props(styles.checkboxCell)}>
          <button
            type="button"
            role="checkbox"
            aria-checked={isIndeterminate ? 'mixed' : isAllSelected}
            aria-label="Select all files in current folder"
            disabled={selectableIds.length === 0}
            {...stylex.props(
              styles.checkbox,
              (isAllSelected || isIndeterminate) && styles.checkboxChecked,
              selectableIds.length === 0 && styles.checkboxDisabled
            )}
            onClick={(e) => {
              e.stopPropagation();
              handleToggleSelectAll();
            }}
          >
            {isAllSelected && <IconCheck size={12} strokeWidth={3} />}
            {isIndeterminate && <IconMinus size={12} strokeWidth={3} />}
          </button>
        </div>
        <div
          role="columnheader"
          aria-sort={currentSortColumn === 'name' ? (currentSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
          {...stylex.props(styles.headerCell)}
        >
          <button
            type="button"
            {...stylex.props(styles.headerBtn, styles.headerBtnLeft, currentSortColumn === 'name' && styles.headerBtnActive)}
            onClick={() => handleSort('name')}
            aria-label={`Sort by Name in ${currentSortColumn === 'name' && currentSortDirection === 'asc' ? 'descending' : 'ascending'} order`}
            title={`Sort by Name ${currentSortColumn === 'name' ? (currentSortDirection === 'asc' ? '(Z to A)' : '(A to Z)') : '(A to Z)'}`}
          >
            <span>Name</span>
            <span {...stylex.props(styles.sortSlot)}>
              {currentSortColumn === 'name' ? (
                currentSortDirection === 'asc' ? (
                  <IconChevronUp size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon)} />
                ) : (
                  <IconChevronDown size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon)} />
                )
              ) : (
                <IconChevronUp size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon, styles.sortIconHidden)} aria-hidden="true" />
              )}
            </span>
          </button>
        </div>
        <div
          role="columnheader"
          aria-sort={currentSortColumn === 'account' ? (currentSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
          {...stylex.props(styles.headerCell)}
        >
          <button
            type="button"
            {...stylex.props(styles.headerBtn, styles.headerBtnLeft, currentSortColumn === 'account' && styles.headerBtnActive)}
            onClick={() => handleSort('account')}
            aria-label={`Sort by Account in ${currentSortColumn === 'account' && currentSortDirection === 'asc' ? 'descending' : 'ascending'} order`}
            title={`Sort by Account ${currentSortColumn === 'account' ? (currentSortDirection === 'asc' ? '(Z to A)' : '(A to Z)') : '(A to Z)'}`}
          >
            <span>Account</span>
            <span {...stylex.props(styles.sortSlot)}>
              {currentSortColumn === 'account' ? (
                currentSortDirection === 'asc' ? (
                  <IconChevronUp size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon)} />
                ) : (
                  <IconChevronDown size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon)} />
                )
              ) : (
                <IconChevronUp size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon, styles.sortIconHidden)} aria-hidden="true" />
              )}
            </span>
          </button>
        </div>
        <div
          role="columnheader"
          aria-sort={currentSortColumn === 'size' ? (currentSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
          {...stylex.props(styles.headerCell, styles.headerCellRight)}
        >
          <button
            type="button"
            {...stylex.props(styles.headerBtn, styles.headerBtnRight, currentSortColumn === 'size' && styles.headerBtnActive)}
            onClick={() => handleSort('size')}
            aria-label={`Sort by Size in ${currentSortColumn === 'size' && currentSortDirection === 'asc' ? 'descending' : 'ascending'} order`}
            title={`Sort by Size ${currentSortColumn === 'size' ? (currentSortDirection === 'asc' ? '(largest first)' : '(smallest first)') : '(largest first)'}`}
          >
            <span>Size</span>
            <span {...stylex.props(styles.sortSlot)}>
              {currentSortColumn === 'size' ? (
                currentSortDirection === 'asc' ? (
                  <IconChevronUp size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon)} />
                ) : (
                  <IconChevronDown size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon)} />
                )
              ) : (
                <IconChevronUp size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon, styles.sortIconHidden)} aria-hidden="true" />
              )}
            </span>
          </button>
        </div>
        <div
          role="columnheader"
          aria-sort={currentSortColumn === 'date' ? (currentSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
          {...stylex.props(styles.headerCell, styles.headerCellRight)}
        >
          <button
            type="button"
            {...stylex.props(styles.headerBtn, styles.headerBtnRight, currentSortColumn === 'date' && styles.headerBtnActive)}
            onClick={() => handleSort('date')}
            aria-label={`Sort by ${isTrashView ? 'Date trashed' : 'Date modified'} in ${currentSortColumn === 'date' && currentSortDirection === 'asc' ? 'descending' : 'ascending'} order`}
            title={`Sort by ${isTrashView ? 'Date trashed' : 'Date modified'} ${currentSortColumn === 'date' ? (currentSortDirection === 'asc' ? '(newest first)' : '(oldest first)') : '(newest first)'}`}
          >
            <span>{isTrashView ? 'Date trashed' : 'Modified'}</span>
            <span {...stylex.props(styles.sortSlot)}>
              {currentSortColumn === 'date' ? (
                currentSortDirection === 'asc' ? (
                  <IconChevronUp size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon)} />
                ) : (
                  <IconChevronDown size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon)} />
                )
              ) : (
                <IconChevronUp size={12} strokeWidth={2.5} {...stylex.props(styles.sortIcon, styles.sortIconHidden)} aria-hidden="true" />
              )}
            </span>
          </button>
        </div>
        <div {...stylex.props(styles.headerCell, styles.headerCellRight)}>Actions</div>
      </div>

      <div
        ref={parentRef}
        {...stylex.props(styles.scrollViewport)}
        onMouseDown={handleMouseDown}
        onDragOver={(e) => {
          if (isTrashView) return;
          if (isExternalFileDrag(e) || isInternalItemDrag(e)) {
            e.preventDefault();
          }
        }}
        onClick={() => {
          if (!justFinishedMarquee.current) {
            anchorIndexRef.current = -1;
            focusIndexRef.current = -1;
            lastSelectedIdRef.current = null;
            onClearSelection?.();
          }
        }}
      >
        {items.length === 0 ? (
          <div
            {...stylex.props(
              styles.emptyState,
              isDropZoneActive && !isTrashView && styles.emptyStateDragOver
            )}
            onDragEnter={(e) => {
              if (isTrashView || !isExternalFileDrag(e)) return;
              e.preventDefault();
              e.stopPropagation();
              setIsDropZoneActive(true);
            }}
            onDragOver={(e) => {
              if (isTrashView || !isExternalFileDrag(e)) {
                if (isDropZoneActive) setIsDropZoneActive(false);
                return;
              }
              e.preventDefault();
              e.stopPropagation();
              if (e.dataTransfer) {
                e.dataTransfer.dropEffect = 'copy';
              }
              if (!isDropZoneActive) {
                setIsDropZoneActive(true);
              }
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDropZoneActive(false);
            }}
            onDrop={(e) => {
              setIsDropZoneActive(false);
              handleDrop(e);
            }}
          >
            {isDropZoneActive && !isTrashView ? (
              <div {...stylex.props(styles.dropBox)}>
                <IconUpload size={36} color={colors.accentGold} strokeWidth={2.5} />
                <h3 {...stylex.props(styles.dropTitle)}>Drop files to upload</h3>
                <p {...stylex.props(styles.dropSubtitle)}>
                  Files will be staged for cluster allocation
                </p>
                <span {...stylex.props(styles.dropTargetBadge)}>
                  Target: {cleanPath}
                </span>
              </div>
            ) : (
              <>
                <h3 {...stylex.props(styles.emptyTitle)}>
                  {isTrashView
                    ? 'Trash is empty'
                    : isSearching
                    ? 'No search results'
                    : 'Folder is empty'}
                </h3>
                <p {...stylex.props(styles.emptyDesc)}>
                  {isTrashView
                    ? 'Soft-deleted files across connected accounts will appear here.'
                    : isSearching
                    ? `No files or directories match "${searchQuery}".`
                    : 'Upload files or create subfolders to populate this directory.'}
                </p>
              </>
            )}
          </div>
        ) : (
          <div {...stylex.props(styles.tableBodyContainer)}>
            {marqueeRect && (
              <div
                {...stylex.props(styles.marqueeBox)}
                style={{
                  left: `${marqueeRect.left}px`,
                  top: `${marqueeRect.top}px`,
                  width: `${marqueeRect.width}px`,
                  height: `${marqueeRect.height}px`,
                }}
              />
            )}
            <div
              {...stylex.props(styles.virtualTrack)}
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const item = items[virtualRow.index];
                if (!item) return null;

                if (item.kind === 'parent') {
                  const isDragOverParent = dragOverRowId === '__parent__';
                  const isSelected = selectedIds.has('__parent__');
                  return (
                    <div
                      key={`parent-${virtualRow.index}`}
                      {...stylex.props(
                        styles.rowWrapper,
                        isSelected && styles.rowWrapperSelected,
                        isDragOverParent && styles.rowWrapperDragOver
                      )}
                      style={{
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <div
                        data-marquee-gutter="true"
                        aria-hidden="true"
                        {...stylex.props(styles.gutterCell)}
                      />
                      <div
                        data-row="true"
                        {...stylex.props(
                          styles.rowMain,
                          isSelected && styles.rowSelected,
                          isDragOverParent && styles.rowDragOver
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleItemClick('__parent__', e);
                        }}
                        onDoubleClick={() => onNavigate(item.path)}
                        onDragOver={(e) => {
                          if (isTrashView) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.dataTransfer) {
                            e.dataTransfer.dropEffect = isInternalItemDrag(e) ? 'move' : 'copy';
                          }
                          setDragOverRowId('__parent__');
                        }}
                        onDragLeave={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDragOverRowId((prev) => (prev === '__parent__' ? null : prev));
                        }}
                        onDrop={(e) => {
                          setDragOverRowId(null);
                          handleRowDrop(e, item.path);
                        }}
                      >
                        <div {...stylex.props(styles.checkboxCell)} />
                        <div {...stylex.props(styles.nameCell)} title={item.path}>
                          <IconFolderFilled {...stylex.props(styles.itemIcon, styles.folderIcon)} />
                          <span {...stylex.props(styles.itemLabel)}>.. (Parent directory)</span>
                        </div>
                        <div {...stylex.props(styles.accountCell)}>
                          <span {...stylex.props(styles.accountPill)} title="Parent folder">Parent folder</span>
                        </div>
                        <div {...stylex.props(styles.colRight, styles.tabularCell)}>—</div>
                        <div {...stylex.props(styles.colRight, styles.tabularCell)}>—</div>
                        <div {...stylex.props(styles.actionsCell)}>
                          <button
                            type="button"
                            {...stylex.props(styles.rowBtn)}
                            aria-label="Open parent folder"
                            onClick={(e) => {
                              e.stopPropagation();
                              onNavigate(item.path);
                            }}
                          >
                            <IconChevronRight {...stylex.props(styles.actionIcon)} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                }

                if (item.kind === 'folder') {
                  const folder = item.data;
                  const isSelected = selectedIds.has(folder.id);
                  const isDragOverFolder = dragOverRowId === folder.id;
                  const isCut = clipboard?.mode === 'cut' && clipboard.items.some((ci) => ci.id === folder.id);
                  const folderSize = folderSizeMap.get(folder.id) || 0;

                  return (
                    <div
                      key={folder.id}
                      {...stylex.props(
                        styles.rowWrapper,
                        isSelected && styles.rowWrapperSelected,
                        isDragOverFolder && styles.rowWrapperDragOver
                      )}
                      style={{
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <div
                        data-marquee-gutter="true"
                        aria-hidden="true"
                        {...stylex.props(styles.gutterCell)}
                      />
                      <div
                        data-row="true"
                        draggable={!isTrashView}
                        onDragStart={(e) =>
                          handleRowDragStart(e, {
                            kind: 'folder',
                            id: folder.id,
                            name: folder.name,
                            virtualPath: folder.virtualPath,
                          })
                        }
                        onDragOver={(e) => {
                          if (isTrashView) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.dataTransfer) {
                            e.dataTransfer.dropEffect = isInternalItemDrag(e) ? 'move' : 'copy';
                          }
                          setDragOverRowId(folder.id);
                        }}
                        onDragLeave={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDragOverRowId((prev) => (prev === folder.id ? null : prev));
                        }}
                        onDrop={(e) => {
                          setDragOverRowId(null);
                          handleRowDrop(e, folder.virtualPath);
                        }}
                        {...stylex.props(
                          styles.rowMain,
                          isSelected && styles.rowSelected,
                          isDragOverFolder && styles.rowDragOver,
                          isCut && styles.rowCutMuted
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleItemClick(folder.id, e);
                        }}
                        onDoubleClick={() => onNavigate(folder.virtualPath)}
                      >
                        <div {...stylex.props(styles.checkboxCell)}>
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={isSelected}
                            aria-label={`Select folder ${folder.name}`}
                            {...stylex.props(styles.checkbox, isSelected && styles.checkboxChecked)}
                            onClick={(e) => handleCheckboxToggle(folder.id, e)}
                          >
                            {isSelected && <IconCheck size={12} strokeWidth={3} />}
                          </button>
                        </div>

                        <div {...stylex.props(styles.nameCell)} title={folder.virtualPath}>
                          <IconFolderFilled {...stylex.props(styles.itemIcon, styles.folderIcon)} />
                          <span {...stylex.props(styles.itemLabel)}>
                            {isSearching ? folder.virtualPath : folder.name}
                          </span>
                        </div>

                        <div {...stylex.props(styles.accountCell)}>
                          <span {...stylex.props(styles.accountPill)} title="Cluster folder">Cluster folder</span>
                        </div>

                        <div
                          {...stylex.props(styles.colRight, styles.tabularCell)}
                          title={folderSize > 0 ? `${formatBytes(folderSize)} across descendant files` : 'Empty folder'}
                        >
                          {folderSize > 0 ? formatBytes(folderSize) : '—'}
                        </div>
                        <div {...stylex.props(styles.colRight, styles.tabularCell)}>
                          {formatDate(folder.updatedAt)}
                        </div>
                        <div {...stylex.props(styles.actionsCell)}>
                          {onDeleteFolder && (
                            <button
                              type="button"
                              {...stylex.props(styles.rowBtn, styles.rowBtnDanger)}
                              aria-label="Delete folder"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteFolder(folder);
                              }}
                            >
                              <IconTrash {...stylex.props(styles.actionIcon)} />
                            </button>
                          )}
                          <button
                            type="button"
                            {...stylex.props(styles.rowBtn)}
                            aria-label="Open folder"
                            onClick={(e) => {
                              e.stopPropagation();
                              onNavigate(folder.virtualPath);
                            }}
                          >
                            <IconChevronRight {...stylex.props(styles.actionIcon)} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                }

                if (item.kind === 'trash') {
                  const file = item.data;
                  const isSelected = selectedIds.has(file.id);
                  const fileAcc = accounts.find((a) => a.id === file.accountId);

                  return (
                    <div
                      key={`trash-${file.id}`}
                      {...stylex.props(
                        styles.rowWrapper,
                        isSelected && styles.rowWrapperSelected
                      )}
                      style={{
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <div
                        data-marquee-gutter="true"
                        aria-hidden="true"
                        {...stylex.props(styles.gutterCell)}
                      />
                      <div
                        data-row="true"
                        draggable={true}
                        onDragStart={(e) =>
                          handleRowDragStart(e, {
                            kind: 'file',
                            id: file.id,
                            name: file.name,
                            virtualPath: file.virtualPath,
                            isTrashed: true,
                          })
                        }
                        {...stylex.props(styles.rowMain, isSelected && styles.rowSelected)}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleItemClick(file.id, e);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.dataTransfer) {
                            e.dataTransfer.dropEffect = 'none';
                          }
                        }}
                      >
                      <div {...stylex.props(styles.checkboxCell)}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={isSelected}
                          aria-label={`Select trashed file ${file.name}`}
                          {...stylex.props(styles.checkbox, isSelected && styles.checkboxChecked)}
                          onClick={(e) => handleCheckboxToggle(file.id, e)}
                        >
                          {isSelected && <IconCheck size={12} strokeWidth={3} />}
                        </button>
                      </div>

                      <div {...stylex.props(styles.nameCell)} title={file.virtualPath}>
                        <IconFile {...stylex.props(styles.itemIcon)} />
                        <span
                          {...stylex.props(styles.itemLabel)}
                          title={`Original location: ${file.virtualPath}`}
                        >
                          {file.virtualPath}
                        </span>
                      </div>

                      <div {...stylex.props(styles.accountCell)}>
                        <span
                          {...stylex.props(styles.accountPill)}
                          title={fileAcc ? `${fileAcc.displayName || file.accountId} (${fileAcc.email || file.accountId})` : file.accountId}
                        >
                          {file.accountId}
                        </span>
                      </div>

                      <div {...stylex.props(styles.colRight, styles.tabularCell)}>
                        {formatBytes(file.sizeBytes)}
                      </div>

                      <div {...stylex.props(styles.colRight, styles.tabularCell)}>
                        {formatDate(file.trashedAt || file.updatedAt)}
                      </div>

                      <div {...stylex.props(styles.actionsCell)}>
                        {onRestore && (
                          <button
                            type="button"
                            {...stylex.props(styles.rowBtn)}
                            aria-label="Restore to original location"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRestore(file);
                            }}
                          >
                            <IconRotateCcw {...stylex.props(styles.actionIcon)} />
                          </button>
                        )}

                        {onPermanentDelete && (
                          <button
                            type="button"
                            {...stylex.props(styles.rowBtn, styles.rowBtnDanger)}
                            aria-label="Delete permanently from Google Drive"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPermanentDelete(file);
                            }}
                          >
                            <IconTrash {...stylex.props(styles.actionIcon)} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }

                // File row
                const file = item.data;
                const isSelected = selectedIds.has(file.id);
                const isCut = clipboard?.mode === 'cut' && clipboard.items.some((ci) => ci.id === file.id);
                const fileAcc = accounts.find((a) => a.id === file.accountId);

                return (
                  <div
                    key={file.id}
                    {...stylex.props(
                      styles.rowWrapper,
                      isSelected && styles.rowWrapperSelected
                    )}
                    style={{
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div
                      data-marquee-gutter="true"
                      aria-hidden="true"
                      {...stylex.props(styles.gutterCell)}
                    />
                    <div
                      data-row="true"
                      draggable={!isTrashView}
                      onDragStart={(e) =>
                        handleRowDragStart(e, {
                          kind: 'file',
                          id: file.id,
                          name: file.name,
                          virtualPath: file.virtualPath,
                        })
                      }
                      onDragOver={(e) => {
                        if (isTrashView) return;
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.dataTransfer) {
                          e.dataTransfer.dropEffect = 'none';
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        (e.nativeEvent as any).__tsubasaHandled = true;
                      }}
                      {...stylex.props(
                        styles.rowMain,
                        isSelected && styles.rowSelected,
                        isCut && styles.rowCutMuted
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleItemClick(file.id, e);
                      }}
                    >
                    <div {...stylex.props(styles.checkboxCell)}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={isSelected}
                        aria-label={`Select file ${file.name}`}
                        {...stylex.props(styles.checkbox, isSelected && styles.checkboxChecked)}
                        onClick={(e) => handleCheckboxToggle(file.id, e)}
                      >
                        {isSelected && <IconCheck size={12} strokeWidth={3} />}
                      </button>
                    </div>

                    <div {...stylex.props(styles.nameCell)} title={file.virtualPath}>
                      <IconFile {...stylex.props(styles.itemIcon)} />
                      <span {...stylex.props(styles.itemLabel)}>
                        {isSearching ? file.virtualPath : file.name}
                      </span>
                    </div>

                    <div {...stylex.props(styles.accountCell)}>
                      {accounts && accounts.length > 1 && onTransferFile ? (
                        <div {...stylex.props(styles.selectWrapper)}>
                          <select
                            aria-label={`Transfer ${file.name} to another account`}
                            title={fileAcc ? `${fileAcc.displayName || file.accountId} (${fileAcc.email || file.accountId})` : file.accountId}
                            value={file.accountId}
                            disabled={transferringFileId === file.id}
                            {...stylex.props(
                              styles.accountSelect,
                              transferringFileId === file.id && styles.accountSelectTransferring
                            )}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              e.stopPropagation();
                              const targetId = e.target.value;
                              if (targetId && targetId !== file.accountId) {
                                onTransferFile(file.id, targetId);
                              }
                            }}
                          >
                            {accounts.map((acc) => {
                              const isCurrent = acc.id === file.accountId;
                              const isDriveDisabled = Boolean(acc.isDisabled);
                              const hasHeadroom = acc.headroomBytes >= file.sizeBytes;
                              const remainingBudget =
                                acc.transferStats?.remainingUploadBytes24h ?? 750 * 1024 * 1024 * 1024;
                              const hasTransferBudget = remainingBudget >= file.sizeBytes;
                              const canHold = !isDriveDisabled && acc.authorized && hasHeadroom && hasTransferBudget;
                              const isMuted = !isCurrent && !canHold;

                              let labelSuffix = '';
                              if (isCurrent) {
                                labelSuffix = ' (Current)';
                              } else if (isDriveDisabled) {
                                labelSuffix = ' (Disabled)';
                              } else if (!acc.authorized) {
                                labelSuffix = ' (Unauthorized)';
                              } else if (!hasHeadroom) {
                                labelSuffix = ` (No headroom: needs ${formatGbCompact(file.sizeBytes)} GB)`;
                              } else if (!hasTransferBudget) {
                                labelSuffix = ' (24h transfer limit reached)';
                              } else {
                                labelSuffix = ` (${formatGbCompact(acc.headroomBytes)} GB free)`;
                              }

                              const optFullTitle = `${acc.displayName || acc.id} (${acc.email || acc.id})${labelSuffix}`;

                              return (
                                <option key={acc.id} value={acc.id} disabled={isMuted} title={optFullTitle}>
                                  {(acc.displayName || acc.id) + labelSuffix}
                                </option>
                              );
                            })}
                          </select>
                          <div {...stylex.props(styles.selectChevron)}>
                            <IconChevronDown size={10} strokeWidth={2.5} />
                          </div>
                        </div>
                      ) : (
                        <span
                          {...stylex.props(styles.accountPill)}
                          title={fileAcc ? `${fileAcc.displayName || file.accountId} (${fileAcc.email || file.accountId})` : file.accountId}
                        >
                          {file.accountId}
                        </span>
                      )}
                    </div>

                    <div {...stylex.props(styles.colRight, styles.tabularCell)}>
                      {formatBytes(file.sizeBytes)}
                    </div>

                    <div {...stylex.props(styles.colRight, styles.tabularCell)}>
                      {formatDate(file.updatedAt)}
                    </div>

                    <div {...stylex.props(styles.actionsCell)}>
                      <button
                        type="button"
                        {...stylex.props(styles.rowBtn)}
                        aria-label="Download file"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDownload(file);
                        }}
                      >
                        <IconDownload {...stylex.props(styles.actionIcon)} />
                      </button>

                      <button
                        type="button"
                        {...stylex.props(styles.rowBtn)}
                        aria-label="Move to trash"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTrash(file);
                        }}
                      >
                        <IconTrash {...stylex.props(styles.actionIcon)} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            </div>

            <div
              {...stylex.props(styles.emptyDropZone)}
              onDragEnter={(e) => {
                if (isTrashView || !isExternalFileDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setIsDropZoneActive(true);
              }}
              onDragOver={(e) => {
                if (isTrashView || !isExternalFileDrag(e)) {
                  if (isDropZoneActive) setIsDropZoneActive(false);
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer) {
                  e.dataTransfer.dropEffect = 'copy';
                }
                if (!isDropZoneActive) {
                  setIsDropZoneActive(true);
                }
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDropZoneActive(false);
              }}
              onDrop={(e) => {
                setIsDropZoneActive(false);
                handleDrop(e);
              }}
            >
              {isDropZoneActive && !isTrashView && (
                <div {...stylex.props(styles.dropBox)}>
                  <IconUpload size={32} color={colors.accentGold} strokeWidth={2.5} />
                  <h3 {...stylex.props(styles.dropTitle)}>Drop files to upload</h3>
                  <p {...stylex.props(styles.dropSubtitle)}>
                    Files will be staged for cluster allocation
                  </p>
                  <span {...stylex.props(styles.dropTargetBadge)}>
                    Target: {cleanPath}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
