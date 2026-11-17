import React, { useRef, useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, layout, spacing, radius, typography } from '../tokens.stylex.js';
import { IconAlertTriangle, IconTrash } from './Icons.js';
import { formatBytes } from '../utils/format.js';
import { ModalDialog } from './ModalDialog.js';
import { ModalHeader, modalChromeStyles } from './ModalChrome.js';
import type { AccountItem } from './Sidebar.js';

interface ConfirmDriveActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  account: AccountItem | null;
  filesCount: number;
  totalBytes: number;
  isLoading: boolean;
  errorMessage?: string | null;
}

const styles = stylex.create({
  surface: {
    width: layout.drawerWidth,
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
    gap: spacing.space2,
  },
  driveName: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
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
    fontWeight: typography.fontWeightSection,
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
    marginTop: spacing.space1,
  },
  warningText: {
    fontSize: typography.fontSizeMeta,
    color: colors.dangerTextOnSurface,
    lineHeight: typography.lineHeightBody,
    margin: 0,
    fontWeight: '500',
  },
});

export function ConfirmDriveActionModal({
  isOpen,
  onClose,
  onConfirm,
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
          <ModalHeader
            titleId={titleId}
            title="Remove drive"
            icon={<IconTrash size={16} strokeWidth={2} {...stylex.props(styles.warningIcon)} />}
            onClose={onClose}
            isBusy={isLoading}
            closeAriaLabel="Close dialog"
          />

          <div {...stylex.props(modalChromeStyles.body)}>
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

          <div {...stylex.props(modalChromeStyles.footer, modalChromeStyles.footerGapLg)}>
            <button
              type="button"
              {...stylex.props(modalChromeStyles.cancelBtn, modalChromeStyles.cancelBtnSurface)}
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              ref={confirmBtnRef}
              type="button"
              autoFocus
              {...stylex.props(modalChromeStyles.dangerBtn)}
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

