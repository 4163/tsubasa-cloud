import React, { useRef, useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconAlertTriangle, IconTrash } from './Icons.js';
import { formatBytes } from '../utils/format.js';
import { ModalDialog } from './ModalDialog.js';
import type { AccountItem } from './Sidebar.js';

interface ConfirmDriveActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  action: 'remove';
  account: AccountItem | null;
  filesCount: number;
  totalBytes: number;
  isLoading: boolean;
  errorMessage?: string | null;
}

const styles = stylex.create({
  surface: {
    width: '460px',
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
    width: '100%',
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    display: 'flex',
    gap: spacing.space3,
    alignItems: 'flex-start',
    boxSizing: 'border-box',
  },
  warningIcon: {
    color: colors.dangerTextOnSurface,
    flexShrink: 0,
    marginTop: '2px',
  },
  warningText: {
    fontSize: typography.fontSizeMeta,
    color: colors.dangerTextOnSurface,
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
    backgroundColor: colors.surface,
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
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
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
      backgroundColor: colors.surface,
      borderColor: colors.border,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
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
    color: colors.brandAccentText,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
      borderColor: colors.brandAccentHover,
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
  confirmBtnDanger: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
    color: colors.dangerText,
    ':hover': {
      backgroundColor: colors.dangerHover,
      borderColor: colors.dangerHover,
    },
  },
});

export function ConfirmDriveActionModal({
  isOpen,
  onClose,
  onConfirm,
  action: _action,
  account,
  filesCount,
  totalBytes,
  isLoading,
  errorMessage,
}: ConfirmDriveActionModalProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const effectiveOpen = isOpen && Boolean(account);

  const actionLabel = isLoading ? 'Evacuating files...' : 'Evacuate & remove drive';

  return (
    <ModalDialog
      isOpen={effectiveOpen}
      onClose={onClose}
      isBusy={isLoading}
      ariaLabelledBy={titleId}
      initialFocusRef={confirmBtnRef}
      surfaceStyle={styles.surface}
    >
      {account && (
        <>
          <div {...stylex.props(styles.header)}>
            <div {...stylex.props(styles.titleGroup)}>
              <IconTrash size={16} strokeWidth={2} {...stylex.props(styles.warningIcon)} />
              <h2 id={titleId} {...stylex.props(styles.title)}>
                Remove drive
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
              Removing this drive will automatically migrate its files to other active drives in the pool using the Folder-Cohesion algorithm, and delete its OAuth credentials from Tsubasa~.
            </p>

            <div {...stylex.props(styles.statsBox)}>
              <span {...stylex.props(styles.statsLabel)}>Files to evacuate</span>
              <span {...stylex.props(styles.statsValue)}>
                {filesCount} {filesCount === 1 ? 'file' : 'files'} ({formatBytes(totalBytes)})
              </span>
            </div>

            <div role="status" aria-live="polite">
              {errorMessage && (
                <div {...stylex.props(styles.warningBox)}>
                  <IconAlertTriangle size={18} {...stylex.props(styles.warningIcon)} />
                  <p {...stylex.props(styles.warningText)}>{errorMessage}</p>
                </div>
              )}
            </div>
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
              autoFocus
              {...stylex.props(styles.confirmBtn, styles.confirmBtnDanger)}
              onClick={() => onConfirm()}
              disabled={isLoading}
            >
              {actionLabel}
            </button>
          </div>
        </>
      )}
    </ModalDialog>
  );
}

