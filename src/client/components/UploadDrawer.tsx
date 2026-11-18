import React, { useCallback, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useVirtualizer } from '@tanstack/react-virtual';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import {
  IconClose,
  IconUpload,
  IconAlertTriangle,
  IconFolder,
  IconFolderFilled,
  IconRotateCcw,
} from './Icons.js';
import { formatBytes, formatSignedBytes } from '../utils/format.js';
import { DrawerSectionHeader, DrawerButton, DrawerSheet } from './DrawerPrimitives.js';
import { useUploadQueue } from '../hooks/useUploadQueue.js';
import type { UploadDisplayRow } from '../utils/uploadQueueModel.js';
import { UploadFileCard, UploadFolderCard } from './UploadDrawerCards.js';
import type { AccountItem, StagedItem } from '../types.js';

interface UploadDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  stagedFiles: Array<File | StagedItem>;
  stagedEmptyFolders?: string[];
  currentPath: string;
  accounts?: AccountItem[];
  poolId?: number;
  onUploadComplete: () => Promise<void>;
  onClearFiles: () => void;
}

const VIRTUALIZE_THRESHOLD = 30;
const EMPTY_FOLDERS: string[] = [];

const styles = stylex.create({
  summaryBar: {
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    flexShrink: 0,
  },
  summaryMainRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
  },
  destinationGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
    flex: 1,
  },
  destinationLabel: {
    fontSize: typography.fontSizeMeta,
    color: colors.dimText,
    fontWeight: '500',
    flexShrink: 0,
  },
  destinationPath: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.primaryText,
    maxWidth: '220px',
    minWidth: 0,
  },
  destinationIcon: {
    flexShrink: 0,
  },
  destinationPathText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  stagedStats: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontWeight: '500',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  progressBarContainer: {
    width: '100%',
    height: '3px',
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
    transition: motion.transitionNormal,
  },
  progressBarComplete: {
    backgroundColor: colors.success,
  },
  fileList: {
    flex: 1,
    overflowY: 'auto',
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    paddingRight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  fileCard: {
    position: 'relative',
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderRadius: radius.none,
    borderWidth: '0px',
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
  fileCardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.space3,
  },
  fileInfoGroup: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.space4,
    minWidth: 0,
    flex: 1,
  },
  fileName: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  badge: {
    height: '20px',
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyBody,
    fontWeight: typography.fontWeightBadge,
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.selectionBg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.primaryText,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  badgeMuted: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderSubtle,
    color: colors.secondaryText,
  },
  footer: {
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.space2,
    flexShrink: 0,
  },
  secondaryBtn: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    color: colors.secondaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
      borderColor: colors.primaryText,
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
  primaryBtn: {
    height: '32px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
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
  planErrorBanner: {
    position: 'relative',
    marginTop: 0,
    marginBottom: 0,
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderRadius: radius.none,
    borderWidth: '0px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.dangerSurface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
    flexWrap: 'wrap',
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
  planErrorNotice: {
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    color: colors.danger,
  },
  conflictBanner: {
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
    flexShrink: 0,
  },
  conflictBannerTop: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    color: colors.warning,
  },
  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    flexWrap: 'wrap',
  },
  poolFolderIcon: {
    display: 'inline-flex',
    color: colors.poolGold,
    flexShrink: 0,
    marginTop: '2px',
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
  dangerBtn: {
    height: '32px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderRadius: radius.compact,
    backgroundColor: colors.dangerSurface,
    color: colors.dangerTextOnSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.danger,
      color: colors.dangerText,
      borderColor: colors.danger,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
    },
  },
});

export function UploadDrawer({
  isOpen,
  onClose,
  stagedFiles,
  stagedEmptyFolders = EMPTY_FOLDERS,
  currentPath,
  accounts = [],
  poolId = 1,
  onUploadComplete,
  onClearFiles,
}: UploadDrawerProps) {
  const requestCloseRef = useRef<((afterClose?: () => void) => void) | null>(null);
  const fileListRef = useRef<HTMLDivElement | null>(null);

  const {
    normalizedItems,
    previewByPath,
    accountById,
    conflictsByPath,
    contentMatchByKey,
    conflictActions,
    isPlanning,
    planError,
    retryPlan,
    selectedAccounts,
    expandedFolders,
    hasCreatedEmptyFolders,
    isUploading,
    fileProgress,
    conflictItems,
    skippedCount,
    actionableBytes,
    totalBytes,
    replacedBytes,
    netDeltaBytes,
    canHoldFile,
    overallProgress,
    failedItems,
    displayRows,
    folderSummaryByKey,
    batchConflictSelection,
    hasEditableConflicts,
    batchCanFitReplace,
    batchCanFitKeepBoth,
    allActionableComplete,
    startUploadDisabled,
    startUploadTitle,
    clearActiveXhrs,
    handleStartUpload,
    handleRetryFailed,
    handleAbortUpload,
    handleSelectAccount,
    handleSelectConflictAction,
    handleApplyBatchConflictAction,
    handleToggleFolderExpand,
    handleApplyFolderConflictAction,
  } = useUploadQueue({
    isOpen,
    stagedFiles,
    stagedEmptyFolders,
    currentPath,
    accounts,
    poolId,
    onUploadComplete,
  });

  const shouldVirtualize = displayRows.length > VIRTUALIZE_THRESHOLD;

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? displayRows.length : 0,
    getScrollElement: () => fileListRef.current,
    estimateSize: () => 96,
    getItemKey: (index) => displayRows[index]?.key ?? index,
    overscan: 6,
  });

  const handleClearAndClose = useCallback(() => {
    clearActiveXhrs();
    if (requestCloseRef.current) {
      requestCloseRef.current(() => onClearFiles());
    } else {
      onClearFiles();
      onClose();
    }
  }, [clearActiveXhrs, onClearFiles, onClose]);

  const renderDisplayRow = (row: UploadDisplayRow) => {
    if (row.kind === 'section_header') {
      return <DrawerSectionHeader title={row.title} count={row.count} />;
    }

    if (row.kind === 'folder_group') {
      const summary = folderSummaryByKey.get(row.group.key);
      if (!summary) return null;
      const singleTargetAcc = summary.singleTargetAccId
        ? accountById.get(summary.singleTargetAccId)
        : undefined;
      return (
        <UploadFolderCard
          group={row.group}
          summary={summary}
          singleTargetAcc={singleTargetAcc}
          isExpanded={Boolean(expandedFolders[row.group.key])}
          isUploading={isUploading}
          isPlanning={isPlanning}
          onToggleExpand={handleToggleFolderExpand}
          onApplyFolderConflictAction={handleApplyFolderConflictAction}
        />
      );
    }

    if (row.kind === 'empty_folder') {
      return (
        <div {...stylex.props(styles.fileCard)}>
          <div {...stylex.props(styles.fileCardHeader)}>
            <div {...stylex.props(styles.fileInfoGroup)}>
              <span {...stylex.props(styles.poolFolderIcon)}>
                <IconFolderFilled size={16} />
              </span>
              <div {...stylex.props(styles.fileTitleCol)}>
                <span {...stylex.props(styles.fileName)} title={row.folderPath}>
                  {row.name}
                </span>
                <span {...stylex.props(styles.fileVirtualPath)} title={row.folderPath}>
                  {row.folderPath}
                </span>
              </div>
            </div>
            <span {...stylex.props(styles.badge, styles.badgeMuted)}>Empty folder</span>
          </div>
        </div>
      );
    }

    const item = row.item;
    const preview = previewByPath.get(item.virtualPath);
    const existingFile = conflictsByPath[item.virtualPath];
    const existingAcc = existingFile ? accountById.get(existingFile.accountId) : undefined;
    const selectedAccountId = selectedAccounts[item.key];
    const chosenAccountId = selectedAccountId || preview?.targetAccountId || '';
    const chosenAcc = chosenAccountId ? accountById.get(chosenAccountId) : undefined;

    return (
      <UploadFileCard
        item={item}
        preview={preview}
        progress={fileProgress[item.key]}
        existingFile={existingFile}
        existingAcc={existingAcc}
        contentMatch={contentMatchByKey[item.key]}
        canHoldUpload={canHoldFile(item.file.size)}
        canHoldReplace={existingFile ? canHoldFile(item.file.size, existingFile) : canHoldFile(item.file.size)}
        conflictAction={conflictActions[item.key]}
        selectedAccountId={selectedAccountId}
        chosenAcc={chosenAcc}
        accounts={accounts}
        isUploading={isUploading}
        isPlanning={isPlanning}
        planError={planError}
        onSelectAccount={handleSelectAccount}
        onSelectConflictAction={handleSelectConflictAction}
      />
    );
  };

  return (
    <DrawerSheet
      isOpen={isOpen}
      isLocked={isUploading}
      onClose={onClose}
      ariaLabel="Upload files"
      title="Upload & allocation"
      icon={<IconUpload size={16} strokeWidth={2.25} />}
      closeAriaLabel="Close upload drawer"
      requestCloseRef={requestCloseRef}
    >
      <div {...stylex.props(styles.summaryBar)}>
        <div {...stylex.props(styles.summaryMainRow)}>
          <div {...stylex.props(styles.destinationGroup)}>
            <span {...stylex.props(styles.destinationLabel)}>Destination:</span>
            <span {...stylex.props(styles.destinationPath)} title={currentPath}>
              <IconFolder size={12} {...stylex.props(styles.destinationIcon)} />
              <span {...stylex.props(styles.destinationPathText)}>
                {currentPath === '/' ? 'Root (/)' : currentPath}
              </span>
            </span>
          </div>
          <span {...stylex.props(styles.stagedStats)}>
            {normalizedItems.length} {normalizedItems.length === 1 ? 'file' : 'files'}
            {skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}
            {stagedEmptyFolders && stagedEmptyFolders.length > 0
              ? ` + ${stagedEmptyFolders.length} folder${stagedEmptyFolders.length === 1 ? '' : 's'}`
              : ''}{' '}
            · {formatBytes(skippedCount > 0 ? actionableBytes : totalBytes)}
            {replacedBytes > 0 ? ` (${formatSignedBytes(netDeltaBytes)} net)` : ''}
          </span>
        </div>

        {(isUploading || overallProgress.completedCount > 0) && (
          <div {...stylex.props(styles.progressBarContainer)}>
            <div
              {...stylex.props(
                styles.progressBarFill,
                allActionableComplete && !isUploading && styles.progressBarComplete
              )}
              style={{ transform: `scaleX(${Math.min(100, Math.max(0, overallProgress.percent)) / 100})` }}
            />
          </div>
        )}
      </div>

      {hasEditableConflicts && (
        <div {...stylex.props(styles.conflictBanner)}>
          <div {...stylex.props(styles.conflictBannerTop)}>
            <IconAlertTriangle size={14} />
            <span>
              {conflictItems.length} {conflictItems.length === 1 ? 'file already exists' : 'files already exist'}
            </span>
          </div>
          <div
            {...stylex.props(styles.actionsRow)}
            role="group"
            aria-label="Apply conflict action to all conflicting files"
          >
            {(
              [
                { value: 'skip', label: 'Skip all' },
                { value: 'replace', label: 'Replace all' },
                { value: 'keep_both', label: 'Keep both' },
              ] as const
            ).map((opt) => {
              const active = batchConflictSelection === opt.value;
              const lacksCapacity =
                opt.value === 'replace'
                  ? !batchCanFitReplace
                  : opt.value === 'keep_both'
                  ? !batchCanFitKeepBoth
                  : false;
              return (
                <DrawerButton
                  key={opt.value}
                  variant={active ? 'primary' : 'secondary'}
                  disabled={isUploading || lacksCapacity}
                  aria-pressed={active}
                  title={
                    lacksCapacity
                      ? 'Insufficient pool headroom or 24h transfer quota for all conflicting files'
                      : undefined
                  }
                  onClick={() => handleApplyBatchConflictAction(opt.value)}
                >
                  {opt.label}
                </DrawerButton>
              );
            })}
          </div>
        </div>
      )}

      <div ref={fileListRef} {...stylex.props(styles.fileList)}>
        {planError && (
          <div {...stylex.props(styles.planErrorBanner)}>
            <span {...stylex.props(styles.planErrorNotice)}>{planError}</span>
            {!isPlanning && !isUploading && (
              <DrawerButton
                variant="secondary"
                onClick={() => {
                  if (normalizedItems.length === 0 && stagedEmptyFolders.length > 0 && !hasCreatedEmptyFolders) {
                    void handleStartUpload();
                  } else {
                    retryPlan();
                  }
                }}
              >
                Retry allocation
              </DrawerButton>
            )}
          </div>
        )}

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
      </div>

      <div {...stylex.props(styles.footer)}>
        {isUploading ? (
          <button
            type="button"
            {...stylex.props(styles.dangerBtn)}
            onClick={handleAbortUpload}
          >
            <IconClose size={14} />
            Cancel upload
          </button>
        ) : (
          <>
            <button
              type="button"
              {...stylex.props(styles.secondaryBtn)}
              onClick={handleClearAndClose}
            >
              {allActionableComplete ? 'Close' : 'Cancel'}
            </button>

            {failedItems.length > 0 && (
              <button
                type="button"
                {...stylex.props(styles.secondaryBtn)}
                onClick={handleRetryFailed}
              >
                <IconRotateCcw size={14} /> Retry failed ({failedItems.length})
              </button>
            )}

            <button
              type="button"
              {...stylex.props(styles.primaryBtn)}
              onClick={handleStartUpload}
              disabled={startUploadDisabled}
              title={startUploadTitle}
            >
              <IconUpload size={16} strokeWidth={2.5} />
              Start upload
            </button>
          </>
        )}
      </div>
    </DrawerSheet>
  );
}
