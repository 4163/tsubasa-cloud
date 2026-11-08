import React, { useState, useEffect, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconTrash, IconClose, IconAlertTriangle } from './Icons';

interface ConfirmPurgeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  itemCount: number;
  totalBytes?: number;
}

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(11, 20, 18, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 110,
    padding: spacing.space4,
    boxSizing: 'border-box',
    transition: motion.transitionFast,
  },
  modal: {
    width: '400px',
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
  pathHint: {
    fontSize: typography.fontSizeMeta,
    color: colors.dimText,
    fontFamily: typography.fontFamilyMono,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  warningBox: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  warningHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    color: colors.dangerTextOnSurface,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
  },
  warningDesc: {
    fontSize: typography.fontSizeMeta,
    lineHeight: '1.4',
    color: colors.secondaryText,
    margin: 0,
  },
  footer: {
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.space2,
    flexShrink: 0,
  },
  cancelBtn: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.compact,
    backgroundColor: 'transparent',
    color: colors.secondaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    cursor: 'pointer',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
      borderColor: colors.primaryText,
    },
  },
  purgeBtn: {
    height: '32px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderRadius: radius.compact,
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
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function ConfirmPurgeModal({
  isOpen,
  onClose,
  onConfirm,
  itemCount,
  totalBytes = 0,
}: ConfirmPurgeModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsSubmitting(false);
      setTimeout(() => {
        confirmBtnRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div {...stylex.props(styles.backdrop)} onClick={onClose} onKeyDown={handleKeyDown}>
      <div
        {...stylex.props(styles.modal)}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm permanent purge"
        onClick={(e) => e.stopPropagation()}
      >
        <div {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.titleGroup)}>
            <IconTrash size={16} />
            <h3 {...stylex.props(styles.title)}>Permanently purge trash</h3>
          </div>
          <button
            type="button"
            {...stylex.props(styles.closeBtn)}
            onClick={onClose}
            aria-label="Close dialog"
          >
            <IconClose size={14} />
          </button>
        </div>

        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.pathHint)}>
            Target: Trash · {itemCount} {itemCount === 1 ? 'file' : 'files'}
            {totalBytes > 0 ? ` (${formatBytes(totalBytes)} recoverable quota)` : ''}
          </div>

          <div {...stylex.props(styles.warningBox)}>
            <div {...stylex.props(styles.warningHeader)}>
              <IconAlertTriangle size={15} />
              <span>Irreversible action</span>
            </div>
            <p {...stylex.props(styles.warningDesc)}>
              Permanently purge all {itemCount} {itemCount === 1 ? 'file' : 'files'}? Storage will be permanently reclaimed from Google Drive across all connected accounts. This action cannot be undone.
            </p>
          </div>
        </div>

        <div {...stylex.props(styles.footer)}>
          <button
            type="button"
            {...stylex.props(styles.cancelBtn)}
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            {...stylex.props(styles.purgeBtn)}
            onClick={handleConfirm}
            disabled={isSubmitting}
          >
            <IconTrash size={14} />
            {isSubmitting ? 'Purging...' : 'Confirm purge'}
          </button>
        </div>
      </div>
    </div>
  );
}

