import React, { useRef } from 'react';
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
  onClearSelection?: () => void;
  onNavigate: (path: string) => void;
  onDownload: (file: ClientFileRecord) => void;
  onTrash: (file: ClientFileRecord) => void;
  onDeleteFolder?: (folder: ClientFolder) => void;
  isTrashView?: boolean;
  onRestore?: (file: ClientFileRecord) => void;
  onPermanentDelete?: (file: ClientFileRecord) => void;
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
    height: layout.tableRowHeightCompact,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    display: 'grid',
    gridTemplateColumns: 'minmax(260px, 3fr) 140px 110px 140px 90px',
    alignItems: 'center',
    paddingLeft: spacing.space4,
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
  },
  virtualTrack: {
    width: '100%',
    position: 'relative',
  },
  row: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: layout.tableRowHeightCompact,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'grid',
    gridTemplateColumns: 'minmax(260px, 3fr) 140px 110px 140px 90px',
    alignItems: 'center',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    boxSizing: 'border-box',
    cursor: 'pointer',
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
      gridTemplateColumns: '40px 1fr 40px',
      paddingLeft: spacing.space3,
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
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.accentGold,
  },
  nameCell: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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
  },
  accountPill: {
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.secondaryText,
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
    padding: spacing.space10,
    textAlign: 'center',
    color: colors.secondaryText,
    gap: spacing.space2,
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
  onClearSelection,
  onNavigate,
  onDownload,
  onTrash,
  onDeleteFolder,
  isTrashView = false,
  onRestore,
  onPermanentDelete,
}: FileTableProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);

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
        <div>Name</div>
        <div>Account</div>
        <div {...stylex.props(styles.colRight)}>Size</div>
        <div {...stylex.props(styles.colRight)}>{isTrashView ? 'Date trashed' : 'Modified'}</div>
        <div {...stylex.props(styles.colRight)}>Actions</div>
      </div>

      <div
        ref={parentRef}
        {...stylex.props(styles.scrollViewport)}
        onClick={() => {
          onClearSelection?.();
        }}
      >
        {items.length === 0 ? (
          <div {...stylex.props(styles.emptyState)}>
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
          </div>
        ) : (
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
                    onClick={(e) => {
                      e.stopPropagation();
                      onNavigate(item.path);
                    }}
                  >
                    <div {...stylex.props(styles.nameCell)}>
                      <IconChevronLeft {...stylex.props(styles.itemIcon)} />
                      <span {...stylex.props(styles.itemLabel)}>.. (Parent directory)</span>
                    </div>
                    <div />
                    <div />
                    <div />
                    <div />
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
                      onSelect(folder.id, e.shiftKey || e.ctrlKey || e.metaKey);
                    }}
                    onDoubleClick={() => onNavigate(folder.virtualPath)}
                  >
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
                          title="Delete folder"
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
                        title="Open folder"
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
                      onSelect(file.id, e.shiftKey || e.ctrlKey || e.metaKey);
                    }}
                  >
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
                      <span {...stylex.props(styles.accountPill)} title={`Stored on account ${file.accountId}`}>
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
                          title="Restore to original location"
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
                          title="Delete permanently from Google Drive"
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
                    onSelect(file.id, e.shiftKey || e.ctrlKey || e.metaKey);
                  }}
                  onDoubleClick={() => onDownload(file)}
                >
                  <div {...stylex.props(styles.nameCell)}>
                    <IconFile {...stylex.props(styles.itemIcon)} />
                    <span {...stylex.props(styles.itemLabel)}>{file.name}</span>
                  </div>

                  <div>
                    <span {...stylex.props(styles.accountPill)} title={`Stored on account ${file.accountId}`}>
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
                      title="Download file"
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
                      title="Move to trash"
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
        )}
      </div>
    </div>
  );
}
