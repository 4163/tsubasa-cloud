import React, { useRef, useState, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import {
  IconFolderFilled,
  IconFile,
  IconDownload,
  IconTrash,
  IconChevronLeft,
  IconChevronRight,
  IconRotateCcw,
  IconUpload,
  IconCheck,
  IconMinus,
} from './Icons';
import type { FileRecord, Folder } from '../../server/db/schema.js';

export type ClientFileRecord = Omit<FileRecord, 'createdAt' | 'updatedAt' | 'trashedAt'> & {
  createdAt: string | Date;
  updatedAt: string | Date;
  trashedAt?: string | Date | null;
};

export type ClientFolder = Omit<Folder, 'createdAt' | 'updatedAt'> & {
  createdAt: string | Date;
  updatedAt: string | Date;
};

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
    gridTemplateColumns: '40px minmax(240px, 3fr) 140px 110px 140px 90px',
    alignItems: 'center',
    paddingLeft: spacing.space3,
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
  colRight: {
    textAlign: 'right',
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
  row: {
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
    display: 'grid',
    gridTemplateColumns: '40px minmax(240px, 3fr) 140px 110px 140px 90px',
    alignItems: 'center',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space4,
    boxSizing: 'border-box',
    cursor: 'default',
    userSelect: 'none',
    fontSize: typography.fontSizeBody,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    backgroundColor: 'transparent',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
    },
    '@media (pointer: coarse)': {
      height: layout.mobileRowHeight,
      gridTemplateColumns: '36px 32px 1fr 36px',
      paddingLeft: spacing.space2,
      paddingRight: spacing.space3,
      ':hover': {
        backgroundColor: 'unset',
      },
      ':active': {
        backgroundColor: colors.rowHover,
        transition: motion.transitionTap,
      },
    },
  },
  rowSelected: {
    backgroundColor: colors.selectionBg,
    borderLeftColor: colors.accentGold,
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
  accountPill: {
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccentSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.brandAccent,
    width: 'fit-content',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
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
}: FileTableProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const dragCounter = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const justFinishedMarquee = useRef(false);
  const lastSelectedIdRef = useRef<string | null>(null);

  const handleDragEnter = (e: React.DragEvent) => {
    if (isTrashView) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer?.types?.includes('Files')) {
      setIsDragOver(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (isTrashView) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    if (!isDragOver && e.dataTransfer?.types?.includes('Files')) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (isTrashView) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    if (isTrashView) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      onDropFiles?.(Array.from(e.dataTransfer.files));
    }
  };

  const cleanPath = currentPath.trim() === '' ? '/' : currentPath;

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

    list.forEach((f) => items.push({ kind: 'trash', data: f }));
  } else if (isSearching) {
    folders
      .filter((f) => f.name.toLowerCase().includes(searchLower))
      .forEach((f) => items.push({ kind: 'folder', data: f }));

    files
      .filter((f) => !f.isTrashed && f.name.toLowerCase().includes(searchLower))
      .forEach((f) => items.push({ kind: 'file', data: f }));
  } else {
    // Add ".." if not root
    if (cleanPath !== '/') {
      items.push({ kind: 'parent', path: getParentDir(cleanPath) });
    }

    // Folders in current dir
    folders
      .filter((f) => getParentDir(f.virtualPath) === cleanPath)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((f) => items.push({ kind: 'folder', data: f }));

    // Files in current dir
    files
      .filter((f) => !f.isTrashed && getParentDir(f.virtualPath) === cleanPath)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((f) => items.push({ kind: 'file', data: f }));
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
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectableIds, onSelectMultiple, onSelect]);

  const handleItemClick = (id: string, e: React.MouseEvent) => {
    if (justFinishedMarquee.current) return;

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
    onSelect(id, true);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement | null;
    if (target?.closest('button') || target?.closest('input') || target?.closest('a')) {
      return;
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
        setMarqueeRect(null);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // TanStack Virtualizer
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  return (
    <div {...stylex.props(styles.container)}>
      <div {...stylex.props(styles.headerRow)}>
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
        <div>Name</div>
        <div>Account</div>
        <div {...stylex.props(styles.colRight)}>Size</div>
        <div {...stylex.props(styles.colRight)}>{isTrashView ? 'Date trashed' : 'Modified'}</div>
        <div {...stylex.props(styles.colRight)}>Actions</div>
      </div>

      <div
        ref={parentRef}
        {...stylex.props(styles.scrollViewport)}
        onMouseDown={handleMouseDown}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => {
          if (!justFinishedMarquee.current) {
            onClearSelection?.();
          }
        }}
      >
        {items.length === 0 ? (
          <div
            {...stylex.props(
              styles.emptyState,
              isDragOver && !isTrashView && styles.emptyStateDragOver
            )}
          >
            {isDragOver && !isTrashView ? (
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
                  return (
                    <div
                      key={`parent-${virtualRow.index}`}
                      {...stylex.props(styles.row)}
                      style={{
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      onDoubleClick={() => onNavigate(item.path)}
                    >
                      <div />
                      <div {...stylex.props(styles.nameCell)}>
                        <IconFolderFilled {...stylex.props(styles.itemIcon, styles.folderIcon)} />
                        <span {...stylex.props(styles.itemLabel)}>.. (Parent directory)</span>
                      </div>
                      <div>
                        <span {...stylex.props(styles.accountPill)}>Parent folder</span>
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
                  );
                }

                if (item.kind === 'folder') {
                  const folder = item.data;
                  const isSelected = selectedIds.has(folder.id);

                  return (
                    <div
                      key={folder.id}
                      {...stylex.props(styles.row, isSelected && styles.rowSelected)}
                      style={{
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
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

                      <div {...stylex.props(styles.nameCell)}>
                        <IconFolderFilled {...stylex.props(styles.itemIcon, styles.folderIcon)} />
                        <span {...stylex.props(styles.itemLabel)}>{folder.name}</span>
                      </div>

                      <div>
                        <span {...stylex.props(styles.accountPill)}>Cluster folder</span>
                      </div>

                      <div {...stylex.props(styles.colRight, styles.tabularCell)}>—</div>
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
                  );
                }

                if (item.kind === 'trash') {
                  const file = item.data;
                  const isSelected = selectedIds.has(file.id);

                  return (
                    <div
                      key={`trash-${file.id}`}
                      {...stylex.props(styles.row, isSelected && styles.rowSelected)}
                      style={{
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
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
                          aria-label={`Select trashed file ${file.name}`}
                          {...stylex.props(styles.checkbox, isSelected && styles.checkboxChecked)}
                          onClick={(e) => handleCheckboxToggle(file.id, e)}
                        >
                          {isSelected && <IconCheck size={12} strokeWidth={3} />}
                        </button>
                      </div>

                      <div {...stylex.props(styles.nameCell)}>
                        <IconFile {...stylex.props(styles.itemIcon)} />
                        <span
                          {...stylex.props(styles.itemLabel)}
                          title={`Original location: ${file.virtualPath}`}
                        >
                          {file.name}
                        </span>
                      </div>

                      <div>
                        <span {...stylex.props(styles.accountPill)}>
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
                  );
                }

                // File row
                const file = item.data;
                const isSelected = selectedIds.has(file.id);

                return (
                  <div
                    key={file.id}
                    {...stylex.props(styles.row, isSelected && styles.rowSelected)}
                    style={{
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleItemClick(file.id, e);
                    }}
                    onDoubleClick={() => onDownload(file)}
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

                    <div {...stylex.props(styles.nameCell)}>
                      <IconFile {...stylex.props(styles.itemIcon)} />
                      <span {...stylex.props(styles.itemLabel)}>{file.name}</span>
                    </div>

                    <div>
                      <span {...stylex.props(styles.accountPill)}>
                        {file.accountId}
                      </span>
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
                );
              })}
            </div>

            <div {...stylex.props(styles.emptyDropZone)}>
              {isDragOver && !isTrashView && (
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
