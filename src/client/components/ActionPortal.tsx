import React, { useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import {
  IconUpload,
  IconFolderPlus,
  IconRefreshCw,
  IconTrash,
  IconRotateCcw,
  IconEdit,
  IconCopy,
  IconClipboard,
  IconFolder,
} from './Icons.js';
import { formatBytes } from '../utils/format.js';

export interface ActionPortalClipboard {
  mode: 'cut' | 'copy';
  items: Array<{
    kind: 'file' | 'folder';
    id: string;
    name: string;
    virtualPath: string;
  }>;
}

interface ActionPortalProps {
  currentPath: string;
  onNavigatePath: (path: string) => void;
  onUploadFiles: (files: FileList) => void;
  onCreateFolderPrompt: () => void;
  onSyncAll: () => void;
  isSyncing: boolean;
  isTrashView?: boolean;
  trashedCount?: number;
  onEmptyTrash?: () => void;
  selectedCount?: number;
  selectedTotalBytes?: number;
  onClearSelection?: () => void;
  onDeleteSelected?: () => void;
  onRenamePrompt?: () => void;
  onRestoreSelected?: () => void;
  onCutSelected?: () => void;
  onCopySelected?: () => void;
  clipboard?: ActionPortalClipboard | null;
  onPaste?: () => void;
  onMoveItemsToPath?: (items: Array<{ kind: 'file' | 'folder'; id: string }>, targetPath: string) => void;
  onDropExternalToPath?: (targetPath: string, dataTransfer: DataTransfer) => void;
}

const styles = stylex.create({
  portal: {
    height: layout.actionsPortalHeight,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    boxSizing: 'border-box',
    gap: spacing.space4,
    flexWrap: 'nowrap',
    overflowX: 'auto',
  },
  breadcrumbs: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    fontSize: typography.fontSizeBody,
    fontFamily: typography.fontFamilyBody,
    color: colors.secondaryText,
    whiteSpace: 'nowrap',
  },
  crumbBtn: {
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    color: colors.secondaryText,
    cursor: 'pointer',
    fontSize: typography.fontSizeBody,
    fontFamily: typography.fontFamilyBody,
    paddingTop: spacing.space1,
    paddingBottom: spacing.space1,
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
  },
  crumbActive: {
    color: colors.primaryText,
    fontWeight: typography.fontWeightTitle,
    cursor: 'default',
  },
  crumbActiveTrash: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space3,
  },
  crumbDragOver: {
    backgroundColor: colors.brandAccentSurface,
    color: colors.brandAccent,
    borderColor: colors.accentGold,
  },
  crumbSeparator: {
    color: colors.dimText,
    userSelect: 'none',
  },
  actionCluster: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    flexShrink: 0,
  },
  primaryBtn: {
    height: '32px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderRadius: radius.button,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
    },
    ':active': {
      transform: 'scale(0.98)',
      transition: motion.transitionTap,
    },
  },
  secondaryBtn: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.button,
    backgroundColor: 'transparent',
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.brandAccent,
      color: colors.brandAccent,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  hiddenInput: {
    display: 'none',
  },
  btnIcon: {
    width: '14px',
    height: '14px',
  },
  emptyTrashBtn: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.button,
    backgroundColor: colors.danger,
    color: colors.dangerText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.dangerHover,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  selectionGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
  },
  selectionBadge: {
    height: '32px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    fontSize: typography.fontSizeBody,
    fontFamily: typography.fontFamilyBody,
    fontWeight: '500',
    color: colors.primaryText,
    backgroundColor: colors.selectionBg,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.button,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.selectionBorder,
    userSelect: 'none',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
  },
  selectionBadgeSize: {
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
    fontSize: typography.fontSizeMeta,
  },
  deleteSelectedBtn: {
    color: colors.danger,
    borderColor: colors.border,
    ':hover': {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
      color: colors.danger,
    },
  },
  clearBtn: {
    height: '32px',
    backgroundColor: 'transparent',
    borderWidth: '0px',
    color: colors.secondaryText,
    cursor: 'pointer',
    fontSize: typography.fontSizeBody,
    fontFamily: typography.fontFamilyBody,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.button,
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
  },
  clusterDivider: {
    width: '1px',
    height: '20px',
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.space2,
    marginRight: spacing.space2,
    flexShrink: 0,
  },
});

export function ActionPortal({
  currentPath,
  onNavigatePath,
  onUploadFiles,
  onCreateFolderPrompt,
  onSyncAll,
  isSyncing,
  isTrashView = false,
  trashedCount = 0,
  onEmptyTrash,
  selectedCount = 0,
  selectedTotalBytes = 0,
  onClearSelection,
  onDeleteSelected,
  onRenamePrompt,
  onRestoreSelected,
  onCutSelected,
  onCopySelected,
  clipboard,
  onPaste,
  onMoveItemsToPath,
  onDropExternalToPath,
}: ActionPortalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Normalize path segments
  const cleanPath = currentPath.trim() === '' ? '/' : currentPath;
  const segments = cleanPath.split('/').filter(Boolean);

  function handleBreadcrumbClick(index: number) {
    if (index === -1) {
      onNavigatePath('/');
    } else {
      const targetPath = '/' + segments.slice(0, index + 1).join('/');
      onNavigatePath(targetPath);
    }
  }

  function handleBreadcrumbDragOver(e: React.DragEvent, index: number) {
    if (isTrashView) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    setDragOverIndex(index);
  }

  function handleBreadcrumbDragLeave(e: React.DragEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverIndex((prev) => (prev === index ? null : prev));
    }
  }

  function handleBreadcrumbDrop(e: React.DragEvent, index: number) {
    if (isTrashView) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOverIndex(null);
    const targetPath = index === -1 ? '/' : '/' + segments.slice(0, index + 1).join('/');

    if (e.dataTransfer.types.includes('application/x-tsubasa-items')) {
      try {
        const raw = e.dataTransfer.getData('application/x-tsubasa-items');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          onMoveItemsToPath?.(parsed, targetPath);
          return;
        }
      } catch {}
    }

    if (e.dataTransfer.types.includes('Files') && e.dataTransfer.files.length > 0) {
      onDropExternalToPath?.(targetPath, e.dataTransfer);
    }
  }

  return (
    <div {...stylex.props(styles.portal)}>
      <nav aria-label="Breadcrumb" {...stylex.props(styles.breadcrumbs)}>
        <button
          type="button"
          {...stylex.props(
            styles.crumbBtn,
            !isTrashView && segments.length === 0 && styles.crumbActive,
            dragOverIndex === -1 && styles.crumbDragOver
          )}
          onClick={() => handleBreadcrumbClick(-1)}
          onDragOver={(e) => handleBreadcrumbDragOver(e, -1)}
          onDragLeave={(e) => handleBreadcrumbDragLeave(e, -1)}
          onDrop={(e) => handleBreadcrumbDrop(e, -1)}
          title="All files (/)"
        >
          All files
        </button>

        {isTrashView ? (
          <>
            <span {...stylex.props(styles.crumbSeparator)}>›</span>
            <span
              {...stylex.props(styles.crumbActive, styles.crumbActiveTrash)}
            >
              <IconTrash size={14} />
              Trash ({trashedCount} item{trashedCount === 1 ? '' : 's'})
            </span>
          </>
        ) : (
          segments.map((segment, idx) => {
            const isLast = idx === segments.length - 1;
            const fullPath = '/' + segments.slice(0, idx + 1).join('/');
            return (
              <React.Fragment key={segment + idx}>
                <span {...stylex.props(styles.crumbSeparator)}>›</span>
                <button
                  type="button"
                  {...stylex.props(
                    styles.crumbBtn,
                    isLast && styles.crumbActive,
                    dragOverIndex === idx && styles.crumbDragOver
                  )}
                  onClick={() => !isLast && handleBreadcrumbClick(idx)}
                  onDragOver={(e) => handleBreadcrumbDragOver(e, idx)}
                  onDragLeave={(e) => handleBreadcrumbDragLeave(e, idx)}
                  onDrop={(e) => handleBreadcrumbDrop(e, idx)}
                  aria-current={isLast ? 'page' : undefined}
                  title={fullPath}
                >
                  {segment}
                </button>
              </React.Fragment>
            );
          })
        )}
      </nav>

      <div {...stylex.props(styles.actionCluster)}>
        {selectedCount > 0 && (
          <>
            <div {...stylex.props(styles.selectionGroup)}>
              <span {...stylex.props(styles.selectionBadge)}>
                <span>{selectedCount} selected</span>
                {selectedTotalBytes > 0 && (
                  <span {...stylex.props(styles.selectionBadgeSize)}>
                    · {formatBytes(selectedTotalBytes)}
                  </span>
                )}
              </span>

              {isTrashView && onRestoreSelected && (
                <button
                  type="button"
                  {...stylex.props(styles.primaryBtn)}
                  onClick={onRestoreSelected}
                  title="Restore selected items to their original locations"
                >
                  <IconRotateCcw size={14} />
                  Restore
                </button>
              )}

              {!isTrashView && selectedCount === 1 && onRenamePrompt && (
                <button
                  type="button"
                  {...stylex.props(styles.secondaryBtn)}
                  onClick={onRenamePrompt}
                  title="Rename item (F2)"
                >
                  <IconEdit size={14} />
                  Rename
                </button>
              )}

              {!isTrashView && onCutSelected && (
                <button
                  type="button"
                  {...stylex.props(styles.secondaryBtn)}
                  onClick={onCutSelected}
                  title="Cut selected items (Ctrl+X)"
                >
                  <IconCopy size={14} />
                  Cut
                </button>
              )}

              {!isTrashView && onCopySelected && (
                <button
                  type="button"
                  {...stylex.props(styles.secondaryBtn)}
                  onClick={onCopySelected}
                  title="Copy selected items (Ctrl+C)"
                >
                  <IconCopy size={14} />
                  Copy
                </button>
              )}

              {onDeleteSelected && (
                <button
                  type="button"
                  {...stylex.props(styles.secondaryBtn, styles.deleteSelectedBtn)}
                  onClick={onDeleteSelected}
                  aria-label="Delete selected items"
                  title="Delete selected (Delete)"
                >
                  <IconTrash size={14} />
                  {isTrashView ? 'Purge' : 'Delete'}
                </button>
              )}

              {onClearSelection && (
                <button
                  type="button"
                  {...stylex.props(styles.clearBtn)}
                  onClick={onClearSelection}
                  title="Deselect all (Esc)"
                >
                  Clear
                </button>
              )}
            </div>
            <div {...stylex.props(styles.clusterDivider)} />
          </>
        )}

        {clipboard && !isTrashView && onPaste && (
          <>
            <button
              type="button"
              {...stylex.props(styles.secondaryBtn)}
              onClick={onPaste}
              title={`Paste ${clipboard.items.length} item(s) (${clipboard.mode === 'cut' ? 'move' : 'copy'}) into ${cleanPath}`}
            >
              <IconClipboard size={14} />
              Paste ({clipboard.items.length})
            </button>
            <div {...stylex.props(styles.clusterDivider)} />
          </>
        )}

        {isTrashView ? (
          <button
            type="button"
            {...stylex.props(styles.emptyTrashBtn)}
            onClick={onEmptyTrash}
            disabled={trashedCount === 0}
          >
            <IconTrash size={14} />
            Empty trash
          </button>
        ) : (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              {...stylex.props(styles.hiddenInput)}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  onUploadFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />

            <input
              ref={folderInputRef}
              type="file"
              multiple
              {...({ webkitdirectory: '', directory: '' } as any)}
              {...stylex.props(styles.hiddenInput)}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  onUploadFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />

            <button
              type="button"
              {...stylex.props(styles.primaryBtn)}
              onClick={() => fileInputRef.current?.click()}
              title="Upload files to current folder"
            >
              <IconUpload strokeWidth={2.5} {...stylex.props(styles.btnIcon)} />
              Upload file
            </button>

            <button
              type="button"
              {...stylex.props(styles.secondaryBtn)}
              onClick={() => folderInputRef.current?.click()}
              title="Upload an entire folder with nested files and structure"
            >
              <IconFolderPlus {...stylex.props(styles.btnIcon)} />
              Upload folder
            </button>

            <button
              type="button"
              {...stylex.props(styles.secondaryBtn)}
              onClick={onCreateFolderPrompt}
              title="Create new directory in current location"
            >
              <IconFolder {...stylex.props(styles.btnIcon)} />
              New folder
            </button>

            <button
              type="button"
              {...stylex.props(styles.secondaryBtn)}
              onClick={onSyncAll}
              disabled={isSyncing}
              title="Fetch external changes from Google Drive and scan .oauths/ credentials"
            >
              <IconRefreshCw {...stylex.props(styles.btnIcon)} />
              {isSyncing ? 'Fetching...' : 'Fetch Drive changes'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

