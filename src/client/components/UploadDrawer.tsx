import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useVirtualizer } from '@tanstack/react-virtual';
import { client } from '../api.js';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconUpload, FileTypeIcon, IconCheck, IconAlertTriangle, IconChevronDown, IconChevronUp, IconFolder, IconFolderFilled, IconMinus, IconRotateCcw } from './Icons.js';
import { formatBytes } from '../utils/format.js';
import { useBeforeUnload } from '../utils/useBeforeUnload.js';
import type { AccountItem } from './Sidebar.js';

export type UploadConflictAction = 'skip' | 'replace' | 'keep_both';

export interface ExistingPoolFile {
  id: string;
  virtualPath: string;
  name: string;
  sizeBytes: number;
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

interface UploadFolderGroup {
  key: string;
  name: string;
  folderPath: string;
  items: NormalizedUploadItem[];
  subfolderCount: number;
  totalBytes: number;
}

type UploadDisplayRow =
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
  isMinimized?: boolean;
  onMinimize?: () => void;
  onRestore?: () => void;
}

const CEILING_14_25_GB = 14.25 * 1024 * 1024 * 1024;
const PROGRESS_THROTTLE_MS = 120;
const MAX_CONCURRENT_UPLOADS = 3;
const VIRTUALIZE_THRESHOLD = 30;

const styles = stylex.create({
  dialog: {
    position: 'fixed',
    inset: {
      default: '0 0 0 auto',
      '@media (max-width: 768px)': '0 0 auto 0',
    },
    margin: 0,
    padding: 0,
    borderWidth: '0px',
    backgroundColor: 'transparent',
    color: 'inherit',
    outline: 'none',
    overflow: 'hidden',
    width: {
      default: '420px',
      '@media (max-width: 768px)': '100vw',
    },
    maxWidth: '100vw',
    height: {
      default: '100dvh',
      '@media (max-width: 768px)': 'auto',
    },
    maxHeight: {
      default: '100dvh',
      '@media (max-width: 768px)': '92dvh',
    },
    '::backdrop': {
      backgroundColor: colors.modalBackdrop,
    },
  },
  drawerSurface: {
    width: '100%',
    height: '100%',
    maxHeight: 'inherit',
    backgroundColor: colors.surface,
    borderLeftWidth: {
      default: '1px',
      '@media (max-width: 768px)': '0px',
    },
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    overflow: 'hidden',
    '@media (max-width: 768px)': {
      borderBottomWidth: '1px',
      borderBottomStyle: 'solid',
      borderBottomColor: colors.border,
      borderBottomLeftRadius: radius.card,
      borderBottomRightRadius: radius.card,
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
    width: '100%',
    height: '100%',
    backgroundColor: colors.brandAccent,
    borderRadius: radius.pill,
    transformOrigin: 'left center',
    transition: 'transform 0.2s ease',
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
  badgeWarning: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warning,
    color: colors.warning,
    fontWeight: '600',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
  },
  badgeMuted: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderSubtle,
    color: colors.secondaryText,
    fontWeight: '600',
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
    width: '100%',
    height: '100%',
    backgroundColor: colors.brandAccent,
    borderRadius: radius.pill,
    transformOrigin: 'left center',
    transition: 'transform 0.15s ease',
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
  conflictBanner: {
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    backgroundColor: colors.warningSurface,
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
    fontWeight: '600',
    color: colors.warning,
  },
  conflictBatchActions: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.space2,
  },
  conflictActionGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    flexShrink: 0,
  },
  conflictPillBtn: {
    height: '24px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: '600',
    cursor: 'pointer',
    transition: motion.transitionFast,
    outline: 'none',
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.border,
    },
    ':focus-visible': {
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
      minHeight: '44px',
      paddingLeft: spacing.space3,
      paddingRight: spacing.space3,
    },
  },
  conflictPillBtnActive: {
    backgroundColor: colors.brandAccent,
    borderColor: colors.brandAccent,
    color: colors.brandAccentText,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
      borderColor: colors.brandAccentHover,
    },
  },
  conflictRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
    flexWrap: 'wrap',
    paddingTop: spacing.space1,
  },
  conflictHintText: {
    fontSize: typography.fontSizeBadge,
    color: colors.warning,
    fontWeight: '500',
    minWidth: 0,
  },
  skippedNoticeText: {
    fontSize: typography.fontSizeBadge,
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
  },
  folderSubMeta: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  folderExpandRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    flexWrap: 'wrap',
    marginTop: spacing.space1,
  },
  folderExpandBtn: {
    height: '28px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.button,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: '500',
    cursor: 'pointer',
    transition: motion.transitionFast,
    outline: 'none',
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.border,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
      paddingLeft: spacing.space4,
      paddingRight: spacing.space4,
    },
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
  existingFile?: ExistingPoolFile;
  existingAcc?: AccountItem;
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
  const conflictControlsDisabled = isUploading || isComplete;

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
          <span {...stylex.props(styles.badge, isSameSize ? styles.badgeMuted : styles.badgeWarning)}>
            {isSameSize ? 'Already uploaded' : 'Skipped'}
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

      {!isRejected && existingFile && !isComplete && (
        <div {...stylex.props(styles.conflictRow)}>
          <span {...stylex.props(isSkipped ? styles.skippedNoticeText : styles.conflictHintText)}>
            Existing: {formatBytes(existingFile.sizeBytes)}
            {existingAcc ? ` on ${existingAcc.displayName || existingAcc.id}` : ''}
            {' · '}
            {isSameSize ? 'Same size' : 'Different size'}
          </span>

          <div
            {...stylex.props(styles.conflictActionGroup)}
            role="group"
            aria-label={`Conflict action for ${item.virtualPath}`}
          >
            {(
              [
                { value: 'skip', label: 'Skip' },
                { value: 'replace', label: 'Replace' },
                { value: 'keep_both', label: 'Keep both' },
              ] as const
            ).map((opt) => {
              const active = effectiveConflictAction === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={active}
                  disabled={conflictControlsDisabled}
                  onClick={() => onSelectConflictAction(item.key, opt.value)}
                  {...stylex.props(
                    styles.conflictPillBtn,
                    active && styles.conflictPillBtnActive
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!isRejected && !isSkipped && (
        <div {...stylex.props(styles.driveAllocationRow)}>
          <div {...stylex.props(styles.driveSelectorGroup)}>
            <span {...stylex.props(styles.driveLabel)}>Drive:</span>
            {accounts.length > 0 ? (
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
                    const isDriveDisabled = Boolean(acc.isDisabled);
                    const freedBytes =
                      effectiveConflictAction === 'replace' && existingFile?.accountId === acc.id
                        ? existingFile.sizeBytes
                        : 0;
                    const hasHeadroom = acc.headroomBytes + freedBytes >= item.file.size;
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
            style={{ transform: `scaleX(${Math.min(100, Math.max(0, pct)) / 100})` }}
          />
        </div>
      )}
    </div>
  );
});

interface UploadFolderCardProps {
  group: UploadFolderGroup;
  isExpanded: boolean;
  isUploading: boolean;
  isPlanning: boolean;
  previewByPath: Map<string, PlacementItemPreview>;
  conflictsByPath: Record<string, ExistingPoolFile>;
  conflictActions: Record<string, UploadConflictAction>;
  selectedAccounts: Record<string, string>;
  fileProgress: Record<string, FileProgressState>;
  accountById: Map<string, AccountItem>;
  onToggleExpand: (groupKey: string) => void;
  onApplyFolderConflictAction: (groupKey: string, action: UploadConflictAction) => void;
}

const UploadFolderCard = React.memo(function UploadFolderCard({
  group,
  isExpanded,
  isUploading,
  isPlanning,
  previewByPath,
  conflictsByPath,
  conflictActions,
  selectedAccounts,
  fileProgress,
  accountById,
  onToggleExpand,
  onApplyFolderConflictAction,
}: UploadFolderCardProps) {
  let rejectedCount = 0;
  let skippedCount = 0;
  let completedCount = 0;
  let uploadingCount = 0;
  let errorCount = 0;
  let sameSizeSkippedCount = 0;
  let actionableCount = 0;
  let actionableBytes = 0;
  let loadedBytes = 0;

  const editableConflicts: NormalizedUploadItem[] = [];
  const targetAccountIds = new Set<string>();

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
      editableConflicts.push(item);
    }

    if (effectiveAction === 'skip') {
      skippedCount += 1;
      if (existingFile && existingFile.sizeBytes === item.file.size) {
        sameSizeSkippedCount += 1;
      }
      continue;
    }

    actionableCount += 1;
    actionableBytes += item.file.size;

    const chosenAccountId = selectedAccounts[item.key] || preview?.targetAccountId;
    if (chosenAccountId) {
      targetAccountIds.add(chosenAccountId);
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

  const allRejected = rejectedCount === group.items.length;
  const allComplete = actionableCount > 0 && completedCount === actionableCount;
  const allSkipped = !allRejected && actionableCount === 0 && skippedCount > 0;
  const pct = actionableBytes > 0 ? Math.round((loadedBytes / actionableBytes) * 100) : 0;

  let uniformFolderConflictAction: UploadConflictAction | null = null;
  if (editableConflicts.length > 0) {
    const firstAction = conflictActions[editableConflicts[0].key] ?? 'skip';
    const allMatch = editableConflicts.every(
      (it) => (conflictActions[it.key] ?? 'skip') === firstAction
    );
    if (allMatch) uniformFolderConflictAction = firstAction;
  }

  const singleTargetAccId = targetAccountIds.size === 1 ? Array.from(targetAccountIds)[0] : null;
  const singleTargetAcc = singleTargetAccId ? accountById.get(singleTargetAccId) : undefined;

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
            <IconFolderFilled size={18} />
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
              sameSizeSkippedCount === skippedCount ? styles.badgeMuted : styles.badgeWarning
            )}
          >
            {sameSizeSkippedCount === skippedCount ? 'Already uploaded' : 'Skipped'}
          </span>
        ) : editableConflicts.length > 0 ? (
          <span {...stylex.props(styles.badge, styles.badgeWarning)}>
            {editableConflicts.length} {editableConflicts.length === 1 ? 'conflict' : 'conflicts'}
          </span>
        ) : singleTargetAcc ? (
          <span {...stylex.props(styles.badge)} title={singleTargetAcc.email || singleTargetAcc.id}>
            {singleTargetAcc.displayName || singleTargetAcc.id}
          </span>
        ) : targetAccountIds.size > 1 ? (
          <span {...stylex.props(styles.badge)}>
            {targetAccountIds.size} drives
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
      </div>

      {!allRejected && editableConflicts.length > 0 && (
        <div {...stylex.props(styles.conflictRow)}>
          <span {...stylex.props(uniformFolderConflictAction === 'skip' ? styles.skippedNoticeText : styles.conflictHintText)}>
            {editableConflicts.length} {editableConflicts.length === 1 ? 'file already exists' : 'files already exist'}
          </span>

          <div
            {...stylex.props(styles.conflictActionGroup)}
            role="group"
            aria-label={`Conflict action for folder ${group.name}`}
          >
            {(
              [
                { value: 'skip', label: 'Skip all' },
                { value: 'replace', label: 'Replace all' },
                { value: 'keep_both', label: 'Keep both' },
              ] as const
            ).map((opt) => {
              const active = uniformFolderConflictAction === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={active}
                  disabled={isUploading}
                  onClick={() => onApplyFolderConflictAction(group.key, opt.value)}
                  {...stylex.props(
                    styles.conflictPillBtn,
                    active && styles.conflictPillBtnActive
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
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

      <div {...stylex.props(styles.folderExpandRow)}>
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => onToggleExpand(group.key)}
          {...stylex.props(styles.folderExpandBtn)}
        >
          {isExpanded ? 'Hide individual files' : 'Review individually'}
        </button>
      </div>
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
  const [conflictsByPath, setConflictsByPath] = useState<Record<string, ExistingPoolFile>>({});
  const [conflictActions, setConflictActions] = useState<Record<string, UploadConflictAction>>({});
  const [isPlanning, setIsPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({});
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});

  const [isUploading, setIsUploading] = useState(false);
  const [fileProgress, setFileProgress] = useState<Record<string, FileProgressState>>({});
  const [internalMinimized, setInternalMinimized] = useState(false);

  const progressRef = useRef<Record<string, FileProgressState>>({});
  const hasCreatedEmptyFoldersRef = useRef(false);
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

  const { totalBytes, actionableBytes, allRejected } = useMemo(() => {
    let allBytes = 0;
    for (const it of normalizedItems) {
      allBytes += it.file.size;
    }
    let activeBytes = 0;
    for (const it of actionableItems) {
      activeBytes += it.file.size;
    }
    const allExceed = normalizedItems.length > 0 && normalizedItems.every((it) => it.file.size > CEILING_14_25_GB);
    return { totalBytes: allBytes, actionableBytes: activeBytes, allRejected: allExceed };
  }, [normalizedItems, actionableItems]);

  // Reset per-session progress and conflict overrides whenever staged items change
  useEffect(() => {
    setConflictsByPath({});
    setConflictActions({});
    setExpandedFolders({});
    progressRef.current = {};
    hasCreatedEmptyFoldersRef.current = false;
    setFileProgress({});
    setSelectedAccounts({});
  }, [isOpen, normalizedItems, poolId]);

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
  }, [isOpen, normalizedItems, poolId, conflictActions]);

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
      if (isUploading || itemsToUpload.length === 0) return;

      abortedRef.current = false;
      setIsUploading(true);

      let succeededCount = 0;

      if (createEmptyFolders && stagedEmptyFolders && stagedEmptyFolders.length > 0) {
        hasCreatedEmptyFoldersRef.current = true;
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

      const nextProgress = { ...progressRef.current };
      for (const it of itemsToUpload) {
        nextProgress[it.key] = {
          loaded: 0,
          total: it.file.size,
          status: it.file.size > CEILING_14_25_GB ? 'error' : 'pending',
        };
      }
      progressRef.current = nextProgress;
      flushProgressImmediate();

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
    if (unstartedActionableItems.length === 0) return;
    void runUploadQueue(unstartedActionableItems, !hasCreatedEmptyFoldersRef.current);
  }, [runUploadQueue, unstartedActionableItems]);

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

    const standaloneEmptyFolders: Array<{ key: string; name: string; folderPath: string }> = [];
    for (const rawEmptyPath of stagedEmptyFolders) {
      const emptyPath = rawEmptyPath.startsWith('/') ? rawEmptyPath : `/${rawEmptyPath}`;
      const { rel, base } = getRelAndBase(emptyPath);
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
          key: `empty::${emptyPath}`,
          name: displayName,
          folderPath: emptyPath,
        });
      }
    }

    const groupsMap = new Map<string, UploadFolderGroup>();
    const rows: UploadDisplayRow[] = [];

    for (const entry of topEntries) {
      if (entry.kind === 'loose_file') {
        rows.push({
          kind: 'loose_file',
          key: entry.item.key,
          item: entry.item,
        });
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

    return { folderGroupByKey: groupsMap, displayRows: rows };
  }, [normalizedItems, stagedEmptyFolders, currentPath, expandedFolders]);

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

  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerDownOutsideRef = useRef(false);
  const isClosingRef = useRef(false);
  const clearOnCloseRef = useRef(false);

  const requestClose = useCallback(() => {
    if (isUploading || isClosingRef.current) return;
    const dialog = dialogRef.current;
    if (!dialog || !dialog.open) {
      onClose();
      return;
    }

    const skipExitAnimation =
      document.body.classList.contains('resize-animation-stopper') ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (skipExitAnimation) {
      dialog.removeAttribute('data-closing');
      dialog.close();
      return;
    }

    isClosingRef.current = true;
    dialog.setAttribute('data-closing', '');
    const animations = dialog.getAnimations();
    Promise.all(animations.map((anim) => anim.finished.catch(() => {}))).then(() => {
      if (!isClosingRef.current) return;
      isClosingRef.current = false;
      dialog.removeAttribute('data-closing');
      if (dialog.open) {
        dialog.close();
      }
    });
  }, [isUploading, onClose]);

  const handleClearAndClose = useCallback(() => {
    clearActiveXhrs();
    if (!dialogRef.current?.open) {
      onClearFiles();
      onClose();
      return;
    }
    clearOnCloseRef.current = true;
    requestClose();
  }, [clearActiveXhrs, onClearFiles, onClose, requestClose]);

  const handleEscapeOrBackdrop = useCallback(() => {
    if (isUploading) {
      handleMinimize();
    } else {
      requestClose();
    }
  }, [isUploading, handleMinimize, requestClose]);

  useBeforeUnload(isUploading);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !effectiveMinimized) {
      isClosingRef.current = false;
      clearOnCloseRef.current = false;
      dialog.removeAttribute('data-closing');
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.removeAttribute('data-closing');
      dialog.close();
    }
  }, [isOpen, effectiveMinimized]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.setAttribute('closedby', isUploading ? 'none' : 'any');
  }, [isUploading, isOpen, effectiveMinimized]);

  if (!isOpen) return null;

  if (effectiveMinimized) {
    const totalCount = actionableItems.length;
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
                {overallProgress.percent}% · {formatBytes(overallProgress.totalLoaded)} / {formatBytes(actionableBytes)}
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
            style={{ transform: `scaleX(${Math.min(100, Math.max(0, overallProgress.percent)) / 100})` }}
          />
        </div>
      </div>
    );
  }

  const isOutsideDialogBounds = (e: React.PointerEvent<HTMLDialogElement>, dialog: HTMLDialogElement) => {
    const rect = dialog.getBoundingClientRect();
    return (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    );
  };

  const handleDialogCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    handleEscapeOrBackdrop();
  };

  const handleDialogClose = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.currentTarget.returnValue = '';
    e.currentTarget.removeAttribute('data-closing');
    isClosingRef.current = false;
    if (clearOnCloseRef.current) {
      clearOnCloseRef.current = false;
      onClearFiles();
    }
    onClose();
  };

  const handleDialogPointerDown = (e: React.PointerEvent<HTMLDialogElement>) => {
    if ('closedBy' in HTMLDialogElement.prototype && !isUploading) return;
    pointerDownOutsideRef.current = isOutsideDialogBounds(e, e.currentTarget);
  };

  const handleDialogPointerUp = (e: React.PointerEvent<HTMLDialogElement>) => {
    if ('closedBy' in HTMLDialogElement.prototype && !isUploading) return;
    const startedOutside = pointerDownOutsideRef.current;
    pointerDownOutsideRef.current = false;
    if (!startedOutside) return;
    if (isOutsideDialogBounds(e, e.currentTarget)) {
      handleEscapeOrBackdrop();
    }
  };

  const allActionableComplete =
    actionableItems.length > 0 && overallProgress.completedCount === actionableItems.length;
  const allConflictsSkipped =
    !allRejected && actionableItems.length === 0 && conflictItems.length > 0;
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
  const startUploadDisabled =
    (isPlanning && !unstartedActionableItems.every((it) => selectedAccounts[it.key])) ||
    allRejected ||
    normalizedItems.length === 0 ||
    unstartedActionableItems.length === 0 ||
    hasUnallocatedFiles;
  const startUploadTitle = allActionableComplete
    ? 'All staged files are already uploaded'
    : allConflictsSkipped
    ? 'All staged files already exist in the destination'
    : failedItems.length > 0 && unstartedActionableItems.length === 0
    ? 'Use Retry failed to re-attempt failed uploads'
    : undefined;

  const renderDisplayRow = (row: UploadDisplayRow) => {
    if (row.kind === 'folder_group') {
      return (
        <UploadFolderCard
          group={row.group}
          isExpanded={Boolean(expandedFolders[row.group.key])}
          isUploading={isUploading}
          isPlanning={isPlanning}
          previewByPath={previewByPath}
          conflictsByPath={conflictsByPath}
          conflictActions={conflictActions}
          selectedAccounts={selectedAccounts}
          fileProgress={fileProgress}
          accountById={accountById}
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
                <IconFolderFilled size={18} />
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
    <dialog
      ref={dialogRef}
      data-tsubasa-dialog="drawer-sheet"
      aria-label="Upload files"
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
      onPointerDown={handleDialogPointerDown}
      onPointerUp={handleDialogPointerUp}
      {...stylex.props(styles.dialog)}
    >
      <div {...stylex.props(styles.drawerSurface)}>
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
              onClick={requestClose}
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
              {skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}
              {stagedEmptyFolders && stagedEmptyFolders.length > 0
                ? ` + ${stagedEmptyFolders.length} folder${stagedEmptyFolders.length === 1 ? '' : 's'}`
                : ''}{' '}
              · {formatBytes(skippedCount > 0 ? actionableBytes : totalBytes)}
            </span>
          </div>

          <div {...stylex.props(styles.summarySubRow)}>
            <div {...stylex.props(styles.statusIndicator)}>
              <div
                {...stylex.props(
                  styles.statusDot,
                  (isUploading || isPlanning) && styles.statusDotActive,
                  allActionableComplete && styles.statusDotComplete
                )}
              />
              <span>
                {isPlanning
                  ? 'Calculating placement...'
                  : isUploading
                  ? `Uploading ${Math.min(overallProgress.completedCount + overallProgress.activeCount, actionableItems.length)} of ${actionableItems.length} (${overallProgress.percent}%)`
                  : allActionableComplete
                  ? skippedCount > 0
                    ? `All ${actionableItems.length} transfers complete, ${skippedCount} skipped`
                    : 'All transfers complete'
                  : failedItems.length > 0
                  ? `${failedItems.length} ${failedItems.length === 1 ? 'file' : 'files'} failed or cancelled`
                  : allRejected
                  ? 'All files exceed ceiling'
                  : allConflictsSkipped
                  ? 'All staged files already exist and are skipped'
                  : 'Ready to upload'}
              </span>
            </div>
          </div>

          {(isUploading || (overallProgress.completedCount > 0 && allActionableComplete)) && (
            <div {...stylex.props(styles.progressBarContainer)}>
              <div
                {...stylex.props(
                  styles.progressBarFill,
                  allActionableComplete && styles.progressBarComplete
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
                {conflictItems.length} {conflictItems.length === 1 ? 'file already exists' : 'files already exist'} at the destination
              </span>
            </div>
            <div {...stylex.props(styles.conflictBatchActions)}>
              {(
                [
                  { value: 'skip', label: 'Skip all' },
                  { value: 'replace', label: 'Replace all' },
                  { value: 'keep_both', label: 'Keep both' },
                ] as const
              ).map((opt) => {
                const active = batchConflictSelection === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={isUploading}
                    aria-pressed={active}
                    onClick={() => handleApplyBatchConflictAction(opt.value)}
                    {...stylex.props(
                      styles.conflictPillBtn,
                      active && styles.conflictPillBtnActive
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

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
      </div>
    </dialog>
  );
}

