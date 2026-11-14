import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { client } from '../api.js';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconAlertTriangle, FileTypeIcon, IconCheck, IconChevronDown, IconFolderFilled } from './Icons.js';
import { formatBytes } from '../utils/format.js';
import { useDialogLock } from '../utils/useBeforeUnload.js';

export interface ExternalDiscrepancyItem {
  driveFileId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  accountId: string;
  discrepancyType: 'unindexed' | 'modified' | 'over_ceiling';
}

export interface PathConflictItem {
  driveFileId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  modifiedTime: string | null;
  accountId: string;
  accountEmail: string;
  accountDisplayName: string;
  discrepancyType: 'conflict';
  isExactDuplicate: boolean;
  existingFile: {
    fileId: string;
    driveFileId: string;
    accountId: string;
    accountEmail: string;
    accountDisplayName: string;
    sizeBytes: number;
    hash: string | null;
    updatedAt: string | null;
  };
}

export interface DiscrepancyReport {
  accountId: string;
  poolFolderName: string;
  scannedFiles: number;
  conflicts: PathConflictItem[];
  unindexed: ExternalDiscrepancyItem[];
  modified: ExternalDiscrepancyItem[];
  overCeiling: ExternalDiscrepancyItem[];
  missingRemote: Array<{
    fileId: string;
    driveFileId: string;
    virtualPath: string;
    accountId: string;
  }>;
}

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
  onResolved: () => Promise<void>;
}

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
    width: '460px',
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
    height: '32px',
    lineHeight: '28px',
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space3,
    paddingRight: '28px',
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
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
    right: '8px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: colors.dimText,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  contentScroll: {
    flex: 1,
    overflowY: 'auto',
    paddingTop: spacing.space5,
    paddingBottom: spacing.space5,
    paddingLeft: 0,
    paddingRight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space4,
  },
  sectionTitle: {
    fontSize: typography.fontSizeSection,
    fontWeight: typography.fontWeightSection,
    color: colors.primaryText,
    margin: 0,
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
  sectionDesc: {
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
  },
  card: {
    position: 'relative',
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space5,
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
      paddingRight: spacing.space5,
      borderLeftWidth: '3px',
      borderLeftStyle: 'solid',
      borderLeftColor: 'transparent',
    },
  },
  cardOverCeiling: {
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
  cardConflict: {
    '::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      right: spacing.space2,
      width: '3px',
      backgroundColor: colors.warning,
      pointerEvents: 'none',
      display: {
        default: 'block',
        '@media (max-width: 768px)': 'none',
      },
    },
    '@media (max-width: 768px)': {
      borderLeftColor: colors.warning,
    },
  },
  batchActionsBar: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    flexWrap: 'wrap',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    marginTop: spacing.space2,
  },
  poolFolderIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    color: colors.poolGold,
  },
  conflictBadgeExact: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '20px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccentSurface,
    color: colors.brandAccent,
    fontSize: typography.fontSizeBadge,
    fontWeight: '600',
    flexShrink: 0,
  },
  conflictBadgeDiff: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '20px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.warningSurface,
    color: colors.warning,
    fontSize: typography.fontSizeBadge,
    fontWeight: '600',
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
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
    fontSize: typography.fontSizeMeta,
    fontVariantNumeric: 'tabular-nums',
  },
  conflictCompareLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
    flex: 1,
  },
  conflictOriginTag: {
    fontSize: typography.fontSizeBadge,
    fontWeight: '600',
    color: colors.primaryText,
    minWidth: '66px',
    flexShrink: 0,
  },
  conflictAccountEmail: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  conflictSizeText: {
    fontSize: typography.fontSizeMeta,
    color: colors.primaryText,
    fontWeight: '500',
    fontVariantNumeric: 'tabular-nums',
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
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
    flex: 1,
  },
  fileName: {
    fontSize: typography.fontSizeBody,
    fontWeight: '600',
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileMeta: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  cardDesc: {
    fontSize: '12px',
    color: colors.secondaryText,
    lineHeight: '1.4',
    margin: 0,
  },
  confirmPromptText: {
    fontSize: typography.fontSizeMeta,
    fontWeight: '500',
    color: colors.primaryText,
    lineHeight: '1.4',
    margin: 0,
    fontVariantNumeric: 'tabular-nums',
  },
  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    flexWrap: 'wrap',
    marginTop: spacing.space1,
  },
  btnPrimary: {
    height: '28px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.button,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: '600',
    cursor: 'pointer',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  btnSecondary: {
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
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.border,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  btnDanger: {
    height: '28px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.button,
    backgroundColor: colors.danger,
    color: colors.dangerText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: '600',
    cursor: 'pointer',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.dangerHover,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  statusNoticeBanner: {
    position: 'relative',
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space5,
    paddingRight: spacing.space6,
    borderRadius: radius.none,
    borderWidth: '0px',
    backgroundColor: colors.dangerSurface,
    color: colors.danger,
    fontSize: typography.fontSizeMeta,
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
      paddingRight: spacing.space5,
      borderLeftWidth: '3px',
      borderLeftStyle: 'solid',
      borderLeftColor: colors.danger,
    },
  },
  cardList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    marginTop: spacing.space3,
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
    fontWeight: '600',
    color: colors.primaryText,
  },
  scanningNoticeText: {
    fontSize: typography.fontSizeBody,
    color: colors.dimText,
  },
  emptyNoticeTitle: {
    fontSize: '14px',
    fontWeight: '600',
    color: colors.primaryText,
  },
  rebalanceBanner: {
    position: 'relative',
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space5,
    paddingRight: spacing.space6,
    borderRadius: radius.none,
    borderWidth: '0px',
    backgroundColor: 'transparent',
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    '::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      right: spacing.space2,
      width: '3px',
      backgroundColor: colors.warning,
      pointerEvents: 'none',
      display: {
        default: 'block',
        '@media (max-width: 768px)': 'none',
      },
    },
    '@media (max-width: 768px)': {
      paddingRight: spacing.space5,
      borderLeftWidth: '3px',
      borderLeftStyle: 'solid',
      borderLeftColor: colors.warning,
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
  onResolved,
}: ExternalChangesDrawerProps) {
  const [selectedAccount, setSelectedAccount] = useState<string>(() => {
    if (initialAccountId && accounts.some((a) => a.id === initialAccountId)) {
      return initialAccountId;
    }
    return accounts[0]?.id || '';
  });
  const [report, setReport] = useState<DiscrepancyReport | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [showIndividualFiles, setShowIndividualFiles] = useState(false);
  const [confirmingEject, setConfirmingEject] = useState(false);

  const activeScanRef = useRef<string | null>(null);

  const currentAccount = accounts.find((a) => a.id === selectedAccount);
  const isBreached = currentAccount
    ? (currentAccount.quotaUsedBytes ?? 0) > (currentAccount.usableLimitBytes ?? 0)
    : false;
  const hasPoolFiles = (currentAccount?.tsubasaUsedBytes ?? 0) > 0;
  const showRebalance = isBreached && hasPoolFiles;

  useEffect(() => {
    if (initialAccountId && accounts.some((a) => a.id === initialAccountId)) {
      setSelectedAccount(initialAccountId);
    } else if (accounts.length > 0 && (!selectedAccount || !accounts.some((a) => a.id === selectedAccount))) {
      setSelectedAccount(accounts[0].id);
    }
  }, [initialAccountId, accounts]);

  const scanAccount = useCallback(async (accId: string) => {
    if (!accId) return;
    activeScanRef.current = accId;
    setIsScanning(true);
    setReport(null);
    setStatusNotice(null);
    setConfirmingEject(false);

    try {
      const res = await client.api.sync['external-changes'][':accountId'].$get({
        param: { accountId: accId },
      });
      if (activeScanRef.current !== accId) return;

      if (res.ok) {
        const data = await res.json();
        if (activeScanRef.current === accId) {
          setReport(data as DiscrepancyReport);
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        if (activeScanRef.current === accId) {
          setStatusNotice(('error' in errData ? errData.error : null) || `Scan failed (${res.status})`);
        }
      }
    } catch (err) {
      if (activeScanRef.current === accId) {
        setStatusNotice(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (activeScanRef.current === accId) {
        setIsScanning(false);
      }
    }
  }, []);

  useEffect(() => {
    if (isOpen && selectedAccount) {
      setShowIndividualFiles(false);
      setConfirmingEject(false);
      scanAccount(selectedAccount);
    }
    return () => {
      activeScanRef.current = null;
    };
  }, [isOpen, selectedAccount, scanAccount]);

  const handleAccept = async (item: ExternalDiscrepancyItem) => {
    setActiveActionId(item.driveFileId);
    try {
      const res = await client.api.sync.resolve.accept.$post({
        json: {
          accountId: item.accountId,
          driveFileId: item.driveFileId,
          targetVirtualPath: item.virtualPath,
        },
      });

      if (res.ok) {
        await scanAccount(selectedAccount);
        await onResolved();
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusNotice(('error' in err ? err.error : null) || 'Failed to accept file');
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleBulkResolve = async (action: 'accept-all' | 'eject-all') => {
    if (!selectedAccount) return;
    setActiveActionId(action);
    setStatusNotice(null);
    try {
      const endpoint = client.api.sync.resolve[action];
      const res = await endpoint.$post({ json: { accountId: selectedAccount } });

      if (res.ok) {
        const data = await res.json();
        await scanAccount(selectedAccount);
        await onResolved();
        if ('failedCount' in data && data.failedCount > 0) {
          setStatusNotice(`${data.failedCount.toLocaleString()} files could not be ejected. Check the server log.`);
        }
      } else {
        const err = await res.json().catch(() => ({}));
        const fallback = action === 'accept-all' ? 'Failed to accept files' : 'Failed to eject files';
        setStatusNotice(('error' in err ? err.error : null) || fallback);
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleMoveToRoot = async (item: ExternalDiscrepancyItem) => {
    setActiveActionId(item.driveFileId);
    try {
      const res = await client.api.sync.resolve['move-to-root'].$post({
        json: {
          accountId: item.accountId,
          driveFileId: item.driveFileId,
        },
      });

      if (res.ok) {
        await scanAccount(selectedAccount);
        await onResolved();
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusNotice(('error' in err ? err.error : null) || 'Failed to eject file');
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleRemoveMissing = async (item: { driveFileId: string; accountId: string }) => {
    setActiveActionId(item.driveFileId);
    setStatusNotice(null);
    try {
      const res = await client.api.sync.resolve['remove-missing'].$post({
        json: {
          accountId: item.accountId,
          driveFileId: item.driveFileId,
        },
      });

      if (res.ok) {
        await scanAccount(selectedAccount);
        await onResolved();
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusNotice(('error' in err ? err.error : null) || 'Failed to remove missing file');
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleAutoRebalance = async () => {
    if (!selectedAccount) return;
    setActiveActionId('rebalance');
    try {
      const res = await client.api.sync.rebalance.auto[':accountId'].$post({
        param: { accountId: selectedAccount },
      });

      if (res.ok) {
        const data = await res.json();
        const count = ('results' in data && Array.isArray(data.results)) ? data.results.length : 0;
        setStatusNotice(`Rebalance complete. ${count} files migrated.`);
        await scanAccount(selectedAccount);
        await onResolved();
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusNotice(('error' in err ? err.error : null) || 'Auto-rebalance failed');
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleResolveConflict = async (
    item: PathConflictItem,
    resolution: 'keep_both' | 'deduplicate' | 'replace_existing' | 'eject'
  ) => {
    setActiveActionId(item.driveFileId);
    setStatusNotice(null);
    try {
      const res = await client.api.sync.resolve.conflict.$post({
        json: {
          accountId: item.accountId,
          driveFileId: item.driveFileId,
          resolution,
          targetVirtualPath: item.virtualPath,
        },
      });

      if (res.ok) {
        await scanAccount(selectedAccount);
        await onResolved();
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusNotice(('error' in err ? err.error : null) || 'Failed to resolve conflict');
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleBatchResolveConflicts = async (
    items: PathConflictItem[],
    resolution: 'keep_both' | 'deduplicate'
  ) => {
    if (items.length === 0) return;
    setActiveActionId('batch-conflict');
    setStatusNotice(null);
    try {
      for (const item of items) {
        const res = await client.api.sync.resolve.conflict.$post({
          json: {
            accountId: item.accountId,
            driveFileId: item.driveFileId,
            resolution,
            targetVirtualPath: item.virtualPath,
          },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setStatusNotice(('error' in err ? err.error : null) || `Failed to resolve ${item.name}`);
          break;
        }
      }
      await scanAccount(selectedAccount);
      await onResolved();
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const isLocked = activeActionId !== null;

  useDialogLock(isOpen, isLocked, onClose);

  if (!isOpen) return null;

  const exactDuplicates = (report?.conflicts ?? []).filter((c) => c.isExactDuplicate);

  const acceptableItems = [...(report?.unindexed ?? []), ...(report?.modified ?? [])];
  const showPoolSummary = acceptableItems.length > 1;
  const showIndividualAcceptable = !showPoolSummary || showIndividualFiles;
  let acceptableBytes = 0;
  const acceptableFolders = new Set<string>();
  for (const item of acceptableItems) {
    acceptableBytes += item.sizeBytes;
    const parentDir = item.virtualPath.slice(0, item.virtualPath.lastIndexOf('/'));
    if (parentDir) acceptableFolders.add(parentDir);
  }
  const poolSummaryParts = [
    report?.unindexed.length ? `${report.unindexed.length.toLocaleString()} new` : null,
    report?.modified.length ? `${report.modified.length.toLocaleString()} updated` : null,
    acceptableFolders.size > 0
      ? `${acceptableFolders.size.toLocaleString()} ${acceptableFolders.size === 1 ? 'folder' : 'folders'}`
      : null,
  ].filter(Boolean);

  const totalDiscrepancies =
    (report?.conflicts?.length ?? 0) +
    (report?.overCeiling.length ?? 0) +
    (report?.unindexed.length ?? 0) +
    (report?.modified.length ?? 0) +
    (report?.missingRemote.length ?? 0);

  return (
    <>
      <div
        {...stylex.props(styles.backdrop)}
        onClick={() => {
          if (!isLocked) onClose();
        }}
      />
      <div {...stylex.props(styles.drawer)} role="dialog" aria-modal="true" aria-label="External modifications">
        <div {...stylex.props(styles.drawerHeader)}>
          <div {...stylex.props(styles.titleGroup)}>
            <IconAlertTriangle size={18} />
            <h2 {...stylex.props(styles.title)}>External changes</h2>
          </div>
          <button
            type="button"
            {...stylex.props(styles.closeBtn)}
            onClick={onClose}
            disabled={isLocked}
            aria-label="Close drawer"
          >
            <IconClose size={16} />
          </button>
        </div>

        <div {...stylex.props(styles.accountSelectorBar)}>
          <div {...stylex.props(styles.selectWrapper)}>
            <select
              aria-label="Select connected account"
              title={(() => {
                const cur = accounts.find((a) => a.id === selectedAccount);
                return cur ? `${cur.displayName || cur.id} (${cur.email || cur.id})` : 'Select connected account';
              })()}
              {...stylex.props(styles.select)}
              value={selectedAccount}
              onChange={(e) => setSelectedAccount(e.target.value)}
              disabled={accounts.length === 0 || isScanning || isLocked}
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
                    title={`${acc.displayName || acc.id} (${acc.email || acc.id})`}
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
        </div>

        <div {...stylex.props(styles.contentScroll)}>
          {statusNotice && (
            <div {...stylex.props(styles.statusNoticeBanner)}>
              {statusNotice}
            </div>
          )}

          {/* Over-ceiling items */}
          {report?.overCeiling && report.overCeiling.length > 0 && (
            <div>
              <h3 {...stylex.props(styles.sectionTitle)}>
                <IconAlertTriangle size={16} color={colors.danger} />
                Over-ceiling files (&gt; 14.25 GB)
              </h3>
              <p {...stylex.props(styles.cardDesc, styles.sectionDesc)}>
                Files between 14.25 GB and 15 GB breach the 750 MB reserve ceiling. Accept into Tsubasa or eject outside the Tsubasa pool folder to preserve incoming email delivery.
              </p>
              <div {...stylex.props(styles.cardList)}>
                {report.overCeiling.map((item) => (
                  <div key={item.driveFileId} {...stylex.props(styles.card, styles.cardOverCeiling)}>
                    <div {...stylex.props(styles.fileHeaderRow)}>
                      <div {...stylex.props(styles.fileTitleGroup)}>
                        <FileTypeIcon name={item.name || item.virtualPath} size={16} />
                        <div {...stylex.props(styles.fileTitleCol)}>
                          <span {...stylex.props(styles.fileName)} title={item.virtualPath}>
                            {item.name}
                          </span>
                          <span
                            {...stylex.props(styles.fileVirtualPath)}
                            title={item.virtualPath}
                          >
                            {item.virtualPath}
                          </span>
                        </div>
                      </div>
                      <span {...stylex.props(styles.fileMeta)}>{formatBytes(item.sizeBytes)}</span>
                    </div>

                    <div {...stylex.props(styles.actionsRow)}>
                      <button
                        type="button"
                        {...stylex.props(styles.btnPrimary)}
                        onClick={() => handleAccept(item)}
                        disabled={isLocked}
                      >
                        Accept into Tsubasa (Over-ceiling mode)
                      </button>
                      <button
                        type="button"
                        {...stylex.props(styles.btnDanger)}
                        onClick={() => handleMoveToRoot(item)}
                        disabled={isLocked}
                      >
                        Move to root (Eject)
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Path conflicts in pool */}
          {report?.conflicts && report.conflicts.length > 0 && (
            <div>
              <h3 {...stylex.props(styles.sectionTitle)}>
                <IconAlertTriangle size={16} color={colors.warning} />
                Path conflicts in pool, {report.conflicts.length}
              </h3>
              <p {...stylex.props(styles.cardDesc, styles.sectionDesc)}>
                These files share the same folder path as files already stored on another drive in this pool.
              </p>

              {report.conflicts.length > 1 && (
                <div {...stylex.props(styles.batchActionsBar)}>
                  {exactDuplicates.length > 1 && (
                    <button
                      type="button"
                      {...stylex.props(styles.btnPrimary)}
                      onClick={() => handleBatchResolveConflicts(exactDuplicates, 'deduplicate')}
                      disabled={isLocked}
                    >
                      Remove {exactDuplicates.length} identical duplicates
                    </button>
                  )}
                  <button
                    type="button"
                    {...stylex.props(exactDuplicates.length > 1 ? styles.btnSecondary : styles.btnPrimary)}
                    onClick={() => handleBatchResolveConflicts(report.conflicts, 'keep_both')}
                    disabled={isLocked}
                  >
                    Keep both for all {report.conflicts.length}
                  </button>
                </div>
              )}

              <div {...stylex.props(styles.cardList)}>
                {report.conflicts.map((item) => (
                  <div key={item.driveFileId} {...stylex.props(styles.card, styles.cardConflict)}>
                    <div {...stylex.props(styles.fileHeaderRow)}>
                      <div {...stylex.props(styles.fileTitleGroup)}>
                        <FileTypeIcon name={item.name || item.virtualPath} size={16} />
                        <div {...stylex.props(styles.fileTitleCol)}>
                          <span {...stylex.props(styles.fileName)} title={item.virtualPath}>
                            {item.name}
                          </span>
                          <span {...stylex.props(styles.fileVirtualPath)} title={item.virtualPath}>
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
                        <div {...stylex.props(styles.conflictCompareLeft)}>
                          <span {...stylex.props(styles.conflictOriginTag)}>In pool</span>
                          <span
                            {...stylex.props(styles.conflictAccountEmail)}
                            title={item.existingFile.accountEmail}
                          >
                            {item.existingFile.accountEmail}
                          </span>
                        </div>
                        <span {...stylex.props(styles.conflictSizeText)}>
                          {formatBytes(item.existingFile.sizeBytes)}
                        </span>
                      </div>
                      <div {...stylex.props(styles.conflictCompareRow)}>
                        <div {...stylex.props(styles.conflictCompareLeft)}>
                          <span {...stylex.props(styles.conflictOriginTag)}>This drive</span>
                          <span {...stylex.props(styles.conflictAccountEmail)} title={item.accountEmail}>
                            {item.accountEmail}
                          </span>
                        </div>
                        <span {...stylex.props(styles.conflictSizeText)}>{formatBytes(item.sizeBytes)}</span>
                      </div>
                    </div>

                    <div {...stylex.props(styles.actionsRow)}>
                      {item.isExactDuplicate ? (
                        <>
                          <button
                            type="button"
                            {...stylex.props(styles.btnPrimary)}
                            onClick={() => handleResolveConflict(item, 'deduplicate')}
                            disabled={isLocked}
                          >
                            Remove duplicate
                          </button>
                          <button
                            type="button"
                            {...stylex.props(styles.btnSecondary)}
                            onClick={() => handleResolveConflict(item, 'keep_both')}
                            disabled={isLocked}
                          >
                            Keep both, rename
                          </button>
                          <button
                            type="button"
                            {...stylex.props(styles.btnSecondary)}
                            onClick={() => handleResolveConflict(item, 'replace_existing')}
                            disabled={isLocked}
                          >
                            Use this drive&apos;s copy
                          </button>
                          <button
                            type="button"
                            {...stylex.props(styles.btnSecondary)}
                            onClick={() => handleResolveConflict(item, 'eject')}
                            disabled={isLocked}
                          >
                            Eject to Drive root
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            {...stylex.props(styles.btnPrimary)}
                            onClick={() => handleResolveConflict(item, 'keep_both')}
                            disabled={isLocked}
                          >
                            Keep both, rename
                          </button>
                          <button
                            type="button"
                            {...stylex.props(styles.btnSecondary)}
                            onClick={() => handleResolveConflict(item, 'replace_existing')}
                            disabled={isLocked}
                          >
                            Replace pool copy
                          </button>
                          <button
                            type="button"
                            {...stylex.props(styles.btnSecondary)}
                            onClick={() => handleResolveConflict(item, 'deduplicate')}
                            disabled={isLocked}
                          >
                            Discard this copy
                          </button>
                          <button
                            type="button"
                            {...stylex.props(styles.btnSecondary)}
                            onClick={() => handleResolveConflict(item, 'eject')}
                            disabled={isLocked}
                          >
                            Eject to Drive root
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pool folder summary: accept every external change in one action */}
          {report && showPoolSummary && (
            <div>
              <h3 {...stylex.props(styles.sectionTitle)}>Files added or changed in Google Drive</h3>
              <div {...stylex.props(styles.cardList)}>
                <div {...stylex.props(styles.card)}>
                  <div {...stylex.props(styles.fileHeaderRow)}>
                    <div {...stylex.props(styles.fileTitleGroup)}>
                      <span {...stylex.props(styles.poolFolderIcon)}>
                        <IconFolderFilled size={18} />
                      </span>
                      <div {...stylex.props(styles.fileTitleCol)}>
                        <span {...stylex.props(styles.fileName)} title={report.poolFolderName}>
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
                        <button
                          type="button"
                          {...stylex.props(styles.btnDanger)}
                          onClick={() => handleBulkResolve('eject-all')}
                          disabled={isLocked}
                        >
                          {activeActionId === 'eject-all'
                            ? 'Ejecting...'
                            : `Eject ${acceptableItems.length.toLocaleString()} files`}
                        </button>
                        <button
                          type="button"
                          {...stylex.props(styles.btnSecondary)}
                          onClick={() => setConfirmingEject(false)}
                          disabled={isLocked}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <div {...stylex.props(styles.actionsRow)}>
                      <button
                        type="button"
                        {...stylex.props(styles.btnPrimary)}
                        onClick={() => handleBulkResolve('accept-all')}
                        disabled={isLocked}
                      >
                        {activeActionId === 'accept-all'
                          ? 'Accepting...'
                          : `Accept all ${acceptableItems.length.toLocaleString()} files`}
                      </button>
                      <button
                        type="button"
                        {...stylex.props(styles.btnSecondary)}
                        onClick={() => setConfirmingEject(true)}
                        disabled={isLocked}
                      >
                        Eject all to Drive root
                      </button>
                      <button
                        type="button"
                        {...stylex.props(styles.btnSecondary)}
                        onClick={() => setShowIndividualFiles((prev) => !prev)}
                        disabled={isLocked}
                        aria-expanded={showIndividualFiles}
                      >
                        {showIndividualFiles ? 'Hide individual files' : 'Review individually'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Unindexed external additions */}
          {showIndividualAcceptable && report?.unindexed && report.unindexed.length > 0 && (
            <div>
              <h3 {...stylex.props(styles.sectionTitle)}>
                Unindexed files added in Google Drive
              </h3>
              <div {...stylex.props(styles.cardList)}>
                {report.unindexed.map((item) => (
                  <div key={item.driveFileId} {...stylex.props(styles.card)}>
                    <div {...stylex.props(styles.fileHeaderRow)}>
                      <div {...stylex.props(styles.fileTitleGroup)}>
                        <FileTypeIcon name={item.name || item.virtualPath} size={16} />
                        <div {...stylex.props(styles.fileTitleCol)}>
                          <span {...stylex.props(styles.fileName)} title={item.virtualPath}>
                            {item.name}
                          </span>
                          <span
                            {...stylex.props(styles.fileVirtualPath)}
                            title={item.virtualPath}
                          >
                            {item.virtualPath}
                          </span>
                        </div>
                      </div>
                      <span {...stylex.props(styles.fileMeta)}>{formatBytes(item.sizeBytes)}</span>
                    </div>

                    <div {...stylex.props(styles.actionsRow)}>
                      <button
                        type="button"
                        {...stylex.props(styles.btnPrimary)}
                        onClick={() => handleAccept(item)}
                        disabled={isLocked}
                      >
                        Accept into Tsubasa
                      </button>
                      <button
                        type="button"
                        {...stylex.props(styles.btnSecondary)}
                        onClick={() => handleMoveToRoot(item)}
                        disabled={isLocked}
                      >
                        Eject to Drive root
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Modified files */}
          {showIndividualAcceptable && report?.modified && report.modified.length > 0 && (
            <div>
              <h3 {...stylex.props(styles.sectionTitle)}>Modified files</h3>
              <div {...stylex.props(styles.cardList)}>
                {report.modified.map((item) => (
                  <div key={item.driveFileId} {...stylex.props(styles.card)}>
                    <div {...stylex.props(styles.fileHeaderRow)}>
                      <div {...stylex.props(styles.fileTitleGroup)}>
                        <FileTypeIcon name={item.name || item.virtualPath} size={16} />
                        <div {...stylex.props(styles.fileTitleCol)}>
                          <span {...stylex.props(styles.fileName)} title={item.virtualPath}>
                            {item.name}
                          </span>
                          <span
                            {...stylex.props(styles.fileVirtualPath)}
                            title={item.virtualPath}
                          >
                            {item.virtualPath}
                          </span>
                        </div>
                      </div>
                      <span {...stylex.props(styles.fileMeta)}>{formatBytes(item.sizeBytes)}</span>
                    </div>

                    <div {...stylex.props(styles.actionsRow)}>
                      <button
                        type="button"
                        {...stylex.props(styles.btnPrimary)}
                        onClick={() => handleAccept(item)}
                        disabled={isLocked}
                      >
                        Accept update
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Missing or externally moved files */}
          {report?.missingRemote && report.missingRemote.length > 0 && (
            <div>
              <h3 {...stylex.props(styles.sectionTitle)}>
                <IconAlertTriangle size={16} color={colors.warning} />
                Missing or externally moved files
              </h3>
              <p {...stylex.props(styles.cardDesc, styles.sectionDesc)}>
                These files were moved outside the Tsubasa folder structure or removed directly in Google Drive.
              </p>
              <div {...stylex.props(styles.cardList)}>
                {report.missingRemote.map((item) => (
                  <div key={item.driveFileId} {...stylex.props(styles.card)}>
                    <div {...stylex.props(styles.fileHeaderRow)}>
                      <div {...stylex.props(styles.fileTitleGroup)}>
                        <FileTypeIcon name={item.virtualPath} size={16} />
                        <span {...stylex.props(styles.fileName)} title={item.virtualPath}>
                          {item.virtualPath}
                        </span>
                      </div>
                    </div>

                    <div {...stylex.props(styles.actionsRow)}>
                      <button
                        type="button"
                        {...stylex.props(styles.btnDanger)}
                        onClick={() => handleRemoveMissing(item)}
                        disabled={isLocked}
                      >
                        Remove from Tsubasa
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Rebalance section */}
          {showRebalance && (
            <div {...stylex.props(styles.rebalanceBanner)}>
              <div {...stylex.props(styles.rebalanceTitle)}>
                Auto-rebalance files
              </div>
              <p {...stylex.props(styles.cardDesc)}>
                This account breached its 750 MB safety buffer. Auto-rebalance moves Tsubasa files to an emptier account in your pool to restore safe headroom.
              </p>
              <div>
                <button
                  type="button"
                  {...stylex.props(styles.btnSecondary)}
                  onClick={handleAutoRebalance}
                  disabled={isLocked}
                >
                  {activeActionId === 'rebalance' ? 'Rebalancing...' : 'Auto-rebalance'}
                </button>
              </div>
            </div>
          )}

          {/* Scanning indicator */}
          {isScanning && (
            <div {...stylex.props(styles.scanningNotice)}>
              <div {...stylex.props(styles.scanningNoticeText)}>
                Scanning Drive for external changes...
              </div>
            </div>
          )}

          {/* Empty state when no accounts have changes */}
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

          {/* Empty state for the selected account */}
          {!isScanning && report !== null && accounts.length > 0 && totalDiscrepancies === 0 && !showRebalance && (
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
      </div>
    </>
  );
}

