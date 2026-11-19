import React, { useState, useEffect, useRef, useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography } from '../tokens.stylex.js';
import { IconTrash, IconAlertTriangle } from './Icons.js';
import { formatBytes } from '../utils/format.js';
import { syncOverflowTitle } from '../utils/workspaceHelpers.js';
import { ModalDialog } from './ModalDialog.js';
import { ModalHeader, modalChromeStyles } from './ModalChrome.js';

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
    lineHeight: typography.lineHeightBody,
    color: colors.secondaryText,
    margin: 0,
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
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const isSharePool = mode === 'share_pool';

  useEffect(() => {
    if (isOpen) {
      submittingRef.current = false;
      setIsSubmitting(false);
      setError(null);
    }
  }, [isOpen]);

  const handleConfirm = async () => {
    if (submittingRef.current || isSubmitting) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
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
      <ModalHeader
        titleId={titleId}
        title={isSharePool ? 'Clear share pool?' : 'Permanently purge trash'}
        icon={<IconTrash size={16} />}
        onClose={onClose}
        isBusy={isSubmitting}
        closeAriaLabel="Close dialog"
        closeIconSize={14}
      />

      <div {...stylex.props(modalChromeStyles.body)}>
        <div {...stylex.props(styles.pathHint)} onMouseEnter={syncOverflowTitle}>
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
              : `Permanently purge ${itemCount === 1 ? 'this file' : `all ${itemCount} files`}? Storage will be permanently reclaimed from Google Drive across all connected accounts. This action cannot be undone.`}
          </p>
        </div>

        <div role="status" aria-live="polite">
          {error && <span {...stylex.props(modalChromeStyles.errorMessage)}>{error}</span>}
        </div>
      </div>

      <div {...stylex.props(modalChromeStyles.footer)}>
        <button
          type="button"
          {...stylex.props(modalChromeStyles.cancelBtn)}
          onClick={onClose}
          disabled={isSubmitting}
        >
          Cancel
        </button>
        <button
          ref={confirmBtnRef}
          type="button"
          autoFocus
          {...stylex.props(modalChromeStyles.dangerBtn)}
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

