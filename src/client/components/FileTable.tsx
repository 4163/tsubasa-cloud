import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import {
  IconFolderFilled,
  FileTypeIcon,
  IconDownload,
  IconTrash,
  IconChevronRight,
  IconChevronUp,
  IconChevronDown,
  IconRotateCcw,
  IconUpload,
  IconCheck,
  IconMinus,
  IconShare,
  IconLink,
} from './Icons.js';
import { formatBytes, COPY_FEEDBACK_DURATION_MS } from '../utils/format.js';
import { useMediaQuery } from '../utils/useBeforeUnload.js';
import {
  getParentDir,
  setActiveInternalDragPayload,
  rejectInvalidInternalDragOver,
  parseInternalDropItems,
} from '../utils/virtualPath.js';
import { evaluateAccountTransferCandidate } from '../utils/accountTransfer.js';
import { RedactedEmail } from './RedactedEmail.js';

const TABLE_ROW_HEIGHT_DESKTOP = 36;
const TABLE_ROW_HEIGHT_COARSE = 44;
const TABLE_ROW_HEIGHT_MOBILE = 64;
const DOUBLE_CLICK_MS = 500;
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
  onStageDroppedUpload?: (dropped: {
    files: Array<{ file: File; virtualPath: string }>;
    emptyFolders: string[];
    basePath?: string;
  }) => void;
  onMoveItems?: (items: Array<{ kind: 'file' | 'folder'; id: string }>, targetPath: string) => Promise<void> | void;
  clipboard?: { mode: 'cut' | 'copy'; items: Array<{ kind: 'file' | 'folder'; id: string; name: string; virtualPath: string }> } | null;
  accounts?: AccountItem[];
  onTransferFile?: (fileId: string, targetAccountId: string) => Promise<void>;
  transferringFileId?: string | null;
  sortColumn?: SortColumn;
  sortDirection?: SortDirection;
  onSortChange?: (column: SortColumn, direction: SortDirection) => void;
  onShareItem?: (item: { kind: 'file' | 'folder'; id: string; name: string; virtualPath: string }) => void;
  isSharePoolActive?: boolean;
  isLoading?: boolean;
  shareLinksByBatch?: Record<string, Array<{ webViewLink: string; accountId: string }>>;
  onCopyShareLinks?: (batchFolderName: string) => Promise<boolean> | void;
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
    gridTemplateColumns: '16px 40px minmax(240px, 3fr) 160px 110px 156px 96px',
    alignItems: 'stretch',
    paddingLeft: '0px',
    paddingRight: spacing.space4,
    fontSize: typography.fontSizeTableHeader,
    fontWeight: typography.fontWeightTableHeader,
    color: colors.secondaryText,
    userSelect: 'none',
    boxSizing: 'border-box',
    overflow: 'hidden',
    flexShrink: 0,
    '@media (pointer: coarse)': {
      gridTemplateColumns: '16px 40px minmax(240px, 3fr) 160px 110px 156px 120px',
    },
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  headerGutter: {
    width: '16px',
    height: '100%',
    boxSizing: 'border-box',
  },
  headerCell: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    boxSizing: 'border-box',
  },
  headerBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    height: '100%',
    paddingLeft: spacing.space1,
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
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
  },
  headerBtnLeft: {
    marginLeft: '-4px',
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
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  rowWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: layout.tableRowHeight,
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
      height: '44px',
    },
    '@media (max-width: 768px)': {
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
    gridTemplateColumns: '40px minmax(240px, 3fr) 160px 110px 156px 96px',
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
      gridTemplateColumns: '40px minmax(240px, 3fr) 160px 110px 156px 120px',
      ':active': {
        backgroundColor: colors.rowHover,
        transition: motion.transitionTap,
      },
    },
    '@media (max-width: 768px)': {
      gridTemplateColumns: '36px minmax(0, 1fr) auto',
      paddingLeft: spacing.space2,
      paddingRight: spacing.space3,
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
    minWidth: '28px',
    minHeight: '28px',
    borderRadius: radius.compact,
    borderWidth: '0px',
    backgroundColor: 'transparent',
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
      backgroundColor: colors.surfaceAlt,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    '@media (pointer: coarse)': {
      minWidth: '36px',
      minHeight: '36px',
    },
  },
  checkboxDisabled: {
    opacity: 0.35,
    cursor: 'not-allowed',
  },
  checkboxBox: {
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
    boxSizing: 'border-box',
    transition: motion.transitionFast,
    pointerEvents: 'none',
  },
  checkboxBoxChecked: {
    backgroundColor: colors.accentGold,
    borderColor: colors.accentGold,
    color: colors.accentGoldText,
  },
  marqueeBox: {
    position: 'absolute',
    top: 0,
    left: 0,
    display: 'none',
    willChange: 'transform, width, height',
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
    paddingLeft: '2px',
    paddingRight: spacing.space6,
    overflow: 'hidden',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  selectWrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    maxWidth: '136px',
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
    maxWidth: '136px',
    outline: 'none',
    cursor: 'pointer',
    boxSizing: 'border-box',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    transitionProperty: 'background-color, opacity',
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easingOut,
    ':hover': {
      borderColor: colors.accentGold,
      backgroundColor: colors.surfaceAlt,
    },
    ':focus': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
    ':focus-visible': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
  accountSelectTransferring: {
    opacity: 0.5,
    cursor: 'wait',
    pointerEvents: 'none',
  },
  accountPill: {
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    display: 'inline-block',
    maxWidth: '100%',
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
    boxSizing: 'border-box',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
    cursor: 'default',
    userSelect: 'text',
  },
  tabularCell: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    paddingRight: spacing.space2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  dateCell: {
    paddingRight: spacing.space4,
  },
  actionsCell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: spacing.space1,
    '@media (max-width: 768px)': {
      justifyContent: 'flex-end',
    },
  },
  rowBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    minWidth: '26px',
    minHeight: '26px',
    padding: spacing.space1,
    color: colors.secondaryText,
    borderRadius: radius.compact,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    boxSizing: 'border-box',
    transition: motion.transitionFast,
    ':hover': {
      color: colors.primaryText,
      backgroundColor: colors.surfaceAlt,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    '@media (pointer: coarse)': {
      minWidth: '36px',
      minHeight: '36px',
    },
  },
  rowBtnDanger: {
    ':hover': {
      color: colors.danger,
      backgroundColor: colors.dangerSurface,
    },
  },
  rowBtnCopied: {
    color: colors.success,
    backgroundColor: colors.successSurface,
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
    minWidth: '829px',
    position: 'relative',
    boxSizing: 'border-box',
    userSelect: 'none',
    '@media (pointer: coarse)': {
      minWidth: '853px',
    },
    '@media (max-width: 768px)': {
      minWidth: 0,
    },
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
  loadingSpinner: {
    position: 'relative',
    width: layout.loadingSpinnerSize,
    height: layout.loadingSpinnerSize,
    borderRadius: radius.pill,
    appearance: 'none',
    color: colors.brandAccent,
    backgroundColor: colors.progressTrack,
  },
});

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
): Promise<{ files: Array<{ file: File; virtualPath: string }>; emptyFolders: string[]; basePath: string }> {
  const cleanBase = basePath === '/' ? '' : basePath.replace(/\/+$/, '');
  const normalizedBase = cleanBase === '' ? '/' : cleanBase.startsWith('/') ? cleanBase : `/${cleanBase}`;
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
    return { files: resultFiles, emptyFolders: resultEmptyFolders, basePath: normalizedBase };
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
    return { files: resultFiles, emptyFolders: resultEmptyFolders, basePath: normalizedBase };
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

  return { files: resultFiles, emptyFolders: resultEmptyFolders, basePath: normalizedBase };
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortFolders(
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

function sortFiles(
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

function getAccountTooltip(accountId: string, fileAcc?: AccountItem): string {
  const email = fileAcc?.email || accountId;
  if (fileAcc?.displayName && fileAcc.displayName !== email) {
    return `${fileAcc.displayName} (${email})`;
  }
  return email;
}

interface DragItemPayload {
  kind: 'file' | 'folder';
  id: string;
  name: string;
  virtualPath: string;
  isTrashed?: boolean;
}

interface MemoParentRowProps {
  path: string;
  rowIndex: number;
  virtualSize: number;
  virtualStart: number;
  isSelected: boolean;
  isDragOver: boolean;
  isTrashView: boolean;
  isSharePoolActive: boolean;
  onItemClick: (id: string, e: React.MouseEvent) => void;
  onNavigate: (path: string) => void;
  onSetDragOverRowId: React.Dispatch<React.SetStateAction<string | null>>;
  onRowDrop: (e: React.DragEvent, targetVirtualPath: string) => void;
}

const MemoParentRow = React.memo(function MemoParentRow({
  path,
  rowIndex,
  virtualSize,
  virtualStart,
  isSelected,
  isDragOver,
  isTrashView,
  isSharePoolActive,
  onItemClick,
  onNavigate,
  onSetDragOverRowId,
  onRowDrop,
}: MemoParentRowProps) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-selected={isSelected}
      {...stylex.props(
        styles.rowWrapper,
        isSelected && styles.rowWrapperSelected,
        isDragOver && styles.rowWrapperDragOver
      )}
      style={{
        height: `${virtualSize}px`,
        transform: `translateY(${virtualStart}px)`,
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
          isDragOver && styles.rowDragOver
        )}
        onClick={(e) => {
          e.stopPropagation();
          onItemClick('__parent__', e);
        }}
        onDragOver={(e) => {
          if (isTrashView || isSharePoolActive) return;
          if (
            rejectInvalidInternalDragOver(e, path, () =>
              onSetDragOverRowId((prev) => (prev === '__parent__' ? null : prev))
            )
          ) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = isInternalItemDrag(e) ? 'move' : 'copy';
          }
          onSetDragOverRowId('__parent__');
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSetDragOverRowId((prev) => (prev === '__parent__' ? null : prev));
        }}
        onDrop={(e) => {
          if (isInternalItemDrag(e) && !parseInternalDropItems(e, path)) {
            e.preventDefault();
            e.stopPropagation();
            (e.nativeEvent as any).__tsubasaHandled = true;
            setActiveInternalDragPayload(null);
            onSetDragOverRowId(null);
            return;
          }
          onSetDragOverRowId(null);
          onRowDrop(e, path);
        }}
      >
        <div role="gridcell" {...stylex.props(styles.checkboxCell)} />
        <div role="gridcell" {...stylex.props(styles.nameCell)} title={path}>
          <IconFolderFilled {...stylex.props(styles.itemIcon, styles.folderIcon)} />
          <span {...stylex.props(styles.itemLabel)}>.. (Parent directory)</span>
        </div>
        <div role="gridcell" {...stylex.props(styles.accountCell)}>
          <span {...stylex.props(styles.accountPill)}>Parent folder</span>
        </div>
        <div role="gridcell" {...stylex.props(styles.tabularCell)}>—</div>
        <div role="gridcell" {...stylex.props(styles.tabularCell, styles.dateCell)}>—</div>
        <div role="gridcell" {...stylex.props(styles.actionsCell)}>
          <button
            type="button"
            {...stylex.props(styles.rowBtn)}
            aria-label="Open parent folder"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(path);
            }}
          >
            <IconChevronRight {...stylex.props(styles.actionIcon)} />
          </button>
        </div>
      </div>
    </div>
  );
});

interface MemoFolderRowProps {
  folder: ClientFolder;
  rowIndex: number;
  virtualSize: number;
  virtualStart: number;
  isSelected: boolean;
  isDragOver: boolean;
  isCut: boolean;
  folderSize: number;
  folderBatchLinks?: Array<{ webViewLink: string; accountId: string }>;
  isCopiedBatch: boolean;
  isTrashView: boolean;
  isSharePoolActive: boolean;
  isSearching: boolean;
  onItemClick: (id: string, e: React.MouseEvent) => void;
  onCheckboxToggle: (id: string, e: React.MouseEvent) => void;
  onRowDragStart: (e: React.DragEvent, item: DragItemPayload) => void;
  onSetDragOverRowId: React.Dispatch<React.SetStateAction<string | null>>;
  onRowDrop: (e: React.DragEvent, targetVirtualPath: string) => void;
  onShareItem?: (item: { kind: 'file' | 'folder'; id: string; name: string; virtualPath: string }) => void;
  onCopyBatchLinks?: (folderId: string, folderName: string) => void;
  onDeleteFolder?: (folder: ClientFolder) => void;
  onNavigate: (path: string) => void;
}

const MemoFolderRow = React.memo(function MemoFolderRow({
  folder,
  rowIndex,
  virtualSize,
  virtualStart,
  isSelected,
  isDragOver,
  isCut,
  folderSize,
  folderBatchLinks,
  isCopiedBatch,
  isTrashView,
  isSharePoolActive,
  isSearching,
  onItemClick,
  onCheckboxToggle,
  onRowDragStart,
  onSetDragOverRowId,
  onRowDrop,
  onShareItem,
  onCopyBatchLinks,
  onDeleteFolder,
  onNavigate,
}: MemoFolderRowProps) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-selected={isSelected}
      {...stylex.props(
        styles.rowWrapper,
        isSelected && styles.rowWrapperSelected,
        isDragOver && styles.rowWrapperDragOver
      )}
      style={{
        height: `${virtualSize}px`,
        transform: `translateY(${virtualStart}px)`,
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
          onRowDragStart(e, {
            kind: 'folder',
            id: folder.id,
            name: folder.name,
            virtualPath: folder.virtualPath,
          })
        }
        onDragOver={(e) => {
          if (isTrashView || isSharePoolActive) return;
          if (
            rejectInvalidInternalDragOver(e, folder.virtualPath, () =>
              onSetDragOverRowId((prev) => (prev === folder.id ? null : prev))
            )
          ) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = isInternalItemDrag(e) ? 'move' : 'copy';
          }
          onSetDragOverRowId(folder.id);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSetDragOverRowId((prev) => (prev === folder.id ? null : prev));
        }}
        onDrop={(e) => {
          if (isInternalItemDrag(e) && !parseInternalDropItems(e, folder.virtualPath)) {
            e.preventDefault();
            e.stopPropagation();
            (e.nativeEvent as any).__tsubasaHandled = true;
            setActiveInternalDragPayload(null);
            onSetDragOverRowId(null);
            return;
          }
          onSetDragOverRowId(null);
          onRowDrop(e, folder.virtualPath);
        }}
        {...stylex.props(
          styles.rowMain,
          isSelected && styles.rowSelected,
          isDragOver && styles.rowDragOver,
          isCut && styles.rowCutMuted
        )}
        onClick={(e) => {
          e.stopPropagation();
          onItemClick(folder.id, e);
        }}
      >
        <div role="gridcell" {...stylex.props(styles.checkboxCell)}>
          <button
            type="button"
            role="checkbox"
            aria-checked={isSelected}
            aria-label={`Select folder ${folder.name}`}
            {...stylex.props(styles.checkbox)}
            onClick={(e) => onCheckboxToggle(folder.id, e)}
          >
            <span
              aria-hidden="true"
              {...stylex.props(styles.checkboxBox, isSelected && styles.checkboxBoxChecked)}
            >
              {isSelected && <IconCheck size={12} strokeWidth={3} />}
            </span>
          </button>
        </div>

        <div role="gridcell" {...stylex.props(styles.nameCell)} title={folder.virtualPath}>
          <IconFolderFilled {...stylex.props(styles.itemIcon, styles.folderIcon)} />
          <span {...stylex.props(styles.itemLabel)}>
            {isSearching ? folder.virtualPath : folder.name}
          </span>
        </div>

        <div role="gridcell" {...stylex.props(styles.accountCell)}>
          <span {...stylex.props(styles.accountPill)}>Cluster folder</span>
        </div>

        <div
          role="gridcell"
          {...stylex.props(styles.tabularCell)}
          title={folderSize > 0 ? `${formatBytes(folderSize)} across descendant files` : 'Empty folder'}
        >
          {folderSize > 0 ? formatBytes(folderSize) : '—'}
        </div>
        <div role="gridcell" {...stylex.props(styles.tabularCell, styles.dateCell)}>
          {formatDate(folder.updatedAt)}
        </div>
        <div role="gridcell" {...stylex.props(styles.actionsCell)}>
          {!isTrashView && !isSharePoolActive && onShareItem && (
            <button
              type="button"
              {...stylex.props(styles.rowBtn)}
              aria-label={`Share folder ${folder.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onShareItem({
                  kind: 'folder',
                  id: folder.id,
                  name: folder.name,
                  virtualPath: folder.virtualPath,
                });
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <IconShare {...stylex.props(styles.actionIcon)} />
            </button>
          )}
          {folderBatchLinks && folderBatchLinks.length > 0 && onCopyBatchLinks && (
            <button
              type="button"
              {...stylex.props(
                styles.rowBtn,
                isCopiedBatch && styles.rowBtnCopied
              )}
              aria-label={`Copy share link for ${folder.name}`}
              title={
                folderBatchLinks.length === 1
                  ? `Copy share link: ${folderBatchLinks[0].webViewLink}`
                  : `Copy ${folderBatchLinks.length} share links (across ${folderBatchLinks.length} drives)`
              }
              onClick={(e) => {
                e.stopPropagation();
                onCopyBatchLinks(folder.id, folder.name);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {isCopiedBatch ? (
                <IconCheck {...stylex.props(styles.actionIcon)} />
              ) : (
                <IconLink {...stylex.props(styles.actionIcon)} />
              )}
            </button>
          )}
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
});

interface MemoFileRowProps {
  file: ClientFileRecord;
  isTrashItem: boolean;
  rowIndex: number;
  virtualSize: number;
  virtualStart: number;
  isSelected: boolean;
  isCut: boolean;
  fileAcc?: AccountItem;
  accounts?: AccountItem[];
  canTransfer: boolean;
  isTransferring: boolean;
  isTrashView: boolean;
  isSharePoolActive: boolean;
  isSearching: boolean;
  onItemClick: (id: string, e: React.MouseEvent) => void;
  onCheckboxToggle: (id: string, e: React.MouseEvent) => void;
  onRowDragStart: (e: React.DragEvent, item: DragItemPayload) => void;
  onTransferFile?: (fileId: string, targetAccountId: string) => void;
  onShareItem?: (item: { kind: 'file' | 'folder'; id: string; name: string; virtualPath: string }) => void;
  onDownload: (file: ClientFileRecord) => void;
  onTrash: (file: ClientFileRecord) => void;
  onRestore?: (file: ClientFileRecord) => void;
  onPermanentDelete?: (file: ClientFileRecord) => void;
}

const MemoFileRow = React.memo(function MemoFileRow({
  file,
  isTrashItem,
  rowIndex,
  virtualSize,
  virtualStart,
  isSelected,
  isCut,
  fileAcc,
  accounts,
  canTransfer,
  isTransferring,
  isTrashView,
  isSharePoolActive,
  isSearching,
  onItemClick,
  onCheckboxToggle,
  onRowDragStart,
  onTransferFile,
  onShareItem,
  onDownload,
  onTrash,
  onRestore,
  onPermanentDelete,
}: MemoFileRowProps) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-selected={isSelected}
      {...stylex.props(
        styles.rowWrapper,
        isSelected && styles.rowWrapperSelected
      )}
      style={{
        height: `${virtualSize}px`,
        transform: `translateY(${virtualStart}px)`,
      }}
    >
      <div
        data-marquee-gutter="true"
        aria-hidden="true"
        {...stylex.props(styles.gutterCell)}
      />
      <div
        data-row="true"
        draggable={isTrashItem || !isTrashView}
        onDragStart={(e) =>
          onRowDragStart(e, {
            kind: 'file',
            id: file.id,
            name: file.name,
            virtualPath: file.virtualPath,
            ...(isTrashItem ? { isTrashed: true } : {}),
          })
        }
        onDragOver={(e) => {
          if (!isTrashItem && (isTrashView || isSharePoolActive)) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'none';
          }
        }}
        onDrop={
          isTrashItem
            ? undefined
            : (e) => {
                e.preventDefault();
                e.stopPropagation();
                (e.nativeEvent as any).__tsubasaHandled = true;
              }
        }
        {...stylex.props(
          styles.rowMain,
          isSelected && styles.rowSelected,
          !isTrashItem && isCut && styles.rowCutMuted
        )}
        onClick={(e) => {
          e.stopPropagation();
          onItemClick(file.id, e);
        }}
      >
        <div role="gridcell" {...stylex.props(styles.checkboxCell)}>
          <button
            type="button"
            role="checkbox"
            aria-checked={isSelected}
            aria-label={isTrashItem ? `Select trashed file ${file.name}` : `Select file ${file.name}`}
            {...stylex.props(styles.checkbox)}
            onClick={(e) => onCheckboxToggle(file.id, e)}
          >
            <span
              aria-hidden="true"
              {...stylex.props(styles.checkboxBox, isSelected && styles.checkboxBoxChecked)}
            >
              {isSelected && <IconCheck size={12} strokeWidth={3} />}
            </span>
          </button>
        </div>

        <div role="gridcell" {...stylex.props(styles.nameCell)} title={file.virtualPath}>
          <FileTypeIcon name={file.name || file.virtualPath} {...stylex.props(styles.itemIcon)} />
          <span
            {...stylex.props(styles.itemLabel)}
            title={isTrashItem ? `Original location: ${file.virtualPath}` : undefined}
          >
            {isTrashItem ? file.virtualPath : isSearching ? file.virtualPath : file.name}
          </span>
        </div>

        <div role="gridcell" {...stylex.props(styles.accountCell)}>
          {!isTrashItem && canTransfer && accounts && onTransferFile ? (
            <div {...stylex.props(styles.selectWrapper)}>
              <select
                aria-label={`Transfer ${file.name} to another account`}
                title={fileAcc ? `${fileAcc.displayName || file.accountId} (${fileAcc.email || file.accountId})` : file.accountId}
                value={file.accountId}
                disabled={isTransferring}
                {...stylex.props(
                  styles.accountSelect,
                  isTransferring && styles.accountSelectTransferring
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
                  const { isMuted, optionTitle, optionLabel } = evaluateAccountTransferCandidate(
                    acc,
                    file.sizeBytes,
                    { isCurrent: acc.id === file.accountId }
                  );

                  return (
                    <option key={acc.id} value={acc.id} disabled={isMuted} title={optionTitle}>
                      {optionLabel}
                    </option>
                  );
                })}
              </select>
              <div {...stylex.props(styles.selectChevron)}>
                <IconChevronDown size={10} strokeWidth={2.5} />
              </div>
            </div>
          ) : (
            <RedactedEmail
              email={fileAcc?.email || file.accountId}
              tooltip={getAccountTooltip(file.accountId, fileAcc)}
              style={styles.accountPill}
            />
          )}
        </div>

        <div role="gridcell" {...stylex.props(styles.tabularCell)}>
          {formatBytes(file.sizeBytes)}
        </div>

        <div role="gridcell" {...stylex.props(styles.tabularCell, styles.dateCell)}>
          {formatDate(isTrashItem ? file.trashedAt || file.updatedAt : file.updatedAt)}
        </div>

        <div role="gridcell" {...stylex.props(styles.actionsCell)}>
          {isTrashItem ? (
            <>
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
            </>
          ) : (
            <>
              {!isTrashView && !isSharePoolActive && onShareItem && (
                <button
                  type="button"
                  {...stylex.props(styles.rowBtn)}
                  aria-label={`Share file ${file.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onShareItem({
                      kind: 'file',
                      id: file.id,
                      name: file.name,
                      virtualPath: file.virtualPath,
                    });
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <IconShare {...stylex.props(styles.actionIcon)} />
                </button>
              )}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
});

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
  onShareItem,
  isSharePoolActive = false,
  isLoading = false,
  shareLinksByBatch,
  onCopyShareLinks,
}: FileTableProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [isDropZoneActive, setIsDropZoneActive] = useState(false);
  const [dragOverRowId, setDragOverRowId] = useState<string | null>(null);
  const [copiedBatchId, setCopiedBatchId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const marqueeBoxRef = useRef<HTMLDivElement | null>(null);
  const marqueeRafRef = useRef<number | null>(null);
  const justFinishedMarquee = useRef(false);
  const lastSelectedIdRef = useRef<string | null>(null);
  const anchorIndexRef = useRef<number>(-1);
  const focusIndexRef = useRef<number>(-1);
  // Tracked manually because native dblclick is suppressed once the clicked row unmounts mid-sequence.
  const lastClickRef = useRef<{ id: string; path: string; time: number } | null>(null);
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isCoarsePointer = useMediaQuery('(pointer: coarse)');
  const rowHeight = isMobile
    ? TABLE_ROW_HEIGHT_MOBILE
    : isCoarsePointer
      ? TABLE_ROW_HEIGHT_COARSE
      : TABLE_ROW_HEIGHT_DESKTOP;

  const hideMarqueeBox = useCallback(() => {
    if (marqueeRafRef.current !== null) {
      cancelAnimationFrame(marqueeRafRef.current);
      marqueeRafRef.current = null;
    }
    if (marqueeBoxRef.current) {
      marqueeBoxRef.current.style.display = 'none';
    }
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (marqueeRafRef.current !== null) cancelAnimationFrame(marqueeRafRef.current);
    };
  }, []);

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
      setActiveInternalDragPayload(null);
      setIsDropZoneActive(false);
      setDragOverRowId(null);
      hideMarqueeBox();
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
      hideMarqueeBox();
    };

    window.addEventListener('dragleave', handleGlobalDragLeave);
    window.addEventListener('dragend', handleGlobalDragEnd);
    window.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      window.removeEventListener('dragleave', handleGlobalDragLeave);
      window.removeEventListener('dragend', handleGlobalDragEnd);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [hideMarqueeBox]);

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
    if (isTrashView || isSharePoolActive) return;
    e.preventDefault();
    e.stopPropagation();
    (e.nativeEvent as any).__tsubasaHandled = true;
    setActiveInternalDragPayload(null);
    setIsDropZoneActive(false);
    setDragOverRowId(null);

    if (e.dataTransfer) {
      if (isInternalItemDrag(e)) {
        const parsed = parseInternalDropItems(e, cleanPath);
        if (parsed) {
          onMoveItems?.(parsed, cleanPath);
        }
        return;
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

  const handleRowDrop = useCallback(
    async (e: React.DragEvent, targetVirtualPath: string) => {
      if (isTrashView || isSharePoolActive) return;
      e.preventDefault();
      e.stopPropagation();
      (e.nativeEvent as any).__tsubasaHandled = true;
      setActiveInternalDragPayload(null);
      setIsDropZoneActive(false);
      setDragOverRowId(null);

      if (isInternalItemDrag(e)) {
        const parsed = parseInternalDropItems(e, targetVirtualPath);
        if (parsed) {
          onMoveItems?.(parsed, targetVirtualPath);
        }
        return;
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
    },
    [isTrashView, isSharePoolActive, onMoveItems, onStageDroppedUpload, onDropFiles]
  );

  const cleanPath = currentPath.trim() === '' ? '/' : currentPath;

  useEffect(() => {
    anchorIndexRef.current = -1;
    focusIndexRef.current = -1;
    lastSelectedIdRef.current = null;
    lastClickRef.current = null;
  }, [cleanPath]);

  // Filter or search
  const isSearching = searchQuery.trim().length > 0;
  const searchLower = searchQuery.toLowerCase();

  // Build items array
  const items = useMemo<TableItem[]>(() => {
    const result: TableItem[] = [];

    if (isTrashView) {
      const list = isSearching
        ? files.filter(
            (f) =>
              f.name.toLowerCase().includes(searchLower) ||
              (f.virtualPath && f.virtualPath.toLowerCase().includes(searchLower))
          )
        : files;

      const sortedList = sortFiles(list, currentSortColumn, currentSortDirection, true);
      sortedList.forEach((f) => result.push({ kind: 'trash', data: f }));
    } else if (isSearching) {
      const matchedFolders = folders.filter(
        (f) => f.name.toLowerCase().includes(searchLower) || f.virtualPath.toLowerCase().includes(searchLower)
      );
      const sortedFoldersList = sortFolders(matchedFolders, currentSortColumn, currentSortDirection);
      sortedFoldersList.forEach((f) => result.push({ kind: 'folder', data: f }));

      const matchedFiles = files.filter(
        (f) =>
          !f.isTrashed &&
          (f.name.toLowerCase().includes(searchLower) || f.virtualPath.toLowerCase().includes(searchLower))
      );
      const sortedFilesList = sortFiles(matchedFiles, currentSortColumn, currentSortDirection, false);
      sortedFilesList.forEach((f) => result.push({ kind: 'file', data: f }));
    } else {
      // Add ".." if not root
      if (cleanPath !== '/') {
        result.push({ kind: 'parent', path: getParentDir(cleanPath) });
      }

      // Folders in current dir
      const dirFolders = folders.filter((f) => getParentDir(f.virtualPath) === cleanPath);
      const sortedFoldersList = sortFolders(dirFolders, currentSortColumn, currentSortDirection);
      sortedFoldersList.forEach((f) => result.push({ kind: 'folder', data: f }));

      // Files in current dir
      const dirFiles = files.filter((f) => !f.isTrashed && getParentDir(f.virtualPath) === cleanPath);
      const sortedFilesList = sortFiles(dirFiles, currentSortColumn, currentSortDirection, false);
      sortedFilesList.forEach((f) => result.push({ kind: 'file', data: f }));
    }

    return result;
  }, [isTrashView, isSearching, searchLower, cleanPath, files, folders, currentSortColumn, currentSortDirection]);

  // Selectable items in current view
  const selectableItems = useMemo(
    () =>
      items.filter(
        (item): item is { kind: 'folder'; data: ClientFolder } | { kind: 'file'; data: ClientFileRecord } | { kind: 'trash'; data: ClientFileRecord } =>
          item.kind !== 'parent'
      ),
    [items]
  );
  const selectableIds = useMemo(() => selectableItems.map((item) => item.data.id), [selectableItems]);
  const selectedInViewCount = useMemo(
    () => selectableIds.reduce((count, id) => (selectedIds.has(id) ? count + 1 : count), 0),
    [selectableIds, selectedIds]
  );
  const isAllSelected = selectableIds.length > 0 && selectedInViewCount === selectableIds.length;
  const isIndeterminate = selectedInViewCount > 0 && !isAllSelected;

  const accountById = useMemo(() => {
    const map = new Map<string, AccountItem>();
    for (const acc of accounts) {
      map.set(acc.id, acc);
    }
    return map;
  }, [accounts]);

  const clipboardCutIds = useMemo(() => {
    const set = new Set<string>();
    if (clipboard?.mode === 'cut') {
      for (const ci of clipboard.items) {
        set.add(ci.id);
      }
    }
    return set;
  }, [clipboard]);

  // Keep latest values in refs so row callbacks stay identity-stable for React.memo rows.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selectableItemsRef = useRef(selectableItems);
  selectableItemsRef.current = selectableItems;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const handleCopyBatchLinks = useCallback(
    async (folderId: string, folderName: string) => {
      if (!onCopyShareLinks) return;
      const result = await onCopyShareLinks(folderName);
      if (result !== false) {
        setCopiedBatchId(folderId);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
          setCopiedBatchId((prev) => (prev === folderId ? null : prev));
        }, COPY_FEEDBACK_DURATION_MS);
      }
    },
    [onCopyShareLinks]
  );

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

  const getNavigationTarget = useCallback(
    (id: string): string | null => {
      if (id === '__parent__') return getParentDir(cleanPath);
      const item = itemsRef.current.find((it) => it.kind === 'folder' && it.data.id === id);
      return item?.kind === 'folder' ? item.data.virtualPath : null;
    },
    [cleanPath]
  );

  const handleItemClick = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (justFinishedMarquee.current) return;

      const hasModifier = e.shiftKey || e.ctrlKey || e.metaKey;
      const navTarget = hasModifier ? null : getNavigationTarget(id);
      if (navTarget === null) {
        lastClickRef.current = null;
      } else {
        const now = performance.now();
        const last = lastClickRef.current;
        if (last && last.id === id && last.path === cleanPath && now - last.time <= DOUBLE_CLICK_MS) {
          lastClickRef.current = null;
          onNavigate(navTarget);
          return;
        }
        lastClickRef.current = { id, path: cleanPath, time: now };
      }

      if (id === '__parent__') {
        anchorIndexRef.current = 0;
        focusIndexRef.current = 0;
        lastSelectedIdRef.current = null;
        onSelect('__parent__', false);
        return;
      }

      const curItems = itemsRef.current;
      const curSelectableItems = selectableItemsRef.current;
      const clickedIdx = curItems.findIndex((it) => it.kind !== 'parent' && it.data.id === id);
      if (clickedIdx !== -1) {
        if (!e.shiftKey || anchorIndexRef.current === -1) {
          anchorIndexRef.current = clickedIdx;
        }
        focusIndexRef.current = clickedIdx;
      }

      if (e.shiftKey && lastSelectedIdRef.current && onSelectMultiple) {
        const idxA = curSelectableItems.findIndex((it) => it.data.id === lastSelectedIdRef.current);
        const idxB = curSelectableItems.findIndex((it) => it.data.id === id);
        if (idxA !== -1 && idxB !== -1) {
          const start = Math.min(idxA, idxB);
          const end = Math.max(idxA, idxB);
          const rangeIds = curSelectableItems.slice(start, end + 1).map((it) => it.data.id);
          onSelectMultiple(rangeIds, 'add');
          return;
        }
      }

      lastSelectedIdRef.current = id;
      onSelect(id, e.shiftKey || e.ctrlKey || e.metaKey);
    },
    [cleanPath, getNavigationTarget, onNavigate, onSelect, onSelectMultiple]
  );

  const handleCheckboxToggle = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      lastSelectedIdRef.current = id;
      const clickedIdx = itemsRef.current.findIndex((it) => it.kind !== 'parent' && it.data.id === id);
      if (clickedIdx !== -1) {
        anchorIndexRef.current = clickedIdx;
        focusIndexRef.current = clickedIdx;
      }
      onSelect(id, true);
    },
    [onSelect]
  );

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

    let cachedViewportRect = viewport.getBoundingClientRect();
    let maxContentX = viewport.scrollWidth;
    let maxContentY = Math.max(rowVirtualizer.getTotalSize(), viewport.clientHeight);
    let rectDirty = false;

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startScrollTop = viewport.scrollTop;
    const startScrollLeft = viewport.scrollLeft;
    const startContentX = startClientX - cachedViewportRect.left + startScrollLeft;
    const startContentY = startClientY - cachedViewportRect.top + startScrollTop;

    const isModifier = e.shiftKey || e.ctrlKey || e.metaKey;
    const initialSelected = new Set(selectedIds);
    initialSelected.delete('__parent__');
    let isDragging = false;
    let latestClientX = startClientX;
    let latestClientY = startClientY;
    let prevRangeStart = -1;
    let prevRangeEnd = -2;
    let hasAppliedSelection = false;

    const onViewportChange = () => {
      rectDirty = true;
    };

    const updateMarqueeFrame = () => {
      marqueeRafRef.current = null;
      if (!isDragging) return;

      if (rectDirty) {
        cachedViewportRect = viewport.getBoundingClientRect();
        maxContentX = viewport.scrollWidth;
        maxContentY = Math.max(rowVirtualizer.getTotalSize(), viewport.clientHeight);
        rectDirty = false;
      }

      const curScrollTop = viewport.scrollTop;
      const curScrollLeft = viewport.scrollLeft;
      const clientHeight = viewport.clientHeight;
      const scrollHeight = viewport.scrollHeight;

      // Auto-scrolling when dragging near or outside top/bottom edges (compute nextScrollTop before writing)
      const topDist = latestClientY - cachedViewportRect.top;
      const bottomDist = cachedViewportRect.bottom - latestClientY;
      let nextScrollTop = curScrollTop;
      if (topDist < 30) {
        nextScrollTop = Math.max(0, curScrollTop - 10);
      } else if (bottomDist < 30) {
        nextScrollTop = Math.min(Math.max(0, scrollHeight - clientHeight), curScrollTop + 10);
      }
      if (nextScrollTop !== curScrollTop) {
        viewport.scrollTop = nextScrollTop;
      }

      const clampedClientX = Math.max(
        cachedViewportRect.left,
        Math.min(cachedViewportRect.right, latestClientX)
      );
      const clampedClientY = Math.max(
        cachedViewportRect.top,
        Math.min(cachedViewportRect.bottom, latestClientY)
      );

      const currentContentX = clampedClientX - cachedViewportRect.left + curScrollLeft;
      const currentContentY = clampedClientY - cachedViewportRect.top + nextScrollTop;

      const boundedCurrentX = Math.max(0, Math.min(maxContentX, currentContentX));
      const boundedCurrentY = Math.max(0, Math.min(maxContentY, currentContentY));
      const boundedStartX = Math.max(0, Math.min(maxContentX, startContentX));
      const boundedStartY = Math.max(0, Math.min(maxContentY, startContentY));

      const left = Math.min(boundedStartX, boundedCurrentX);
      const top = Math.min(boundedStartY, boundedCurrentY);
      const width = Math.abs(boundedCurrentX - boundedStartX);
      const height = Math.abs(boundedCurrentY - boundedStartY);

      const box = marqueeBoxRef.current;
      if (box) {
        box.style.display = 'block';
        box.style.transform = `translate(${left}px, ${top}px)`;
        box.style.width = `${width}px`;
        box.style.height = `${height}px`;
      }

      // O(1) hit math for overlapping row index range
      const curItems = itemsRef.current;
      let startIdx = -1;
      let endIdx = -2;
      if (curItems.length > 0) {
        const rawStart = Math.floor(top / rowHeight);
        const rawEnd = Math.floor((top + height) / rowHeight);
        if (rawEnd >= 0 && rawStart < curItems.length) {
          startIdx = Math.max(0, rawStart);
          endIdx = Math.min(curItems.length - 1, rawEnd);
        }
      }

      if (!hasAppliedSelection || startIdx !== prevRangeStart || endIdx !== prevRangeEnd) {
        hasAppliedSelection = true;
        prevRangeStart = startIdx;
        prevRangeEnd = endIdx;

        if (onSelectMultiple) {
          const newSelected = isModifier ? new Set(initialSelected) : new Set<string>();
          for (let i = startIdx; i <= endIdx; i++) {
            const item = curItems[i];
            if (item && item.kind !== 'parent') {
              newSelected.add(item.data.id);
            }
          }
          onSelectMultiple(Array.from(newSelected), 'set');
        }
      }

      // Keep auto-scrolling smoothly if pointer remains in edge zone
      if (nextScrollTop !== curScrollTop && marqueeRafRef.current === null) {
        marqueeRafRef.current = requestAnimationFrame(updateMarqueeFrame);
      }
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      latestClientX = moveEvent.clientX;
      latestClientY = moveEvent.clientY;

      if (!isDragging) {
        const dx = latestClientX - startClientX;
        const dy = latestClientY - startClientY;
        if (Math.hypot(dx, dy) > 5) {
          isDragging = true;
        } else {
          return;
        }
      }

      if (marqueeRafRef.current === null) {
        marqueeRafRef.current = requestAnimationFrame(updateMarqueeFrame);
      }
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('resize', onViewportChange);

      if (isDragging) {
        justFinishedMarquee.current = true;
        setTimeout(() => {
          justFinishedMarquee.current = false;
        }, 80);
      }
      isDragging = false;
      hideMarqueeBox();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('resize', onViewportChange, { passive: true });
  };

  const handleRowDragStart = useCallback(
    (
      e: React.DragEvent,
      item: { kind: 'file' | 'folder'; id: string; name: string; virtualPath: string; isTrashed?: boolean }
    ) => {
      if (isTrashView) {
        e.preventDefault();
        return;
      }
      hideMarqueeBox();
      const curSelectedIds = selectedIdsRef.current;
      const isItemSelected = curSelectedIds.has(item.id);
      let dragPayload: Array<{
        kind: 'file' | 'folder';
        id: string;
        name: string;
        virtualPath: string;
        isTrashed?: boolean;
      }> = [];

      if (isItemSelected && curSelectedIds.size > 1) {
        dragPayload = selectableItemsRef.current
          .filter((it) => curSelectedIds.has(it.data.id))
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

      setActiveInternalDragPayload(dragPayload);
      e.dataTransfer.setData('application/x-tsubasa-items', JSON.stringify(dragPayload));
      e.dataTransfer.effectAllowed = 'copyMove';
    },
    [hideMarqueeBox, isTrashView, onSelect]
  );

  // TanStack Virtualizer
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 4,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

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
      if (parentRef.current?.closest('[inert]')) {
        return;
      }
      if (document.querySelector('dialog[open], [role="dialog"]')) {
        return;
      }

      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || Boolean(target.closest('select, input, textarea, [contenteditable="true"]'))))
      ) {
        return;
      }

      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        (activeEl instanceof HTMLElement && activeEl.isContentEditable)
      ) {
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

        if (
          parentRef.current &&
          document.activeElement instanceof HTMLElement &&
          parentRef.current.contains(document.activeElement)
        ) {
          document.activeElement.blur();
        }

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

  const headerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const viewport = parentRef.current;
    if (!viewport) return;
    const header = headerRef.current;

    const canScrollY = (el: HTMLElement, deltaY: number) => {
      if (el.scrollHeight <= el.clientHeight) return false;
      if (deltaY > 0) {
        return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      }
      return el.scrollTop > 0;
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.deltaX !== 0 || e.deltaY === 0) return;
      if (viewport.scrollWidth <= viewport.clientWidth) return;

      const delta =
        e.deltaMode === 1
          ? e.deltaY * 40
          : e.deltaMode === 2
            ? e.deltaY * viewport.clientWidth
            : e.deltaY;

      const rect = viewport.getBoundingClientRect();
      const isOverHorizontalScrollbar =
        e.clientY >= rect.top + viewport.clientTop + viewport.clientHeight &&
        e.clientY <= rect.bottom &&
        e.clientX >= rect.left &&
        e.clientX <= rect.right;
      const isOverHeader =
        header !== null &&
        e.target instanceof Node &&
        (e.currentTarget === header || header.contains(e.target));

      if (!isOverHeader && !isOverHorizontalScrollbar && canScrollY(viewport, delta)) {
        return;
      }

      const prevScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft !== prevScrollLeft) {
        if (header) {
          header.scrollLeft = viewport.scrollLeft;
        }
        e.preventDefault();
      } else if (isOverHorizontalScrollbar) {
        e.preventDefault();
      }
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    header?.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      viewport.removeEventListener('wheel', handleWheel);
      header?.removeEventListener('wheel', handleWheel);
    };
  }, []);

  const canTransferFiles = Boolean(!isSharePoolActive && accounts && accounts.length > 1 && onTransferFile);

  return (
    <div
      role="grid"
      aria-rowcount={items.length + 1}
      aria-label={isTrashView ? 'Trash files' : 'Files'}
      aria-multiselectable="true"
      {...stylex.props(styles.container)}
      aria-busy={isLoading ? 'true' : undefined}
    >
      <div ref={headerRef} role="row" aria-rowindex={1} {...stylex.props(styles.headerRow)}>
        <div {...stylex.props(styles.headerGutter)} data-marquee-gutter="true" aria-hidden="true" />
        <div role="columnheader" {...stylex.props(styles.checkboxCell)}>
          <button
            type="button"
            role="checkbox"
            aria-checked={isIndeterminate ? 'mixed' : isAllSelected}
            aria-label="Select all files in current folder"
            disabled={selectableIds.length === 0}
            {...stylex.props(
              styles.checkbox,
              selectableIds.length === 0 && styles.checkboxDisabled
            )}
            onClick={(e) => {
              e.stopPropagation();
              handleToggleSelectAll();
            }}
          >
            <span
              aria-hidden="true"
              {...stylex.props(
                styles.checkboxBox,
                (isAllSelected || isIndeterminate) && styles.checkboxBoxChecked
              )}
            >
              {isAllSelected && <IconCheck size={12} strokeWidth={3} />}
              {isIndeterminate && <IconMinus size={12} strokeWidth={3} />}
            </span>
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
          {...stylex.props(styles.headerCell)}
        >
          <button
            type="button"
            {...stylex.props(styles.headerBtn, styles.headerBtnLeft, currentSortColumn === 'size' && styles.headerBtnActive)}
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
          {...stylex.props(styles.headerCell)}
        >
          <button
            type="button"
            {...stylex.props(styles.headerBtn, styles.headerBtnLeft, currentSortColumn === 'date' && styles.headerBtnActive)}
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
        <div role="columnheader" {...stylex.props(styles.headerCell)}>Actions</div>
      </div>

      <div
        ref={parentRef}
        {...stylex.props(styles.scrollViewport)}
        onScroll={(e) => {
          if (headerRef.current) {
            headerRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        onMouseDown={handleMouseDown}
        onDragOver={(e) => {
          if (isTrashView || isSharePoolActive) return;
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
              isDropZoneActive && !isTrashView && !isSharePoolActive && styles.emptyStateDragOver
            )}
            onDragEnter={(e) => {
              if (isTrashView || isSharePoolActive || !isExternalFileDrag(e)) return;
              e.preventDefault();
              e.stopPropagation();
              setIsDropZoneActive(true);
            }}
            onDragOver={(e) => {
              if (isTrashView || isSharePoolActive || !isExternalFileDrag(e)) {
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
            {isDropZoneActive && !isTrashView && !isSharePoolActive ? (
              <div {...stylex.props(styles.dropBox)}>
                <IconUpload size={36} color={colors.accentGold} strokeWidth={2.5} />
                <h3 {...stylex.props(styles.dropTitle)}>Drop files to upload</h3>
                <p {...stylex.props(styles.dropSubtitle)}>
                  Files will be staged for cluster allocation
                </p>
              </div>
            ) : isLoading ? (
              <progress
                aria-label={isTrashView ? 'Loading trash' : 'Loading folder contents'}
                data-loading-spinner="true"
                {...stylex.props(styles.loadingSpinner)}
              />
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
                    : isSharePoolActive
                    ? 'Files and folders copied to the Share Pool appear here.'
                    : 'Upload files or create subfolders to populate this directory.'}
                </p>
              </>
            )}
          </div>
        ) : (
          <div {...stylex.props(styles.tableBodyContainer)}>
            <div ref={marqueeBoxRef} {...stylex.props(styles.marqueeBox)} aria-hidden="true" />
            <div
              {...stylex.props(styles.virtualTrack)}
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const item = items[virtualRow.index];
                if (!item) return null;

                if (item.kind === 'parent') {
                  return (
                    <MemoParentRow
                      key={`parent-${virtualRow.index}`}
                      path={item.path}
                      rowIndex={virtualRow.index}
                      virtualSize={virtualRow.size}
                      virtualStart={virtualRow.start}
                      isSelected={selectedIds.has('__parent__')}
                      isDragOver={dragOverRowId === '__parent__'}
                      isTrashView={isTrashView}
                      isSharePoolActive={isSharePoolActive}
                      onItemClick={handleItemClick}
                      onNavigate={onNavigate}
                      onSetDragOverRowId={setDragOverRowId}
                      onRowDrop={handleRowDrop}
                    />
                  );
                }

                if (item.kind === 'folder') {
                  const folder = item.data;
                  const folderBatchLinks =
                    isSharePoolActive && !isTrashView && getParentDir(folder.virtualPath) === '/'
                      ? shareLinksByBatch?.[folder.name]
                      : undefined;
                  return (
                    <MemoFolderRow
                      key={folder.id}
                      folder={folder}
                      rowIndex={virtualRow.index}
                      virtualSize={virtualRow.size}
                      virtualStart={virtualRow.start}
                      isSelected={selectedIds.has(folder.id)}
                      isDragOver={dragOverRowId === folder.id}
                      isCut={clipboardCutIds.has(folder.id)}
                      folderSize={folderSizeMap.get(folder.id) || 0}
                      folderBatchLinks={folderBatchLinks}
                      isCopiedBatch={copiedBatchId === folder.id}
                      isTrashView={isTrashView}
                      isSharePoolActive={isSharePoolActive}
                      isSearching={isSearching}
                      onItemClick={handleItemClick}
                      onCheckboxToggle={handleCheckboxToggle}
                      onRowDragStart={handleRowDragStart}
                      onSetDragOverRowId={setDragOverRowId}
                      onRowDrop={handleRowDrop}
                      onShareItem={onShareItem}
                      onCopyBatchLinks={onCopyShareLinks ? handleCopyBatchLinks : undefined}
                      onDeleteFolder={onDeleteFolder}
                      onNavigate={onNavigate}
                    />
                  );
                }

                const file = item.data;
                const isTrashItem = item.kind === 'trash';
                return (
                  <MemoFileRow
                    key={isTrashItem ? `trash-${file.id}` : file.id}
                    file={file}
                    isTrashItem={isTrashItem}
                    rowIndex={virtualRow.index}
                    virtualSize={virtualRow.size}
                    virtualStart={virtualRow.start}
                    isSelected={selectedIds.has(file.id)}
                    isCut={!isTrashItem && clipboardCutIds.has(file.id)}
                    fileAcc={accountById.get(file.accountId)}
                    accounts={accounts}
                    canTransfer={canTransferFiles}
                    isTransferring={transferringFileId === file.id}
                    isTrashView={isTrashView}
                    isSharePoolActive={isSharePoolActive}
                    isSearching={isSearching}
                    onItemClick={handleItemClick}
                    onCheckboxToggle={handleCheckboxToggle}
                    onRowDragStart={handleRowDragStart}
                    onTransferFile={onTransferFile}
                    onShareItem={onShareItem}
                    onDownload={onDownload}
                    onTrash={onTrash}
                    onRestore={onRestore}
                    onPermanentDelete={onPermanentDelete}
                  />
                );
              })}
            </div>

            <div
              {...stylex.props(styles.emptyDropZone)}
              onDragEnter={(e) => {
                if (isTrashView || isSharePoolActive || !isExternalFileDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setIsDropZoneActive(true);
              }}
              onDragOver={(e) => {
                if (isTrashView || isSharePoolActive || !isExternalFileDrag(e)) {
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
              {isDropZoneActive && !isTrashView && !isSharePoolActive && (
                <div {...stylex.props(styles.dropBox)}>
                  <IconUpload size={32} color={colors.accentGold} strokeWidth={2.5} />
                  <h3 {...stylex.props(styles.dropTitle)}>Drop files to upload</h3>
                  <p {...stylex.props(styles.dropSubtitle)}>
                    Files will be staged for cluster allocation
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
