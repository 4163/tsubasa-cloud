import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import { IconFolder, IconTrash, IconPlus, IconAlertTriangle, IconClose } from './Icons.js';
import { RedactedEmail } from './RedactedEmail.js';
import { SidebarAccountCard } from './SidebarAccountCard.js';
import { SidebarPoolSection } from './SidebarPoolSection.js';
import { useDialogLifecycle } from '../hooks/useDialogLifecycle.js';
import { useScrollableKeyboardNav } from '../hooks/useScrollableKeyboardNav.js';
import { sortPools } from '../utils/format.js';
import { useMediaQuery } from '../utils/useBeforeUnload.js';
import { rejectInvalidInternalDragOver, parseInternalDropItems, markDropHandled } from '../utils/virtualPath.js';
import { formatGbCompact } from '../utils/accountTransfer.js';
import brandLogo from '../assets/brand-mono.png';
import type {
  ClusterTransferOverview,
  PoolSummary,
  AccountItem,
} from '../types.js';

export interface SidebarProps {
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
  isMobileOpen?: boolean;
  isDimmed?: boolean;
  onCloseMobile?: () => void;
  onDropItemsToRoot?: (items: Array<{ kind: 'file' | 'folder'; id: string; name?: string; virtualPath?: string; isTrashed?: boolean }>) => void;
  onDropItemsToTrash?: (items: Array<{ kind: 'file' | 'folder'; id: string; name?: string; virtualPath?: string; isTrashed?: boolean }>) => void;
  onDropExternalToRoot?: (dataTransfer: DataTransfer) => void;
  filteredAccountIds?: Set<string>;
  onToggleAccountFilter?: (accountId: string) => void;
  authUrls?: Record<string, string>;
  authUrlErrors?: Record<string, boolean>;
  copiedAuthUrlId?: string | null;
  onCopyAuthUrl?: (accountId: string) => void;
  sidebarError?: string | null;
  onDismissSidebarError?: () => void;
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
  inlineErrorWrapper: {
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    marginBottom: spacing.space2,
  },
  inlineErrorAlert: {
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurface,
    color: colors.dangerTextOnSurface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
    boxSizing: 'border-box',
  },
  inlineErrorContent: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
    flex: 1,
  },
  inlineErrorIcon: {
    flexShrink: 0,
  },
  inlineErrorText: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    lineHeight: typography.lineHeightMeta,
    color: colors.dangerTextOnSurface,
    overflowWrap: 'anywhere',
    minWidth: 0,
    flex: 1,
  },
  inlineErrorEmail: {
    fontSize: typography.fontSizeMeta,
    lineHeight: typography.lineHeightMeta,
    color: colors.dangerTextOnSurface,
    whiteSpace: 'normal',
    overflow: 'visible',
    textOverflow: 'clip',
    overflowWrap: 'anywhere',
  },
  inlineErrorDismissBtn: {
    width: '18px',
    height: '18px',
    padding: '0px',
    borderRadius: radius.compact,
    borderWidth: '0px',
    backgroundColor: {
      default: 'transparent',
      ':hover': {
        default: colors.rowHover,
        '@media (pointer: coarse)': 'transparent',
      },
      ':active': colors.selectionBg,
    },
    color: {
      default: colors.dangerTextOnSurface,
      ':hover': {
        default: colors.primaryText,
        '@media (pointer: coarse)': colors.dangerTextOnSurface,
      },
      ':active': colors.primaryText,
    },
    cursor: 'pointer',
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    transition: {
      default: motion.transitionFast,
      ':active': motion.transitionTap,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    '@media (pointer: coarse)': {
      minWidth: '44px',
      minHeight: '44px',
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
    scrollPaddingTop: spacing.space2,
    scrollPaddingBottom: spacing.space2,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    outline: 'none',
  },
  accountsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    paddingBottom: spacing.space3,
  },
  progressBarContainer: {
    width: '100%',
    height: '4px',
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    overflow: 'hidden',
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
  hiddenInput: {
    display: 'none',
  },
  progressScale: (scale: number) => ({
    transform: `scaleX(${scale})`,
  }),
});

const EMAIL_TOKEN_PATTERN = /([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

function renderSidebarErrorMessage(message: string): React.ReactNode {
  const parts = message.split(EMAIL_TOKEN_PATTERN);
  if (parts.length === 1) return message;
  return parts.map((part, index) => {
    if (!part) return null;
    if (index % 2 === 1) {
      return <RedactedEmail key={`${index}-${part}`} email={part} style={styles.inlineErrorEmail} />;
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
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
  isMobileOpen = false,
  isDimmed = false,
  onCloseMobile,
  onDropItemsToRoot,
  onDropItemsToTrash,
  onDropExternalToRoot,
  filteredAccountIds,
  onToggleAccountFilter,
  authUrls,
  authUrlErrors,
  copiedAuthUrlId,
  onCopyAuthUrl,
  sidebarError,
  onDismissSidebarError,
}: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const accountsScrollRef = useRef<HTMLDivElement>(null);
  const [dragOverNav, setDragOverNav] = useState<'files' | 'trash' | null>(null);
  const isMobileViewport = useMediaQuery('(max-width: 768px)');

  useScrollableKeyboardNav({
    scrollRef: accountsScrollRef,
    enabled: !isMobileViewport || isMobileOpen,
    scope: isMobileViewport ? 'dialog' : 'container',
  });
  const handleMobileDialogCloseCallback = useCallback(() => {
    onCloseMobile?.();
  }, [onCloseMobile]);

  const {
    dialogRef: mobileDialogRef,
    handleCancel: handleMobileDialogCancel,
    handleClose: handleMobileDialogClose,
    handlePointerDown: handleMobileDialogPointerDown,
    handlePointerUp: handleMobileDialogPointerUp,
  } = useDialogLifecycle({
    isOpen: isMobileViewport && isMobileOpen,
    onClose: handleMobileDialogCloseCallback,
    skipExitAnimation: !isMobileViewport,
    requireTargetSelfForBackdrop: false,
  });

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

  const handleImportClick = () => {
    onDismissSidebarError?.();
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
  const activePool = sortedPools.find((p) => p.id === activePoolId) || sortedPools[0];

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

        <SidebarPoolSection
          sortedPools={sortedPools}
          activePool={activePool}
          activePoolId={activePoolId}
          onSelectPool={onSelectPool}
          onCreatePool={onCreatePool}
          onRenamePoolPrompt={onRenamePoolPrompt}
          onDeletePoolPrompt={onDeletePoolPrompt}
        />

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

        <div ref={accountsScrollRef} tabIndex={-1} {...stylex.props(styles.accountsScrollArea)}>
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

        {sidebarError && (
          <div {...stylex.props(styles.inlineErrorWrapper)}>
            <div role="alert" {...stylex.props(styles.inlineErrorAlert)}>
              <div {...stylex.props(styles.inlineErrorContent)}>
                <IconAlertTriangle size={13} {...stylex.props(styles.inlineErrorIcon)} />
                <span {...stylex.props(styles.inlineErrorText)}>
                  {renderSidebarErrorMessage(sidebarError)}
                </span>
              </div>
              {onDismissSidebarError && (
                <button
                  type="button"
                  aria-label="Dismiss sidebar error"
                  onClick={onDismissSidebarError}
                  {...stylex.props(styles.inlineErrorDismissBtn)}
                >
                  <IconClose size={12} />
                </button>
              )}
            </div>
          </div>
        )}

        {accounts.length === 0 && (
          <div {...stylex.props(styles.emptyNotice)}>
            No accounts connected yet. Add an account to begin pooling storage.
          </div>
        )}

        <div {...stylex.props(styles.accountsList)}>
          {accounts.map((acc, index) => (
            <SidebarAccountCard
              key={acc.id}
              account={acc}
              index={index}
              isFiltered={Boolean(filteredAccountIds?.has(acc.id))}
              canMovePool={Boolean(pools && pools.length > 1)}
              isSharePool={Boolean(activePool?.isSharePool)}
              authUrl={authUrls?.[acc.id]}
              hasAuthUrlError={authUrlErrors?.[acc.id]}
              isAuthUrlCopied={copiedAuthUrlId === acc.id}
              onCopyAuthUrl={onCopyAuthUrl}
              onToggleAccountFilter={onToggleAccountFilter}
              onRefreshStorage={onRefreshStorage}
              onOpenExternalChanges={onOpenExternalChanges}
              onOpenMovePool={onOpenMovePool}
              onEnableAccount={onEnableAccount}
              onDisableAccount={onDisableAccount}
              onRemoveAccount={onRemoveAccount}
            />
          ))}
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

