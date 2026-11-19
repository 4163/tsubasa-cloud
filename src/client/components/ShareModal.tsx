import React, { useState, useEffect, useRef, useId } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import {
  IconShare,
  IconLink,
  IconFolderFilled,
  FileTypeIcon,
  IconCheck,
  IconCopy,
  IconAlertTriangle,
} from './Icons.js';
import {
  formatBytes,
  copyTextToClipboard,
  COPY_FEEDBACK_DURATION_MS,
} from '../utils/format.js';
import { useMediaQuery } from '../utils/useBeforeUnload.js';
import { ModalDialog } from './ModalDialog.js';
import { ModalHeader, modalChromeStyles } from './ModalChrome.js';
import type { ShareTargetItem, ShareExecuteResult } from '../types.js';
import {
  useShareWizard,
  isDriveSelectable,
  type EmptyShareAccount,
} from '../hooks/useShareWizard.js';
import { useScrollableKeyboardNav } from '../hooks/useScrollableKeyboardNav.js';

export interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: ShareTargetItem[];
  sourcePoolId: number;
  onComplete: (result: ShareExecuteResult) => Promise<void> | void;
}

function getDriveStatusBadge(
  acc: EmptyShareAccount
): { label: string; tone: 'danger' | 'neutral' } | null {
  if (acc.isDisabled) return { label: 'Disabled', tone: 'danger' };
  if (!acc.authorized) return { label: 'Re-auth needed', tone: 'danger' };
  if (acc.syncState === 'error') return { label: 'Sync error', tone: 'danger' };
  if (acc.currentPoolIsShare) return { label: 'Already in share pool', tone: 'neutral' };
  return null;
}

function getAccountLabel(
  displayName: string | null | undefined,
  email: string,
  fallbackId: string
): string {
  return displayName && displayName !== email ? displayName : fallbackId;
}

const styles = stylex.create({
  surface: {
    width: layout.shareModalWidth,
  },
  bodyScroll: {
    overflowY: 'auto',
    flex: 1,
    minHeight: 0,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
  },
  summaryRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
    paddingBottom: spacing.space3,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
  },
  summaryMain: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
    flex: 1,
  },
  summaryIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: colors.secondaryText,
  },
  summaryIconFolder: {
    color: colors.poolGold,
  },
  summaryTextCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    minWidth: 0,
    flex: 1,
  },
  summaryTitle: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  summaryMeta: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  summarySize: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    fontVariantNumeric: 'tabular-nums',
    color: colors.primaryText,
    flexShrink: 0,
  },
  loadingStrip: {
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    backgroundColor: 'transparent',
    fontSize: typography.fontSizeBody,
    color: colors.secondaryText,
    fontFamily: typography.fontFamilyBody,
  },
  dangerBanner: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
  },
  dangerBannerHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    color: colors.dangerTextOnSurface,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    fontFamily: typography.fontFamilyBody,
  },
  dangerBannerText: {
    margin: 0,
    fontSize: typography.fontSizeMeta,
    color: colors.dangerTextOnSurface,
    lineHeight: typography.lineHeightBody,
    fontVariantNumeric: 'tabular-nums',
  },
  successStrip: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.successSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    color: colors.success,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    fontFamily: typography.fontFamilyBody,
    fontVariantNumeric: 'tabular-nums',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  sectionHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
  },
  sectionLabel: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    color: colors.secondaryText,
  },
  allocationPrompt: {
    margin: 0,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    color: colors.primaryText,
    lineHeight: typography.lineHeightBody,
    fontVariantNumeric: 'tabular-nums',
  },
  meterBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    backgroundColor: 'transparent',
  },
  meterTextRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  meterValue: {
    fontFamily: typography.fontFamilyMono,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  meterTrack: {
    width: '100%',
    height: spacing.space2,
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.accentGold,
    transition: motion.transitionFast,
  },
  autoSelectBtn: {
    height: '26px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    outline: 'none',
    transition: motion.transitionFast,
    flexShrink: 0,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.brandAccent,
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
  driveListContainer: {
    maxHeight: layout.shareDriveListMaxHeight,
    overflowY: 'auto',
    backgroundColor: 'transparent',
    borderRadius: radius.none,
    padding: spacing.space0,
    position: 'relative',
    boxSizing: 'border-box',
    outline: 'none',
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
  },
  virtualTrack: {
    width: '100%',
    position: 'relative',
  },
  driveRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.none,
    boxSizing: 'border-box',
    cursor: 'pointer',
    backgroundColor: 'transparent',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    textAlign: 'left',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    '@media (pointer: coarse)': {
      minHeight: layout.mobileTouchTarget,
    },
  },
  driveRowSelected: {
    backgroundColor: colors.selectionBg,
    ':hover': {
      backgroundColor: colors.selectionBg,
    },
  },
  rowLast: {
    borderBottomWidth: '0px',
  },
  driveRowDisabled: {
    opacity: 0.55,
    cursor: 'not-allowed',
    ':hover': {
      backgroundColor: 'transparent',
    },
  },
  checkbox: {
    width: '16px',
    height: '16px',
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    backgroundColor: colors.surface,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: colors.accentGoldText,
    boxSizing: 'border-box',
    transition: motion.transitionFast,
  },
  checkboxChecked: {
    backgroundColor: colors.accentGold,
    borderColor: colors.accentGold,
    color: colors.accentGoldText,
  },
  driveInfoCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    minWidth: 0,
    flex: 1,
  },
  driveTopLine: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
  },
  driveName: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  driveSubLine: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
  },
  driveEmail: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  driveMetaSep: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    flexShrink: 0,
  },
  drivePoolMeta: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    maxWidth: '140px',
  },
  driveNeutralStatus: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBody,
    color: colors.secondaryText,
    flexShrink: 0,
  },
  driveStatusBadge: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    color: colors.dangerTextOnSurface,
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    borderRadius: radius.compact,
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    flexShrink: 0,
  },
  driveHeadroom: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    fontVariantNumeric: 'tabular-nums',
    color: colors.primaryText,
    flexShrink: 0,
  },
  emptyDriveNotice: {
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: 'transparent',
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    lineHeight: typography.lineHeightBody,
  },
  linkRow: {
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    backgroundColor: 'transparent',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  linkRowTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
  },
  linkAccountCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
    flex: 1,
  },
  linkAccountName: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  linkAccountEmail: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  coverageText: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryText,
    flexShrink: 0,
  },
  urlRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    height: '32px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    outline: 'none',
    boxSizing: 'border-box',
    ':focus-visible': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
  },
  copyBtn: {
    height: '32px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    flexShrink: 0,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.brandAccent,
    },
    ':focus-visible': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
    },
  },
  copyBtnCopied: {
    backgroundColor: colors.successSurface,
    borderColor: colors.success,
    color: colors.success,
  },
  resultListContainer: {
    maxHeight: layout.shareResultListMaxHeight,
    overflowY: 'auto',
    position: 'relative',
    paddingRight: spacing.space2,
    outline: 'none',
  },
  virtualRowItem: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    boxSizing: 'border-box',
  },
  linkUnavailable: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    lineHeight: typography.lineHeightBody,
  },
  coarseMobileBtn: {
    '@media (pointer: coarse)': {
      minHeight: layout.mobileTouchTarget,
    },
  },
});

export function ShareModal({
  isOpen,
  onClose,
  items,
  sourcePoolId,
  onComplete,
}: ShareModalProps) {
  const {
    inspectData,
    isInspecting,
    selectedAccountIds,
    validationData,
    isValidating,
    isSubmitting,
    error,
    setError,
    executeResult,
    activeDriveIndex,
    setActiveDriveIndex,
    emptyAccounts,
    neededBytes,
    selectedHeadroomBytes,
    eligibleEmptyAccounts,
    hasOverCeiling,
    canSubmit,
    meterPercent,
    handleToggleAccount,
    handleAutoSelect,
    handleDismiss,
    handleSubmit,
  } = useShareWizard({
    isOpen,
    items,
    sourcePoolId,
    onComplete,
    onClose,
  });

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const isCoarsePointer = useMediaQuery('(pointer: coarse)');
  const titleId = useId();
  const driveOptionIdPrefix = useId();

  const driveListRef = useRef<HTMLDivElement | null>(null);
  const linksListRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setCopiedKey(null);
  }, [isOpen, items, sourcePoolId]);

  const driveRowHeight = isCoarsePointer ? 58 : 50;

  const driveVirtualizer = useVirtualizer({
    count: emptyAccounts.length,
    getScrollElement: () => driveListRef.current,
    estimateSize: () => driveRowHeight,
    overscan: 5,
  });

  const linksVirtualizer = useVirtualizer({
    count: executeResult?.links.length ?? 0,
    getScrollElement: () => linksListRef.current,
    estimateSize: () => 96,
    overscan: 4,
  });

  const handleCopyText = async (key: string, text: string) => {
    try {
      const ok = await copyTextToClipboard(text);
      if (!ok) {
        setError('Failed to copy link to clipboard');
        return;
      }
      setError(null);
      setCopiedKey(key);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, COPY_FEEDBACK_DURATION_MS);
    } catch {
      setError('Failed to copy link to clipboard');
    }
  };

  const effectiveOpen = isOpen && items.length > 0;
  const showDriveSelectionList =
    effectiveOpen &&
    !executeResult &&
    Boolean(
      inspectData &&
        !hasOverCeiling &&
        !inspectData.sharePoolFitsWithoutExpansion &&
        emptyAccounts.length > 0
    );
  const showResultLinksList =
    effectiveOpen && Boolean(executeResult && executeResult.links.length > 0);

  useScrollableKeyboardNav({
    scrollRef: driveListRef,
    enabled: showDriveSelectionList,
  });

  useScrollableKeyboardNav({
    scrollRef: linksListRef,
    enabled: showResultLinksList,
    onScrollToEnd:
      executeResult && executeResult.links.length > 0
        ? () => linksVirtualizer.scrollToIndex(executeResult.links.length - 1, { align: 'end' })
        : undefined,
  });

  const firstItem = items[0];
  const summaryTitle = !firstItem
    ? ''
    : items.length === 1
      ? firstItem.name
      : `${firstItem.name} + ${items.length - 1} ${items.length - 1 === 1 ? 'other' : 'others'}`;

  const summaryHasFolder = items.some((i) => i.kind === 'folder');

  const linksWithUrl = executeResult?.links.filter((l) => Boolean(l.webViewLink)) ?? [];

  const activeDriveAccount = emptyAccounts[activeDriveIndex];
  const activeDescendantId = activeDriveAccount
    ? `${driveOptionIdPrefix}-${activeDriveAccount.id}`
    : undefined;

  const handleDriveListboxKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (emptyAccounts.length === 0) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

    const pageStep = Math.max(
      1,
      Math.floor((driveListRef.current?.clientHeight ?? 0) / driveRowHeight) || 4
    );

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = Math.min(emptyAccounts.length - 1, activeDriveIndex + 1);
      setActiveDriveIndex(nextIdx);
      driveVirtualizer.scrollToIndex(nextIdx, { align: 'auto' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const nextIdx = Math.max(0, activeDriveIndex - 1);
      setActiveDriveIndex(nextIdx);
      driveVirtualizer.scrollToIndex(nextIdx, { align: 'auto' });
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      const nextIdx = Math.min(emptyAccounts.length - 1, activeDriveIndex + pageStep);
      setActiveDriveIndex(nextIdx);
      driveVirtualizer.scrollToIndex(nextIdx, { align: 'auto' });
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      const nextIdx = Math.max(0, activeDriveIndex - pageStep);
      setActiveDriveIndex(nextIdx);
      driveVirtualizer.scrollToIndex(nextIdx, { align: 'auto' });
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveDriveIndex(0);
      driveVirtualizer.scrollToIndex(0, { align: 'auto' });
    } else if (e.key === 'End') {
      e.preventDefault();
      const lastIdx = emptyAccounts.length - 1;
      setActiveDriveIndex(lastIdx);
      driveVirtualizer.scrollToIndex(lastIdx, { align: 'auto' });
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const acc = emptyAccounts[activeDriveIndex];
      if (acc) {
        handleToggleAccount(acc);
      }
    }
  };

  const errorBanner = (
    <div role="status" aria-live="polite">
      {error && (
        <div {...stylex.props(styles.dangerBanner)}>
          <div {...stylex.props(styles.dangerBannerHeader)}>
            <IconAlertTriangle size={15} />
            <span>Unable to share</span>
          </div>
          <p {...stylex.props(styles.dangerBannerText)}>{error}</p>
        </div>
      )}
    </div>
  );

  return (
    <ModalDialog
      isOpen={effectiveOpen}
      onClose={onClose}
      isBusy={isSubmitting}
      ariaLabelledBy={titleId}
      surfaceStyle={styles.surface}
    >
      <ModalHeader
        titleId={titleId}
        title={executeResult ? 'Share links ready' : 'Share via Drive'}
        icon={executeResult ? <IconLink size={16} /> : <IconShare size={16} />}
        onClose={handleDismiss}
        isBusy={isSubmitting}
        closeAriaLabel="Close"
        titleEllipsis
      />

        {executeResult ? (
          <>
            <div {...stylex.props(modalChromeStyles.body, modalChromeStyles.bodySpaced, styles.bodyScroll)}>
              <div {...stylex.props(styles.successStrip)}>
                <IconCheck size={15} />
                <span>
                  Shared {executeResult.fileCount} {executeResult.fileCount === 1 ? 'file' : 'files'}
                  {executeResult.folderCount > 0
                    ? ` and ${executeResult.folderCount} ${executeResult.folderCount === 1 ? 'folder' : 'folders'}`
                    : ''}{' '}
                  ({formatBytes(executeResult.totalBytes)}) via _Tsubasa~ Pool share/
                  {executeResult.batchFolderName}
                </span>
              </div>

              {executeResult.links.length > 0 && (
                <div {...stylex.props(styles.section)}>
                  <div {...stylex.props(styles.sectionHeaderRow)}>
                    <span {...stylex.props(styles.sectionLabel)}>
                      Participating Share Pool drives ({executeResult.links.length})
                    </span>
                    {linksWithUrl.length > 1 && (
                      <button
                        type="button"
                        {...stylex.props(
                          styles.copyBtn,
                          copiedKey === 'all' && styles.copyBtnCopied
                        )}
                        onClick={() =>
                          void handleCopyText(
                            'all',
                            linksWithUrl.map((l) => l.webViewLink!).join('\n')
                          )
                        }
                      >
                        {copiedKey === 'all' ? <IconCheck size={13} /> : <IconCopy size={13} />}
                        {copiedKey === 'all' ? 'Copied all' : 'Copy all links'}
                      </button>
                    )}
                  </div>

                  <div ref={linksListRef} tabIndex={-1} {...stylex.props(styles.resultListContainer)}>
                    <div
                      {...stylex.props(styles.virtualTrack)}
                      style={{ height: `${linksVirtualizer.getTotalSize()}px` }}
                    >
                      {linksVirtualizer.getVirtualItems().map((virtualRow) => {
                        const link = executeResult.links[virtualRow.index];
                        if (!link) return null;
                        const displayName = getAccountLabel(
                          link.accountDisplayName,
                          link.accountEmail,
                          link.accountId
                        );
                        const isCopied = copiedKey === link.accountId;
                        const isLast = virtualRow.index === executeResult.links.length - 1;
                        return (
                          <div
                            key={link.accountId}
                            ref={linksVirtualizer.measureElement}
                            data-index={virtualRow.index}
                            {...stylex.props(styles.virtualRowItem)}
                            style={{ transform: `translateY(${virtualRow.start}px)` }}
                          >
                            <div {...stylex.props(styles.linkRow, isLast && styles.rowLast)}>
                              <div {...stylex.props(styles.linkRowTop)}>
                                <div {...stylex.props(styles.linkAccountCol)}>
                                  <span {...stylex.props(styles.linkAccountName)}>{displayName}</span>
                                  <span {...stylex.props(styles.linkAccountEmail)}>{link.accountEmail}</span>
                                </div>
                                <span {...stylex.props(styles.coverageText)}>
                                  {link.filesCount} {link.filesCount === 1 ? 'file' : 'files'} ·{' '}
                                  {formatBytes(link.bytesAllocated)}
                                </span>
                              </div>

                              {link.webViewLink ? (
                                <div {...stylex.props(styles.urlRow)}>
                                  <input
                                    type="text"
                                    readOnly
                                    value={link.webViewLink}
                                    aria-label={`Share link for ${link.accountEmail}`}
                                    onClick={(e) => e.currentTarget.select()}
                                    {...stylex.props(styles.urlInput)}
                                  />
                                  <button
                                    type="button"
                                    {...stylex.props(styles.copyBtn, isCopied && styles.copyBtnCopied)}
                                    onClick={() => void handleCopyText(link.accountId, link.webViewLink!)}
                                  >
                                    {isCopied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                                    {isCopied ? 'Copied' : 'Copy link'}
                                  </button>
                                </div>
                              ) : (
                                <span {...stylex.props(styles.linkUnavailable)}>
                                  Share link unavailable for this drive
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {errorBanner}
            </div>

            <div {...stylex.props(modalChromeStyles.footer)}>
              <button
                type="button"
                {...stylex.props(modalChromeStyles.primaryBtn, styles.coarseMobileBtn)}
                onClick={handleDismiss}
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit} {...stylex.props(styles.form)}>
            <div {...stylex.props(modalChromeStyles.body, modalChromeStyles.bodySpaced, styles.bodyScroll)}>
              <div {...stylex.props(styles.summaryRow)}>
                <div {...stylex.props(styles.summaryMain)}>
                  <span
                    {...stylex.props(
                      styles.summaryIcon,
                      summaryHasFolder && styles.summaryIconFolder
                    )}
                  >
                    {summaryHasFolder ? (
                      <IconFolderFilled size={18} />
                    ) : firstItem ? (
                      <FileTypeIcon name={firstItem.name || firstItem.virtualPath} size={16} />
                    ) : null}
                  </span>
                  <div {...stylex.props(styles.summaryTextCol)}>
                    <span {...stylex.props(styles.summaryTitle)} title={summaryTitle}>
                      {summaryTitle}
                    </span>
                    <span {...stylex.props(styles.summaryMeta)}>
                      {inspectData
                        ? `${inspectData.folderCount} ${inspectData.folderCount === 1 ? 'folder' : 'folders'} · ${inspectData.fileCount} ${inspectData.fileCount === 1 ? 'file' : 'files'}`
                        : `${items.length} selected ${items.length === 1 ? 'item' : 'items'}`}
                    </span>
                  </div>
                </div>
                <span {...stylex.props(styles.summarySize)}>
                  {inspectData ? formatBytes(inspectData.totalBytes) : '—'}
                </span>
              </div>

              {isInspecting && (
                <div {...stylex.props(styles.loadingStrip)}>
                  Inspecting Share Pool capacity and target files...
                </div>
              )}

              {inspectData && hasOverCeiling && (
                <div {...stylex.props(styles.dangerBanner)}>
                  <div {...stylex.props(styles.dangerBannerHeader)}>
                    <IconAlertTriangle size={15} />
                    <span>Exceeds 14.25 GB single-drive limit</span>
                  </div>
                  <p {...stylex.props(styles.dangerBannerText)}>
                    {inspectData.overCeilingFiles
                      .map((f) => `${f.name} (${formatBytes(f.sizeBytes)})`)
                      .join(', ')}{' '}
                    cannot be placed on a single Google Drive account.
                  </p>
                </div>
              )}

              {inspectData && !hasOverCeiling && inspectData.sharePoolFitsWithoutExpansion && (
                <div {...stylex.props(styles.successStrip)}>
                  <IconCheck size={15} />
                  <span>
                    Using Share Pool free space ·{' '}
                    {formatBytes(inspectData.existingSharePoolHeadroomBytes)} available of{' '}
                    {formatBytes(inspectData.totalBytes)} needed
                  </span>
                </div>
              )}

              {inspectData && !hasOverCeiling && !inspectData.sharePoolFitsWithoutExpansion && (
                <div {...stylex.props(styles.section)}>
                  <div {...stylex.props(styles.sectionHeaderRow)}>
                    <span {...stylex.props(styles.sectionLabel)}>Share Pool allocation</span>
                    <button
                      type="button"
                      {...stylex.props(styles.autoSelectBtn)}
                      onClick={handleAutoSelect}
                      disabled={eligibleEmptyAccounts.length === 0 || isSubmitting}
                    >
                      Auto-select
                    </button>
                  </div>

                  <p {...stylex.props(styles.allocationPrompt)}>
                    Share Pool size of {formatBytes(neededBytes)} is needed. Please select empty
                    drive(s) to use for the Share Pool.
                  </p>

                  <div {...stylex.props(styles.meterBlock)}>
                    <div {...stylex.props(styles.meterTextRow)}>
                      <span>
                        Selected headroom:{' '}
                        <span {...stylex.props(styles.meterValue)}>
                          {formatBytes(selectedHeadroomBytes)}
                        </span>
                      </span>
                      <span>
                        Needed:{' '}
                        <span {...stylex.props(styles.meterValue)}>
                          {formatBytes(neededBytes)}
                        </span>
                      </span>
                    </div>
                    <div {...stylex.props(styles.meterTrack)}>
                      <div
                        {...stylex.props(styles.meterFill)}
                        style={{ width: `${meterPercent}%` }}
                      />
                    </div>
                  </div>

                  {!isValidating && validationData && !validationData.valid && validationData.reason && (
                    <div {...stylex.props(styles.dangerBanner)} role="status">
                      <div {...stylex.props(styles.dangerBannerHeader)}>
                        <IconAlertTriangle size={15} />
                        <span>Selection insufficient</span>
                      </div>
                      <p {...stylex.props(styles.dangerBannerText)}>{validationData.reason}</p>
                    </div>
                  )}

                  {emptyAccounts.length === 0 ? (
                    <div {...stylex.props(styles.emptyDriveNotice)}>
                      No empty drives found across your pools. Remove files from an account or add a
                      new Google Drive account to expand the Share Pool.
                    </div>
                  ) : (
                    <div
                      ref={driveListRef}
                      role="listbox"
                      aria-multiselectable="true"
                      aria-label="Select empty drives for Share Pool"
                      aria-activedescendant={activeDescendantId}
                      tabIndex={0}
                      onKeyDown={handleDriveListboxKeyDown}
                      {...stylex.props(styles.driveListContainer)}
                    >
                      <div
                        {...stylex.props(styles.virtualTrack)}
                        style={{ height: `${driveVirtualizer.getTotalSize()}px` }}
                      >
                        {driveVirtualizer.getVirtualItems().map((virtualRow) => {
                          const acc = emptyAccounts[virtualRow.index];
                          if (!acc) return null;
                          const selectable = isDriveSelectable(acc);
                          const isSelected = selectedAccountIds.includes(acc.id);
                          const statusBadge = getDriveStatusBadge(acc);

                          return (
                            <div
                              key={acc.id}
                              id={`${driveOptionIdPrefix}-${acc.id}`}
                              role="option"
                              aria-selected={isSelected}
                              aria-disabled={!selectable || isSubmitting}
                              onClick={() => {
                                setActiveDriveIndex(virtualRow.index);
                                handleToggleAccount(acc);
                              }}
                              {...stylex.props(
                                styles.driveRow,
                                isSelected && styles.driveRowSelected,
                                (!selectable || isSubmitting) && styles.driveRowDisabled,
                                virtualRow.index === emptyAccounts.length - 1 && styles.rowLast
                              )}
                              style={{
                                height: `${virtualRow.size}px`,
                                transform: `translateY(${virtualRow.start}px)`,
                              }}
                            >
                              <span
                                {...stylex.props(
                                  styles.checkbox,
                                  isSelected && styles.checkboxChecked
                                )}
                              >
                                {isSelected && <IconCheck size={12} />}
                              </span>
                              <div {...stylex.props(styles.driveInfoCol)}>
                                <div {...stylex.props(styles.driveTopLine)}>
                                  <span {...stylex.props(styles.driveName)}>
                                    {getAccountLabel(acc.displayName, acc.email, acc.id)}
                                  </span>
                                </div>
                                <div {...stylex.props(styles.driveSubLine)}>
                                  <span {...stylex.props(styles.driveEmail)}>{acc.email}</span>
                                  <span {...stylex.props(styles.driveMetaSep)} aria-hidden="true">
                                    ·
                                  </span>
                                  {!acc.currentPoolIsShare && (
                                    <span {...stylex.props(styles.drivePoolMeta)}>
                                      {acc.currentPoolName}
                                    </span>
                                  )}
                                  {statusBadge && (
                                    <span
                                      {...stylex.props(
                                        statusBadge.tone === 'danger'
                                          ? styles.driveStatusBadge
                                          : styles.driveNeutralStatus
                                      )}
                                    >
                                      {statusBadge.label}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <span {...stylex.props(styles.driveHeadroom)}>
                                {formatBytes(acc.headroomBytes)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {errorBanner}
            </div>

            <div {...stylex.props(modalChromeStyles.footer)}>
              <button
                type="button"
                {...stylex.props(
                  modalChromeStyles.cancelBtn,
                  modalChromeStyles.cancelBtnSurface,
                  styles.coarseMobileBtn
                )}
                onClick={handleDismiss}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                {...stylex.props(modalChromeStyles.primaryBtn, styles.coarseMobileBtn)}
                disabled={!canSubmit}
              >
                <IconShare size={14} />
                {isSubmitting ? 'Sharing...' : 'Share'}
              </button>
            </div>
          </form>
        )}
    </ModalDialog>
  );
}
