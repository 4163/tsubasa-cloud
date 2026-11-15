import React, { useState, useEffect, useRef, useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconTrash, IconClose, IconAlertTriangle } from './Icons.js';
import { formatBytes } from '../utils/format.js';
import { ModalDialog } from './ModalDialog.js';

interface ConfirmPurgeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  itemCount: number;
  totalBytes?: number;
  mode?: 'trash' | 'share_pool';
}

const styles = stylex.create({
  surface: {
    width: '400px',
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
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.35,
      color: colors.secondaryText,
      backgroundColor: 'transparent',
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minWidth: '44px',
      minHeight: '44px',
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
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
      borderColor: colors.primaryText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.5,
      backgroundColor: 'transparent',
      color: colors.secondaryText,
      borderColor: colors.border,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
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
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.dangerHover,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
    },
  },
});

export function ConfirmPurgeModal({
  isOpen,
  onClose,
  onConfirm,
  itemCount,
  totalBytes = 0,
  mode = 'trash',
}: ConfirmPurgeModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const isSharePool = mode === 'share_pool';

  useEffect(() => {
    if (isOpen) {
      setIsSubmitting(false);
    }
  }, [isOpen]);

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

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      isBusy={isSubmitting}
      ariaLabelledBy={titleId}
      initialFocusRef={confirmBtnRef}
      surfaceStyle={styles.surface}
    >
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.titleGroup)}>
          <IconTrash size={16} />
          <h3 id={titleId} {...stylex.props(styles.title)}>
            {isSharePool ? 'Clear share pool?' : 'Permanently purge trash'}
          </h3>
        </div>
        <button
          type="button"
          {...stylex.props(styles.closeBtn)}
          onClick={onClose}
          disabled={isSubmitting}
          aria-label="Close dialog"
        >
          <IconClose size={14} />
        </button>
      </div>

      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.pathHint)}>
          {isSharePool ? (
            <>
              Target: share pool (_Tsubasa~ Pool share) · {itemCount} {itemCount === 1 ? 'item' : 'items'}
              {totalBytes > 0 ? ` (${formatBytes(totalBytes)})` : ''}
            </>
          ) : (
            <>
              Target: Trash · {itemCount} {itemCount === 1 ? 'file' : 'files'}
              {totalBytes > 0 ? ` (${formatBytes(totalBytes)} recoverable quota)` : ''}
            </>
          )}
        </div>

        <div {...stylex.props(styles.warningBox)}>
          <div {...stylex.props(styles.warningHeader)}>
            <IconAlertTriangle size={15} />
            <span>{isSharePool ? 'Permanent deletion' : 'Irreversible action'}</span>
          </div>
          <p {...stylex.props(styles.warningDesc)}>
            {isSharePool
              ? 'All copied files and folders in _Tsubasa~ Pool share will be permanently deleted across share pool drives. Original files in your storage pools remain untouched.'
              : `Permanently purge all ${itemCount} ${itemCount === 1 ? 'file' : 'files'}? Storage will be permanently reclaimed from Google Drive across all connected accounts. This action cannot be undone.`}
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
          autoFocus
          {...stylex.props(styles.purgeBtn)}
          onClick={handleConfirm}
          disabled={isSubmitting}
        >
          <IconTrash size={14} />
          {isSharePool
            ? (isSubmitting ? 'Clearing...' : 'Clear share pool')
            : (isSubmitting ? 'Purging...' : 'Confirm purge')}
        </button>
      </div>
    </ModalDialog>
  );
}

