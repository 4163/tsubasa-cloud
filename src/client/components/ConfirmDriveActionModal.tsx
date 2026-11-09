import React, { useEffect, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconAlertTriangle, IconTrash, IconFolder } from './Icons.js';
import type { AccountItem } from './Sidebar.js';

interface ConfirmDriveActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  action: 'disable' | 'remove';
  account: AccountItem | null;
  filesCount: number;
  totalBytes: number;
  isLoading: boolean;
  errorMessage?: string | null;
}

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(11, 20, 18, 0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 110,
    padding: spacing.space4,
    boxSizing: 'border-box',
    transition: motion.transitionFast,
  },
  modal: {
    width: '460px',
    maxWidth: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    zIndex: 120,
    boxSizing: 'border-box',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
  },
  header: {
    height: '48px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    flexShrink: 0,
  },
  titleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
  },
  title: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeSection,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    margin: 0,
  },
  closeBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    color: colors.secondaryText,
    padding: spacing.space1,
    borderRadius: radius.compact,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
  },
  body: {
    padding: spacing.space5,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space3,
    backgroundColor: colors.surface,
  },
  driveInfoCard: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  driveName: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '600',
    color: colors.primaryText,
  },
  driveMeta: {
    fontSize: typography.fontSizeMeta,
    fontFamily: typography.fontFamilyMono,
    color: colors.secondaryText,
  },
  explanationText: {
    fontSize: typography.fontSizeBody,
    color: colors.primaryText,
    lineHeight: '1.45',
    margin: 0,
  },
  statsBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccentSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    fontSize: typography.fontSizeMeta,
    color: colors.brandAccent,
  },
  statsLabel: {
    fontWeight: '600',
  },
  statsValue: {
    fontFamily: typography.fontFamilyMono,
    fontVariantNumeric: 'tabular-nums',
  },
  warningBox: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.danger,
    display: 'flex',
    gap: spacing.space3,
    alignItems: 'flex-start',
  },
  warningIcon: {
    color: colors.danger,
    flexShrink: 0,
    marginTop: '2px',
  },
  warningText: {
    fontSize: typography.fontSizeMeta,
    color: colors.danger,
    lineHeight: '1.4',
    margin: 0,
    fontWeight: '500',
  },
  footer: {
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.space3,
    backgroundColor: colors.surfaceAlt,
  },
  cancelBtn: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.primaryText,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  confirmBtn: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.brandAccent,
    backgroundColor: colors.brandAccent,
    color: '#111d18',
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    transition: motion.transitionFast,
    ':hover': {
      filter: 'brightness(1.1)',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  confirmBtnDanger: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
    color: '#ffffff',
    ':hover': {
      filter: 'brightness(1.1)',
    },
  },
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function ConfirmDriveActionModal({
  isOpen,
  onClose,
  onConfirm,
  action,
  account,
  filesCount,
  totalBytes,
  isLoading,
  errorMessage,
}: ConfirmDriveActionModalProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        confirmBtnRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen || isLoading) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isLoading, onClose]);

  if (!isOpen || !account) return null;

  const isRemove = action === 'remove';
  const titleText = isRemove ? 'Remove drive' : 'Disable drive';
  const actionLabel = isLoading
    ? 'Evacuating files...'
    : isRemove
    ? 'Evacuate & remove drive'
    : 'Evacuate & disable drive';

  return (
    <div
      {...stylex.props(styles.backdrop)}
      onClick={() => {
        if (!isLoading) onClose();
      }}
    >
      <div
        {...stylex.props(styles.modal)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drive-action-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.titleGroup)}>
            {isRemove ? (
              <IconTrash size={16} strokeWidth={2} {...stylex.props(styles.warningIcon)} />
            ) : (
              <IconFolder size={16} strokeWidth={2} />
            )}
            <h2 id="drive-action-modal-title" {...stylex.props(styles.title)}>
              {titleText}
            </h2>
          </div>
          <button
            type="button"
            {...stylex.props(styles.closeBtn)}
            onClick={onClose}
            disabled={isLoading}
            aria-label="Close dialog"
          >
            <IconClose size={16} />
          </button>
        </div>

        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.driveInfoCard)}>
            <span {...stylex.props(styles.driveName)}>
              {account.displayName || account.id}
            </span>
            <span {...stylex.props(styles.driveMeta)}>
              {account.email || account.id}
            </span>
          </div>

          <p {...stylex.props(styles.explanationText)}>
            {isRemove
              ? 'Removing this drive will automatically migrate its files to other active drives in the pool using the Folder-Cohesion algorithm, and delete its OAuth credentials from Tsubasa~.'
              : 'Disabling this drive will exclude it from the storage pool. You can re-enable it at any time.'}
          </p>

          <div {...stylex.props(styles.statsBox)}>
            <span {...stylex.props(styles.statsLabel)}>Files to evacuate</span>
            <span {...stylex.props(styles.statsValue)}>
              {filesCount} {filesCount === 1 ? 'file' : 'files'} ({formatBytes(totalBytes)})
            </span>
          </div>

          {errorMessage && (
            <div {...stylex.props(styles.warningBox)}>
              <IconAlertTriangle size={18} {...stylex.props(styles.warningIcon)} />
              <p {...stylex.props(styles.warningText)}>{errorMessage}</p>
            </div>
          )}
        </div>

        <div {...stylex.props(styles.footer)}>
          <button
            type="button"
            {...stylex.props(styles.cancelBtn)}
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            {...stylex.props(styles.confirmBtn, isRemove && styles.confirmBtnDanger)}
            onClick={() => onConfirm()}
            disabled={isLoading}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

