import React, { useState, useMemo, useRef, useEffect } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import { IconFolder, IconTrash } from './Icons';
import { AccountAvatar } from './AccountAvatar.js';

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
  authorized: boolean;
}

interface SidebarProps {
  accounts: AccountItem[];
  tsubasaUsedBytes: number;
  poolHeadroomBytes: number;
  totalLimitBytes: number;
  currentNav: 'files' | 'trash';
  onSelectNav: (nav: 'files' | 'trash') => void;
  onAuthorizeAccount: (id: string) => void;
  onSyncAccount: (id: string) => void;
  onOpenExternalChanges?: (id: string) => void;
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
    overflowY: 'auto',
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
  },
  brandRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brandWordmark: {
    fontFamily: typography.fontFamilyBrand,
    fontSize: typography.fontSizeBrand,
    fontWeight: typography.fontWeightBrand,
    color: colors.primaryText,
    letterSpacing: '0.02em',
    margin: 0,
    userSelect: 'none',
  },
  badgeRetro: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    backgroundColor: colors.selectionBg,
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
  },
  brandSubtitle: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontFamily: typography.fontFamilyBody,
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
  accountsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    flex: 1,
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
  quotaMeterText: {
    fontSize: typography.fontSizeBadge,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  progressBarContainer: {
    width: '100%',
    height: '4px',
    borderRadius: radius.pill,
    backgroundColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    transition: 'width 0.3s ease',
  },
  progressBarBreach: {
    backgroundColor: colors.danger,
  },
  externalDriveText: {
    fontSize: '10px',
    color: colors.dimText,
    fontVariantNumeric: 'tabular-nums',
  },
  accountActionsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
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
    color: colors.secondaryText,
    cursor: 'pointer',
    ':hover': {
      backgroundColor: colors.surface,
      color: colors.primaryText,
    },
  },
  authPill: {
    fontSize: typography.fontSizeBadge,
    color: colors.success,
    fontWeight: '600',
  },
  pendingPill: {
    fontSize: typography.fontSizeBadge,
    color: colors.warning,
    cursor: 'pointer',
    textDecoration: 'underline',
    backgroundColor: 'transparent',
    borderWidth: '0px',
    padding: '0',
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
  },
  footerTitle: {
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightSection,
    color: colors.dimText,
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
});

export function maskEmail(email: string): string {
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
  currentNav,
  onSelectNav,
  onAuthorizeAccount,
  onSyncAccount,
  onOpenExternalChanges,
  isSyncing,
  isMobileOpen = false,
  onCloseMobile,
}: SidebarProps) {
  const formatGb = (bytes: number) => (bytes / (1024 * 1024 * 1024)).toFixed(2);

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
            <h1 {...stylex.props(styles.brandWordmark)}>Tsubasa~</h1>
            <span {...stylex.props(styles.badgeRetro)}>v0.1.0</span>
          </div>
          <div {...stylex.props(styles.brandSubtitle)}>Pooled Google Drive Cluster</div>
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

        <div {...stylex.props(styles.sectionHeading)}>Connected accounts ({accounts.length})</div>

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

                  {acc.authorized ? (
                    <span {...stylex.props(styles.authPill)}>Active</span>
                  ) : (
                    <button
                      type="button"
                      {...stylex.props(styles.pendingPill)}
                      onClick={() => onAuthorizeAccount(acc.id)}
                    >
                      Authorize
                    </button>
                  )}
                </div>

                <div {...stylex.props(styles.progressBarContainer)}>
                  <div
                    {...stylex.props(styles.progressBarFill, isBreached && styles.progressBarBreach)}
                    style={{ width: `${usedPct}%` }}
                  />
                </div>

                <div {...stylex.props(styles.accountActionsRow)}>
                  <span
                    {...stylex.props(styles.quotaMeterText)}
                    title={`${headroomGb} GB free headroom remaining (${driveUsedGb} GB total Drive usage)`}
                  >
                    {tsubasaUsedGb} / {capacityGb} GB ({usedPct}%)
                  </span>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {acc.authorized && onOpenExternalChanges && (
                      <button
                        type="button"
                        {...stylex.props(styles.miniSyncBtn)}
                        onClick={() => onOpenExternalChanges(acc.id)}
                        title="Check external modifications"
                      >
                        Changes
                      </button>
                    )}

                    {acc.authorized && (
                      <button
                        type="button"
                        {...stylex.props(styles.miniSyncBtn)}
                        onClick={() => onSyncAccount(acc.id)}
                        disabled={isSyncing}
                      >
                        Sync
                      </button>
                    )}
                  </div>
                </div>

                {hasNonTsubasaData && (
                  <div {...stylex.props(styles.externalDriveText)}>
                    ({nonTsubasaGb} GB already used in Drive)
                  </div>
                )}

                {isBreached && (
                  <div {...stylex.props(styles.breachNotice)}>
                    750 MB buffer breached ({driveUsedGb} GB). Writes locked.
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div {...stylex.props(styles.footer)}>
          <div {...stylex.props(styles.footerTitle)}>Pooled storage</div>
          <div {...stylex.props(styles.progressBarContainer)}>
            <div {...stylex.props(styles.progressBarFill)} style={{ width: `${poolPercentage}%` }} />
          </div>
          <div {...stylex.props(styles.footerStats)}>
            {tsubasaUsedGb} GB used of {poolCapacityGb} GB ({poolPercentage}%)
          </div>
          <div {...stylex.props(styles.footerHeadroom)}>
            {poolHeadroomGb} GB free across {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'} (each account has a safety buffer of 750 MB)
          </div>
        </div>
      </aside>
    </>
  );
}

