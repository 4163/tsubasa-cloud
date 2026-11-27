import * as stylex from '@stylexjs/stylex';
import { colors, motion, radius, spacing, typography } from '../tokens.stylex.js';
import type { AccountItem } from '../types.js';
import { AccountAvatar } from './AccountAvatar.js';
import { AccountTransferGauge } from './AccountTransferGauge.js';
import { IconFolder, IconFunnel, IconFunnelX } from './Icons.js';
import { RedactedEmail } from './RedactedEmail.js';
import { syncOverflowTitle } from '../utils/workspaceHelpers.js';

export interface SidebarAccountCardProps {
  account: AccountItem;
  index: number;
  isFiltered: boolean;
  canMovePool: boolean;
  isSharePool: boolean;
  authUrl?: string;
  hasAuthUrlError?: boolean;
  isAuthUrlCopied: boolean;
  onCopyAuthUrl?: (accountId: string) => void;
  isAuthorizing?: boolean;
  onAuthorizeDemoAccount?: (accountId: string) => void;
  onToggleAccountFilter?: (accountId: string) => void;
  onRefreshStorage?: () => void;
  onOpenExternalChanges?: (accountId: string) => void;
  onOpenMovePool?: (account: AccountItem) => void;
  onEnableAccount?: (accountId: string) => void;
  onDisableAccount?: (account: AccountItem) => void;
  onRemoveAccount?: (account: AccountItem) => void;
}

const formatGb = (bytes: number) => (bytes / (1024 * 1024 * 1024)).toFixed(2);

const styles = stylex.create({
  accountCard: {
    padding: spacing.space3,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    contentVisibility: 'auto',
    containIntrinsicSize: 'auto 140px',
    contain: {
      default: null,
      '@supports not (content-visibility: auto)': 'layout style paint',
    },
  },
  accountCardFiltered: {
    borderColor: colors.accentGold,
  },
  accountTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  accountNameGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
  },
  accountTextGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  accountNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space1,
    minWidth: 0,
  },
  accountName: {
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  accountFilterBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    padding: '0px',
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: radius.compact,
    color: colors.secondaryText,
    cursor: 'pointer',
    flexShrink: 0,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.surface,
      borderColor: colors.borderSubtle,
      color: colors.primaryText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    '@media (pointer: coarse)': {
      minWidth: '36px',
      minHeight: '36px',
    },
  },
  accountFilterBtnActive: {
    backgroundColor: colors.brandAccentSurface,
    borderColor: colors.brandAccent,
    color: colors.brandAccent,
    ':hover': {
      backgroundColor: colors.brandAccentSurface,
      borderColor: colors.brandAccentHover,
      color: colors.brandAccentHover,
    },
  },
  accountStatusGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
  disabledPill: {
    fontSize: typography.fontSizeBadge,
    color: colors.danger,
    fontWeight: '600',
  },
  fullPill: {
    fontSize: typography.fontSizeBadge,
    color: colors.danger,
    fontWeight: '600',
  },
  authPill: {
    fontSize: typography.fontSizeBadge,
    color: colors.success,
    fontWeight: '600',
  },
  authLinkContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    marginTop: spacing.space1,
    marginBottom: spacing.space1,
  },
  authLinkLabelRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  authLinkLabel: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: '600',
    color: colors.dimText,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  authLinkHelp: {
    fontSize: '10px',
    color: colors.dimText,
  },
  authLinkBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
    paddingTop: '4px',
    paddingBottom: '4px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
    boxSizing: 'border-box',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.border,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.6,
      cursor: 'not-allowed',
    },
  },
  authLinkBoxCopied: {
    borderColor: colors.success,
    backgroundColor: colors.successSurface,
  },
  authLinkText: {
    fontFamily: typography.fontFamilyMono,
    fontSize: '10px',
    color: colors.secondaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    flex: 1,
  },
  authLinkCopyTag: {
    fontFamily: typography.fontFamilyBody,
    fontSize: '10px',
    fontWeight: '600',
    color: colors.dimText,
    flexShrink: 0,
    paddingLeft: '4px',
    paddingRight: '4px',
  },
  authLinkCopyTagSuccess: {
    color: colors.success,
  },
  storageSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
  },
  storageHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: typography.fontSizeBadge,
  },
  storageLabel: {
    fontFamily: typography.fontFamilyBody,
    fontSize: '10px',
    fontWeight: '600',
    color: colors.secondaryText,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  storageValueText: {
    fontSize: '10px',
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  progressBarContainer: {
    width: '100%',
    height: '4px',
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    overflow: 'hidden',
  },
  progressBarFill: {
    width: '100%',
    height: '100%',
    backgroundColor: colors.brandAccent,
    borderRadius: radius.pill,
    transformOrigin: 'left center',
    transition: 'transform 0.3s ease',
  },
  progressBarBreach: {
    backgroundColor: colors.danger,
  },
  progressScale: (scale: number) => ({
    transform: `scaleX(${scale})`,
  }),
  externalDriveRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
  },
  externalDriveText: {
    fontSize: '10px',
    color: colors.dimText,
    fontVariantNumeric: 'tabular-nums',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    flex: 1,
  },
  accountActionsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
    marginTop: '2px',
  },
  accountActionsLeft: {
    display: 'flex',
    alignItems: 'center',
  },
  accountActionsRight: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.space2,
    marginLeft: 'auto',
  },
  miniChangesBtnRed: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.danger,
    borderRadius: radius.compact,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    fontSize: typography.fontSizeBadge,
    lineHeight: typography.lineHeightBadge,
    color: colors.danger,
    cursor: 'pointer',
    flexShrink: 0,
    fontWeight: '600',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
  miniSyncBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    fontSize: typography.fontSizeBadge,
    lineHeight: typography.lineHeightBadge,
    color: colors.secondaryText,
    cursor: 'pointer',
    flexShrink: 0,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.surface,
      borderColor: colors.brandAccent,
      color: colors.brandAccent,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
  miniEnableBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    fontSize: typography.fontSizeBadge,
    lineHeight: typography.lineHeightBadge,
    color: colors.success,
    cursor: 'pointer',
    flexShrink: 0,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.successSurface,
      borderColor: colors.success,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
  miniDangerBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    fontSize: typography.fontSizeBadge,
    lineHeight: typography.lineHeightBadge,
    color: colors.danger,
    cursor: 'pointer',
    flexShrink: 0,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
  breachNotice: {
    fontSize: '10px',
    color: colors.danger,
    fontWeight: '600',
    lineHeight: '1.2',
  },
});

export function SidebarAccountCard({
  account: acc,
  index,
  isFiltered,
  canMovePool,
  isSharePool,
  authUrl,
  hasAuthUrlError,
  isAuthUrlCopied,
  onCopyAuthUrl,
  isAuthorizing = false,
  onAuthorizeDemoAccount,
  onToggleAccountFilter,
  onRefreshStorage,
  onOpenExternalChanges,
  onOpenMovePool,
  onEnableAccount,
  onDisableAccount,
  onRemoveAccount,
}: SidebarAccountCardProps) {
  const tsubasaUsedBytes = acc.tsubasaUsedBytes ?? 0;
  const accountCapacityBytes = tsubasaUsedBytes + acc.headroomBytes;
  const tsubasaUsedGb = formatGb(tsubasaUsedBytes);
  const capacityGb = formatGb(accountCapacityBytes);
  const headroomGb = formatGb(acc.headroomBytes);
  const driveUsedGb = formatGb(acc.quotaUsedBytes);
  const nonTsubasaBytes = Math.max(0, acc.quotaUsedBytes - tsubasaUsedBytes);
  const nonTsubasaGb = formatGb(nonTsubasaBytes);
  const hasNonTsubasaData = nonTsubasaBytes > 10 * 1024 * 1024;
  const isBreached = acc.quotaUsedBytes > acc.usableLimitBytes;
  const hasPoolFiles = tsubasaUsedBytes > 0;
  const canRebalance = isBreached && hasPoolFiles;
  const hasActionableChanges = Boolean(canRebalance || acc.hasPendingChanges);
  const usedPct = isBreached
    ? 100
    : accountCapacityBytes > 0
      ? Math.min(100, Math.max(0, Math.round((tsubasaUsedBytes / accountCapacityBytes) * 100)))
      : 0;
  const hasFiles = (acc.fileCount ?? 0) > 0 || (acc.tsubasaUsedBytes ?? 0) > 0;

  return (
    <div {...stylex.props(styles.accountCard, isFiltered && styles.accountCardFiltered)}>
      <div {...stylex.props(styles.accountTop)}>
        <div {...stylex.props(styles.accountNameGroup)}>
          <AccountAvatar
            avatarUrl={acc.avatarUrl}
            displayName={acc.displayName}
            email={acc.email}
            index={index}
          />
          <div {...stylex.props(styles.accountTextGroup)}>
            <div {...stylex.props(styles.accountNameRow)}>
              <span
                {...stylex.props(styles.accountName)}
                onMouseEnter={syncOverflowTitle}
              >
                {acc.displayName || acc.id}
              </span>
              {hasFiles && (
                <button
                  type="button"
                  {...stylex.props(
                    styles.accountFilterBtn,
                    isFiltered && styles.accountFilterBtnActive
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleAccountFilter?.(acc.id);
                  }}
                  title={isFiltered ? 'Clear account filter' : 'Filter by account'}
                  aria-label={
                    isFiltered
                      ? `Remove filter for ${acc.displayName || acc.id}`
                      : `Filter files on ${acc.displayName || acc.id}`
                  }
                  aria-pressed={isFiltered}
                >
                  {isFiltered ? <IconFunnelX size={11} /> : <IconFunnel size={11} />}
                </button>
              )}
            </div>
            <RedactedEmail email={acc.email || acc.id} />
          </div>
        </div>

        <div {...stylex.props(styles.accountStatusGroup)}>
          {acc.isDisabled ? (
            <span {...stylex.props(styles.disabledPill)} title="Excluded from storage pool">
              Disabled
            </span>
          ) : isBreached ? (
            <span {...stylex.props(styles.fullPill)} title="750 MB buffer breached">
              Full
            </span>
          ) : acc.authorized ? (
            <span {...stylex.props(styles.authPill)}>Active</span>
          ) : null}
        </div>
      </div>

      {!acc.authorized && (
        <>
          <div {...stylex.props(styles.authLinkContainer)}>
            <div {...stylex.props(styles.authLinkLabelRow)}>
              <span {...stylex.props(styles.authLinkLabel)}>Authorize link</span>
              <span {...stylex.props(styles.authLinkHelp)}>
                {__DEMO_MODE__ ? 'Click to authorize' : 'Click to copy'}
              </span>
            </div>
            {__DEMO_MODE__ ? (
              <button
                type="button"
                {...stylex.props(styles.authLinkBox)}
                disabled={isAuthorizing}
                onClick={() => onAuthorizeDemoAccount?.(acc.id)}
                aria-label="Authorize account"
              >
                <span {...stylex.props(styles.authLinkText)}>
                  {authUrl ||
                    (hasAuthUrlError
                      ? 'Authorize link unavailable'
                      : 'Generating authorize link...')}
                </span>
                <span {...stylex.props(styles.authLinkCopyTag)}>
                  {isAuthorizing ? 'Authorizing...' : 'Authorize'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                {...stylex.props(styles.authLinkBox, isAuthUrlCopied && styles.authLinkBoxCopied)}
                onClick={() => onCopyAuthUrl?.(acc.id)}
                aria-label="Copy authorize link"
              >
                <span {...stylex.props(styles.authLinkText)}>
                  {authUrl ||
                    (hasAuthUrlError
                      ? 'Authorize link unavailable (click to retry)'
                      : 'Generating authorize link...')}
                </span>
                <span
                  {...stylex.props(
                    styles.authLinkCopyTag,
                    isAuthUrlCopied && styles.authLinkCopyTagSuccess
                  )}
                >
                  {isAuthUrlCopied ? 'Copied' : 'Copy'}
                </span>
              </button>
            )}
          </div>

          {(onRemoveAccount || (canMovePool && acc.canSwitchPool !== false)) && (
            <div {...stylex.props(styles.accountActionsRow)}>
              <div {...stylex.props(styles.accountActionsLeft)} />
              <div {...stylex.props(styles.accountActionsRight)}>
                {canMovePool && acc.canSwitchPool !== false && (
                  <button
                    type="button"
                    {...stylex.props(styles.miniSyncBtn)}
                    onClick={() => onOpenMovePool?.(acc)}
                  >
                    Move pool
                  </button>
                )}
                {onRemoveAccount && (
                  <button
                    type="button"
                    {...stylex.props(styles.miniDangerBtn)}
                    onClick={() => onRemoveAccount(acc)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {acc.authorized && (
        <>
          <div {...stylex.props(styles.storageSection)}>
            <div {...stylex.props(styles.storageHeaderRow)}>
              <span {...stylex.props(styles.storageLabel)}>
                <IconFolder size={11} />
                Storage
              </span>
              <span
                {...stylex.props(styles.storageValueText)}
                title={`${headroomGb} GB free · ${driveUsedGb} GB total in Drive`}
              >
                {tsubasaUsedGb} / {capacityGb} GB ({usedPct}%)
              </span>
            </div>

            <div {...stylex.props(styles.progressBarContainer)}>
              <div
                {...stylex.props(
                  styles.progressBarFill,
                  isBreached && styles.progressBarBreach,
                  styles.progressScale(Math.min(100, Math.max(0, usedPct)) / 100)
                )}
              />
            </div>

            {hasNonTsubasaData && (
              <div {...stylex.props(styles.externalDriveRow)}>
                <span {...stylex.props(styles.externalDriveText)}>
                  ({nonTsubasaGb} GB already used in Drive)
                </span>
              </div>
            )}
          </div>

          <AccountTransferGauge stats={acc.transferStats} onTimerExpired={onRefreshStorage} />

          <div {...stylex.props(styles.accountActionsRow)}>
            <div {...stylex.props(styles.accountActionsLeft)}>
              {!isSharePool && hasActionableChanges && onOpenExternalChanges && (
                <button
                  type="button"
                  {...stylex.props(styles.miniChangesBtnRed)}
                  onClick={() => onOpenExternalChanges(acc.id)}
                >
                  Changes
                </button>
              )}
            </div>
            <div {...stylex.props(styles.accountActionsRight)}>
              {canMovePool && acc.canSwitchPool !== false && (
                <button
                  type="button"
                  {...stylex.props(styles.miniSyncBtn)}
                  onClick={() => onOpenMovePool?.(acc)}
                >
                  Move pool
                </button>
              )}
              {acc.isDisabled && onEnableAccount && (
                <button
                  type="button"
                  {...stylex.props(styles.miniEnableBtn)}
                  onClick={() => onEnableAccount(acc.id)}
                  title="Include in storage pool"
                >
                  Enable
                </button>
              )}
              {acc.authorized && !acc.isDisabled && onDisableAccount && (
                <button
                  type="button"
                  {...stylex.props(styles.miniSyncBtn)}
                  onClick={() => onDisableAccount(acc)}
                  title="Exclude from storage pool"
                >
                  Disable
                </button>
              )}
              {onRemoveAccount && (
                <button
                  type="button"
                  {...stylex.props(styles.miniDangerBtn)}
                  onClick={() => onRemoveAccount(acc)}
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {isBreached && hasPoolFiles && (
            <div {...stylex.props(styles.breachNotice)}>
              750 MB buffer breached ({driveUsedGb} GB).
            </div>
          )}
        </>
      )}
    </div>
  );
}
