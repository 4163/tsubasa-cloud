import React, { useState, useMemo, useRef, useEffect } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import { IconFolder, IconTrash, IconPlus, IconClock } from './Icons';
import { AccountAvatar } from './AccountAvatar.js';
import brandLogo from '../assets/brand-mono.png';

export interface AccountTransferStats {
  accountId: string;
  rollingWindowMs: number;
  uploadedBytes24h: number;
  remainingUploadBytes24h: number;
  dailyUploadLimitBytes: number;
  isUploadRateLimited: boolean;
  downloadedBytes24h: number;
  oldestTransferTimestamp: number | null;
  latestTransferTimestamp: number | null;
  nextResetMs: number | null;
  fullResetMs: number | null;
  nextExpiringBytes: number | null;
  activeTransferCount24h: number;
}

export interface ClusterTransferOverview {
  totalUploadedBytes24h: number;
  totalRemainingUploadBytes24h: number;
  dailyUploadLimitBytes: number;
  rateLimitedAccountsCount: number;
}

export interface AccountItem {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  usableLimitBytes: number;
  headroomBytes: number;
  tsubasaUsedBytes?: number;
  syncState: string;
  isDisabled?: boolean;
  authorized: boolean;
  transferStats?: AccountTransferStats;
  hasPendingChanges?: boolean;
  hasDiscrepancy?: boolean;
  mtimeMs?: number;
}

interface SidebarProps {
  accounts: AccountItem[];
  tsubasaUsedBytes: number;
  poolHeadroomBytes: number;
  totalLimitBytes: number;
  clusterTransfer?: ClusterTransferOverview;
  currentNav: 'files' | 'trash';
  onSelectNav: (nav: 'files' | 'trash') => void;
  onAuthorizeAccount: (id: string) => void;
  onOpenExternalChanges?: (id: string) => void;
  onImportOAuth?: (file: File) => void;
  onRefreshStorage?: () => void;
  onDisableAccount?: (account: AccountItem) => void;
  onEnableAccount?: (accountId: string) => void;
  onRemoveAccount?: (account: AccountItem) => void;
  isImporting?: boolean;
  isSyncing: boolean;
  isMobileOpen?: boolean;
  onCloseMobile?: () => void;
}

const styles = stylex.create({
  sidebar: {
    width: layout.sidebarWidth,
    height: '100%',
    backgroundColor: colors.surface,
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    overflow: 'hidden',
    flexShrink: 0,
    zIndex: 20,
    '@media (max-width: 768px)': {
      position: 'fixed',
      top: 0,
      left: 0,
      bottom: 0,
      width: '300px',
      borderRightWidth: '1px',
      borderRightStyle: 'solid',
      borderRightColor: colors.border,
      transform: 'translateX(-100%)',
      transition: 'transform 0.25s ease-out',
    },
  },
  sidebarOpen: {
    '@media (max-width: 768px)': {
      transform: 'translateX(0)',
    },
  },
  backdrop: {
    display: 'none',
    '@media (max-width: 768px)': {
      display: 'block',
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      zIndex: 19,
    },
  },
  brandHeader: {
    padding: spacing.space6,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    flexShrink: 0,
  },
  brandRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space4,
  },
  brandLogoContainer: {
    width: '40px',
    height: '40px',
    aspectRatio: '1 / 1',
    borderRadius: radius.pill,
    backgroundColor: colors.accentGold,
    position: 'relative',
    flexShrink: 0,
  },
  brandLogoImage: {
    position: 'absolute',
    bottom: 0,
    left: '50%',
    transform: 'translateX(-50%)',
    width: '100%',
    height: 'auto',
    display: 'block',
    pointerEvents: 'none',
    userSelect: 'none',
  },
  brandTitleGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  brandWordmark: {
    fontFamily: typography.fontFamilyBrand,
    fontSize: typography.fontSizeBrand,
    fontWeight: typography.fontWeightBrand,
    color: colors.primaryText,
    letterSpacing: '0.02em',
    margin: 0,
    lineHeight: '1.2',
  },
  brandSubtitle: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontFamily: typography.fontFamilyBody,
    lineHeight: '1.3',
  },
  navSection: {
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: '0px',
    paddingRight: '0px',
    display: 'flex',
    flexDirection: 'column',
    gap: '0px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space4,
    borderRadius: '0px',
    backgroundColor: 'transparent',
    borderTopWidth: '0px',
    borderRightWidth: '0px',
    borderBottomWidth: '0px',
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'transparent',
    color: colors.secondaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    cursor: 'pointer',
    width: '100%',
    boxSizing: 'border-box',
    textAlign: 'left',
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
  navItemActive: {
    backgroundColor: colors.selectionBg,
    color: colors.primaryText,
    fontWeight: typography.fontWeightTitle,
    borderLeftColor: colors.accentGold,
    ':hover': {
      backgroundColor: colors.selectionBg,
      color: colors.primaryText,
    },
  },
  navIcon: {
    width: '18px',
    height: '18px',
  },
  sectionHeading: {
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightSection,
    color: colors.dimText,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    marginTop: spacing.space4,
    marginBottom: spacing.space2,
  },
  addAccountWrapper: {
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    marginBottom: spacing.space2,
  },
  addAccountButton: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    paddingTop: '8px',
    paddingBottom: '8px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    backgroundColor: 'transparent',
    color: colors.primaryText,
    cursor: 'pointer',
    textAlign: 'left',
    boxSizing: 'border-box',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.brandAccent,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
    ':disabled': {
      opacity: 0.6,
      cursor: 'not-allowed',
    },
  },
  addAccountIconCircle: {
    width: '30px',
    height: '30px',
    borderRadius: radius.pill,
    borderWidth: '1px',
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: colors.primaryText,
    transition: motion.transitionFast,
  },
  addAccountTextCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    flex: 1,
  },
  addAccountLabel: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '600',
    color: colors.primaryText,
    lineHeight: '1.2',
  },
  addAccountSub: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    color: colors.secondaryText,
    lineHeight: '1.2',
  },
  emptyNotice: {
    fontSize: '11px',
    color: colors.dimText,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    marginBottom: spacing.space2,
    fontStyle: 'italic',
  },
  accountsScrollArea: {
    flex: 1,
    overflowY: 'auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  accountsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    paddingBottom: spacing.space3,
  },
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
  accountName: {
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  redactedEmail: {
    fontSize: '10px',
    fontFamily: typography.fontFamilyMono,
    color: colors.secondaryText,
    userSelect: 'text',
    cursor: 'default',
    transition: motion.transitionFast,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    letterSpacing: '0.02em',
    ':hover': {
      color: colors.primaryText,
    },
  },
  redactedEmailRevealed: {
    color: colors.primaryText,
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
  quotaMeterText: {
    fontSize: typography.fontSizeBadge,
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
    height: '100%',
    backgroundColor: colors.brandAccent,
    borderRadius: radius.pill,
    transition: 'width 0.3s ease',
  },
  poolProgressBarFill: {
    height: '100%',
    backgroundColor: colors.poolGold,
    borderRadius: radius.pill,
    transition: 'width 0.3s ease',
  },
  progressBarWarning: {
    backgroundColor: colors.warning,
  },
  progressBarBreach: {
    backgroundColor: colors.danger,
  },
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
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
    },
  },
  miniSyncBtn: {
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
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.surface,
      borderColor: colors.brandAccent,
      color: colors.brandAccent,
    },
  },
  miniEnableBtn: {
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
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.successSurface,
      borderColor: colors.success,
    },
  },
  miniDangerBtn: {
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
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
    },
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
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.border,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
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
  breachNotice: {
    fontSize: '10px',
    color: colors.danger,
    fontWeight: '600',
    lineHeight: '1.2',
  },
  footer: {
    padding: spacing.space4,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    marginTop: 'auto',
    flexShrink: 0,
  },
  footerTitle: {
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightSection,
    color: colors.secondaryText,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  footerStats: {
    fontSize: typography.fontSizeMeta,
    color: colors.primaryText,
    fontVariantNumeric: 'tabular-nums',
    fontWeight: '600',
  },
  footerHeadroom: {
    fontSize: typography.fontSizeBadge,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  footerTransfer: {
    fontSize: '10px',
    color: colors.dimText,
    fontVariantNumeric: 'tabular-nums',
    paddingTop: '4px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
  },
  transferSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    paddingTop: spacing.space1,
    marginTop: '2px',
  },
  transferHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: typography.fontSizeBadge,
  },
  transferLabel: {
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
  transferValueText: {
    fontSize: '10px',
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  transferProgressBarContainer: {
    width: '100%',
    height: '4px',
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    overflow: 'hidden',
  },
  transferProgressBarFill: {
    height: '100%',
    backgroundColor: colors.brandAccent,
    borderRadius: radius.pill,
    transition: 'width 0.3s ease',
  },
  transferProgressBarWarning: {
    backgroundColor: colors.warning,
  },
  transferProgressBarBreach: {
    backgroundColor: colors.danger,
  },
});

export function hasActiveTransferStats(stats?: AccountTransferStats): boolean {
  if (!stats) return false;
  const DAILY_LIMIT = 750 * 1024 * 1024 * 1024;
  const uploaded = stats.uploadedBytes24h ?? 0;
  const remaining = stats.remainingUploadBytes24h ?? DAILY_LIMIT;
  const isRateLimited = stats.isUploadRateLimited || remaining <= 0;
  return uploaded > 0 || isRateLimited;
}

interface AccountTransferGaugeProps {
  stats?: AccountTransferStats;
  onTimerExpired?: () => void;
}

export function AccountTransferGauge({ stats, onTimerExpired }: AccountTransferGaugeProps) {
  const DAILY_LIMIT = 750 * 1024 * 1024 * 1024;
  const uploaded = stats?.uploadedBytes24h ?? 0;
  const remaining = stats?.remainingUploadBytes24h ?? DAILY_LIMIT;
  const isRateLimited = stats?.isUploadRateLimited || remaining <= 0;
  const oldestTs = stats?.oldestTransferTimestamp ?? null;

  const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

  useEffect(() => {
    if (!oldestTs || uploaded === 0) return;

    const delayMs = Math.max(1000, oldestTs + ROLLING_WINDOW_MS - Date.now());
    const timer = setTimeout(() => {
      if (onTimerExpired) onTimerExpired();
    }, delayMs);

    return () => clearTimeout(timer);
  }, [oldestTs, uploaded, onTimerExpired]);

  if (!hasActiveTransferStats(stats)) {
    return null;
  }

  const pct = Math.min(100, Math.max(0, Math.round((uploaded / DAILY_LIMIT) * 100)));
  const uploadedGb = (uploaded / (1024 * 1024 * 1024)).toFixed(1);

  return (
    <div {...stylex.props(styles.transferSection)}>
      <div {...stylex.props(styles.transferHeaderRow)}>
        <span {...stylex.props(styles.transferLabel)}>
          <IconClock size={11} />
          24h quota
        </span>
        <span {...stylex.props(styles.transferValueText)}>
          {uploadedGb} / 750 GB ({pct}%)
        </span>
      </div>

      <div {...stylex.props(styles.transferProgressBarContainer)}>
        <div
          {...stylex.props(
            styles.transferProgressBarFill,
            isRateLimited && styles.transferProgressBarBreach
          )}
          style={{ width: `${isRateLimited ? 100 : pct}%` }}
        />
      </div>
    </div>
  );
}

function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return email;
  const [user, domain] = email.split('@');
  if (!user || user.length <= 4) return email;

  const startCount = user.length >= 8 ? 3 : 2;
  const endCount = user.length >= 6 ? 2 : 1;
  const dotCount = Math.max(1, user.length - startCount - endCount);

  const start = user.slice(0, startCount);
  const end = user.slice(user.length - endCount);
  const dots = '•'.repeat(dotCount);

  return `${start}${dots}${end}@${domain}`;
}

function isNodeSelected(el: HTMLElement | null): boolean {
  if (!el || typeof window === 'undefined') return false;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;

  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if ((anchor && el.contains(anchor)) || (focus && el.contains(focus))) {
    return true;
  }
  if (typeof selection.containsNode === 'function') {
    return selection.containsNode(el, true);
  }
  return false;
}

function RedactedEmail({ email }: { email: string }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isSelected, setIsSelected] = useState(false);
  const masked = useMemo(() => maskEmail(email), [email]);

  useEffect(() => {
    const handleSelectionChange = () => {
      const selected = isNodeSelected(spanRef.current);
      setIsSelected((prev) => (prev !== selected ? selected : prev));
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, []);

  const isRevealed = isHovered || isSelected;

  return (
    <span
      ref={spanRef}
      {...stylex.props(styles.redactedEmail, isRevealed && styles.redactedEmailRevealed)}
      onMouseEnter={() => {
        setIsHovered(true);
        if (spanRef.current) {
          setIsSelected(isNodeSelected(spanRef.current));
        }
      }}
      onMouseLeave={() => {
        setIsHovered(false);
        if (spanRef.current) {
          setIsSelected(isNodeSelected(spanRef.current));
        }
      }}
    >
      {isRevealed ? email : masked}
    </span>
  );
}

export function Sidebar({
  accounts,
  tsubasaUsedBytes,
  poolHeadroomBytes,
  totalLimitBytes,
  clusterTransfer,
  currentNav,
  onSelectNav,
  onAuthorizeAccount,
  onOpenExternalChanges,
  onImportOAuth,
  onRefreshStorage,
  onDisableAccount,
  onEnableAccount,
  onRemoveAccount,
  isImporting = false,
  isSyncing,
  isMobileOpen = false,
  onCloseMobile,
}: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [authUrls, setAuthUrls] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    for (const acc of accounts) {
      if (!acc.authorized && !authUrls[acc.id]) {
        fetch(`/api/accounts/auth-url/${encodeURIComponent(acc.id)}`)
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data?.url) {
              setAuthUrls((prev) => ({ ...prev, [acc.id]: data.url }));
            }
          })
          .catch(() => {});
      }
    }
  }, [accounts, authUrls]);

  const handleCopyAuthUrl = async (accountId: string) => {
    let url = authUrls[accountId];
    if (!url) {
      try {
        const res = await fetch(`/api/accounts/auth-url/${encodeURIComponent(accountId)}`);
        if (res.ok) {
          const data = await res.json();
          url = data.url;
          setAuthUrls((prev) => ({ ...prev, [accountId]: data.url }));
        }
      } catch {}
    }

    if (url) {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedId(accountId);
      setTimeout(() => {
        setCopiedId((prev) => (prev === accountId ? null : prev));
      }, 3000);
      onAuthorizeAccount?.(accountId);
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onImportOAuth) {
      onImportOAuth(file);
    }
    e.target.value = '';
  };

  const formatGb = (bytes: number) => (bytes / (1024 * 1024 * 1024)).toFixed(2);

  const authorizedAccounts = accounts.filter((a) => a.authorized);
  const authorizedCount = authorizedAccounts.length;

  const poolCapacityBytes = tsubasaUsedBytes + poolHeadroomBytes;
  const tsubasaUsedGb = formatGb(tsubasaUsedBytes);
  const poolCapacityGb = formatGb(poolCapacityBytes);
  const poolHeadroomGb = formatGb(poolHeadroomBytes);

  const poolPercentage = poolCapacityBytes > 0
    ? Math.min(100, Math.round((tsubasaUsedBytes / poolCapacityBytes) * 100))
    : 0;

  return (
    <>
      {isMobileOpen && <div {...stylex.props(styles.backdrop)} onClick={onCloseMobile} />}
      <aside {...stylex.props(styles.sidebar, isMobileOpen && styles.sidebarOpen)}>
        <div {...stylex.props(styles.brandHeader)}>
          <div {...stylex.props(styles.brandRow)}>
            <div {...stylex.props(styles.brandLogoContainer)}>
              <img src={brandLogo} alt="Tsubasa" draggable={false} {...stylex.props(styles.brandLogoImage)} />
            </div>
            <div {...stylex.props(styles.brandTitleGroup)}>
              <h1 {...stylex.props(styles.brandWordmark)}>Tsubasa~</h1>
              <div {...stylex.props(styles.brandSubtitle)}>Pooled Google Drive Cluster</div>
            </div>
          </div>
        </div>

        <nav aria-label="Main Navigation" {...stylex.props(styles.navSection)}>
          <button
            type="button"
            {...stylex.props(styles.navItem, currentNav === 'files' && styles.navItemActive)}
            onClick={() => onSelectNav('files')}
          >
            <IconFolder {...stylex.props(styles.navIcon)} />
            All files
          </button>

          <button
            type="button"
            {...stylex.props(styles.navItem, currentNav === 'trash' && styles.navItemActive)}
            onClick={() => onSelectNav('trash')}
          >
            <IconTrash {...stylex.props(styles.navIcon)} />
            Trash
          </button>
        </nav>

        <div {...stylex.props(styles.accountsScrollArea)}>
          <div {...stylex.props(styles.sectionHeading)}>
            Connected accounts ({authorizedCount})
          </div>

        {onImportOAuth && (
          <div {...stylex.props(styles.addAccountWrapper)}>
            <button
              type="button"
              {...stylex.props(styles.addAccountButton)}
              onClick={handleImportClick}
              disabled={isImporting}
              aria-label="Add account"
            >
              <div {...stylex.props(styles.addAccountIconCircle)}>
                <IconPlus size={14} strokeWidth={2.5} />
              </div>
              <div {...stylex.props(styles.addAccountTextCol)}>
                <span {...stylex.props(styles.addAccountLabel)}>
                  {isImporting ? 'Inspecting credential...' : 'Add account'}
                </span>
                <span {...stylex.props(styles.addAccountSub)}>
                  Import OAuth credentials
                </span>
              </div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>
        )}

        {accounts.length === 0 && (
          <div {...stylex.props(styles.emptyNotice)}>
            No accounts connected yet. Add an account to begin pooling storage.
          </div>
        )}

        <div {...stylex.props(styles.accountsList)}>
          {accounts.map((acc, index) => {
            const tsubasaUsedBytes = acc.tsubasaUsedBytes ?? 0;
            const accountCapacityBytes = tsubasaUsedBytes + acc.headroomBytes;
            const tsubasaUsedGb = formatGb(tsubasaUsedBytes);
            const capacityGb = formatGb(accountCapacityBytes);
            const headroomGb = formatGb(acc.headroomBytes);
            const driveUsedGb = formatGb(acc.quotaUsedBytes);
            const nonTsubasaBytes = Math.max(0, acc.quotaUsedBytes - tsubasaUsedBytes);
            const nonTsubasaGb = formatGb(nonTsubasaBytes);
            const hasNonTsubasaData = nonTsubasaBytes > 10 * 1024 * 1024; // > 10 MB
            const isBreached = acc.quotaUsedBytes > acc.usableLimitBytes;
            const hasPoolFiles = tsubasaUsedBytes > 0;
            const canRebalance = isBreached && hasPoolFiles;
            const hasActionableChanges = Boolean(canRebalance || acc.hasPendingChanges);
            const usedPct = isBreached
              ? 100
              : accountCapacityBytes > 0
                ? Math.min(100, Math.max(0, Math.round((tsubasaUsedBytes / accountCapacityBytes) * 100)))
                : 0;

            return (
              <div key={acc.id} {...stylex.props(styles.accountCard)}>
                <div {...stylex.props(styles.accountTop)}>
                  <div {...stylex.props(styles.accountNameGroup)}>
                    <AccountAvatar
                      avatarUrl={acc.avatarUrl}
                      displayName={acc.displayName}
                      email={acc.email}
                      index={index}
                    />
                    <div {...stylex.props(styles.accountTextGroup)}>
                      <span {...stylex.props(styles.accountName)}>
                        {acc.displayName || acc.id}
                      </span>
                      <RedactedEmail email={acc.email || acc.id} />
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {acc.isDisabled ? (
                      <span {...stylex.props(styles.disabledPill)}>Disabled</span>
                    ) : isBreached ? (
                      <span {...stylex.props(styles.fullPill)}>Full</span>
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
                        <span {...stylex.props(styles.authLinkHelp)}>Click to copy</span>
                      </div>
                      <button
                        type="button"
                        {...stylex.props(
                          styles.authLinkBox,
                          copiedId === acc.id && styles.authLinkBoxCopied
                        )}
                        onClick={() => handleCopyAuthUrl(acc.id)}
                        aria-label="Copy authorize link"
                      >
                        <span {...stylex.props(styles.authLinkText)}>
                          {authUrls[acc.id] || 'Generating authorize link...'}
                        </span>
                        <span
                          {...stylex.props(
                            styles.authLinkCopyTag,
                            copiedId === acc.id && styles.authLinkCopyTagSuccess
                          )}
                        >
                          {copiedId === acc.id ? 'Copied' : 'Copy'}
                        </span>
                      </button>
                    </div>

                    {onRemoveAccount && (
                      <div {...stylex.props(styles.accountActionsRow)}>
                        <div {...stylex.props(styles.accountActionsRight)}>
                          <button
                            type="button"
                            {...stylex.props(styles.miniDangerBtn)}
                            onClick={() => onRemoveAccount(acc)}
                            title="Remove credential file"
                          >
                            Remove
                          </button>
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
                          title={`${headroomGb} GB free headroom remaining (${driveUsedGb} GB total Drive usage)`}
                        >
                          {tsubasaUsedGb} / {capacityGb} GB ({usedPct}%)
                        </span>
                      </div>

                      <div {...stylex.props(styles.progressBarContainer)}>
                        <div
                          {...stylex.props(
                            styles.progressBarFill,
                            isBreached && styles.progressBarBreach
                          )}
                          style={{ width: `${usedPct}%` }}
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

                    <AccountTransferGauge
                      stats={acc.transferStats}
                      onTimerExpired={onRefreshStorage}
                    />

                    <div {...stylex.props(styles.accountActionsRow)}>
                      <div {...stylex.props(styles.accountActionsLeft)}>
                        {hasActionableChanges && onOpenExternalChanges && (
                          <button
                            type="button"
                            {...stylex.props(styles.miniChangesBtnRed)}
                            onClick={() => onOpenExternalChanges(acc.id)}
                            title="Resolve external modifications or over-ceiling usage"
                          >
                            Changes
                          </button>
                        )}
                      </div>
                      <div {...stylex.props(styles.accountActionsRight)}>
                        {acc.isDisabled && onEnableAccount && (
                          <button
                            type="button"
                            {...stylex.props(styles.miniEnableBtn)}
                            onClick={() => onEnableAccount(acc.id)}
                            title="Re-enable drive in storage pool"
                          >
                            Enable
                          </button>
                        )}
                        {acc.authorized && !acc.isDisabled && onDisableAccount && (
                          <button
                            type="button"
                            {...stylex.props(styles.miniSyncBtn)}
                            onClick={() => onDisableAccount(acc)}
                            title="Disable drive and exclude from storage pool"
                          >
                            Disable
                          </button>
                        )}
                        {onRemoveAccount && (
                          <button
                            type="button"
                            {...stylex.props(styles.miniDangerBtn)}
                            onClick={() => onRemoveAccount(acc)}
                            title="Permanently remove drive and credentials"
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
          })}
        </div>
        </div>

        <div {...stylex.props(styles.footer)}>
          <div {...stylex.props(styles.footerTitle)}>Pooled storage</div>
          <div {...stylex.props(styles.progressBarContainer)}>
            <div
              {...stylex.props(
                styles.poolProgressBarFill,
                poolPercentage >= 100 && styles.progressBarBreach
              )}
              style={{ width: `${poolPercentage}%` }}
            />
          </div>
          <div {...stylex.props(styles.footerStats)}>
            {tsubasaUsedGb} GB used of {poolCapacityGb} GB ({poolPercentage}%)
          </div>
          <div {...stylex.props(styles.footerHeadroom)}>
            {poolHeadroomGb} GB free across {authorizedCount} {authorizedCount === 1 ? 'account' : 'accounts'} (each account has a safety buffer of 750 MB)
          </div>
          {clusterTransfer && clusterTransfer.totalUploadedBytes24h > 0 && (
            <div {...stylex.props(styles.footerTransfer)}>
              24h cluster transfers: {(clusterTransfer.totalUploadedBytes24h / (1024 * 1024 * 1024)).toFixed(1)} / {(clusterTransfer.dailyUploadLimitBytes / (1024 * 1024 * 1024)).toFixed(0)} GB ({Math.round((clusterTransfer.totalUploadedBytes24h / clusterTransfer.dailyUploadLimitBytes) * 100)}%)
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

