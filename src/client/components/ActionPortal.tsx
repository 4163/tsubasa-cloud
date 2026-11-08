import React, { useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import { IconUpload, IconFolderPlus, IconRefreshCw } from './Icons';

interface ActionPortalProps {
  currentPath: string;
  onNavigatePath: (path: string) => void;
  onUploadFiles: (files: FileList) => void;
  onCreateFolderPrompt: () => void;
  onSyncAll: () => void;
  isSyncing: boolean;
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
});

export function ActionPortal({
  currentPath,
  onNavigatePath,
  onUploadFiles,
  onCreateFolderPrompt,
  onSyncAll,
  isSyncing,
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
          {...stylex.props(styles.crumbBtn, segments.length === 0 && styles.crumbActive)}
          onClick={() => handleBreadcrumbClick(-1)}
        >
          All files
        </button>

        {segments.map((segment, idx) => {
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
        })}
      </nav>

      <div {...stylex.props(styles.actionCluster)}>
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
        >
          <IconRefreshCw {...stylex.props(styles.btnIcon)} />
          {isSyncing ? 'Syncing...' : 'Sync pool'}
        </button>
      </div>
    </div>
  );
}

