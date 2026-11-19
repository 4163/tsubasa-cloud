import React from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { FileTypeIcon, IconCheck, IconAlertTriangle, IconChevronDown, IconFolderFilled } from './Icons.js';
import { formatBytes, formatSignedBytes } from '../utils/format.js';
import { evaluateAccountTransferCandidate } from '../utils/accountTransfer.js';
import { DrawerButton } from './DrawerPrimitives.js';
import {
  CEILING_14_25_GB,
  type NormalizedUploadItem,
  type UploadFolderGroup,
  type UploadFolderSummary,
} from '../utils/uploadQueueModel.js';
import type {
  AccountItem,
  UploadConflictAction,
  UploadContentMatchStatus,
  ExistingPoolFile,
  PlacementItemPreview,
  FileProgressState,
} from '../types.js';

const styles = stylex.create({
  progressBarComplete: {
    backgroundColor: colors.success,
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
  fileCardRejected: {
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
  fileIcon: {
    color: colors.brandAccent,
    flexShrink: 0,
    marginTop: '2px',
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
  fileMeta: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.primaryText,
    fontVariantNumeric: 'tabular-nums',
    fontWeight: typography.fontWeightTitle,
    flexShrink: 0,
  },
  selectWrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    maxWidth: '180px',
  },
  accountSelect: {
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    height: '22px',
    lineHeight: '18px',
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: spacing.space2,
    paddingRight: '22px',
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccentSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.brandAccent,
    maxWidth: '180px',
    outline: 'none',
    cursor: 'pointer',
    boxSizing: 'border-box',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    transitionProperty: 'background-color, opacity',
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easingOut,
    ':hover': {
      borderColor: colors.accentGold,
      backgroundColor: colors.surfaceAlt,
    },
    ':focus': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    ':focus-visible': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
  selectChevron: {
    position: 'absolute',
    right: '7px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: colors.brandAccent,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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
  badgeError: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.dangerBorder,
    color: colors.dangerTextOnSurface,
  },
  badgeSuccess: {
    backgroundColor: colors.successSurface,
    borderColor: colors.borderSubtle,
    color: colors.success,
    gap: '3px',
  },
  badgeWarning: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warningBorder,
    color: colors.warning,
    gap: '3px',
  },
  badgeMuted: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderSubtle,
    color: colors.secondaryText,
  },
  miniProgressContainer: {
    width: '100%',
    height: '3px',
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    overflow: 'hidden',
  },
  miniProgressFill: {
    width: '100%',
    height: '100%',
    backgroundColor: colors.brandAccent,
    borderRadius: radius.pill,
    transformOrigin: 'left center',
    transition: motion.transitionFast,
  },
  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    flexWrap: 'wrap',
  },
  conflictHintText: {
    fontSize: typography.fontSizeMeta,
    color: colors.warning,
    fontWeight: '500',
    minWidth: 0,
  },
  skippedNoticeText: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontWeight: '500',
  },
  fileCardSkipped: {
    opacity: 0.78,
  },
  poolFolderIcon: {
    display: 'inline-flex',
    color: colors.poolGold,
    flexShrink: 0,
    marginTop: '2px',
  },
  folderSubMeta: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
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
  fileCeilingWarning: {
    fontSize: typography.fontSizeMeta,
    color: colors.danger,
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
});

export interface UploadFileCardProps {
  item: NormalizedUploadItem;
  preview?: PlacementItemPreview;
  progress?: FileProgressState;
  existingFile?: ExistingPoolFile;
  existingAcc?: AccountItem;
  contentMatch?: UploadContentMatchStatus;
  canHoldUpload: boolean;
  canHoldReplace: boolean;
  conflictAction?: UploadConflictAction;
  selectedAccountId?: string;
  chosenAcc?: AccountItem;
  accounts: AccountItem[];
  isUploading: boolean;
  isPlanning: boolean;
  planError: string | null;
  onSelectAccount: (key: string, accountId: string) => void;
  onSelectConflictAction: (key: string, action: UploadConflictAction) => void;
}

export const UploadFileCard = React.memo(function UploadFileCard({
  item,
  preview,
  progress,
  existingFile,
  existingAcc,
  contentMatch,
  canHoldUpload,
  canHoldReplace,
  conflictAction,
  selectedAccountId,
  chosenAcc,
  accounts,
  isUploading,
  isPlanning,
  planError,
  onSelectAccount,
  onSelectConflictAction,
}: UploadFileCardProps) {
  const isRejected = item.file.size > CEILING_14_25_GB || preview?.rejected;
  const pct = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
  const chosenAccountId = selectedAccountId || preview?.targetAccountId || '';
  const effectiveConflictAction: UploadConflictAction | undefined = existingFile
    ? conflictAction ?? 'skip'
    : undefined;
  const isSkipped = effectiveConflictAction === 'skip';
  const isComplete = progress?.status === 'complete';
  const isSameSize = Boolean(existingFile && existingFile.sizeBytes === item.file.size);
  const resolvedMatch: UploadContentMatchStatus =
    contentMatch ??
    (existingFile
      ? isSameSize
        ? existingFile.hash
          ? 'checking'
          : item.file.size === 0
            ? 'identical'
            : 'unverified'
        : 'different'
      : 'different');
  const isIdentical = resolvedMatch === 'identical';
  const conflictControlsDisabled = isUploading || isComplete;
  const conflictComparisonText =
    resolvedMatch === 'checking'
      ? 'Checking contents...'
      : resolvedMatch === 'identical'
        ? 'Byte-for-byte identical'
        : resolvedMatch === 'unverified'
          ? 'Same size (no checksum stored)'
          : isSameSize
            ? 'Same size, different content'
            : 'Different size';
  const netDeltaBytes = existingFile ? item.file.size - existingFile.sizeBytes : 0;

  return (
    <div
      {...stylex.props(
        styles.fileCard,
        isRejected && styles.fileCardRejected,
        isSkipped && !isComplete && styles.fileCardSkipped
      )}
    >
      <div {...stylex.props(styles.fileCardHeader)}>
        <div {...stylex.props(styles.fileInfoGroup)}>
          <FileTypeIcon name={item.file.name || item.virtualPath} size={16} {...stylex.props(styles.fileIcon)} />
          <div {...stylex.props(styles.fileTitleCol)}>
            <span {...stylex.props(styles.fileName)} title={item.virtualPath}>
              {item.file.name}
            </span>
            <span {...stylex.props(styles.fileVirtualPath)} title={item.virtualPath}>
              {item.virtualPath}
            </span>
          </div>
        </div>

        {isRejected ? (
          <span {...stylex.props(styles.badge, styles.badgeError)}>
            &gt; 14.25 GB Ceiling
          </span>
        ) : isComplete ? (
          <span {...stylex.props(styles.badge, styles.badgeSuccess)}>
            <IconCheck size={12} /> Complete
          </span>
        ) : progress?.status === 'error' ? (
          <span {...stylex.props(styles.badge, styles.badgeError)} title={progress.error}>
            {progress.error === 'Cancelled' ? 'Cancelled' : 'Failed'}
          </span>
        ) : isSkipped && existingFile ? (
          <span {...stylex.props(styles.badge, isIdentical ? styles.badgeMuted : styles.badgeWarning)}>
            {isIdentical ? 'Already uploaded' : 'Skipped'}
          </span>
        ) : (
          <span {...stylex.props(styles.fileMeta)}>{formatBytes(item.file.size)}</span>
        )}
      </div>

      {isRejected && (
        <div {...stylex.props(styles.fileCeilingWarning)}>
          <IconAlertTriangle size={12} />
          Single file ceiling exceeded. Files must fit within 14.25 GB to preserve 750 MB reserve.
        </div>
      )}

      {!isRejected && progress?.status === 'error' && progress.error && progress.error !== 'Cancelled' && (
        <div {...stylex.props(styles.fileCeilingWarning)}>
          <IconAlertTriangle size={12} />
          {progress.error}
        </div>
      )}

      {!isRejected && existingFile && !isComplete && (
        <span {...stylex.props(isSkipped ? styles.skippedNoticeText : styles.conflictHintText)}>
          Existing: {formatBytes(existingFile.sizeBytes)}
          {existingAcc ? ` on ${existingAcc.displayName || existingAcc.id}` : ''}
          {' · '}
          {conflictComparisonText}
          {effectiveConflictAction === 'replace' ? ` · ${formatSignedBytes(netDeltaBytes)} net` : ''}
        </span>
      )}

      {!isRejected && ((existingFile && !isComplete) || !isSkipped) && (
        <div {...stylex.props(styles.actionsRow)}>
          {existingFile &&
            !isComplete &&
            (
              [
                { value: 'skip', label: 'Skip' },
                { value: 'replace', label: 'Replace' },
                { value: 'keep_both', label: 'Keep both' },
              ] as const
            ).map((opt) => {
              const active = effectiveConflictAction === opt.value;
              const lacksCapacity =
                opt.value === 'replace'
                  ? !canHoldReplace
                  : opt.value === 'keep_both'
                  ? !canHoldUpload
                  : false;
              const disabledReason = lacksCapacity
                ? `No drive has enough headroom or 24h transfer quota for ${formatBytes(item.file.size)}`
                : undefined;
              return (
                <DrawerButton
                  key={opt.value}
                  variant={active ? 'primary' : 'secondary'}
                  aria-pressed={active}
                  disabled={conflictControlsDisabled || lacksCapacity}
                  title={disabledReason}
                  onClick={() => onSelectConflictAction(item.key, opt.value)}
                >
                  {opt.label}
                </DrawerButton>
              );
            })}

          {!isSkipped &&
            (accounts.length > 0 ? (
              <div {...stylex.props(styles.selectWrapper)}>
                <select
                  aria-label={`Select target drive for ${item.virtualPath}`}
                  title={chosenAcc ? `${chosenAcc.displayName || chosenAcc.id} (${chosenAcc.email || chosenAcc.id})` : 'Select drive'}
                  value={chosenAccountId}
                  disabled={isUploading || isComplete}
                  {...stylex.props(styles.accountSelect)}
                  onChange={(e) => onSelectAccount(item.key, e.target.value)}
                >
                  {!chosenAccountId && (
                    <option value="" disabled>
                      {isPlanning ? 'Calculating...' : 'Select drive...'}
                    </option>
                  )}
                  {accounts.map((acc) => {
                    const freedBytes =
                      effectiveConflictAction === 'replace' && existingFile && acc.id === existingFile.accountId
                        ? existingFile.sizeBytes
                        : 0;
                    const { canHold, optionTitle, optionLabel } = evaluateAccountTransferCandidate(
                      acc,
                      item.file.size,
                      {
                        freedBytes,
                        isAutoSelected: acc.id === preview?.targetAccountId,
                        compactHeadroomLabel: true,
                      },
                    );

                    return (
                      <option key={acc.id} value={acc.id} disabled={!canHold} title={optionTitle}>
                        {optionLabel}
                      </option>
                    );
                  })}
                </select>
                <div {...stylex.props(styles.selectChevron)}>
                  <IconChevronDown size={10} strokeWidth={2.5} />
                </div>
              </div>
            ) : preview?.targetAccountId ? (
              <span {...stylex.props(styles.badge)}>
                {preview.targetAccountId}
              </span>
            ) : planError ? (
              <span {...stylex.props(styles.badge, styles.badgeError)} title={planError}>
                Unallocated
              </span>
            ) : (
              <span {...stylex.props(styles.badge)}>Calculating...</span>
            ))}
        </div>
      )}

      {progress && (progress.status === 'uploading' || progress.status === 'complete') && (
        <div {...stylex.props(styles.miniProgressContainer)}>
          <div
            {...stylex.props(
              styles.miniProgressFill,
              progress.status === 'complete' && styles.progressBarComplete
            )}
            style={{ transform: `scaleX(${Math.min(100, Math.max(0, pct)) / 100})` }}
          />
        </div>
      )}
    </div>
  );
});

export interface UploadFolderCardProps {
  group: UploadFolderGroup;
  summary: UploadFolderSummary;
  singleTargetAcc?: AccountItem;
  isExpanded: boolean;
  isUploading: boolean;
  isPlanning: boolean;
  onToggleExpand: (groupKey: string) => void;
  onApplyFolderConflictAction: (groupKey: string, action: UploadConflictAction) => void;
}

export const UploadFolderCard = React.memo(function UploadFolderCard({
  group,
  summary,
  singleTargetAcc,
  isExpanded,
  isUploading,
  isPlanning,
  onToggleExpand,
  onApplyFolderConflictAction,
}: UploadFolderCardProps) {
  const {
    rejectedCount,
    skippedCount,
    completedCount,
    uploadingCount,
    errorCount,
    identicalSkippedCount,
    actionableCount,
    actionableBytes,
    replacedBytes,
    loadedBytes,
    editableConflictCount,
    uniformFolderConflictAction,
    targetAccountCount,
    folderCanFitReplace,
    folderCanFitKeepBoth,
  } = summary;

  const allRejected = rejectedCount === group.items.length;
  const allComplete = actionableCount > 0 && completedCount === actionableCount;
  const allSkipped = !allRejected && actionableCount === 0 && skippedCount > 0;
  const pct = actionableBytes > 0 ? Math.round((loadedBytes / actionableBytes) * 100) : 0;
  const netDeltaBytes = actionableBytes - replacedBytes;

  return (
    <div
      {...stylex.props(
        styles.fileCard,
        allRejected && styles.fileCardRejected,
        allSkipped && !allComplete && styles.fileCardSkipped
      )}
    >
      <div {...stylex.props(styles.fileCardHeader)}>
        <div {...stylex.props(styles.fileInfoGroup)}>
          <span {...stylex.props(styles.poolFolderIcon)}>
            <IconFolderFilled size={16} />
          </span>
          <div {...stylex.props(styles.fileTitleCol)}>
            <span {...stylex.props(styles.fileName)} title={group.folderPath}>
              {group.name}
            </span>
            <span {...stylex.props(styles.fileVirtualPath)} title={group.folderPath}>
              {group.folderPath}
            </span>
          </div>
        </div>

        {allRejected ? (
          <span {...stylex.props(styles.badge, styles.badgeError)}>
            &gt; 14.25 GB Ceiling
          </span>
        ) : allComplete ? (
          <span {...stylex.props(styles.badge, styles.badgeSuccess)}>
            <IconCheck size={12} /> Complete
          </span>
        ) : uploadingCount > 0 ? (
          <span {...stylex.props(styles.badge)}>
            Uploading {completedCount}/{actionableCount}
          </span>
        ) : errorCount > 0 ? (
          <span {...stylex.props(styles.badge, styles.badgeError)}>
            {errorCount} failed
          </span>
        ) : allSkipped ? (
          <span
            {...stylex.props(
              styles.badge,
              identicalSkippedCount === skippedCount ? styles.badgeMuted : styles.badgeWarning
            )}
          >
            {identicalSkippedCount === skippedCount ? 'Already uploaded' : 'Skipped'}
          </span>
        ) : editableConflictCount > 0 ? (
          <span {...stylex.props(styles.badge, styles.badgeWarning)}>
            {editableConflictCount} {editableConflictCount === 1 ? 'conflict' : 'conflicts'}
          </span>
        ) : singleTargetAcc ? (
          <span {...stylex.props(styles.badge)} title={singleTargetAcc.email || singleTargetAcc.id}>
            {singleTargetAcc.displayName || singleTargetAcc.id}
          </span>
        ) : targetAccountCount > 1 ? (
          <span {...stylex.props(styles.badge)}>
            {targetAccountCount} drives
          </span>
        ) : isPlanning ? (
          <span {...stylex.props(styles.badge)}>Calculating...</span>
        ) : (
          <span {...stylex.props(styles.fileMeta)}>{formatBytes(group.totalBytes)}</span>
        )}
      </div>

      <div {...stylex.props(styles.folderSubMeta)}>
        {group.items.length} {group.items.length === 1 ? 'file' : 'files'}
        {group.subfolderCount > 0
          ? ` · ${group.subfolderCount} ${group.subfolderCount === 1 ? 'subfolder' : 'subfolders'}`
          : ''}
        {skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}
        {` · ${formatBytes(skippedCount > 0 ? actionableBytes : group.totalBytes)}`}
        {replacedBytes > 0 ? ` (${formatSignedBytes(netDeltaBytes)} net)` : ''}
      </div>

      {!allRejected && editableConflictCount > 0 && (
        <span {...stylex.props(uniformFolderConflictAction === 'skip' ? styles.skippedNoticeText : styles.conflictHintText)}>
          {editableConflictCount} {editableConflictCount === 1 ? 'file already exists' : 'files already exist'}
        </span>
      )}

      {(uploadingCount > 0 || (completedCount > 0 && allComplete)) && (
        <div {...stylex.props(styles.miniProgressContainer)}>
          <div
            {...stylex.props(
              styles.miniProgressFill,
              allComplete && styles.progressBarComplete
            )}
            style={{ transform: `scaleX(${Math.min(100, Math.max(0, pct)) / 100})` }}
          />
        </div>
      )}

      <div {...stylex.props(styles.actionsRow)}>
        {!allRejected &&
          editableConflictCount > 0 &&
          (
            [
              { value: 'skip', label: 'Skip all' },
              { value: 'replace', label: 'Replace all' },
              { value: 'keep_both', label: 'Keep both' },
            ] as const
          ).map((opt) => {
            const active = uniformFolderConflictAction === opt.value;
            const lacksCapacity =
              opt.value === 'replace'
                ? !folderCanFitReplace
                : opt.value === 'keep_both'
                ? !folderCanFitKeepBoth
                : false;
            return (
              <DrawerButton
                key={opt.value}
                variant={active ? 'primary' : 'secondary'}
                aria-pressed={active}
                disabled={isUploading || lacksCapacity}
                title={
                  lacksCapacity
                    ? 'Insufficient pool headroom or 24h transfer quota for all conflicting files in this folder'
                    : undefined
                }
                onClick={() => onApplyFolderConflictAction(group.key, opt.value)}
              >
                {opt.label}
              </DrawerButton>
            );
          })}

        <DrawerButton
          variant="secondary"
          aria-expanded={isExpanded}
          onClick={() => onToggleExpand(group.key)}
        >
          {isExpanded ? 'Hide individual files' : 'Review individually'}
        </DrawerButton>
      </div>
    </div>
  );
});
