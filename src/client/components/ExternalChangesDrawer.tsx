import React, { useRef, useMemo } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useVirtualizer } from '@tanstack/react-virtual';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import { IconAlertTriangle, FileTypeIcon, IconCheck, IconChevronDown, IconFolderFilled } from './Icons.js';
import { DrawerSheet, DrawerSectionHeader, DrawerButton } from './DrawerPrimitives.js';
import { formatBytes } from '../utils/format.js';
import { syncOverflowTitle } from '../utils/workspaceHelpers.js';
import { useExternalChanges } from '../hooks/useExternalChanges.js';
import { useScrollableKeyboardNav } from '../hooks/useScrollableKeyboardNav.js';
import type {
  ExternalDiscrepancyItem,
  PathConflictItem,
  DiscrepancyReport,
} from '../types.js';

interface ExternalChangesDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: Array<{
    id: string;
    displayName: string;
    email: string;
    quotaUsedBytes?: number;
    usableLimitBytes?: number;
    tsubasaUsedBytes?: number;
  }>;
  initialAccountId?: string;
  isMobileSidebarOpen?: boolean;
  onResolved: (summary?: { accountId: string; remainingCount: number; refreshFiles?: boolean }) => Promise<void>;
}

const VIRTUALIZE_THRESHOLD = 30;

type ExternalChangesDisplayRow =
  | { type: 'overCeiling-header'; key: 'overCeiling-header'; count: number }
  | { type: 'overCeiling-subbar'; key: 'overCeiling-subbar' }
  | { type: 'overCeiling-item'; key: string; item: ExternalDiscrepancyItem }
  | { type: 'conflicts-header'; key: 'conflicts-header'; count: number }
  | {
      type: 'conflicts-subbar';
      key: 'conflicts-subbar';
      conflictCount: number;
      exactDuplicateCount: number;
    }
  | { type: 'conflict-item'; key: string; item: PathConflictItem }
  | { type: 'pool-summary-header'; key: 'pool-summary-header'; count: number }
  | { type: 'pool-summary-card'; key: 'pool-summary-card' }
  | { type: 'unindexed-header'; key: 'unindexed-header'; count: number }
  | { type: 'unindexed-item'; key: string; item: ExternalDiscrepancyItem }
  | { type: 'modified-header'; key: 'modified-header'; count: number }
  | { type: 'modified-item'; key: string; item: ExternalDiscrepancyItem }
  | { type: 'missingRemote-header'; key: 'missingRemote-header'; count: number }
  | { type: 'missingRemote-subbar'; key: 'missingRemote-subbar' }
  | {
      type: 'missingRemote-item';
      key: string;
      item: DiscrepancyReport['missingRemote'][number];
    }
  | { type: 'rebalance-banner'; key: 'rebalance-banner' };

const styles = stylex.create({
  accountSelectorBar: {
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
    flexShrink: 0,
  },
  selectWrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    flex: 1,
  },
  select: {
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    width: '100%',
    height: layout.tableRowHeightCompact,
    lineHeight: '26px',
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space3,
    paddingRight: '28px',
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    outline: 'none',
    cursor: 'pointer',
    boxSizing: 'border-box',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    transitionProperty: 'background-color, border-color, opacity',
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easingOut,
    ':hover': {
      borderColor: colors.accentGold,
    },
    ':focus-visible': {
      borderColor: colors.focusRing,
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
  selectChevron: {
    position: 'absolute',
    right: spacing.space4,
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: colors.dimText,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rescanBtn: {
    height: layout.tableRowHeightCompact,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.compact,
    fontSize: typography.fontSizeBody,
    flexShrink: 0,
  },
  contentScroll: {
    flex: 1,
    overflowY: 'auto',
    scrollPaddingTop: spacing.space2,
    scrollPaddingBottom: spacing.space2,
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    paddingRight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    outline: 'none',
  },
  sectionSubBar: {
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  card: {
    position: 'relative',
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderRadius: radius.none,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: 'transparent',
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
    },
  },
  cardOverCeiling: {
    '::after': {
      content: '""',
      position: 'absolute',
      top: '1px',
      bottom: '1px',
      right: {
        default: spacing.space2,
        '@media (max-width: 768px)': 'auto',
      },
      left: {
        default: 'auto',
        '@media (max-width: 768px)': 0,
      },
      width: '3px',
      backgroundColor: colors.danger,
      pointerEvents: 'none',
      display: 'block',
    },
  },
  cardConflict: {
    '::after': {
      content: '""',
      position: 'absolute',
      top: '1px',
      bottom: '1px',
      right: {
        default: spacing.space2,
        '@media (max-width: 768px)': 'auto',
      },
      left: {
        default: 'auto',
        '@media (max-width: 768px)': 0,
      },
      width: '3px',
      backgroundColor: colors.warning,
      pointerEvents: 'none',
      display: 'block',
    },
  },
  batchActionsBar: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    flexWrap: 'wrap',
  },
  fileIconWrap: {
    width: '16px',
    height: '16px',
    marginTop: '2px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  poolFolderIcon: {
    color: colors.poolGold,
  },
  conflictBadgeExact: {
    display: 'inline-flex',
    alignItems: 'center',
    height: spacing.space7,
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccentSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.brandAccent,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    flexShrink: 0,
  },
  conflictBadgeDiff: {
    display: 'inline-flex',
    alignItems: 'center',
    height: spacing.space7,
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.warningSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.warningBorder,
    color: colors.warning,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    flexShrink: 0,
  },
  conflictCompareBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
  },
  conflictCompareRow: {
    display: 'grid',
    gridTemplateColumns: '64px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: spacing.space2,
    fontVariantNumeric: 'tabular-nums',
  },
  conflictOriginTag: {
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    textTransform: 'uppercase',
    color: colors.secondaryText,
    letterSpacing: '0.02em',
  },
  conflictAccountEmail: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  conflictSizeText: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.primaryText,
    fontWeight: typography.fontWeightTitle,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'right',
    flexShrink: 0,
  },
  fileHeaderRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.space3,
  },
  fileTitleGroup: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.space4,
    minWidth: 0,
    flex: 1,
  },
  fileName: {
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileMeta: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  },
  cardDesc: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    lineHeight: typography.lineHeightBody,
    margin: 0,
  },
  confirmPromptText: {
    fontSize: typography.fontSizeMeta,
    fontWeight: '500',
    color: colors.primaryText,
    lineHeight: typography.lineHeightBody,
    margin: 0,
    fontVariantNumeric: 'tabular-nums',
  },
  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    flexWrap: 'wrap',
  },
  statusNoticeBanner: {
    position: 'relative',
    flexShrink: 0,
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderRadius: radius.none,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.dangerSurface,
    color: colors.danger,
    fontSize: typography.fontSizeMeta,
    '::after': {
      content: '""',
      position: 'absolute',
      top: '1px',
      bottom: '1px',
      right: {
        default: spacing.space2,
        '@media (max-width: 768px)': 'auto',
      },
      left: {
        default: 'auto',
        '@media (max-width: 768px)': 0,
      },
      width: '3px',
      backgroundColor: colors.danger,
      pointerEvents: 'none',
      display: 'block',
    },
  },
  virtualListInner: {
    position: 'relative',
    width: '100%',
  },
  virtualRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
  },
  fileTitleCol: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1,
    gap: spacing.space1,
  },
  fileVirtualPath: {
    fontSize: typography.fontSizeMeta,
    color: colors.dimText,
    fontFamily: typography.fontFamilyMono,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rebalanceTitle: {
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
  },
  scanningNoticeText: {
    fontSize: typography.fontSizeBody,
    color: colors.dimText,
  },
  emptyNoticeTitle: {
    fontSize: typography.fontSizeSection,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
  },
  rebalanceBanner: {
    position: 'relative',
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderRadius: radius.none,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: 'transparent',
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    '::after': {
      content: '""',
      position: 'absolute',
      top: '1px',
      bottom: '1px',
      right: {
        default: spacing.space2,
        '@media (max-width: 768px)': 'auto',
      },
      left: {
        default: 'auto',
        '@media (max-width: 768px)': 0,
      },
      width: '3px',
      backgroundColor: colors.warning,
      pointerEvents: 'none',
      display: 'block',
    },
  },
  emptyNotice: {
    textAlign: 'center',
    padding: spacing.space10,
    color: colors.secondaryText,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing.space2,
  },
  scanningNotice: {
    textAlign: 'center',
    padding: spacing.space10,
    color: colors.dimText,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing.space2,
  },
});

export function ExternalChangesDrawer({
  isOpen,
  onClose,
  accounts,
  initialAccountId,
  isMobileSidebarOpen = false,
  onResolved,
}: ExternalChangesDrawerProps) {
  const {
    selectedAccount,
    setSelectedAccount,
    report,
    isScanning,
    activeActionId,
    statusNotice,
    showIndividualFiles,
    setShowIndividualFiles,
    confirmingEject,
    setConfirmingEject,
    showRebalance,
    isLocked,
    exactDuplicates,
    acceptableItems,
    showPoolSummary,
    showIndividualAcceptable,
    acceptableBytes,
    poolSummaryParts,
    totalDiscrepancies,
    scanAccount,
    handleAccept,
    handleBulkResolve,
    handleMoveToRoot,
    handleRemoveMissing,
    handleAutoRebalance,
    handleResolveConflict,
    handleBatchResolveConflicts,
  } = useExternalChanges({
    isOpen,
    accounts,
    initialAccountId,
    onResolved,
  });

  const contentScrollRef = useRef<HTMLDivElement>(null);

  const displayRows = useMemo<ExternalChangesDisplayRow[]>(() => {
    const rows: ExternalChangesDisplayRow[] = [];

    if (report?.overCeiling && report.overCeiling.length > 0) {
      rows.push({
        type: 'overCeiling-header',
        key: 'overCeiling-header',
        count: report.overCeiling.length,
      });
      rows.push({ type: 'overCeiling-subbar', key: 'overCeiling-subbar' });
      for (const item of report.overCeiling) {
        rows.push({
          type: 'overCeiling-item',
          key: `overCeiling-${item.driveFileId}`,
          item,
        });
      }
    }

    if (report?.conflicts && report.conflicts.length > 0) {
      rows.push({
        type: 'conflicts-header',
        key: 'conflicts-header',
        count: report.conflicts.length,
      });
      rows.push({
        type: 'conflicts-subbar',
        key: 'conflicts-subbar',
        conflictCount: report.conflicts.length,
        exactDuplicateCount: exactDuplicates.length,
      });
      for (const item of report.conflicts) {
        rows.push({
          type: 'conflict-item',
          key: `conflict-${item.driveFileId}`,
          item,
        });
      }
    }

    if (report && showPoolSummary) {
      rows.push({
        type: 'pool-summary-header',
        key: 'pool-summary-header',
        count: acceptableItems.length,
      });
      rows.push({ type: 'pool-summary-card', key: 'pool-summary-card' });
    }

    if (showIndividualAcceptable && report?.unindexed && report.unindexed.length > 0) {
      rows.push({
        type: 'unindexed-header',
        key: 'unindexed-header',
        count: report.unindexed.length,
      });
      for (const item of report.unindexed) {
        rows.push({
          type: 'unindexed-item',
          key: `unindexed-${item.driveFileId}`,
          item,
        });
      }
    }

    if (showIndividualAcceptable && report?.modified && report.modified.length > 0) {
      rows.push({
        type: 'modified-header',
        key: 'modified-header',
        count: report.modified.length,
      });
      for (const item of report.modified) {
        rows.push({
          type: 'modified-item',
          key: `modified-${item.driveFileId}`,
          item,
        });
      }
    }

    if (report?.missingRemote && report.missingRemote.length > 0) {
      rows.push({
        type: 'missingRemote-header',
        key: 'missingRemote-header',
        count: report.missingRemote.length,
      });
      rows.push({ type: 'missingRemote-subbar', key: 'missingRemote-subbar' });
      for (const item of report.missingRemote) {
        rows.push({
          type: 'missingRemote-item',
          key: `missingRemote-${item.driveFileId}`,
          item,
        });
      }
    }

    if (showRebalance) {
      rows.push({ type: 'rebalance-banner', key: 'rebalance-banner' });
    }

    return rows;
  }, [report, exactDuplicates.length, showPoolSummary, acceptableItems.length, showIndividualAcceptable, showRebalance]);

  const shouldVirtualize = displayRows.length > VIRTUALIZE_THRESHOLD;

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? displayRows.length : 0,
    getScrollElement: () => contentScrollRef.current,
    estimateSize: () => 96,
    getItemKey: (index) => displayRows[index]?.key ?? index,
    overscan: 6,
  });

  useScrollableKeyboardNav({
    scrollRef: contentScrollRef,
    enabled: isOpen,
    onScrollToEnd:
      shouldVirtualize && displayRows.length > 0
        ? () => rowVirtualizer.scrollToIndex(displayRows.length - 1, { align: 'end' })
        : undefined,
  });

  const renderDisplayRow = (row: ExternalChangesDisplayRow): React.ReactNode => {
    switch (row.type) {
      case 'overCeiling-header':
        return (
          <DrawerSectionHeader
            icon={<IconAlertTriangle size={14} color={colors.danger} />}
            title="Over-ceiling files (> 14.25 GB)"
            count={row.count.toLocaleString()}
          />
        );
      case 'overCeiling-subbar':
        return (
          <div {...stylex.props(styles.sectionSubBar)}>
            <p {...stylex.props(styles.cardDesc)}>
              Files over 14.25 GB exceed the single-file ceiling and cannot be indexed into Tsubasa. Eject them to Drive root to keep them outside the pool folder.
            </p>
          </div>
        );
      case 'overCeiling-item': {
        const { item } = row;
        return (
          <div {...stylex.props(styles.card, styles.cardOverCeiling)}>
            <div {...stylex.props(styles.fileHeaderRow)}>
              <div {...stylex.props(styles.fileTitleGroup)}>
                <span {...stylex.props(styles.fileIconWrap)}>
                  <FileTypeIcon name={item.name || item.virtualPath} size={16} />
                </span>
                <div {...stylex.props(styles.fileTitleCol)}>
                  <span {...stylex.props(styles.fileName)} onMouseEnter={syncOverflowTitle}>
                    {item.name}
                  </span>
                  <span
                    {...stylex.props(styles.fileVirtualPath)}
                    onMouseEnter={syncOverflowTitle}
                  >
                    {item.virtualPath}
                  </span>
                </div>
              </div>
              <span {...stylex.props(styles.fileMeta)}>{formatBytes(item.sizeBytes)}</span>
            </div>

            <div {...stylex.props(styles.actionsRow)}>
              <DrawerButton
                variant="danger"
                onClick={() => handleMoveToRoot(item)}
                disabled={isLocked}
              >
                Eject to root
              </DrawerButton>
            </div>
          </div>
        );
      }
      case 'conflicts-header':
        return (
          <DrawerSectionHeader
            icon={<IconAlertTriangle size={14} color={colors.warning} />}
            title="Path conflicts in pool"
            count={row.count.toLocaleString()}
          />
        );
      case 'conflicts-subbar':
        return (
          <div {...stylex.props(styles.sectionSubBar)}>
            <p {...stylex.props(styles.cardDesc)}>
              These files share the same folder path as files already stored on another drive in this pool.
            </p>
            {row.conflictCount > 1 && report?.conflicts && (
              <div {...stylex.props(styles.batchActionsBar)}>
                {row.exactDuplicateCount > 1 && (
                  <DrawerButton
                    variant="primary"
                    onClick={() => handleBatchResolveConflicts(exactDuplicates, 'deduplicate')}
                    disabled={isLocked}
                  >
                    Remove {row.exactDuplicateCount} identical duplicates
                  </DrawerButton>
                )}
                <DrawerButton
                  variant={row.exactDuplicateCount > 1 ? 'secondary' : 'primary'}
                  onClick={() => handleBatchResolveConflicts(report.conflicts, 'keep_both')}
                  disabled={isLocked}
                >
                  Keep both for all {row.conflictCount}
                </DrawerButton>
              </div>
            )}
          </div>
        );
      case 'conflict-item': {
        const { item } = row;
        return (
          <div {...stylex.props(styles.card, styles.cardConflict)}>
            <div {...stylex.props(styles.fileHeaderRow)}>
              <div {...stylex.props(styles.fileTitleGroup)}>
                <span {...stylex.props(styles.fileIconWrap)}>
                  <FileTypeIcon name={item.name || item.virtualPath} size={16} />
                </span>
                <div {...stylex.props(styles.fileTitleCol)}>
                  <span {...stylex.props(styles.fileName)} onMouseEnter={syncOverflowTitle}>
                    {item.name}
                  </span>
                  <span {...stylex.props(styles.fileVirtualPath)} onMouseEnter={syncOverflowTitle}>
                    {item.virtualPath}
                  </span>
                </div>
              </div>
              <span
                {...stylex.props(
                  item.isExactDuplicate ? styles.conflictBadgeExact : styles.conflictBadgeDiff
                )}
              >
                {item.isExactDuplicate ? 'Identical copy' : 'Different version'}
              </span>
            </div>

            <div {...stylex.props(styles.conflictCompareBox)}>
              <div {...stylex.props(styles.conflictCompareRow)}>
                <span {...stylex.props(styles.conflictOriginTag)}>In pool</span>
                <span
                  {...stylex.props(styles.conflictAccountEmail)}
                  onMouseEnter={syncOverflowTitle}
                >
                  {item.existingFile.accountEmail}
                </span>
                <span {...stylex.props(styles.conflictSizeText)}>
                  {formatBytes(item.existingFile.sizeBytes)}
                </span>
              </div>
              <div {...stylex.props(styles.conflictCompareRow)}>
                <span {...stylex.props(styles.conflictOriginTag)}>This drive</span>
                <span {...stylex.props(styles.conflictAccountEmail)} onMouseEnter={syncOverflowTitle}>
                  {item.accountEmail}
                </span>
                <span {...stylex.props(styles.conflictSizeText)}>{formatBytes(item.sizeBytes)}</span>
              </div>
            </div>

            <div {...stylex.props(styles.actionsRow)}>
              {item.isExactDuplicate ? (
                <>
                  <DrawerButton
                    variant="primary"
                    onClick={() => handleResolveConflict(item, 'deduplicate')}
                    disabled={isLocked}
                  >
                    Remove duplicate
                  </DrawerButton>
                  <DrawerButton
                    variant="secondary"
                    onClick={() => handleResolveConflict(item, 'keep_both')}
                    disabled={isLocked}
                  >
                    Keep both
                  </DrawerButton>
                  <DrawerButton
                    variant="secondary"
                    onClick={() => handleResolveConflict(item, 'replace_existing')}
                    disabled={isLocked}
                  >
                    Use drive copy
                  </DrawerButton>
                  <DrawerButton
                    variant="secondary"
                    onClick={() => handleResolveConflict(item, 'eject')}
                    disabled={isLocked}
                    title="Move to Drive root"
                  >
                    Eject
                  </DrawerButton>
                </>
              ) : (
                <>
                  <DrawerButton
                    variant="primary"
                    onClick={() => handleResolveConflict(item, 'keep_both')}
                    disabled={isLocked}
                  >
                    Keep both
                  </DrawerButton>
                  <DrawerButton
                    variant="secondary"
                    onClick={() => handleResolveConflict(item, 'replace_existing')}
                    disabled={isLocked}
                  >
                    Replace pool
                  </DrawerButton>
                  <DrawerButton
                    variant="secondary"
                    onClick={() => handleResolveConflict(item, 'deduplicate')}
                    disabled={isLocked}
                  >
                    Discard copy
                  </DrawerButton>
                  <DrawerButton
                    variant="secondary"
                    onClick={() => handleResolveConflict(item, 'eject')}
                    disabled={isLocked}
                    title="Move to Drive root"
                  >
                    Eject
                  </DrawerButton>
                </>
              )}
            </div>
          </div>
        );
      }
      case 'pool-summary-header':
        return (
          <DrawerSectionHeader
            title="Files added or changed in Google Drive"
            count={row.count.toLocaleString()}
          />
        );
      case 'pool-summary-card':
        if (!report) return null;
        return (
          <div {...stylex.props(styles.card)}>
            <div {...stylex.props(styles.fileHeaderRow)}>
              <div {...stylex.props(styles.fileTitleGroup)}>
                <span {...stylex.props(styles.fileIconWrap, styles.poolFolderIcon)}>
                  <IconFolderFilled size={16} />
                </span>
                <div {...stylex.props(styles.fileTitleCol)}>
                  <span {...stylex.props(styles.fileName)} onMouseEnter={syncOverflowTitle}>
                    {report.poolFolderName}
                  </span>
                  <span {...stylex.props(styles.fileVirtualPath)}>{poolSummaryParts.join(' · ')}</span>
                </div>
              </div>
              <span {...stylex.props(styles.fileMeta)}>{formatBytes(acceptableBytes)}</span>
            </div>

            {confirmingEject ? (
              <>
                <p {...stylex.props(styles.confirmPromptText)}>
                  Move {acceptableItems.length.toLocaleString()} files ({formatBytes(acceptableBytes)}) out of{' '}
                  {report.poolFolderName} to Drive root? Files stay in Google Drive.
                </p>
                <div {...stylex.props(styles.actionsRow)}>
                  <DrawerButton
                    variant="danger"
                    onClick={() => handleBulkResolve('eject-all')}
                    disabled={isLocked}
                  >
                    {activeActionId === 'eject-all'
                      ? 'Ejecting...'
                      : `Eject ${acceptableItems.length.toLocaleString()} files`}
                  </DrawerButton>
                  <DrawerButton
                    variant="secondary"
                    onClick={() => setConfirmingEject(false)}
                    disabled={isLocked}
                  >
                    Cancel
                  </DrawerButton>
                </div>
              </>
            ) : (
              <div {...stylex.props(styles.actionsRow)}>
                <DrawerButton
                  variant="primary"
                  onClick={() => handleBulkResolve('accept-all')}
                  disabled={isLocked}
                >
                  {activeActionId === 'accept-all'
                    ? 'Accepting...'
                    : `Accept all ${acceptableItems.length.toLocaleString()} files`}
                </DrawerButton>
                <DrawerButton
                  variant="secondary"
                  onClick={() => setConfirmingEject(true)}
                  disabled={isLocked}
                >
                  Eject all to Drive root
                </DrawerButton>
                <DrawerButton
                  variant="secondary"
                  onClick={() => setShowIndividualFiles((prev) => !prev)}
                  disabled={isLocked}
                  aria-expanded={showIndividualFiles}
                >
                  {showIndividualFiles ? 'Hide individual files' : 'Review individually'}
                </DrawerButton>
              </div>
            )}
          </div>
        );
      case 'unindexed-header':
        return (
          <DrawerSectionHeader
            title="Unindexed files added in Google Drive"
            count={row.count.toLocaleString()}
          />
        );
      case 'unindexed-item': {
        const { item } = row;
        return (
          <div {...stylex.props(styles.card)}>
            <div {...stylex.props(styles.fileHeaderRow)}>
              <div {...stylex.props(styles.fileTitleGroup)}>
                <span {...stylex.props(styles.fileIconWrap)}>
                  <FileTypeIcon name={item.name || item.virtualPath} size={16} />
                </span>
                <div {...stylex.props(styles.fileTitleCol)}>
                  <span {...stylex.props(styles.fileName)} onMouseEnter={syncOverflowTitle}>
                    {item.name}
                  </span>
                  <span
                    {...stylex.props(styles.fileVirtualPath)}
                    onMouseEnter={syncOverflowTitle}
                  >
                    {item.virtualPath}
                  </span>
                </div>
              </div>
              <span {...stylex.props(styles.fileMeta)}>{formatBytes(item.sizeBytes)}</span>
            </div>

            <div {...stylex.props(styles.actionsRow)}>
              <DrawerButton
                variant="primary"
                onClick={() => handleAccept(item)}
                disabled={isLocked}
              >
                Accept into Tsubasa
              </DrawerButton>
              <DrawerButton
                variant="secondary"
                onClick={() => handleMoveToRoot(item)}
                disabled={isLocked}
              >
                Eject to Drive root
              </DrawerButton>
            </div>
          </div>
        );
      }
      case 'modified-header':
        return (
          <DrawerSectionHeader
            title="Modified files"
            count={row.count.toLocaleString()}
          />
        );
      case 'modified-item': {
        const { item } = row;
        return (
          <div {...stylex.props(styles.card)}>
            <div {...stylex.props(styles.fileHeaderRow)}>
              <div {...stylex.props(styles.fileTitleGroup)}>
                <span {...stylex.props(styles.fileIconWrap)}>
                  <FileTypeIcon name={item.name || item.virtualPath} size={16} />
                </span>
                <div {...stylex.props(styles.fileTitleCol)}>
                  <span {...stylex.props(styles.fileName)} onMouseEnter={syncOverflowTitle}>
                    {item.name}
                  </span>
                  <span
                    {...stylex.props(styles.fileVirtualPath)}
                    onMouseEnter={syncOverflowTitle}
                  >
                    {item.virtualPath}
                  </span>
                </div>
              </div>
              <span {...stylex.props(styles.fileMeta)}>{formatBytes(item.sizeBytes)}</span>
            </div>

            <div {...stylex.props(styles.actionsRow)}>
              <DrawerButton
                variant="primary"
                onClick={() => handleAccept(item)}
                disabled={isLocked}
              >
                Accept update
              </DrawerButton>
            </div>
          </div>
        );
      }
      case 'missingRemote-header':
        return (
          <DrawerSectionHeader
            icon={<IconAlertTriangle size={14} color={colors.warning} />}
            title="Missing or externally moved files"
            count={row.count.toLocaleString()}
          />
        );
      case 'missingRemote-subbar':
        return (
          <div {...stylex.props(styles.sectionSubBar)}>
            <p {...stylex.props(styles.cardDesc)}>
              These files were moved outside the Tsubasa folder structure or removed directly in Google Drive.
            </p>
          </div>
        );
      case 'missingRemote-item': {
        const { item } = row;
        const baseName = item.virtualPath.split('/').filter(Boolean).pop() || item.virtualPath;
        return (
          <div {...stylex.props(styles.card)}>
            <div {...stylex.props(styles.fileHeaderRow)}>
              <div {...stylex.props(styles.fileTitleGroup)}>
                <span {...stylex.props(styles.fileIconWrap)}>
                  <FileTypeIcon name={item.virtualPath} size={16} />
                </span>
                <div {...stylex.props(styles.fileTitleCol)}>
                  <span {...stylex.props(styles.fileName)} onMouseEnter={syncOverflowTitle}>
                    {baseName}
                  </span>
                  <span {...stylex.props(styles.fileVirtualPath)} onMouseEnter={syncOverflowTitle}>
                    {item.virtualPath}
                  </span>
                </div>
              </div>
            </div>

            <div {...stylex.props(styles.actionsRow)}>
              <DrawerButton
                variant="danger"
                onClick={() => handleRemoveMissing(item)}
                disabled={isLocked}
              >
                Remove from Tsubasa
              </DrawerButton>
            </div>
          </div>
        );
      }
      case 'rebalance-banner':
        return (
          <div {...stylex.props(styles.rebalanceBanner)}>
            <div {...stylex.props(styles.rebalanceTitle)}>
              Auto-rebalance files
            </div>
            <p {...stylex.props(styles.cardDesc)}>
              This account breached its 750 MB safety buffer. Auto-rebalance moves Tsubasa files to an emptier account in your pool to restore safe headroom.
            </p>
            <div>
              <DrawerButton
                variant="secondary"
                onClick={handleAutoRebalance}
                disabled={isLocked}
              >
                {activeActionId === 'rebalance' ? 'Rebalancing...' : 'Auto-rebalance'}
              </DrawerButton>
            </div>
          </div>
        );
    }
  };

  if (!isOpen) return null;

  return (
    <DrawerSheet
      isOpen={isOpen}
      isLocked={isLocked}
      onClose={onClose}
      ariaLabel="External modifications"
      title="External changes"
      icon={<IconAlertTriangle size={16} />}
      closeAriaLabel="Close drawer"
      hideMobileBackdrop={isMobileSidebarOpen}
    >
      <div {...stylex.props(styles.accountSelectorBar)}>
        <div {...stylex.props(styles.selectWrapper)}>
          <select
            aria-label="Select connected account"
            {...stylex.props(styles.select)}
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
            disabled={accounts.length === 0 || isLocked}
          >
            {accounts.length === 0 ? (
              <option value="" disabled>
                No accounts with external changes
              </option>
            ) : (
              accounts.map((acc) => (
                <option
                  key={acc.id}
                  value={acc.id}
                >
                  {acc.displayName || acc.id} ({acc.email || acc.id})
                </option>
              ))
            )}
          </select>
          <div {...stylex.props(styles.selectChevron)}>
            <IconChevronDown size={11} strokeWidth={2.5} />
          </div>
        </div>
        <DrawerButton
          variant="secondary"
          style={styles.rescanBtn}
          onClick={() => void scanAccount(selectedAccount, true)}
          disabled={isScanning || isLocked || !selectedAccount}
        >
          {isScanning ? 'Scanning...' : 'Rescan'}
        </DrawerButton>
      </div>

      {statusNotice && (
        <div {...stylex.props(styles.statusNoticeBanner)}>
          {statusNotice}
        </div>
      )}

      <div ref={contentScrollRef} tabIndex={-1} {...stylex.props(styles.contentScroll)}>
        {shouldVirtualize ? (
          <div
            {...stylex.props(styles.virtualListInner)}
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = displayRows[virtualRow.index];
              if (!row) return null;

              return (
                <div
                  key={row.key}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  {...stylex.props(styles.virtualRow)}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {renderDisplayRow(row)}
                </div>
              );
            })}
          </div>
        ) : (
          displayRows.map((row) => (
            <React.Fragment key={row.key}>
              {renderDisplayRow(row)}
            </React.Fragment>
          ))
        )}

        {isScanning && !report && (
          <div {...stylex.props(styles.scanningNotice)}>
            <div {...stylex.props(styles.scanningNoticeText)}>
              Scanning Drive for external changes...
            </div>
          </div>
        )}

        {!isScanning && accounts.length === 0 && (
          <div {...stylex.props(styles.emptyNotice)}>
            <IconCheck size={28} color={colors.success} />
            <div {...stylex.props(styles.emptyNoticeTitle)}>
              All accounts in sync
            </div>
            <p {...stylex.props(styles.cardDesc)}>
              No external modifications or over-ceiling files detected across any connected drives.
            </p>
          </div>
        )}

        {report !== null && accounts.length > 0 && totalDiscrepancies === 0 && !showRebalance && (
          <div {...stylex.props(styles.emptyNotice)}>
            <IconCheck size={28} color={colors.success} />
            <div {...stylex.props(styles.emptyNoticeTitle)}>
              Account in sync
            </div>
            <p {...stylex.props(styles.cardDesc)}>
              No external modifications or over-ceiling files detected on {selectedAccount}.
            </p>
          </div>
        )}
      </div>
    </DrawerSheet>
  );
}

