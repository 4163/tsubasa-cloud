import React, { useState, useMemo, useRef, useEffect } from 'react';
import * as stylex from '@stylexjs/stylex';
import { client } from '../api.js';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import { IconFolder, IconTrash, IconPlus, IconClock, IconEdit, IconChevronDown, IconFunnel, IconFunnelX } from './Icons.js';
import { AccountAvatar } from './AccountAvatar.js';
import { RedactedEmail } from './RedactedEmail.js';
import { sortPools, copyTextToClipboard } from '../utils/format.js';
import { useMediaQuery } from '../utils/useBeforeUnload.js';
import { rejectInvalidInternalDragOver, parseInternalDropItems, markDropHandled } from '../utils/virtualPath.js';
import { DAILY_UPLOAD_LIMIT_BYTES, formatGbCompact } from '../utils/accountTransfer.js';
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

export interface PoolSummary {
  id: number;
  name: string;
  driveFolderName: string;
  accountCount: number;
  fileCount: number;
  totalBytes: number;
  isSharePool?: boolean;
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
  poolId?: number;
  canSwitchPool?: boolean;
  fileCount?: number;
}

interface SidebarProps {
  accounts: AccountItem[];
  tsubasaUsedBytes: number;
  poolHeadroomBytes: number;
  clusterTransfer?: ClusterTransferOverview;
  pools?: PoolSummary[];
  activePoolId?: number;
  onSelectPool?: (poolId: number) => void;
  onCreatePool?: () => void;
  onRenamePoolPrompt?: (pool: PoolSummary) => void;
  onDeletePoolPrompt?: (pool: PoolSummary) => void;
  onSwitchAccountPool?: (accountId: string, targetPoolId: number) => void;
  onOpenMovePool?: (account: AccountItem) => void;
  currentNav: 'files' | 'trash';
  onSelectNav: (nav: 'files' | 'trash') => void;
  onOpenExternalChanges?: (id: string) => void;
  onImportOAuth?: (file: File) => void;
  onRefreshStorage?: () => void;
  onDisableAccount?: (account: AccountItem) => void;
  onEnableAccount?: (accountId: string) => void;
  onRemoveAccount?: (account: AccountItem) => void;
  isImporting?: boolean;
  isSyncing: boolean;
  isMobileOpen?: boolean;
  isDimmed?: boolean;
  onCloseMobile?: () => void;
  onDropItemsToRoot?: (items: Array<{ kind: 'file' | 'folder'; id: string; name?: string; virtualPath?: string; isTrashed?: boolean }>) => void;
  onDropItemsToTrash?: (items: Array<{ kind: 'file' | 'folder'; id: string; name?: string; virtualPath?: string; isTrashed?: boolean }>) => void;
  onDropExternalToRoot?: (dataTransfer: DataTransfer) => void;
  filteredAccountIds?: Set<string>;
  onToggleAccountFilter?: (accountId: string) => void;
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
    contain: 'layout style paint',
  },
  mobileDialog: {
    position: 'fixed',
    inset: '0 auto 0 0',
    margin: 0,
    padding: 0,
    borderWidth: '0px',
    backgroundColor: 'transparent',
    width: '300px',
    maxWidth: '85vw',
    height: '100dvh',
    maxHeight: '100dvh',
    overflow: 'hidden',
    outline: 'none',
    '::backdrop': {
      backgroundColor: colors.modalBackdrop,
    },
  },
  mobileDialogAside: {
    width: '100%',
    height: '100%',
    backgroundColor: colors.surface,
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: colors.border,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  mobileDimScrim: {
    position: 'absolute',
    inset: 0,
    backgroundColor: colors.modalBackdrop,
    pointerEvents: 'none',
    zIndex: 10000,
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
  poolSection: {
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    flexShrink: 0,
  },
  poolHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
  },
  poolHeadingLabel: {
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightSection,
    color: colors.dimText,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  poolHeaderActions: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space1,
  },
  poolActionBtn: {
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
    fontWeight: '600',
    color: colors.secondaryText,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.brandAccent,
      color: colors.primaryText,
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
  poolDeleteBtn: {
    ':hover': {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
      color: colors.danger,
    },
  },
  poolSelectWrapper: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    width: '100%',
  },
  poolSelect: {
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    width: '100%',
    height: '32px',
    paddingLeft: spacing.space3,
    paddingRight: '28px',
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    outline: 'none',
    boxSizing: 'border-box',
    transitionProperty: 'background-color, opacity',
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easingOut,
    ':hover': {
      borderColor: colors.accentGold,
    },
    ':focus': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
    ':focus-visible': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
  },
  poolSelectChevron: {
    position: 'absolute',
    right: '8px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: colors.secondaryText,
    display: 'flex',
    alignItems: 'center',
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
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
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
  navItemDragOver: {
    backgroundColor: colors.brandAccentSurface,
    color: colors.brandAccent,
    borderLeftColor: colors.accentGold,
    ':hover': {
      backgroundColor: colors.brandAccentSurface,
      color: colors.brandAccent,
    },
  },
  navItemDragOverTrash: {
    backgroundColor: colors.dangerSurface,
    color: colors.danger,
    borderLeftColor: colors.danger,
    ':hover': {
      backgroundColor: colors.dangerSurface,
      color: colors.danger,
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
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.brandAccent,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
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
  poolProgressBarFill: {
    width: '100%',
    height: '100%',
    backgroundColor: colors.poolGold,
    borderRadius: radius.pill,
    transformOrigin: 'left center',
    transition: 'transform 0.3s ease',
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
    width: '100%',
    height: '100%',
    backgroundColor: colors.brandAccent,
    borderRadius: radius.pill,
    transformOrigin: 'left center',
    transition: 'transform 0.3s ease',
  },
  transferProgressBarBreach: {
    backgroundColor: colors.danger,
  },
  hiddenInput: {
    display: 'none',
  },
  accountStatusGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
  progressScale: (scale: number) => ({
    transform: `scaleX(${scale})`,
  }),
});

export function hasActiveTransferStats(stats?: AccountTransferStats): boolean {
  if (!stats) return false;
  const uploaded = stats.uploadedBytes24h ?? 0;
  const remaining = stats.remainingUploadBytes24h ?? DAILY_UPLOAD_LIMIT_BYTES;
  const isRateLimited = stats.isUploadRateLimited || remaining <= 0;
  return uploaded > 0 || isRateLimited;
}

interface AccountTransferGaugeProps {
  stats?: AccountTransferStats;
  onTimerExpired?: () => void;
}

export function AccountTransferGauge({ stats, onTimerExpired }: AccountTransferGaugeProps) {
  const uploaded = stats?.uploadedBytes24h ?? 0;
  const remaining = stats?.remainingUploadBytes24h ?? DAILY_UPLOAD_LIMIT_BYTES;
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

  const pct = Math.min(100, Math.max(0, Math.round((uploaded / DAILY_UPLOAD_LIMIT_BYTES) * 100)));
  const uploadedGb = formatGbCompact(uploaded);

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
            isRateLimited && styles.transferProgressBarBreach,
            styles.progressScale((isRateLimited ? 100 : pct) / 100)
          )}
        />
      </div>
    </div>
  );
}

export function Sidebar({
  accounts,
  tsubasaUsedBytes,
  poolHeadroomBytes,
  clusterTransfer,
  pools,
  activePoolId = 1,
  onSelectPool,
  onCreatePool,
  onRenamePoolPrompt,
  onDeletePoolPrompt,
  onSwitchAccountPool,
  onOpenMovePool,
  currentNav,
  onSelectNav,
  onOpenExternalChanges,
  onImportOAuth,
  onRefreshStorage,
  onDisableAccount,
  onEnableAccount,
  onRemoveAccount,
  isImporting = false,
  isSyncing,
  isMobileOpen = false,
  isDimmed = false,
  onCloseMobile,
  onDropItemsToRoot,
  onDropItemsToTrash,
  onDropExternalToRoot,
  filteredAccountIds,
  onToggleAccountFilter,
}: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [authUrls, setAuthUrls] = useState<Record<string, string>>({});
  const authUrlsRef = useRef(authUrls);
  authUrlsRef.current = authUrls;
  const [authUrlErrors, setAuthUrlErrors] = useState<Record<string, boolean>>({});
  const authUrlErrorsRef = useRef(authUrlErrors);
  authUrlErrorsRef.current = authUrlErrors;
  const pendingAuthRequestsRef = useRef<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragOverNav, setDragOverNav] = useState<'files' | 'trash' | null>(null);
  const isMobileViewport = useMediaQuery('(max-width: 768px)');
  const mobileDialogRef = useRef<HTMLDialogElement>(null);
  const mobilePointerDownOutsideRef = useRef(false);

  useEffect(() => {
    const dialog = mobileDialogRef.current;
    if (!dialog) return;

    if (isMobileViewport && isMobileOpen) {
      dialog.removeAttribute('data-closing');
      dialog.setAttribute('closedby', 'any');
      if (!dialog.open) {
        dialog.showModal();
      }
      return;
    }

    if (!dialog.open) return;

    const skipExitAnimation =
      !isMobileViewport ||
      document.body.classList.contains('resize-animation-stopper') ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (skipExitAnimation) {
      dialog.removeAttribute('data-closing');
      dialog.close();
      return;
    }

    if (dialog.hasAttribute('data-closing')) return;
    dialog.setAttribute('data-closing', '');

    let cancelled = false;
    const animations = dialog.getAnimations();
    Promise.all(animations.map((anim) => anim.finished.catch(() => {}))).then(() => {
      if (cancelled || !dialog.hasAttribute('data-closing')) return;
      dialog.removeAttribute('data-closing');
      if (dialog.open) {
        dialog.close();
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isMobileViewport, isMobileOpen]);

  useEffect(() => {
    const handleDragEnd = () => setDragOverNav(null);
    const handleWindowDragLeave = (e: DragEvent) => {
      if (
        !e.relatedTarget ||
        e.clientX <= 0 ||
        e.clientY <= 0 ||
        e.clientX >= window.innerWidth ||
        e.clientY >= window.innerHeight
      ) {
        setDragOverNav(null);
      }
    };
    window.addEventListener('dragend', handleDragEnd);
    window.addEventListener('dragleave', handleWindowDragLeave);
    return () => {
      window.removeEventListener('dragend', handleDragEnd);
      window.removeEventListener('dragleave', handleWindowDragLeave);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    for (const acc of accounts) {
      if (
        !acc.authorized &&
        !authUrlsRef.current[acc.id] &&
        !authUrlErrorsRef.current[acc.id] &&
        !pendingAuthRequestsRef.current.has(acc.id)
      ) {
        pendingAuthRequestsRef.current.add(acc.id);
        client.api.accounts['auth-url'][':id']
          .$get({ param: { id: acc.id }, query: {} })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data && 'url' in data && data.url) {
              setAuthUrls((prev) => (prev[acc.id] === data.url ? prev : { ...prev, [acc.id]: data.url }));
              setAuthUrlErrors((prev) => (prev[acc.id] ? { ...prev, [acc.id]: false } : prev));
            } else {
              setAuthUrlErrors((prev) => (prev[acc.id] ? prev : { ...prev, [acc.id]: true }));
            }
          })
          .catch(() => {
            setAuthUrlErrors((prev) => (prev[acc.id] ? prev : { ...prev, [acc.id]: true }));
          })
          .finally(() => {
            pendingAuthRequestsRef.current.delete(acc.id);
          });
      }
    }
  }, [accounts]);

  const handleCopyAuthUrl = async (accountId: string) => {
    let url = authUrls[accountId];
    if (!url) {
      setAuthUrlErrors((prev) => (prev[accountId] ? { ...prev, [accountId]: false } : prev));
      try {
        const res = await client.api.accounts['auth-url'][':id'].$get({
          param: { id: accountId },
          query: {},
        });
        if (res.ok) {
          const data = await res.json();
          if ('url' in data && data.url) {
            url = data.url;
            setAuthUrls((prev) => ({ ...prev, [accountId]: data.url }));
          } else {
            setAuthUrlErrors((prev) => ({ ...prev, [accountId]: true }));
          }
        } else {
          setAuthUrlErrors((prev) => ({ ...prev, [accountId]: true }));
        }
      } catch (err) {
        setAuthUrlErrors((prev) => ({ ...prev, [accountId]: true }));
        if (import.meta.env.DEV) {
          console.error('[tsubasa] fetch auth URL failed:', err);
        }
      }
    }

    if (url) {
      const copied = await copyTextToClipboard(url);
      if (!copied) return;
      setCopiedId(accountId);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopiedId((prev) => (prev === accountId ? null : prev));
      }, 3000);
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

  const sortedPools = useMemo(() => (pools ? sortPools(pools) : []), [pools]);
  const standardPoolCount = sortedPools.filter((p) => !p.isSharePool).length;
  const activePool = sortedPools.find((p) => p.id === activePoolId) || sortedPools[0];

  const isOutsideMobileDialog = (e: React.PointerEvent<HTMLDialogElement>, dialog: HTMLDialogElement) => {
    const rect = dialog.getBoundingClientRect();
    return (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    );
  };

  const handleMobileDialogPointerDown = (e: React.PointerEvent<HTMLDialogElement>) => {
    if ('closedBy' in HTMLDialogElement.prototype) return;
    mobilePointerDownOutsideRef.current = isOutsideMobileDialog(e, e.currentTarget);
  };

  const handleMobileDialogPointerUp = (e: React.PointerEvent<HTMLDialogElement>) => {
    if ('closedBy' in HTMLDialogElement.prototype) return;
    const startedOutside = mobilePointerDownOutsideRef.current;
    mobilePointerDownOutsideRef.current = false;
    if (startedOutside && isOutsideMobileDialog(e, e.currentTarget)) {
      onCloseMobile?.();
    }
  };

  const handleMobileDialogCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    onCloseMobile?.();
  };

  const handleMobileDialogClose = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.currentTarget.returnValue = '';
    e.currentTarget.removeAttribute('data-closing');
    if (isMobileOpen) {
      onCloseMobile?.();
    }
  };

  const sidebarContent = (
    <>
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

        {sortedPools.length > 0 && (
          <section aria-label="Storage Pool Switcher" {...stylex.props(styles.poolSection)}>
            <div {...stylex.props(styles.poolHeaderRow)}>
              <span {...stylex.props(styles.poolHeadingLabel)}>Storage pool</span>
              <div {...stylex.props(styles.poolHeaderActions)}>
                {activePool && !activePool.isSharePool && onRenamePoolPrompt && (
                  <button
                    type="button"
                    {...stylex.props(styles.poolActionBtn)}
                    onClick={() => onRenamePoolPrompt(activePool)}
                    aria-label="Rename storage pool"
                  >
                    <IconEdit size={11} />
                    <span>Rename</span>
                  </button>
                )}
                {activePool && !activePool.isSharePool && activePool.accountCount === 0 && standardPoolCount > 1 && onDeletePoolPrompt && (
                  <button
                    type="button"
                    {...stylex.props(styles.poolActionBtn, styles.poolDeleteBtn)}
                    onClick={() => onDeletePoolPrompt(activePool)}
                    aria-label="Delete storage pool"
                  >
                    <IconTrash size={11} />
                    <span>Delete</span>
                  </button>
                )}
                {onCreatePool && (
                  <button
                    type="button"
                    {...stylex.props(styles.poolActionBtn)}
                    onClick={onCreatePool}
                    aria-label="Create new storage pool"
                  >
                    <IconPlus size={11} strokeWidth={2.5} />
                    <span>New</span>
                  </button>
                )}
              </div>
            </div>

            <div {...stylex.props(styles.poolSelectWrapper)}>
              <select
                aria-label="Select active storage pool"
                value={activePoolId}
                onChange={(e) => onSelectPool?.(Number(e.target.value))}
                {...stylex.props(styles.poolSelect)}
              >
                {sortedPools.map((pool) => (
                  <option key={pool.id} value={pool.id}>
                    {pool.name} ({pool.accountCount} {pool.accountCount === 1 ? 'Drive' : 'Drives'})
                  </option>
                ))}
              </select>
              <div {...stylex.props(styles.poolSelectChevron)}>
                <IconChevronDown size={14} strokeWidth={2.5} />
              </div>
            </div>
          </section>
        )}

        <nav aria-label="Main Navigation" {...stylex.props(styles.navSection)}>
          <button
            type="button"
            {...stylex.props(
              styles.navItem,
              currentNav === 'files' && styles.navItemActive,
              dragOverNav === 'files' && styles.navItemDragOver
            )}
            onClick={() => onSelectNav('files')}
            onDragOver={(e) => {
              if (activePool?.isSharePool) return;
              if (rejectInvalidInternalDragOver(e, '/', () => setDragOverNav((prev) => (prev === 'files' ? null : prev)))) return;
              const hasItems = e.dataTransfer?.types?.includes('application/x-tsubasa-items');
              const hasFiles = e.dataTransfer?.types?.includes('Files');
              if (hasItems || hasFiles) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = hasItems ? 'move' : 'copy';
                setDragOverNav('files');
              }
            }}
            onDragLeave={(e) => {
              if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOverNav((prev) => (prev === 'files' ? null : prev));
              }
            }}
            onDrop={(e) => {
              if (activePool?.isSharePool) return;
              e.preventDefault();
              e.stopPropagation();
              markDropHandled(e);
              setDragOverNav(null);
              if (e.dataTransfer.types.includes('application/x-tsubasa-items')) {
                const parsed = parseInternalDropItems(e, '/');
                if (parsed) {
                  onDropItemsToRoot?.(parsed);
                }
                return;
              } else if (e.dataTransfer.types.includes('Files') && e.dataTransfer.files.length > 0) {
                onDropExternalToRoot?.(e.dataTransfer);
              }
            }}
          >
            <IconFolder {...stylex.props(styles.navIcon)} />
            All files
          </button>

          <button
            type="button"
            {...stylex.props(
              styles.navItem,
              currentNav === 'trash' && styles.navItemActive,
              dragOverNav === 'trash' && styles.navItemDragOverTrash
            )}
            onClick={() => onSelectNav('trash')}
            onDragOver={(e) => {
              if (currentNav !== 'trash' && e.dataTransfer?.types?.includes('application/x-tsubasa-items')) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                setDragOverNav('trash');
              }
            }}
            onDragLeave={(e) => {
              if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOverNav((prev) => (prev === 'trash' ? null : prev));
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              markDropHandled(e);
              setDragOverNav(null);
              if (currentNav !== 'trash' && e.dataTransfer.types.includes('application/x-tsubasa-items')) {
                try {
                  const raw = e.dataTransfer.getData('application/x-tsubasa-items');
                  const parsed = JSON.parse(raw);
                  if (Array.isArray(parsed) && parsed.length > 0) {
                    onDropItemsToTrash?.(parsed);
                  }
                } catch {}
              }
            }}
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
              {...stylex.props(styles.hiddenInput)}
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
            const isFiltered = Boolean(filteredAccountIds?.has(acc.id));

            return (
              <div
                key={acc.id}
                {...stylex.props(
                  styles.accountCard,
                  isFiltered && styles.accountCardFiltered
                )}
              >
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
                          title={`${acc.displayName || acc.id} (${acc.email || acc.id})`}
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
                            title={isFiltered ? 'Remove filter for this account' : 'Filter files on this account'}
                            aria-label={isFiltered ? `Remove filter for ${acc.displayName || acc.id}` : `Filter files on ${acc.displayName || acc.id}`}
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
                      <span {...stylex.props(styles.disabledPill)} title="Excluded from cluster storage pool">
                        Disabled
                      </span>
                    ) : isBreached ? (
                      <span {...stylex.props(styles.fullPill)} title="Usable limit breached">
                        Full
                      </span>
                    ) : acc.authorized ? (
                      <span {...stylex.props(styles.authPill)}>
                        Active
                      </span>
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
                          {authUrls[acc.id] ||
                            (authUrlErrors[acc.id]
                              ? 'Authorize link unavailable (click to retry)'
                              : 'Generating authorize link...')}
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

                    {(onRemoveAccount || (pools && pools.length > 1 && acc.canSwitchPool !== false)) && (
                      <div {...stylex.props(styles.accountActionsRow)}>
                        <div {...stylex.props(styles.accountActionsLeft)} />
                        <div {...stylex.props(styles.accountActionsRight)}>
                          {pools && pools.length > 1 && acc.canSwitchPool !== false && (
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
                              title="Remove credential file"
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
                          title={`${headroomGb} GB free headroom remaining (${driveUsedGb} GB total Drive usage)`}
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

                    <AccountTransferGauge
                      stats={acc.transferStats}
                      onTimerExpired={onRefreshStorage}
                    />

                    <div {...stylex.props(styles.accountActionsRow)}>
                      <div {...stylex.props(styles.accountActionsLeft)}>
                        {!activePool?.isSharePool && hasActionableChanges && onOpenExternalChanges && (
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
                        {pools && pools.length > 1 && acc.canSwitchPool !== false && (
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
                          >
                            Enable
                          </button>
                        )}
                        {acc.authorized && !acc.isDisabled && onDisableAccount && (
                          <button
                            type="button"
                            {...stylex.props(styles.miniSyncBtn)}
                            onClick={() => onDisableAccount(acc)}
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
                poolPercentage >= 100 && styles.progressBarBreach,
                styles.progressScale(Math.min(100, Math.max(0, poolPercentage)) / 100)
              )}
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
              24h cluster transfers: {formatGbCompact(clusterTransfer.totalUploadedBytes24h)} / {(clusterTransfer.dailyUploadLimitBytes / (1024 * 1024 * 1024)).toFixed(0)} GB ({Math.round((clusterTransfer.totalUploadedBytes24h / clusterTransfer.dailyUploadLimitBytes) * 100)}%)
            </div>
          )}
        </div>
    </>
  );

  if (isMobileViewport) {
    return (
      <dialog
        ref={mobileDialogRef}
        id="mobile-sidebar-dialog"
        data-tsubasa-dialog="drawer-left"
        aria-label="Navigation sidebar"
        onCancel={handleMobileDialogCancel}
        onClose={handleMobileDialogClose}
        onPointerDown={handleMobileDialogPointerDown}
        onPointerUp={handleMobileDialogPointerUp}
        {...stylex.props(styles.mobileDialog)}
      >
        <aside {...stylex.props(styles.mobileDialogAside)}>
          {sidebarContent}
        </aside>
        {isDimmed && <div aria-hidden="true" {...stylex.props(styles.mobileDimScrim)} />}
      </dialog>
    );
  }

  return (
    <aside {...stylex.props(styles.sidebar)}>
      {sidebarContent}
    </aside>
  );
}

