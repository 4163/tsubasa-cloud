import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useVirtualizer } from '@tanstack/react-virtual';
import { client } from '../api.js';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconUpload, FileTypeIcon, IconCheck, IconAlertTriangle, IconChevronDown, IconChevronUp, IconFolder, IconMinus, IconRotateCcw } from './Icons.js';
import { formatBytes } from '../utils/format.js';
import { useBeforeUnload, useDialogLock } from '../utils/useBeforeUnload.js';
import type { AccountItem } from './Sidebar.js';

export interface StagedItem {
  file: File;
  virtualPath: string;
}

export interface PlacementItemPreview {
  virtualPath: string;
  sizeBytes: number;
  targetAccountId?: string;
  reason?: string;
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
  isMinimized?: boolean;
  onMinimize?: () => void;
  onRestore?: () => void;
}

const CEILING_14_25_GB = 14.25 * 1024 * 1024 * 1024;
const PROGRESS_THROTTLE_MS = 120;
const MAX_CONCURRENT_UPLOADS = 3;
const VIRTUALIZE_THRESHOLD = 30;

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: colors.modalBackdrop,
    zIndex: 90,
    transition: motion.transitionFast,
  },
  drawer: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: '420px',
    maxWidth: '100vw',
    backgroundColor: colors.surface,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    zIndex: 100,
    boxSizing: 'border-box',
    transform: 'translateX(0)',
    transition: 'transform 0.25s ease-out',
    '@media (max-width: 768px)': {
      width: '100vw',
    },
  },
  drawerHeader: {
    height: '56px',
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    backgroundColor: colors.surface,
  },
  titleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
  },
  title: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeTitle,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    margin: 0,
  },
  closeBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    color: colors.secondaryText,
    padding: spacing.space2,
    borderRadius: radius.compact,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
    ':disabled': {
      opacity: 0.35,
      cursor: 'not-allowed',
      backgroundColor: 'transparent',
      color: colors.secondaryText,
    },
    '@media (pointer: coarse)': {
      minWidth: '44px',
      minHeight: '44px',
    },
  },
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
  summarySubRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
    fontSize: typography.fontSizeMeta,
    color: colors.dimText,
  },
  statusIndicator: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontWeight: '500',
  },
  statusDot: {
    width: '6px',
    height: '6px',
    borderRadius: radius.pill,
    backgroundColor: colors.accentGold,
    flexShrink: 0,
  },
  statusDotActive: {
    backgroundColor: colors.brandAccent,
  },
  statusDotComplete: {
    backgroundColor: colors.success,
  },
  progressBarContainer: {
    width: '100%',
    height: '3px',
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    overflow: 'hidden',
    marginTop: spacing.space1,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.brandAccent,
    borderRadius: radius.pill,
    transition: 'width 0.2s ease',
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
    backgroundColor: 'transparent',
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
    },
    '@media (max-width: 768px)': {
      borderLeftWidth: '3px',
      borderLeftStyle: 'solid',
      borderLeftColor: 'transparent',
    },
  },
  fileCardRejected: {
    '::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      right: spacing.space2,
      width: '3px',
      backgroundColor: colors.danger,
      pointerEvents: 'none',
      display: {
        default: 'block',
        '@media (max-width: 768px)': 'none',
      },
    },
    '@media (max-width: 768px)': {
      borderLeftColor: colors.danger,
    },
  },
  fileCardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
  },
  fileInfoGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
    flex: 1,
  },
  fileIcon: {
    color: colors.brandAccent,
    flexShrink: 0,
  },
  fileName: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '600',
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileMeta: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
    fontWeight: '500',
    flexShrink: 0,
  },
  driveAllocationRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
    paddingTop: spacing.space1,
  },
  driveSelectorGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
    flex: 1,
  },
  driveLabel: {
    fontFamily: typography.fontFamilyBody,
    fontSize: '10px',
    fontWeight: '600',
    color: colors.dimText,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    flexShrink: 0,
  },
  selectWrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    flex: 1,
  },
  accountSelect: {
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    width: '100%',
    height: '24px',
    lineHeight: '20px',
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: spacing.space2,
    paddingRight: '22px',
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: '500',
    outline: 'none',
    cursor: 'pointer',
    boxSizing: 'border-box',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    transition: motion.transitionFast,
    ':hover': {
      borderColor: colors.brandAccent,
      backgroundColor: colors.surface,
    },
    ':focus': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
    ':disabled': {
      opacity: 0.6,
      cursor: 'not-allowed',
    },
  },
  selectChevron: {
    position: 'absolute',
    right: '6px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: colors.dimText,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.selectionBg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.primaryText,
    whiteSpace: 'nowrap',
  },
  badgeError: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
    color: colors.danger,
    fontWeight: '600',
  },
  badgeSuccess: {
    backgroundColor: colors.successSurface,
    borderColor: colors.success,
    color: colors.success,
    fontWeight: '600',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
  },
  miniProgressContainer: {
    width: '100%',
    height: '3px',
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    overflow: 'hidden',
    marginTop: spacing.space1,
  },
  miniProgressFill: {
    height: '100%',
    backgroundColor: colors.brandAccent,
    borderRadius: radius.pill,
    transition: 'width 0.15s ease',
  },
  footer: {
    padding: spacing.space5,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.space3,
    flexShrink: 0,
  },
  secondaryBtn: {
    height: '36px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderRadius: radius.button,
    backgroundColor: 'transparent',
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    cursor: 'pointer',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '56px',
    },
  },
  primaryBtn: {
    height: '36px',
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderRadius: radius.button,
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
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '56px',
    },
  },
  planErrorBanner: {
    position: 'relative',
    marginTop: spacing.space3,
    marginBottom: spacing.space2,
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderRadius: radius.none,
    borderWidth: '0px',
    backgroundColor: colors.dangerSurface,
    '::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      right: spacing.space2,
      width: '3px',
      backgroundColor: colors.danger,
      pointerEvents: 'none',
      display: {
        default: 'block',
        '@media (max-width: 768px)': 'none',
      },
    },
    '@media (max-width: 768px)': {
      borderLeftWidth: '3px',
      borderLeftStyle: 'solid',
      borderLeftColor: colors.danger,
    },
  },
  planErrorNotice: {
    fontSize: typography.fontSizeMeta,
    fontWeight: '600',
    color: colors.danger,
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
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space1,
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
    height: '36px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderRadius: radius.button,
    backgroundColor: colors.dangerSurface,
    color: colors.dangerTextOnSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '600',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
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
      outlineOffset: '-1px',
    },
    '@media (pointer: coarse)': {
      minHeight: '56px',
    },
  },
  pillContainer: {
    position: 'fixed',
    bottom: spacing.space6,
    right: spacing.space6,
    zIndex: 100,
    minWidth: '280px',
    maxWidth: '360px',
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.card,
    paddingTop: spacing.space4,
    paddingBottom: spacing.space4,
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space3,
  },
  pillMain: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space4,
  },
  pillLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
    flex: 1,
  },
  pillTextGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    minWidth: 0,
  },
  pillTitle: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '600',
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pillMeta: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  pillExpandBtn: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.button,
    color: colors.primaryText,
    cursor: 'pointer',
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: '600',
    flexShrink: 0,
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.brandAccent,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
  },
});

interface UploadFileCardProps {
  item: NormalizedUploadItem;
  preview?: PlacementItemPreview;
  progress?: FileProgressState;
  selectedAccountId?: string;
  chosenAcc?: AccountItem;
  accounts: AccountItem[];
  isUploading: boolean;
  isPlanning: boolean;
  planError: string | null;
  onSelectAccount: (key: string, accountId: string) => void;
}

const UploadFileCard = React.memo(function UploadFileCard({
  item,
  preview,
  progress,
  selectedAccountId,
  chosenAcc,
  accounts,
  isUploading,
  isPlanning,
  planError,
  onSelectAccount,
}: UploadFileCardProps) {
  const isRejected = item.file.size > CEILING_14_25_GB || preview?.rejected;
  const pct = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
  const chosenAccountId = selectedAccountId || preview?.targetAccountId || '';

  return (
    <div {...stylex.props(styles.fileCard, isRejected && styles.fileCardRejected)}>
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
        ) : progress?.status === 'complete' ? (
          <span {...stylex.props(styles.badge, styles.badgeSuccess)}>
            <IconCheck size={12} /> Complete
          </span>
        ) : progress?.status === 'error' ? (
          <span {...stylex.props(styles.badge, styles.badgeError)} title={progress.error}>
            {progress.error === 'Cancelled' ? 'Cancelled' : 'Failed'}
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

      {!isRejected && (
        <div {...stylex.props(styles.driveAllocationRow)}>
          <div {...stylex.props(styles.driveSelectorGroup)}>
            <span {...stylex.props(styles.driveLabel)}>Drive:</span>
            {accounts.length > 0 ? (
              <div {...stylex.props(styles.selectWrapper)}>
                <select
                  aria-label={`Select target drive for ${item.virtualPath}`}
                  title={chosenAcc ? `${chosenAcc.displayName || chosenAcc.id} (${chosenAcc.email || chosenAcc.id})` : 'Select drive'}
                  value={chosenAccountId}
                  disabled={isUploading || progress?.status === 'complete'}
                  {...stylex.props(styles.accountSelect)}
                  onChange={(e) => onSelectAccount(item.key, e.target.value)}
                >
                  {!chosenAccountId && (
                    <option value="" disabled>
                      {isPlanning ? 'Calculating...' : 'Select drive...'}
                    </option>
                  )}
                  {accounts.map((acc) => {
                    const isDriveDisabled = Boolean(acc.isDisabled);
                    const hasHeadroom = acc.headroomBytes >= item.file.size;
                    const remainingBudget =
                      acc.transferStats?.remainingUploadBytes24h ?? 750 * 1024 * 1024 * 1024;
                    const hasTransferBudget = remainingBudget >= item.file.size;
                    const canHold = !isDriveDisabled && acc.authorized && hasHeadroom && hasTransferBudget;

                    let labelSuffix = '';
                    if (isDriveDisabled) {
                      labelSuffix = ' (Disabled)';
                    } else if (!acc.authorized) {
                      labelSuffix = ' (Unauthorized)';
                    } else if (!hasHeadroom) {
                      labelSuffix = ' (No headroom)';
                    } else if (!hasTransferBudget) {
                      labelSuffix = ' (24h limit reached)';
                    } else if (acc.id === preview?.targetAccountId) {
                      labelSuffix = ' (Auto)';
                    }

                    const fullLabel = `${acc.displayName || acc.id} (${acc.email || acc.id})${labelSuffix}`;

                    return (
                      <option key={acc.id} value={acc.id} disabled={!canHold} title={fullLabel}>
                        {fullLabel}
                      </option>
                    );
                  })}
                </select>
                <div {...stylex.props(styles.selectChevron)}>
                  <IconChevronDown size={11} strokeWidth={2.5} />
                </div>
              </div>
            ) : preview?.targetAccountId ? (
              <span {...stylex.props(styles.badge)} title={preview.targetAccountId}>
                {preview.targetAccountId}
              </span>
            ) : planError ? (
              <span {...stylex.props(styles.badge, styles.badgeError)} title={planError}>
                Unallocated
              </span>
            ) : (
              <span {...stylex.props(styles.badge)}>Calculating...</span>
            )}
          </div>
        </div>
      )}

      {progress && (progress.status === 'uploading' || progress.status === 'complete') && (
        <div {...stylex.props(styles.miniProgressContainer)}>
          <div
            {...stylex.props(
              styles.miniProgressFill,
              progress.status === 'complete' && styles.progressBarComplete
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
});

export function UploadDrawer({
  isOpen,
  onClose,
  stagedFiles,
  stagedEmptyFolders = [],
  currentPath,
  accounts = [],
  poolId = 1,
  onUploadComplete,
  onClearFiles,
  isMinimized,
  onMinimize,
  onRestore,
}: UploadDrawerProps) {
  const [previews, setPreviews] = useState<PlacementItemPreview[]>([]);
  const [isPlanning, setIsPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({});

  const [isUploading, setIsUploading] = useState(false);
  const [fileProgress, setFileProgress] = useState<Record<string, FileProgressState>>({});
  const [internalMinimized, setInternalMinimized] = useState(false);

  const progressRef = useRef<Record<string, FileProgressState>>({});
  const rafIdRef = useRef<number | null>(null);
  const lastFlushRef = useRef<number>(0);
  const xhrMapRef = useRef<Map<string, XMLHttpRequest>>(new Map());
  const abortedRef = useRef(false);
  const fileListRef = useRef<HTMLDivElement | null>(null);

  const effectiveMinimized = isMinimized !== undefined ? isMinimized : internalMinimized;

  const handleMinimize = useCallback(() => {
    if (onMinimize) onMinimize();
    else setInternalMinimized(true);
  }, [onMinimize]);

  const handleRestore = useCallback(() => {
    if (onRestore) onRestore();
    else setInternalMinimized(false);
  }, [onRestore]);

  useEffect(() => {
    if (!isOpen) {
      setInternalMinimized(false);
    }
  }, [isOpen]);

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

  const { totalBytes, allRejected } = useMemo(() => {
    let bytes = 0;
    for (const it of normalizedItems) {
      bytes += it.file.size;
    }
    const allExceed = normalizedItems.length > 0 && normalizedItems.every((it) => it.file.size > CEILING_14_25_GB);
    return { totalBytes: bytes, allRejected: allExceed };
  }, [normalizedItems]);

  // Request placement plan whenever staged files change
  useEffect(() => {
    if (!isOpen || normalizedItems.length === 0) {
      setPreviews([]);
      setPlanError(null);
      progressRef.current = {};
      setFileProgress({});
      setSelectedAccounts({});
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

    const eligibleItems = items.filter((i) => !i.rejected);

    if (eligibleItems.length === 0) {
      setPreviews(items);
      setIsPlanning(false);
      return;
    }

    client.api.storage.placement.batch
      .$post(
        {
          json: {
            items: eligibleItems.map((e) => ({ virtualPath: e.virtualPath, sizeBytes: e.sizeBytes })),
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
        const decisions = Array.isArray(planData.decisions) ? planData.decisions : [];
        const decisionByPath = new Map<string, { virtualPath: string; accountId?: string; reason?: string }>();
        for (const d of decisions) {
          if (d && typeof d.virtualPath === 'string') {
            decisionByPath.set(d.virtualPath, d);
          }
        }

        const mapped: PlacementItemPreview[] = items.map((orig) => {
          if (orig.rejected) return orig;
          const matched = decisionByPath.get(orig.virtualPath);
          const reasonLabel =
            matched?.reason === 'folder_affinity'
              ? 'Path affinity'
              : matched?.reason === 'best_fit'
              ? 'Best fit'
              : matched?.reason || 'Best fit';

          return {
            ...orig,
            targetAccountId: matched?.accountId,
            reason: reasonLabel,
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
  }, [isOpen, normalizedItems, poolId]);

  const overallProgress = useMemo(() => {
    let totalLoaded = 0;
    let completedCount = 0;
    let activeCount = 0;
    for (const it of normalizedItems) {
      const p = fileProgress[it.key];
      if (p) {
        totalLoaded += p.loaded;
        if (p.status === 'complete') completedCount += 1;
        else if (p.status === 'uploading') activeCount += 1;
      }
    }
    const percent = totalBytes > 0 ? Math.min(100, Math.round((totalLoaded / totalBytes) * 100)) : 0;
    return { totalLoaded, percent, completedCount, activeCount };
  }, [normalizedItems, fileProgress, totalBytes]);

  const failedItems = useMemo(() => {
    return normalizedItems.filter((it) => {
      if (it.file.size > CEILING_14_25_GB) return false;
      return fileProgress[it.key]?.status === 'error';
    });
  }, [normalizedItems, fileProgress]);

  const runUploadQueue = useCallback(
    async (itemsToUpload: NormalizedUploadItem[], createEmptyFolders: boolean) => {
      if (isUploading || itemsToUpload.length === 0) return;

      abortedRef.current = false;
      setIsUploading(true);

      let succeededCount = 0;

      if (createEmptyFolders && stagedEmptyFolders && stagedEmptyFolders.length > 0) {
        for (const folderPath of stagedEmptyFolders) {
          if (abortedRef.current) break;
          try {
            const name = folderPath.split('/').filter(Boolean).pop() || folderPath;
            await client.api.folders.$post({
              json: { virtualPath: folderPath, name, poolId },
            });
            succeededCount += 1;
          } catch {
            // Continue if already exists
          }
        }
      }

      if (createEmptyFolders) {
        const nextProgress: Record<string, FileProgressState> = {};
        for (const it of normalizedItems) {
          nextProgress[it.key] = {
            loaded: 0,
            total: it.file.size,
            status: it.file.size > CEILING_14_25_GB ? 'error' : 'pending',
          };
        }
        progressRef.current = nextProgress;
      } else {
        const nextProgress = { ...progressRef.current };
        for (const it of itemsToUpload) {
          nextProgress[it.key] = {
            loaded: 0,
            total: it.file.size,
            status: 'pending',
          };
        }
        progressRef.current = nextProgress;
      }
      flushProgressImmediate();

      const eligibleQueue = itemsToUpload.filter((it) => it.file.size <= CEILING_14_25_GB);

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

          const uploadUrl = `/api/files/upload?virtualPath=${encodeURIComponent(item.virtualPath)}&sizeBytes=${item.file.size}&mimeType=${encodeURIComponent(item.file.type || 'application/octet-stream')}${accountParam}&poolId=${encodeURIComponent(String(poolId))}`;

          xhr.open('POST', uploadUrl, true);
          xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');

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

          xhr.send(item.file);
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

      xhrMapRef.current.clear();
      setIsUploading(false);
      if (succeededCount > 0) {
        await onUploadComplete();
      }
    },
    [
      isUploading,
      stagedEmptyFolders,
      poolId,
      normalizedItems,
      flushProgressImmediate,
      scheduleProgressFlush,
      selectedAccounts,
      previewByPath,
      onUploadComplete,
    ]
  );

  const handleStartUpload = useCallback(() => {
    void runUploadQueue(normalizedItems, true);
  }, [runUploadQueue, normalizedItems]);

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

  const handleClearAndClose = useCallback(() => {
    clearActiveXhrs();
    onClearFiles();
    onClose();
  }, [clearActiveXhrs, onClearFiles, onClose]);

  const hasUnallocatedFiles = useMemo(() => {
    return normalizedItems.some((it) => {
      if (it.file.size > CEILING_14_25_GB) return false;
      const chosen = selectedAccounts[it.key] || previewByPath.get(it.virtualPath)?.targetAccountId;
      return !chosen;
    });
  }, [normalizedItems, selectedAccounts, previewByPath]);

  const shouldVirtualize = normalizedItems.length > VIRTUALIZE_THRESHOLD;

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? normalizedItems.length : 0,
    getScrollElement: () => fileListRef.current,
    estimateSize: () => 86,
    overscan: 6,
  });

  const handleEscapeOrBackdrop = useCallback(() => {
    if (isUploading) {
      handleMinimize();
    } else {
      onClose();
    }
  }, [isUploading, handleMinimize, onClose]);

  useBeforeUnload(isUploading);
  useDialogLock(isOpen && !effectiveMinimized, false, handleEscapeOrBackdrop);

  if (!isOpen) return null;

  if (effectiveMinimized) {
    const totalCount = normalizedItems.length;
    const isDone = totalCount > 0 && overallProgress.completedCount === totalCount && !isUploading;

    return (
      <div
        {...stylex.props(styles.pillContainer)}
        role="region"
        aria-label="Upload progress"
      >
        <div {...stylex.props(styles.pillMain)}>
          <div {...stylex.props(styles.pillLeft)}>
            <div
              {...stylex.props(
                styles.statusDot,
                isUploading && styles.statusDotActive,
                isDone && styles.statusDotComplete
              )}
            />
            <div {...stylex.props(styles.pillTextGroup)}>
              <span {...stylex.props(styles.pillTitle)}>
                {isUploading
                  ? `Uploading ${overallProgress.completedCount}/${totalCount}`
                  : isDone
                  ? `Uploaded ${totalCount} ${totalCount === 1 ? 'file' : 'files'}`
                  : `Upload paused (${overallProgress.completedCount}/${totalCount})`}
              </span>
              <span {...stylex.props(styles.pillMeta)}>
                {overallProgress.percent}% · {formatBytes(overallProgress.totalLoaded)} / {formatBytes(totalBytes)}
              </span>
            </div>
          </div>

          <button
            type="button"
            {...stylex.props(styles.pillExpandBtn)}
            onClick={handleRestore}
            aria-label="Expand upload drawer"
          >
            <IconChevronUp size={13} />
            Expand
          </button>
        </div>

        <div {...stylex.props(styles.progressBarContainer)}>
          <div
            {...stylex.props(
              styles.progressBarFill,
              isDone && styles.progressBarComplete
            )}
            style={{ width: `${overallProgress.percent}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        {...stylex.props(styles.backdrop)}
        onClick={handleEscapeOrBackdrop}
      />
      <div {...stylex.props(styles.drawer)} role="dialog" aria-modal="true" aria-label="Upload files">
        <div {...stylex.props(styles.drawerHeader)}>
          <div {...stylex.props(styles.titleGroup)}>
            <IconUpload size={20} strokeWidth={2.5} />
            <h2 {...stylex.props(styles.title)}>Upload & allocation</h2>
          </div>
          <div {...stylex.props(styles.headerActions)}>
            {isUploading && (
              <button
                type="button"
                {...stylex.props(styles.closeBtn)}
                onClick={handleMinimize}
                aria-label="Minimize upload drawer"
                title="Minimize to progress pill"
              >
                <IconMinus size={16} />
              </button>
            )}
            <button
              type="button"
              {...stylex.props(styles.closeBtn)}
              onClick={onClose}
              disabled={isUploading}
              aria-label="Close upload drawer"
            >
              <IconClose size={16} />
            </button>
          </div>
        </div>

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
              {stagedEmptyFolders && stagedEmptyFolders.length > 0
                ? ` + ${stagedEmptyFolders.length} folder${stagedEmptyFolders.length === 1 ? '' : 's'}`
                : ''}{' '}
              · {formatBytes(totalBytes)}
            </span>
          </div>

          <div {...stylex.props(styles.summarySubRow)}>
            <div {...stylex.props(styles.statusIndicator)}>
              <div
                {...stylex.props(
                  styles.statusDot,
                  (isUploading || isPlanning) && styles.statusDotActive,
                  overallProgress.completedCount === normalizedItems.length &&
                    normalizedItems.length > 0 &&
                    styles.statusDotComplete
                )}
              />
              <span>
                {isPlanning
                  ? 'Calculating placement...'
                  : isUploading
                  ? `Uploading ${Math.min(overallProgress.completedCount + overallProgress.activeCount, normalizedItems.length)} of ${normalizedItems.length} (${overallProgress.percent}%)`
                  : overallProgress.completedCount === normalizedItems.length && normalizedItems.length > 0
                  ? 'All transfers complete'
                  : failedItems.length > 0
                  ? `${failedItems.length} ${failedItems.length === 1 ? 'file' : 'files'} failed or cancelled`
                  : allRejected
                  ? 'All files exceed ceiling'
                  : 'Ready to upload'}
              </span>
            </div>
          </div>

          {(isUploading ||
            (overallProgress.completedCount > 0 && overallProgress.completedCount === normalizedItems.length)) && (
            <div {...stylex.props(styles.progressBarContainer)}>
              <div
                {...stylex.props(
                  styles.progressBarFill,
                  overallProgress.completedCount === normalizedItems.length &&
                    normalizedItems.length > 0 &&
                    styles.progressBarComplete
                )}
                style={{ width: `${overallProgress.percent}%` }}
              />
            </div>
          )}
        </div>

        <div ref={fileListRef} {...stylex.props(styles.fileList)}>
          {planError && (
            <div {...stylex.props(styles.planErrorBanner)}>
              <span {...stylex.props(styles.planErrorNotice)}>
                Placement calculation notice: {planError}
              </span>
            </div>
          )}

          {shouldVirtualize ? (
            <div
              {...stylex.props(styles.virtualListInner)}
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const item = normalizedItems[virtualRow.index];
                if (!item) return null;
                const preview = previewByPath.get(item.virtualPath);
                const selectedAccountId = selectedAccounts[item.key];
                const chosenAccountId = selectedAccountId || preview?.targetAccountId || '';
                const chosenAcc = chosenAccountId ? accountById.get(chosenAccountId) : undefined;

                return (
                  <div
                    key={item.key}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    {...stylex.props(styles.virtualRow)}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <UploadFileCard
                      item={item}
                      preview={preview}
                      progress={fileProgress[item.key]}
                      selectedAccountId={selectedAccountId}
                      chosenAcc={chosenAcc}
                      accounts={accounts}
                      isUploading={isUploading}
                      isPlanning={isPlanning}
                      planError={planError}
                      onSelectAccount={handleSelectAccount}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            normalizedItems.map((item) => {
              const preview = previewByPath.get(item.virtualPath);
              const selectedAccountId = selectedAccounts[item.key];
              const chosenAccountId = selectedAccountId || preview?.targetAccountId || '';
              const chosenAcc = chosenAccountId ? accountById.get(chosenAccountId) : undefined;

              return (
                <UploadFileCard
                  key={item.key}
                  item={item}
                  preview={preview}
                  progress={fileProgress[item.key]}
                  selectedAccountId={selectedAccountId}
                  chosenAcc={chosenAcc}
                  accounts={accounts}
                  isUploading={isUploading}
                  isPlanning={isPlanning}
                  planError={planError}
                  onSelectAccount={handleSelectAccount}
                />
              );
            })
          )}
        </div>

        <div {...stylex.props(styles.footer)}>
          {isUploading ? (
            <>
              <button
                type="button"
                {...stylex.props(styles.dangerBtn)}
                onClick={handleAbortUpload}
              >
                <IconClose size={14} />
                Cancel upload
              </button>
              <button
                type="button"
                {...stylex.props(styles.secondaryBtn)}
                onClick={handleMinimize}
              >
                Minimize
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                {...stylex.props(styles.secondaryBtn)}
                onClick={handleClearAndClose}
              >
                {overallProgress.completedCount === normalizedItems.length && normalizedItems.length > 0
                  ? 'Close'
                  : 'Cancel'}
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
                disabled={
                  (isPlanning && !normalizedItems.every((it) => selectedAccounts[it.key])) ||
                  allRejected ||
                  normalizedItems.length === 0 ||
                  hasUnallocatedFiles
                }
              >
                <IconUpload size={16} strokeWidth={2.5} />
                Start upload
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

