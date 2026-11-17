import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useVirtualizer } from '@tanstack/react-virtual';
import { client } from '../api.js';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconUpload, FileTypeIcon, IconCheck, IconAlertTriangle, IconChevronDown, IconFolder, IconFolderFilled, IconRotateCcw } from './Icons.js';
import { formatBytes, formatSignedBytes } from '../utils/format.js';
import { verifyFileMatchesHash, type FileContentVerification } from '../utils/fileHash.js';
import { DAILY_UPLOAD_LIMIT_BYTES, evaluateAccountTransferCandidate } from '../utils/accountTransfer.js';
import { DrawerSectionHeader, DrawerButton, DrawerSheet } from './DrawerPrimitives.js';
import type { AccountItem } from './Sidebar.js';

export type UploadConflictAction = 'skip' | 'replace' | 'keep_both';
export type UploadContentMatchStatus = FileContentVerification | 'checking';

export interface ExistingPoolFile {
  id: string;
  virtualPath: string;
  name: string;
  sizeBytes: number;
  hash: string | null;
  accountId: string;
  updatedAt: number;
}

export interface StagedItem {
  file: File;
  virtualPath: string;
}

export interface PlacementItemPreview {
  virtualPath: string;
  sizeBytes: number;
  targetAccountId?: string;
  rejected?: boolean;
  rejectReason?: string;
}

export interface FileProgressState {
  loaded: number;
  total: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

interface NormalizedUploadItem {
  file: File;
  virtualPath: string;
  key: string;
}

interface UploadFolderGroup {
  key: string;
  name: string;
  folderPath: string;
  items: NormalizedUploadItem[];
  subfolderCount: number;
  totalBytes: number;
}

interface UploadFolderSummary {
  rejectedCount: number;
  skippedCount: number;
  completedCount: number;
  uploadingCount: number;
  errorCount: number;
  identicalSkippedCount: number;
  actionableCount: number;
  actionableBytes: number;
  replacedBytes: number;
  loadedBytes: number;
  editableConflictCount: number;
  uniformFolderConflictAction: UploadConflictAction | null;
  targetAccountCount: number;
  singleTargetAccId: string | null;
  folderCanFitReplace: boolean;
  folderCanFitKeepBoth: boolean;
}

type UploadDisplayRow =
  | { kind: 'section_header'; key: string; title: string; count: number }
  | { kind: 'loose_file'; key: string; item: NormalizedUploadItem }
  | { kind: 'folder_group'; key: string; group: UploadFolderGroup }
  | { kind: 'folder_child_file'; key: string; item: NormalizedUploadItem; parentFolderPath: string }
  | { kind: 'empty_folder'; key: string; name: string; folderPath: string };

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

const CEILING_14_25_GB = 14.25 * 1024 * 1024 * 1024;
const PROGRESS_THROTTLE_MS = 120;
const MAX_CONCURRENT_UPLOADS = 3;
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
      outlineOffset: '-1px',
    },
    ':focus-visible': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
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

interface UploadFileCardProps {
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

const UploadFileCard = React.memo(function UploadFileCard({
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

interface UploadFolderCardProps {
  group: UploadFolderGroup;
  summary: UploadFolderSummary;
  singleTargetAcc?: AccountItem;
  isExpanded: boolean;
  isUploading: boolean;
  isPlanning: boolean;
  onToggleExpand: (groupKey: string) => void;
  onApplyFolderConflictAction: (groupKey: string, action: UploadConflictAction) => void;
}

const UploadFolderCard = React.memo(function UploadFolderCard({
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
  const [previews, setPreviews] = useState<PlacementItemPreview[]>([]);
  const [conflictsByPath, setConflictsByPath] = useState<Record<string, ExistingPoolFile>>({});
  const [contentMatchByKey, setContentMatchByKey] = useState<Record<string, UploadContentMatchStatus>>({});
  const [conflictActions, setConflictActions] = useState<Record<string, UploadConflictAction>>({});
  const [isPlanning, setIsPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planAttempt, setPlanAttempt] = useState(0);
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({});
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [hasCreatedEmptyFolders, setHasCreatedEmptyFolders] = useState(false);

  const [isUploading, setIsUploading] = useState(false);
  const [fileProgress, setFileProgress] = useState<Record<string, FileProgressState>>({});

  const progressRef = useRef<Record<string, FileProgressState>>({});
  const hasCreatedEmptyFoldersRef = useRef(false);
  const verifiedHashCacheRef = useRef<Map<string, UploadContentMatchStatus>>(new Map());
  const requestCloseRef = useRef<((afterClose?: () => void) => void) | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastFlushRef = useRef<number>(0);
  const xhrMapRef = useRef<Map<string, XMLHttpRequest>>(new Map());
  const abortedRef = useRef(false);
  const fileListRef = useRef<HTMLDivElement | null>(null);

  const flushProgressImmediate = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    lastFlushRef.current = performance.now();
    setFileProgress({ ...progressRef.current });
  }, []);

  const scheduleProgressFlush = useCallback(() => {
    if (rafIdRef.current !== null) return;
    const tick = (now: number) => {
      if (now - lastFlushRef.current >= PROGRESS_THROTTLE_MS) {
        rafIdRef.current = null;
        lastFlushRef.current = now;
        setFileProgress({ ...progressRef.current });
      } else {
        rafIdRef.current = requestAnimationFrame(tick);
      }
    };
    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

  const clearActiveXhrs = useCallback(() => {
    for (const xhr of xhrMapRef.current.values()) {
      xhr.abort();
    }
    xhrMapRef.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      abortedRef.current = true;
      clearActiveXhrs();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [clearActiveXhrs]);

  const normalizedItems = useMemo<NormalizedUploadItem[]>(() => {
    return stagedFiles.map((item, index) => {
      if ('virtualPath' in item && 'file' in item) {
        const vPath = item.virtualPath.startsWith('/') ? item.virtualPath : '/' + item.virtualPath;
        return {
          file: item.file,
          virtualPath: vPath,
          key: `${vPath}::${index}`,
        };
      }
      const rel = (item as File & { webkitRelativePath?: string }).webkitRelativePath || item.name;
      const cleanBase = currentPath === '/' ? '' : currentPath;
      const vPath = `${cleanBase}/${rel}`.replace(/\/+/g, '/');
      return {
        file: item,
        virtualPath: vPath,
        key: `${vPath}::${index}`,
      };
    });
  }, [stagedFiles, currentPath]);

  const previewByPath = useMemo(() => {
    const map = new Map<string, PlacementItemPreview>();
    for (const p of previews) {
      map.set(p.virtualPath, p);
    }
    return map;
  }, [previews]);

  const accountById = useMemo(() => {
    const map = new Map<string, AccountItem>();
    for (const acc of accounts) {
      map.set(acc.id, acc);
    }
    return map;
  }, [accounts]);

  const conflictItems = useMemo(() => {
    return normalizedItems.filter(
      (it) => it.file.size <= CEILING_14_25_GB && Boolean(conflictsByPath[it.virtualPath])
    );
  }, [normalizedItems, conflictsByPath]);

  const skippedCount = useMemo(() => {
    let count = 0;
    for (const it of conflictItems) {
      if ((conflictActions[it.key] ?? 'skip') === 'skip') {
        count += 1;
      }
    }
    return count;
  }, [conflictItems, conflictActions]);

  const actionableItems = useMemo(() => {
    return normalizedItems.filter((it) => {
      if (it.file.size > CEILING_14_25_GB) return false;
      const hasConflict = Boolean(conflictsByPath[it.virtualPath]);
      if (hasConflict && (conflictActions[it.key] ?? 'skip') === 'skip') {
        return false;
      }
      return true;
    });
  }, [normalizedItems, conflictsByPath, conflictActions]);

  const unstartedActionableItems = useMemo(() => {
    return actionableItems.filter((it) => {
      const status = fileProgress[it.key]?.status;
      return !status || status === 'pending';
    });
  }, [actionableItems, fileProgress]);

  const { totalBytes, actionableBytes, replacedBytes, netDeltaBytes, allRejected } = useMemo(() => {
    let allBytes = 0;
    for (const it of normalizedItems) {
      allBytes += it.file.size;
    }
    let activeBytes = 0;
    let repBytes = 0;
    for (const it of actionableItems) {
      activeBytes += it.file.size;
      const existing = conflictsByPath[it.virtualPath];
      if (existing && conflictActions[it.key] === 'replace') {
        repBytes += existing.sizeBytes;
      }
    }
    const allExceed = normalizedItems.length > 0 && normalizedItems.every((it) => it.file.size > CEILING_14_25_GB);
    return {
      totalBytes: allBytes,
      actionableBytes: activeBytes,
      replacedBytes: repBytes,
      netDeltaBytes: activeBytes - repBytes,
      allRejected: allExceed,
    };
  }, [normalizedItems, actionableItems, conflictsByPath, conflictActions]);

  const { totalPoolHeadroom, totalPoolUploadBudget, canHoldFile } = useMemo(() => {
    if (accounts.length === 0) {
      return {
        totalPoolHeadroom: Infinity,
        totalPoolUploadBudget: Infinity,
        canHoldFile: () => true,
      };
    }

    const activeEligible = accounts.filter((acc) => !acc.isDisabled && acc.authorized);
    const headroomSum = activeEligible.reduce((sum, acc) => sum + Math.max(0, acc.headroomBytes), 0);
    const budgetSum = activeEligible.reduce(
      (sum, acc) => sum + Math.max(0, acc.transferStats?.remainingUploadBytes24h ?? DAILY_UPLOAD_LIMIT_BYTES),
      0
    );

    return {
      totalPoolHeadroom: headroomSum,
      totalPoolUploadBudget: budgetSum,
      canHoldFile: (
        sizeBytes: number,
        existingFile?: Pick<ExistingPoolFile, 'accountId' | 'sizeBytes'>,
      ) =>
        activeEligible.some((acc) =>
          evaluateAccountTransferCandidate(acc, sizeBytes, {
            freedBytes:
              existingFile && acc.id === existingFile.accountId ? existingFile.sizeBytes : 0,
          }).canHold
        ),
    };
  }, [accounts]);

  const emptyFoldersKey = useMemo(() => stagedEmptyFolders.join('\0'), [stagedEmptyFolders]);

  // Reset per-session progress and conflict overrides whenever staged items change
  useEffect(() => {
    setConflictsByPath({});
    setContentMatchByKey({});
    setConflictActions({});
    setExpandedFolders({});
    progressRef.current = {};
    hasCreatedEmptyFoldersRef.current = false;
    setHasCreatedEmptyFolders(false);
    verifiedHashCacheRef.current.clear();
    setFileProgress({});
    setSelectedAccounts({});
  }, [isOpen, normalizedItems, emptyFoldersKey, poolId]);

  // Verify byte-for-byte identity only when a conflicting file shares the existing file's exact size
  useEffect(() => {
    if (!isOpen || conflictItems.length === 0) {
      setContentMatchByKey({});
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    const immediate: Record<string, UploadContentMatchStatus> = {};
    const toVerify: Array<{
      item: NormalizedUploadItem;
      existing: ExistingPoolFile;
      cacheKey: string;
    }> = [];

    for (const item of conflictItems) {
      const existing = conflictsByPath[item.virtualPath];
      if (!existing) continue;
      const cacheKey = `${item.key}::${existing.id}::${existing.hash ?? ''}`;
      const cached = verifiedHashCacheRef.current.get(cacheKey);
      if (cached) {
        immediate[item.key] = cached;
      } else if (item.file.size !== existing.sizeBytes) {
        immediate[item.key] = 'different';
      } else if (!existing.hash) {
        immediate[item.key] = item.file.size === 0 ? 'identical' : 'unverified';
      } else {
        immediate[item.key] = 'checking';
        toVerify.push({ item, existing, cacheKey });
      }
    }

    setContentMatchByKey(immediate);
    if (toVerify.length === 0) return;

    void (async () => {
      for (const entry of toVerify) {
        if (signal.aborted) break;
        try {
          const result = await verifyFileMatchesHash(
            entry.item.file,
            entry.existing.sizeBytes,
            entry.existing.hash,
            signal
          );
          if (signal.aborted) break;
          verifiedHashCacheRef.current.set(entry.cacheKey, result);
          setContentMatchByKey((prev) => ({ ...prev, [entry.item.key]: result }));
        } catch (err) {
          if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) break;
          setContentMatchByKey((prev) => ({ ...prev, [entry.item.key]: 'unverified' }));
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [isOpen, conflictItems, conflictsByPath]);

  // Request placement plan whenever staged files or conflict choices change
  useEffect(() => {
    if (!isOpen || normalizedItems.length === 0) {
      setPreviews([]);
      setPlanError(null);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    setIsPlanning(true);
    setPlanError(null);

    const items: PlacementItemPreview[] = normalizedItems.map((it) => {
      const isOverCeiling = it.file.size > CEILING_14_25_GB;
      return {
        virtualPath: it.virtualPath,
        sizeBytes: it.file.size,
        rejected: isOverCeiling,
        rejectReason: isOverCeiling ? 'Exceeds 14.25 GB single-account ceiling' : undefined,
      };
    });

    const eligibleRequestItems = normalizedItems
      .filter((it) => it.file.size <= CEILING_14_25_GB)
      .map((it) => ({
        virtualPath: it.virtualPath,
        sizeBytes: it.file.size,
        conflictAction: conflictActions[it.key],
      }));

    if (eligibleRequestItems.length === 0) {
      setPreviews(items);
      setIsPlanning(false);
      return;
    }

    client.api.storage.placement.batch
      .$post(
        {
          json: {
            items: eligibleRequestItems,
            poolId,
          },
        },
        { init: { signal } }
      )
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(('error' in errData ? errData.error : null) || `Planning error ${res.status}`);
        }
        return res.json();
      })
      .then((planData) => {
        if (signal.aborted) return;
        const nextConflicts =
          planData &&
          typeof planData === 'object' &&
          'conflicts' in planData &&
          planData.conflicts &&
          typeof planData.conflicts === 'object'
            ? (planData.conflicts as Record<string, ExistingPoolFile>)
            : {};
        setConflictsByPath(nextConflicts);

        const decisions = Array.isArray(planData.decisions) ? planData.decisions : [];
        const decisionByPath = new Map<string, { virtualPath: string; accountId?: string }>();
        for (const d of decisions) {
          if (d && typeof d.virtualPath === 'string') {
            decisionByPath.set(d.virtualPath, d);
          }
        }

        const mapped: PlacementItemPreview[] = items.map((orig) => {
          if (orig.rejected) return orig;
          const matched = decisionByPath.get(orig.virtualPath);
          return {
            ...orig,
            targetAccountId: matched?.accountId,
          };
        });
        setPreviews(mapped);
      })
      .catch((err) => {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setPlanError(err instanceof Error ? err.message : String(err));
        setPreviews(items);
      })
      .finally(() => {
        if (!signal.aborted) setIsPlanning(false);
      });

    return () => {
      controller.abort();
    };
  }, [isOpen, normalizedItems, poolId, conflictActions, planAttempt]);

  const overallProgress = useMemo(() => {
    let totalLoaded = 0;
    let completedCount = 0;
    let activeCount = 0;
    for (const it of actionableItems) {
      const p = fileProgress[it.key];
      if (p) {
        totalLoaded += p.loaded;
        if (p.status === 'complete') completedCount += 1;
        else if (p.status === 'uploading') activeCount += 1;
      }
    }
    const percent =
      actionableBytes > 0 ? Math.min(100, Math.round((totalLoaded / actionableBytes) * 100)) : 0;
    return { totalLoaded, percent, completedCount, activeCount };
  }, [actionableItems, fileProgress, actionableBytes]);

  const failedItems = useMemo(() => {
    return actionableItems.filter((it) => fileProgress[it.key]?.status === 'error');
  }, [actionableItems, fileProgress]);

  const runUploadQueue = useCallback(
    async (itemsToUpload: NormalizedUploadItem[], createEmptyFolders: boolean) => {
      const shouldCreateEmptyFolders = createEmptyFolders && stagedEmptyFolders.length > 0;
      if (isUploading || (itemsToUpload.length === 0 && !shouldCreateEmptyFolders)) return;

      abortedRef.current = false;
      setIsUploading(true);

      let succeededCount = 0;

      try {
        if (shouldCreateEmptyFolders) {
          setPlanError(null);
          let folderError: string | null = null;
          for (const folderPath of stagedEmptyFolders) {
            if (abortedRef.current) break;
            try {
              const name = folderPath.split('/').filter(Boolean).pop() || folderPath;
              const res = await client.api.folders.$post({
                json: { virtualPath: folderPath, name, poolId },
              });
              if (res.ok || res.status === 409) {
                succeededCount += 1;
              } else {
                let errMsg = `Failed to create folder "${folderPath}" (${res.status})`;
                try {
                  const errData = await res.json();
                  if (
                    errData &&
                    typeof errData === 'object' &&
                    'error' in errData &&
                    typeof errData.error === 'string'
                  ) {
                    errMsg = errData.error;
                  }
                } catch {}
                folderError = folderError ?? errMsg;
              }
            } catch (err) {
              const errMsg =
                err instanceof Error ? err.message : `Failed to create folder "${folderPath}"`;
              folderError = folderError ?? errMsg;
            }
          }
          if (folderError) {
            setPlanError(folderError);
          }
          if (!abortedRef.current && !folderError) {
            hasCreatedEmptyFoldersRef.current = true;
            setHasCreatedEmptyFolders(true);
          }
        }

        if (itemsToUpload.length > 0) {
          const wasAborted = abortedRef.current;
          const nextProgress = { ...progressRef.current };
          for (const it of itemsToUpload) {
            nextProgress[it.key] = wasAborted
              ? {
                  loaded: 0,
                  total: it.file.size,
                  status: 'error',
                  error: 'Cancelled',
                }
              : {
                  loaded: 0,
                  total: it.file.size,
                  status: it.file.size > CEILING_14_25_GB ? 'error' : 'pending',
                };
          }
          progressRef.current = nextProgress;
          flushProgressImmediate();

          if (!wasAborted) {
            const eligibleQueue = itemsToUpload.filter((it) => {
              if (it.file.size > CEILING_14_25_GB) return false;
              if (conflictsByPath[it.virtualPath] && (conflictActions[it.key] ?? 'skip') === 'skip') {
                return false;
              }
              return true;
            });

            // Group items by target accountId for per-account fairness across the concurrency-3 pool
            const accountQueues = new Map<string, Array<{ item: NormalizedUploadItem; accountId?: string }>>();
            for (const item of eligibleQueue) {
              const chosenAccountId =
                selectedAccounts[item.key] || previewByPath.get(item.virtualPath)?.targetAccountId;
              const bucketKey = chosenAccountId || '__auto__';
              let bucket = accountQueues.get(bucketKey);
              if (!bucket) {
                bucket = [];
                accountQueues.set(bucketKey, bucket);
              }
              bucket.push({ item, accountId: chosenAccountId });
            }

            const accountKeys = Array.from(accountQueues.keys());
            const activePerAccount = new Map<string, number>();
            let roundRobinCursor = 0;

            const dequeueNext = (): { bucketKey: string; item: NormalizedUploadItem; accountId?: string } | null => {
              if (abortedRef.current || accountKeys.length === 0) return null;

              let bestKey: string | null = null;
              let bestActive = Infinity;

              for (let offset = 0; offset < accountKeys.length; offset++) {
                const idx = (roundRobinCursor + offset) % accountKeys.length;
                const k = accountKeys[idx];
                const q = accountQueues.get(k);
                if (!q || q.length === 0) continue;
                const active = activePerAccount.get(k) ?? 0;
                if (active < bestActive) {
                  bestActive = active;
                  bestKey = k;
                  if (active === 0) break;
                }
              }

              if (!bestKey) return null;
              roundRobinCursor = (accountKeys.indexOf(bestKey) + 1) % accountKeys.length;
              const q = accountQueues.get(bestKey)!;
              const next = q.shift()!;
              activePerAccount.set(bestKey, (activePerAccount.get(bestKey) ?? 0) + 1);
              return { bucketKey: bestKey, item: next.item, accountId: next.accountId };
            };

            const uploadSingleItem = (item: NormalizedUploadItem, chosenAccountId?: string) => {
              const accountParam = chosenAccountId ? `&accountId=${encodeURIComponent(chosenAccountId)}` : '';
              const conflict = conflictsByPath[item.virtualPath];
              const chosenAction = conflict ? conflictActions[item.key] ?? 'skip' : undefined;
              const conflictMode =
                chosenAction === 'replace'
                  ? 'replace'
                  : chosenAction === 'keep_both'
                  ? 'keep_both'
                  : 'reject';

              progressRef.current[item.key] = {
                loaded: 0,
                total: item.file.size,
                status: 'uploading',
              };
              flushProgressImmediate();

              return new Promise<void>((resolve) => {
                if (abortedRef.current) {
                  progressRef.current[item.key] = {
                    loaded: 0,
                    total: item.file.size,
                    status: 'error',
                    error: 'Cancelled',
                  };
                  flushProgressImmediate();
                  resolve();
                  return;
                }

                const xhr = new XMLHttpRequest();
                xhrMapRef.current.set(item.key, xhr);

                const uploadUrl = `/api/files/upload?virtualPath=${encodeURIComponent(item.virtualPath)}&sizeBytes=${item.file.size}&mimeType=${encodeURIComponent(item.file.type || 'application/octet-stream')}${accountParam}&poolId=${encodeURIComponent(String(poolId))}&conflictMode=${encodeURIComponent(conflictMode)}`;

                xhr.upload.onprogress = (e) => {
                  if (e.lengthComputable) {
                    progressRef.current[item.key] = {
                      loaded: e.loaded,
                      total: e.total,
                      status: 'uploading',
                    };
                    scheduleProgressFlush();
                  }
                };

                xhr.onload = () => {
                  xhrMapRef.current.delete(item.key);
                  if (xhr.status >= 200 && xhr.status < 300) {
                    progressRef.current[item.key] = {
                      loaded: item.file.size,
                      total: item.file.size,
                      status: 'complete',
                    };
                    succeededCount += 1;
                  } else {
                    let errMsg = `Upload failed (${xhr.status})`;
                    try {
                      const parsed = JSON.parse(xhr.responseText);
                      if (parsed.error) errMsg = parsed.error;
                    } catch {}
                    progressRef.current[item.key] = {
                      loaded: 0,
                      total: item.file.size,
                      status: 'error',
                      error: errMsg,
                    };
                  }
                  flushProgressImmediate();
                  resolve();
                };

                xhr.onerror = () => {
                  xhrMapRef.current.delete(item.key);
                  progressRef.current[item.key] = {
                    loaded: 0,
                    total: item.file.size,
                    status: 'error',
                    error: 'Network stream error',
                  };
                  flushProgressImmediate();
                  resolve();
                };

                xhr.onabort = () => {
                  xhrMapRef.current.delete(item.key);
                  progressRef.current[item.key] = {
                    loaded: 0,
                    total: item.file.size,
                    status: 'error',
                    error: 'Cancelled',
                  };
                  flushProgressImmediate();
                  resolve();
                };

                try {
                  xhr.open('POST', uploadUrl, true);
                  xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
                  xhr.send(item.file);
                } catch (err) {
                  xhrMapRef.current.delete(item.key);
                  progressRef.current[item.key] = {
                    loaded: 0,
                    total: item.file.size,
                    status: 'error',
                    error: err instanceof Error ? err.message : 'Failed to start upload',
                  };
                  flushProgressImmediate();
                  resolve();
                }
              });
            };

            const workerCount = Math.min(MAX_CONCURRENT_UPLOADS, eligibleQueue.length);
            const workers = Array.from({ length: workerCount }, async () => {
              while (!abortedRef.current) {
                const entry = dequeueNext();
                if (!entry) break;
                try {
                  await uploadSingleItem(entry.item, entry.accountId);
                } finally {
                  activePerAccount.set(entry.bucketKey, Math.max(0, (activePerAccount.get(entry.bucketKey) ?? 1) - 1));
                }
              }
            });

            await Promise.all(workers);
          }
        }
      } finally {
        xhrMapRef.current.clear();
        setIsUploading(false);
      }

      if (succeededCount > 0) {
        await onUploadComplete();
      }
    },
    [
      isUploading,
      stagedEmptyFolders,
      poolId,
      conflictsByPath,
      conflictActions,
      flushProgressImmediate,
      scheduleProgressFlush,
      selectedAccounts,
      previewByPath,
      onUploadComplete,
    ]
  );

  const handleStartUpload = useCallback(() => {
    const shouldCreateEmpty = !hasCreatedEmptyFoldersRef.current && stagedEmptyFolders.length > 0;
    if (unstartedActionableItems.length === 0 && !shouldCreateEmpty) return;
    void runUploadQueue(unstartedActionableItems, shouldCreateEmpty);
  }, [runUploadQueue, unstartedActionableItems, stagedEmptyFolders.length]);

  const handleRetryFailed = useCallback(() => {
    if (failedItems.length === 0) return;
    void runUploadQueue(failedItems, false);
  }, [runUploadQueue, failedItems]);

  const handleAbortUpload = useCallback(() => {
    abortedRef.current = true;
    clearActiveXhrs();
    const nextProgress = { ...progressRef.current };
    for (const key of Object.keys(nextProgress)) {
      const entry = nextProgress[key];
      if (entry && (entry.status === 'pending' || entry.status === 'uploading')) {
        nextProgress[key] = {
          loaded: 0,
          total: entry.total,
          status: 'error',
          error: 'Cancelled',
        };
      }
    }
    progressRef.current = nextProgress;
    flushProgressImmediate();
  }, [clearActiveXhrs, flushProgressImmediate]);

  const handleSelectAccount = useCallback((key: string, accountId: string) => {
    setSelectedAccounts((prev) => ({ ...prev, [key]: accountId }));
  }, []);

  const handleSelectConflictAction = useCallback((key: string, action: UploadConflictAction) => {
    setConflictActions((prev) => ({ ...prev, [key]: action }));
  }, []);

  const handleApplyBatchConflictAction = useCallback(
    (action: UploadConflictAction) => {
      setConflictActions((prev) => {
        const next = { ...prev };
        for (const it of conflictItems) {
          if (fileProgress[it.key]?.status !== 'complete') {
            next[it.key] = action;
          }
        }
        return next;
      });
    },
    [conflictItems, fileProgress]
  );

  const hasUnallocatedFiles = useMemo(() => {
    return unstartedActionableItems.some((it) => {
      const chosen = selectedAccounts[it.key] || previewByPath.get(it.virtualPath)?.targetAccountId;
      return !chosen;
    });
  }, [unstartedActionableItems, selectedAccounts, previewByPath]);

  const { folderGroupByKey, displayRows } = useMemo(() => {
    const normalizedBase = currentPath === '/' ? '' : currentPath.replace(/\/+$/, '');
    const getRelAndBase = (vPath: string) => {
      if (normalizedBase && vPath.startsWith(`${normalizedBase}/`)) {
        return { rel: vPath.slice(normalizedBase.length + 1), base: normalizedBase };
      }
      return { rel: vPath.replace(/^\/+/, ''), base: '' };
    };

    type MutableGroup = UploadFolderGroup & { subfolders: Set<string> };
    const topEntries: Array<
      | { kind: 'loose_file'; item: NormalizedUploadItem }
      | { kind: 'folder'; group: MutableGroup }
    > = [];
    const groupByPath = new Map<string, MutableGroup>();

    const recordNestedDirs = (group: MutableGroup, relWithinFolder: string) => {
      const parts = relWithinFolder.split('/').filter(Boolean);
      let acc = '';
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        group.subfolders.add(acc);
      }
    };

    for (const item of normalizedItems) {
      const { rel, base } = getRelAndBase(item.virtualPath);
      const slashIdx = rel.indexOf('/');
      if (slashIdx === -1) {
        topEntries.push({ kind: 'loose_file', item });
        continue;
      }

      const topFolderName = rel.slice(0, slashIdx);
      const folderPath = base ? `${base}/${topFolderName}` : `/${topFolderName}`;
      let group = groupByPath.get(folderPath);
      if (!group) {
        group = {
          key: `folder::${folderPath}`,
          name: topFolderName,
          folderPath,
          items: [],
          subfolderCount: 0,
          totalBytes: 0,
          subfolders: new Set<string>(),
        };
        groupByPath.set(folderPath, group);
        topEntries.push({ kind: 'folder', group });
      }
      group.items.push(item);
      group.totalBytes += item.file.size;

      const remainder = rel.slice(slashIdx + 1);
      const lastSlash = remainder.lastIndexOf('/');
      if (lastSlash > 0) {
        recordNestedDirs(group, remainder.slice(0, lastSlash));
      }
    }

    const seenEmptyPaths = new Set<string>();
    const standaloneEmptyFolders: Array<{ key: string; name: string; folderPath: string }> = [];
    for (const rawEmptyPath of stagedEmptyFolders) {
      const emptyPath = rawEmptyPath.startsWith('/') ? rawEmptyPath : `/${rawEmptyPath}`;
      const normalizedEmptyPath = emptyPath.replace(/\/+$/, '') || '/';
      if (seenEmptyPaths.has(normalizedEmptyPath)) continue;
      seenEmptyPaths.add(normalizedEmptyPath);
      const { rel, base } = getRelAndBase(normalizedEmptyPath);
      const parts = rel.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      const topFolderName = parts[0];
      const topFolderPath = base ? `${base}/${topFolderName}` : `/${topFolderName}`;
      const existingGroup = groupByPath.get(topFolderPath);
      if (existingGroup) {
        if (parts.length > 1) {
          recordNestedDirs(existingGroup, parts.slice(1).join('/'));
        }
      } else {
        const displayName = parts.join('/');
        standaloneEmptyFolders.push({
          key: `empty::${normalizedEmptyPath}`,
          name: displayName,
          folderPath: normalizedEmptyPath,
        });
      }
    }

    const groupsMap = new Map<string, UploadFolderGroup>();
    const looseEntries: NormalizedUploadItem[] = [];
    const folderEntries: UploadFolderGroup[] = [];

    for (const entry of topEntries) {
      if (entry.kind === 'loose_file') {
        looseEntries.push(entry.item);
        continue;
      }

      const finalizedGroup: UploadFolderGroup = {
        key: entry.group.key,
        name: entry.group.name,
        folderPath: entry.group.folderPath,
        items: entry.group.items,
        subfolderCount: entry.group.subfolders.size,
        totalBytes: entry.group.totalBytes,
      };
      groupsMap.set(finalizedGroup.key, finalizedGroup);
      folderEntries.push(finalizedGroup);
    }

    const rows: UploadDisplayRow[] = [];
    const totalFolderItems = folderEntries.length + standaloneEmptyFolders.length;

    if (totalFolderItems > 0) {
      rows.push({
        kind: 'section_header',
        key: 'section::folders',
        title: 'Folders',
        count: totalFolderItems,
      });

      for (const finalizedGroup of folderEntries) {
        rows.push({
          kind: 'folder_group',
          key: finalizedGroup.key,
          group: finalizedGroup,
        });

        if (expandedFolders[finalizedGroup.key]) {
          for (const child of finalizedGroup.items) {
            rows.push({
              kind: 'folder_child_file',
              key: child.key,
              item: child,
              parentFolderPath: finalizedGroup.folderPath,
            });
          }
        }
      }

      for (const emptyEntry of standaloneEmptyFolders) {
        rows.push({
          kind: 'empty_folder',
          key: emptyEntry.key,
          name: emptyEntry.name,
          folderPath: emptyEntry.folderPath,
        });
      }
    }

    if (looseEntries.length > 0) {
      rows.push({
        kind: 'section_header',
        key: 'section::files',
        title: 'Files',
        count: looseEntries.length,
      });

      for (const item of looseEntries) {
        rows.push({
          kind: 'loose_file',
          key: item.key,
          item,
        });
      }
    }

    return { folderGroupByKey: groupsMap, displayRows: rows };
  }, [normalizedItems, stagedEmptyFolders, currentPath, expandedFolders]);

  const folderSummaryByKey = useMemo(() => {
    const map = new Map<string, UploadFolderSummary>();
    const isEligibleAccount = (accId: string) => {
      if (accounts.length === 0) return true;
      const acc = accountById.get(accId);
      return Boolean(acc && !acc.isDisabled && acc.authorized);
    };

    for (const [groupKey, group] of folderGroupByKey.entries()) {
      let rejectedCount = 0;
      let skippedCount = 0;
      let completedCount = 0;
      let uploadingCount = 0;
      let errorCount = 0;
      let identicalSkippedCount = 0;
      let actionableCount = 0;
      let actionableBytes = 0;
      let replacedBytes = 0;
      let loadedBytes = 0;
      let basePendingBytes = 0;
      let editableConflictBytes = 0;
      let editableConflictCount = 0;
      let uniformAction: UploadConflictAction | null = null;
      let uniformMismatch = false;
      let canHoldAllReplace = true;
      let canHoldAllKeepBoth = true;
      let freedReplaceHeadroom = 0;
      let firstTargetAccId: string | null = null;
      let hasMultipleTargets = false;
      const seenTargets = new Set<string>();

      for (const item of group.items) {
        const preview = previewByPath.get(item.virtualPath);
        const isRejected = item.file.size > CEILING_14_25_GB || Boolean(preview?.rejected);
        if (isRejected) {
          rejectedCount += 1;
          continue;
        }

        const existingFile = conflictsByPath[item.virtualPath];
        const effectiveAction: UploadConflictAction | undefined = existingFile
          ? conflictActions[item.key] ?? 'skip'
          : undefined;
        const progress = fileProgress[item.key];
        const isComplete = progress?.status === 'complete';

        if (existingFile && !isComplete) {
          editableConflictCount += 1;
          editableConflictBytes += item.file.size;
          const actionChoice = conflictActions[item.key] ?? 'skip';
          if (uniformAction === null) {
            uniformAction = actionChoice;
          } else if (uniformAction !== actionChoice) {
            uniformMismatch = true;
          }
          if (canHoldAllReplace && !canHoldFile(item.file.size, existingFile)) {
            canHoldAllReplace = false;
          }
          if (canHoldAllKeepBoth && !canHoldFile(item.file.size)) {
            canHoldAllKeepBoth = false;
          }
          if (isEligibleAccount(existingFile.accountId)) {
            freedReplaceHeadroom += existingFile.sizeBytes;
          }
        } else if (!isComplete) {
          basePendingBytes += item.file.size;
        }

        if (effectiveAction === 'skip') {
          skippedCount += 1;
          if (contentMatchByKey[item.key] === 'identical') {
            identicalSkippedCount += 1;
          }
          continue;
        }

        actionableCount += 1;
        actionableBytes += item.file.size;
        if (existingFile && effectiveAction === 'replace') {
          replacedBytes += existingFile.sizeBytes;
        }

        const chosenAccountId = selectedAccounts[item.key] || preview?.targetAccountId;
        if (chosenAccountId) {
          if (firstTargetAccId === null) {
            firstTargetAccId = chosenAccountId;
          } else if (chosenAccountId !== firstTargetAccId) {
            hasMultipleTargets = true;
          }
          seenTargets.add(chosenAccountId);
        }

        if (progress?.status === 'complete') {
          completedCount += 1;
          loadedBytes += item.file.size;
        } else if (progress?.status === 'uploading') {
          uploadingCount += 1;
          loadedBytes += progress.loaded;
        } else if (progress?.status === 'error') {
          errorCount += 1;
        }
      }

      const neededTransferBytes = basePendingBytes + editableConflictBytes;
      const neededReplaceHeadroom = neededTransferBytes - freedReplaceHeadroom;

      map.set(groupKey, {
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
        uniformFolderConflictAction: uniformMismatch ? null : uniformAction,
        targetAccountCount: seenTargets.size,
        singleTargetAccId: !hasMultipleTargets ? firstTargetAccId : null,
        folderCanFitReplace:
          canHoldAllReplace &&
          neededReplaceHeadroom <= totalPoolHeadroom &&
          neededTransferBytes <= totalPoolUploadBudget,
        folderCanFitKeepBoth:
          canHoldAllKeepBoth &&
          neededTransferBytes <= totalPoolHeadroom &&
          neededTransferBytes <= totalPoolUploadBudget,
      });
    }

    return map;
  }, [
    folderGroupByKey,
    accounts.length,
    accountById,
    previewByPath,
    conflictsByPath,
    conflictActions,
    fileProgress,
    contentMatchByKey,
    selectedAccounts,
    canHoldFile,
    totalPoolHeadroom,
    totalPoolUploadBudget,
  ]);

  const handleToggleFolderExpand = useCallback((groupKey: string) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [groupKey]: !prev[groupKey],
    }));
  }, []);

  const handleApplyFolderConflictAction = useCallback(
    (groupKey: string, action: UploadConflictAction) => {
      const group = folderGroupByKey.get(groupKey);
      if (!group) return;
      setConflictActions((prev) => {
        const next = { ...prev };
        for (const it of group.items) {
          if (
            it.file.size <= CEILING_14_25_GB &&
            conflictsByPath[it.virtualPath] &&
            fileProgress[it.key]?.status !== 'complete'
          ) {
            next[it.key] = action;
          }
        }
        return next;
      });
    },
    [folderGroupByKey, conflictsByPath, fileProgress]
  );

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

  const batchConflictSelection = useMemo(() => {
    const editableConflicts = conflictItems.filter((it) => fileProgress[it.key]?.status !== 'complete');
    if (editableConflicts.length === 0) return null;
    const first = conflictActions[editableConflicts[0].key] ?? 'skip';
    for (let i = 1; i < editableConflicts.length; i++) {
      if ((conflictActions[editableConflicts[i].key] ?? 'skip') !== first) {
        return null;
      }
    }
    return first;
  }, [conflictItems, conflictActions, fileProgress]);
  const hasEditableConflicts = useMemo(
    () => conflictItems.some((it) => fileProgress[it.key]?.status !== 'complete'),
    [conflictItems, fileProgress]
  );
  const { batchCanFitReplace, batchCanFitKeepBoth } = useMemo(() => {
    let neededTransferBytes = 0;
    let freedReplaceHeadroom = 0;
    let canHoldAllReplace = true;
    let canHoldAllKeepBoth = true;

    for (const it of normalizedItems) {
      if (it.file.size > CEILING_14_25_GB) continue;
      if (fileProgress[it.key]?.status === 'complete') continue;
      const existing = conflictsByPath[it.virtualPath];
      if (existing) {
        if (canHoldAllReplace && !canHoldFile(it.file.size, existing)) {
          canHoldAllReplace = false;
        }
        if (canHoldAllKeepBoth && !canHoldFile(it.file.size)) {
          canHoldAllKeepBoth = false;
        }
        const existingAccount = accounts.length === 0 ? null : accountById.get(existing.accountId);
        if (accounts.length === 0 || (existingAccount && !existingAccount.isDisabled && existingAccount.authorized)) {
          freedReplaceHeadroom += existing.sizeBytes;
        }
      }
      neededTransferBytes += it.file.size;
    }

    const neededReplaceHeadroom = neededTransferBytes - freedReplaceHeadroom;
    return {
      batchCanFitReplace:
        canHoldAllReplace &&
        neededReplaceHeadroom <= totalPoolHeadroom &&
        neededTransferBytes <= totalPoolUploadBudget,
      batchCanFitKeepBoth:
        canHoldAllKeepBoth &&
        neededTransferBytes <= totalPoolHeadroom &&
        neededTransferBytes <= totalPoolUploadBudget,
    };
  }, [
    normalizedItems,
    fileProgress,
    conflictsByPath,
    canHoldFile,
    accounts.length,
    accountById,
    totalPoolHeadroom,
    totalPoolUploadBudget,
  ]);

  const hasPendingEmptyFolders = !hasCreatedEmptyFolders && stagedEmptyFolders.length > 0;
  const allActionableComplete =
    actionableItems.length > 0 && overallProgress.completedCount === actionableItems.length;
  const allConflictsSkipped =
    !allRejected && actionableItems.length === 0 && conflictItems.length > 0;
  const startUploadDisabled =
    isUploading ||
    (isPlanning &&
      unstartedActionableItems.length > 0 &&
      !unstartedActionableItems.every((it) => selectedAccounts[it.key])) ||
    (unstartedActionableItems.length === 0 && !hasPendingEmptyFolders) ||
    hasUnallocatedFiles;
  const startUploadTitle =
    allActionableComplete && !hasPendingEmptyFolders
      ? 'All staged files are already uploaded'
      : allConflictsSkipped && !hasPendingEmptyFolders
      ? 'All staged files already exist in the destination'
      : failedItems.length > 0 && unstartedActionableItems.length === 0 && !hasPendingEmptyFolders
      ? 'Use Retry failed to re-attempt failed uploads'
      : undefined;

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
              {!isPlanning && (
                <DrawerButton variant="secondary" onClick={() => setPlanAttempt((n) => n + 1)}>
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

