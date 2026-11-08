import React, { useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import { IconUpload, IconFolderPlus, IconRefreshCw, IconTrash } from './Icons';

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
    borderWidth: '0px',
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
    backgroundColor: colors.primary,
    color: colors.surface,
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
      backgroundColor: colors.primaryHover,
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
      borderColor: colors.primaryText,
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
    color: '#ffffff',
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
      opacity: 0.9,
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

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
}: ActionPortalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  return (
    <div {...stylex.props(styles.portal)}>
      <nav aria-label="Breadcrumb" {...stylex.props(styles.breadcrumbs)}>
        <button
          type="button"
          {...stylex.props(styles.crumbBtn, !isTrashView && segments.length === 0 && styles.crumbActive)}
          onClick={() => handleBreadcrumbClick(-1)}
        >
          All files
        </button>

        {isTrashView ? (
          <>
            <span {...stylex.props(styles.crumbSeparator)}>›</span>
            <span
              {...stylex.props(styles.crumbActive)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <IconTrash size={14} />
              Trash ({trashedCount} item{trashedCount === 1 ? '' : 's'})
            </span>
          </>
        ) : (
          segments.map((segment, idx) => {
            const isLast = idx === segments.length - 1;
            return (
              <React.Fragment key={segment + idx}>
                <span {...stylex.props(styles.crumbSeparator)}>›</span>
                <button
                  type="button"
                  {...stylex.props(styles.crumbBtn, isLast && styles.crumbActive)}
                  onClick={() => !isLast && handleBreadcrumbClick(idx)}
                  aria-current={isLast ? 'page' : undefined}
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
              {onDeleteSelected && (
                <button
                  type="button"
                  {...stylex.props(styles.secondaryBtn, styles.deleteSelectedBtn)}
                  onClick={onDeleteSelected}
                  aria-label="Delete selected items"
                >
                  <IconTrash size={14} />
                  Delete
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

            <button
              type="button"
              {...stylex.props(styles.primaryBtn)}
              onClick={() => fileInputRef.current?.click()}
            >
              <IconUpload strokeWidth={2.5} {...stylex.props(styles.btnIcon)} />
              Upload
            </button>

            <button
              type="button"
              {...stylex.props(styles.secondaryBtn)}
              onClick={onCreateFolderPrompt}
            >
              <IconFolderPlus {...stylex.props(styles.btnIcon)} />
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

