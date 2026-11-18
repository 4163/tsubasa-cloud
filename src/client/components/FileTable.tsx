import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import {
  IconChevronUp,
  IconChevronDown,
  IconUpload,
  IconCheck,
  IconMinus,
} from './Icons.js';
import { COPY_FEEDBACK_DURATION_MS } from '../utils/format.js';
import { useMediaQuery } from '../utils/useBeforeUnload.js';
import {
  getParentDir,
  normalizeVirtualPath,
  markDropHandled,
  setActiveInternalDragPayload,
  rejectInvalidInternalDragOver,
  parseInternalDropItems,
} from '../utils/virtualPath.js';
import {
  extractDataTransferEntries,
  isInternalItemDrag,
  isExternalFileDrag,
} from '../utils/dataTransfer.js';
import {
  sortFolders,
  sortFiles,
  SESSION_SORT_COL_KEY,
  SESSION_SORT_DIR_KEY,
  getSessionSortColumn,
  getSessionSortDirection,
} from '../utils/fileTableSort.js';
import {
  MemoParentRow,
  MemoFolderRow,
  MemoFileRow,
  rowStyles,
} from './FileTableRows.js';
import { useMarqueeSelection } from '../hooks/useMarqueeSelection.js';
import { useTableKeyboardNav } from '../hooks/useTableKeyboardNav.js';
import { useHorizontalWheelScroll } from '../hooks/useHorizontalWheelScroll.js';
import type {
  AccountItem,
  ClientFileRecord,
  ClientFolder,
  SortColumn,
  SortDirection,
} from '../types.js';

const TABLE_ROW_HEIGHT_DESKTOP = 36;
const TABLE_ROW_HEIGHT_COARSE = 44;
const TABLE_ROW_HEIGHT_MOBILE = 64;
const DOUBLE_CLICK_MS = 500;

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
  onCopyItems?: (items: Array<{ kind: 'file' | 'folder'; id: string }>, targetPath: string) => Promise<void> | void;
  scrollRequest?: { id: string; seq: number } | null;
  clipboard?: { mode: 'cut' | 'copy'; items: Array<{ kind: 'file' | 'folder'; id: string; name: string; virtualPath: string }> } | null;
  accounts?: AccountItem[];
  onTransferFile?: (fileId: string, targetAccountId: string) => Promise<void>;
  transferringFileId?: string | null;
  transferringFileIds?: ReadonlySet<string>;
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

const SORTABLE_COLUMNS: ReadonlyArray<{
  column: SortColumn;
  label: string;
  trashLabel?: string;
  sortSubject: string;
  trashSortSubject?: string;
  ascTitleHint: string;
  descTitleHint: string;
  defaultTitleHint: string;
}> = [
  {
    column: 'name',
    label: 'Name',
    sortSubject: 'Name',
    ascTitleHint: '(Z to A)',
    descTitleHint: '(A to Z)',
    defaultTitleHint: '(A to Z)',
  },
  {
    column: 'account',
    label: 'Account',
    sortSubject: 'Account',
    ascTitleHint: '(Z to A)',
    descTitleHint: '(A to Z)',
    defaultTitleHint: '(A to Z)',
  },
  {
    column: 'size',
    label: 'Size',
    sortSubject: 'Size',
    ascTitleHint: '(largest first)',
    descTitleHint: '(smallest first)',
    defaultTitleHint: '(largest first)',
  },
  {
    column: 'date',
    label: 'Modified',
    trashLabel: 'Date trashed',
    sortSubject: 'Date modified',
    trashSortSubject: 'Date trashed',
    ascTitleHint: '(newest first)',
    descTitleHint: '(oldest first)',
    defaultTitleHint: '(newest first)',
  },
];

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
    // Intentionally widened Account/Date/Actions columns vs docs/styling-guide.md for inline transfer selects and action buttons
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
  checkboxDisabled: {
    opacity: 0.35,
    cursor: 'not-allowed',
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
    backgroundColor: colors.accentGoldMarqueeBg,
    borderRadius: radius.compact,
    pointerEvents: 'none',
    zIndex: 50,
    boxSizing: 'border-box',
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
    backgroundColor: colors.accentGoldDropBg,
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
    lineHeight: typography.lineHeightBrand,
  },
  dropSubtitle: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    margin: 0,
    lineHeight: typography.lineHeightBody,
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
  onCopyItems,
  scrollRequest,
  clipboard,
  accounts = [],
  onTransferFile,
  transferringFileId = null,
  transferringFileIds,
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
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [isDropZoneActive, setIsDropZoneActive] = useState(false);
  const [dragOverRowId, setDragOverRowId] = useState<string | null>(null);
  const [copiedBatchId, setCopiedBatchId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSelectedIdRef = useRef<string | null>(null);
  const anchorIndexRef = useRef<number>(-1);
  const focusIndexRef = useRef<number>(-1);
  const lastHandledScrollSeqRef = useRef<number>(0);
  // Tracked manually because native dblclick is suppressed once the clicked row unmounts mid-sequence.
  const lastClickRef = useRef<{ id: string; path: string; time: number } | null>(null);
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isCoarsePointer = useMediaQuery('(pointer: coarse)');
  const rowHeight = isMobile
    ? TABLE_ROW_HEIGHT_MOBILE
    : isCoarsePointer
      ? TABLE_ROW_HEIGHT_COARSE
      : TABLE_ROW_HEIGHT_DESKTOP;

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
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

  const cleanPath = normalizeVirtualPath(currentPath);

  const processDropTarget = useCallback(
    async (e: React.DragEvent, targetVirtualPath: string) => {
      if (isTrashView || isSharePoolActive) return;
      e.preventDefault();
      e.stopPropagation();
      markDropHandled(e);
      setActiveInternalDragPayload(null);
      setIsDropZoneActive(false);
      setDragOverRowId(null);

      if (!e.dataTransfer) return;

      if (isInternalItemDrag(e)) {
        const isCopyDrag = (e.ctrlKey || e.altKey) && Boolean(onCopyItems);
        const parsed = parseInternalDropItems(e, targetVirtualPath, isCopyDrag);
        if (parsed) {
          if (isCopyDrag) {
            onCopyItems?.(parsed, targetVirtualPath);
          } else {
            onMoveItems?.(parsed, targetVirtualPath);
          }
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
    [isTrashView, isSharePoolActive, onMoveItems, onCopyItems, onStageDroppedUpload, onDropFiles]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => processDropTarget(e, cleanPath),
    [processDropTarget, cleanPath]
  );

  const handleRowDrop = useCallback(
    (e: React.DragEvent, targetVirtualPath: string) => processDropTarget(e, targetVirtualPath),
    [processDropTarget]
  );

  const isSearching = searchQuery.trim().length > 0;
  const searchLower = searchQuery.toLowerCase();

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
      if (cleanPath !== '/') {
        result.push({ kind: 'parent', path: getParentDir(cleanPath) });
      }

      const dirFolders = folders.filter((f) => getParentDir(f.virtualPath) === cleanPath);
      const sortedFoldersList = sortFolders(dirFolders, currentSortColumn, currentSortDirection);
      sortedFoldersList.forEach((f) => result.push({ kind: 'folder', data: f }));

      const dirFiles = files.filter((f) => !f.isTrashed && getParentDir(f.virtualPath) === cleanPath);
      const sortedFilesList = sortFiles(dirFiles, currentSortColumn, currentSortDirection, false);
      sortedFilesList.forEach((f) => result.push({ kind: 'file', data: f }));
    }

    return result;
  }, [isTrashView, isSearching, searchLower, cleanPath, files, folders, currentSortColumn, currentSortDirection]);

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

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 4,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

  useEffect(() => {
    if (!scrollRequest || scrollRequest.seq === lastHandledScrollSeqRef.current) return;
    const idx = items.findIndex((it) => it.kind !== 'parent' && it.data.id === scrollRequest.id);
    if (idx === -1) return;
    lastHandledScrollSeqRef.current = scrollRequest.seq;
    anchorIndexRef.current = idx;
    focusIndexRef.current = idx;
    lastSelectedIdRef.current = scrollRequest.id;
    rowVirtualizer.scrollToIndex(idx, { align: 'auto' });
  }, [scrollRequest, items, rowVirtualizer]);

  const getTotalSize = useCallback(() => rowVirtualizer.getTotalSize(), [rowVirtualizer]);

  const { marqueeBoxRef, justFinishedMarquee, hideMarqueeBox, handleMouseDown } = useMarqueeSelection({
    viewportRef: parentRef,
    getTotalSize,
    rowHeight,
    itemsRef,
    selectedIds,
    onSelectMultiple,
  });

  const scrollToIndex = useCallback(
    (index: number) => {
      rowVirtualizer.scrollToIndex(index, { align: 'auto' });
    },
    [rowVirtualizer]
  );

  const { resetTypeAhead } = useTableKeyboardNav({
    parentRef,
    items,
    selectableIds,
    selectedIds,
    rowHeight,
    scrollToIndex,
    onSelect,
    onSelectMultiple,
    anchorIndexRef,
    focusIndexRef,
    lastSelectedIdRef,
  });

  useHorizontalWheelScroll({
    viewportRef: parentRef,
    headerRef,
    allowVerticalScrollFirst: true,
  });

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

  useEffect(() => {
    anchorIndexRef.current = -1;
    focusIndexRef.current = -1;
    lastSelectedIdRef.current = null;
    lastClickRef.current = null;
    resetTypeAhead();
  }, [cleanPath, resetTypeAhead]);

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

      if (e.shiftKey && onSelectMultiple) {
        const anchorItem =
          anchorIndexRef.current >= 0 && anchorIndexRef.current < curItems.length
            ? curItems[anchorIndexRef.current]
            : null;
        const anchorId =
          anchorItem && anchorItem.kind !== 'parent'
            ? anchorItem.data.id
            : lastSelectedIdRef.current;
        if (anchorId) {
          const idxA = curSelectableItems.findIndex((it) => it.data.id === anchorId);
          const idxB = curSelectableItems.findIndex((it) => it.data.id === id);
          if (idxA !== -1 && idxB !== -1) {
            const start = Math.min(idxA, idxB);
            const end = Math.max(idxA, idxB);
            const rangeIds = curSelectableItems.slice(start, end + 1).map((it) => it.data.id);
            onSelectMultiple(rangeIds, e.ctrlKey || e.metaKey ? 'add' : 'set');
            return;
          }
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
        <div role="columnheader" {...stylex.props(rowStyles.checkboxCell)}>
          <button
            type="button"
            role="checkbox"
            aria-checked={isIndeterminate ? 'mixed' : isAllSelected}
            aria-label="Select all files in current folder"
            disabled={selectableIds.length === 0}
            {...stylex.props(
              rowStyles.checkbox,
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
                rowStyles.checkboxBox,
                (isAllSelected || isIndeterminate) && rowStyles.checkboxBoxChecked
              )}
            >
              {isAllSelected && <IconCheck size={12} strokeWidth={3} />}
              {isIndeterminate && <IconMinus size={12} strokeWidth={3} />}
            </span>
          </button>
        </div>
        {SORTABLE_COLUMNS.map((col) => {
          const isActive = currentSortColumn === col.column;
          const label = isTrashView && col.trashLabel ? col.trashLabel : col.label;
          const subject = isTrashView && col.trashSortSubject ? col.trashSortSubject : col.sortSubject;
          const titleHint = isActive
            ? currentSortDirection === 'asc'
              ? col.ascTitleHint
              : col.descTitleHint
            : col.defaultTitleHint;

          return (
            <div
              key={col.column}
              role="columnheader"
              aria-sort={isActive ? (currentSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              {...stylex.props(styles.headerCell)}
            >
              <button
                type="button"
                {...stylex.props(styles.headerBtn, styles.headerBtnLeft, isActive && styles.headerBtnActive)}
                onClick={() => handleSort(col.column)}
                aria-label={`Sort by ${subject} in ${isActive && currentSortDirection === 'asc' ? 'descending' : 'ascending'} order`}
                title={`Sort by ${subject} ${titleHint}`}
              >
                <span>{label}</span>
                <span {...stylex.props(styles.sortSlot)}>
                  {isActive ? (
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
          );
        })}
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
          if (isInternalItemDrag(e)) {
            const isCopyDrag = (e.ctrlKey || e.altKey) && Boolean(onCopyItems);
            if (rejectInvalidInternalDragOver(e, cleanPath, undefined, isCopyDrag)) {
              return;
            }
            e.preventDefault();
            if (e.dataTransfer) {
              e.dataTransfer.dropEffect = isCopyDrag ? 'copy' : 'move';
            }
            return;
          }
          if (isExternalFileDrag(e)) {
            e.preventDefault();
          }
        }}
        onDrop={(e) => {
          if (isTrashView || isSharePoolActive) return;
          if (isInternalItemDrag(e)) {
            const isCopyDrag = (e.ctrlKey || e.altKey) && Boolean(onCopyItems);
            if (isCopyDrag) {
              handleDrop(e);
            }
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
                      canCopy={Boolean(onCopyItems)}
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
                      canCopy={Boolean(onCopyItems)}
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
                    isTransferring={Boolean(transferringFileIds?.has(file.id) || transferringFileId === file.id)}
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
                if (isTrashView || isSharePoolActive) return;
                const isInternalCopy =
                  isInternalItemDrag(e) && (e.ctrlKey || e.altKey) && Boolean(onCopyItems);
                if (!isExternalFileDrag(e) && !isInternalCopy) {
                  if (isDropZoneActive) setIsDropZoneActive(false);
                  return;
                }
                if (isInternalCopy && rejectInvalidInternalDragOver(e, cleanPath, undefined, true)) {
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer) {
                  e.dataTransfer.dropEffect = 'copy';
                }
                if (!isInternalCopy && !isDropZoneActive) {
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
