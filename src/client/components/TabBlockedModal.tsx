import { useEffect, useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, darkColors, spacing, radius, typography } from '../tokens.stylex.js';
import { IconAlertTriangle, IconCheck } from './Icons.js';
import type { AuthCompletedPayload, TabOwnerKind } from '../utils/useTabLock.js';
import { useResolvedTheme } from '../hooks/useResolvedTheme.js';
import { readThemeChoice } from '../utils/theme.js';
import { applyWindowTitle, BASE_WINDOW_TITLE } from '../utils/windowTitle.js';
import { GhostWorkspaceBackdrop } from './GhostWorkspaceBackdrop.js';
import { ModalDialog } from './ModalDialog.js';
import { ModalHeader, modalChromeStyles } from './ModalChrome.js';

const styles = stylex.create({
  root: {
    position: 'fixed',
    inset: 0,
    backgroundColor: colors.canvas,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    overflow: 'hidden',
  },
  surface: {
    width: '440px',
  },
  iconWrap: {
    color: colors.warning,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconSuccessWrap: {
    color: colors.success,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  noticeBox: {
    padding: spacing.space4,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  noticeBoxSuccess: {
    backgroundColor: colors.successSurface,
  },
  leadText: {
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    lineHeight: typography.lineHeightBody,
    color: colors.primaryText,
    overflowWrap: 'anywhere',
    margin: 0,
  },
  bodyText: {
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightBody,
    lineHeight: typography.lineHeightBody,
    color: colors.secondaryText,
    margin: 0,
  },
  instructionText: {
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightBody,
    lineHeight: typography.lineHeightMeta,
    color: colors.secondaryText,
    margin: 0,
  },
});

interface TabBlockedModalProps {
  ownerKind: TabOwnerKind;
  authCompleted?: AuthCompletedPayload | null;
}

/**
 * Static blocking dialog shown over a blurred workspace placeholder when another instance holds the lock.
 */
export function TabBlockedModal({ ownerKind, authCompleted }: TabBlockedModalProps) {
  const effectiveTheme = useResolvedTheme();
  const isElectronOwner = ownerKind === 'electron';
  const isAuthSuccess = authCompleted != null;
  const titleId = useId();

  useEffect(() => {
    applyWindowTitle(BASE_WINDOW_TITLE);
  }, []);

  const modalTitle = isAuthSuccess ? 'Account linked' : 'Tsubasa~ Cloud is already open';

  const leadMessage = isAuthSuccess
    ? authCompleted.account
      ? `${authCompleted.account} is linked to Tsubasa~ Cloud.`
      : 'Your Google account is linked to Tsubasa~ Cloud.'
    : isElectronOwner
      ? 'The Tsubasa~ Cloud desktop app is already running.'
      : 'Another Tsubasa~ Cloud tab is already open.';

  const bodyMessage = isAuthSuccess
    ? isElectronOwner
      ? 'The desktop app is already running and will pick up the new account. You can close this tab and return to the app.'
      : 'Your active Tsubasa~ Cloud tab is already open and will pick up the new account. You can close this tab and switch back.'
    : 'This tab is blocked so it cannot conflict with active uploads, syncs, or database writes.';

  const instructionMessage = isAuthSuccess
    ? isElectronOwner
      ? 'If the desktop app is no longer open, reload this page to continue here.'
      : 'If you closed the other tab, reload this page to continue here.'
    : isElectronOwner
      ? 'Switch to the desktop app or close this tab. If you quit the desktop app, reload this page to continue.'
      : 'Switch to the active tab or close this tab. If you closed the other tab, reload this page to continue.';

  return (
    <div
      {...stylex.props(styles.root, effectiveTheme === 'dark' && darkColors)}
      data-theme={effectiveTheme}
    >
      <GhostWorkspaceBackdrop effectiveTheme={effectiveTheme} themeChoice={readThemeChoice()} />

      <ModalDialog
        isOpen={true}
        onClose={() => {}}
        isBusy={true}
        preventUnloadWhileBusy={false}
        ariaLabelledBy={titleId}
        surfaceStyle={styles.surface}
      >
        <ModalHeader
          titleId={titleId}
          title={modalTitle}
          icon={
            <span
              {...stylex.props(isAuthSuccess ? styles.iconSuccessWrap : styles.iconWrap)}
              aria-hidden="true"
            >
              {isAuthSuccess ? <IconCheck size={16} /> : <IconAlertTriangle size={16} />}
            </span>
          }
        />

        <div {...stylex.props(modalChromeStyles.body, modalChromeStyles.bodySpaced)}>
          <div {...stylex.props(styles.noticeBox, isAuthSuccess && styles.noticeBoxSuccess)}>
            <p {...stylex.props(styles.leadText)}>{leadMessage}</p>
            <p {...stylex.props(styles.bodyText)}>{bodyMessage}</p>
          </div>

          <p {...stylex.props(styles.instructionText)}>{instructionMessage}</p>
        </div>
      </ModalDialog>
    </div>
  );
}
