import { useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, darkColors, spacing, radius, typography } from '../tokens.stylex.js';
import { IconAlertTriangle } from './Icons.js';
import type { TabOwnerKind } from '../utils/useTabLock.js';
import { useResolvedTheme } from '../hooks/useResolvedTheme.js';
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
  leadText: {
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    lineHeight: typography.lineHeightBody,
    color: colors.primaryText,
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
}

/**
 * Static blocking dialog shown over a blurred workspace placeholder when another instance holds the lock.
 */
export function TabBlockedModal({ ownerKind }: TabBlockedModalProps) {
  const effectiveTheme = useResolvedTheme();
  const isElectronOwner = ownerKind === 'electron';
  const titleId = useId();

  return (
    <div
      {...stylex.props(styles.root, effectiveTheme === 'dark' && darkColors)}
      data-theme={effectiveTheme}
    >
      <div className="grain-overlay" />

      <GhostWorkspaceBackdrop effectiveTheme={effectiveTheme} />

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
          title="Tsubasa~ Cloud is already open"
          icon={
            <span {...stylex.props(styles.iconWrap)} aria-hidden="true">
              <IconAlertTriangle size={16} />
            </span>
          }
        />

        <div {...stylex.props(modalChromeStyles.body, modalChromeStyles.bodySpaced)}>
          <div {...stylex.props(styles.noticeBox)}>
            <p {...stylex.props(styles.leadText)}>
              {isElectronOwner
                ? 'The Tsubasa~ Cloud desktop app is already running.'
                : 'Another Tsubasa~ Cloud tab is already open.'}
            </p>
            <p {...stylex.props(styles.bodyText)}>
              This tab is blocked so it cannot conflict with active uploads, syncs, or database writes.
            </p>
          </div>

          <p {...stylex.props(styles.instructionText)}>
            Switch to the active tab or close this tab. If you closed the other tab, reload this page to continue.
          </p>
        </div>
      </ModalDialog>
    </div>
  );
}
