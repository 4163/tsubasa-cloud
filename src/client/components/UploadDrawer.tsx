import React, { useEffect, useState, useMemo, useCallback } from 'react';
import * as stylex from '@stylexjs/stylex';
import { client } from '../api.js';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconUpload, IconFile, IconCheck, IconAlertTriangle, IconChevronDown, IconFolder } from './Icons.js';
import { formatBytes } from '../utils/format.js';
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

interface UploadDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  stagedFiles: Array<File | StagedItem>;
  stagedEmptyFolders?: string[];
  currentPath: string;
  accounts?: AccountItem[];
  onUploadComplete: () => Promise<void>;
  onClearFiles: () => void;
}

const CEILING_14_25_GB = 14.25 * 1024 * 1024 * 1024;

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
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
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
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
  destinationPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeBadge,
    color: colors.primaryText,
    maxWidth: '220px',
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
    padding: spacing.space4,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space3,
  },
  fileCard: {
    padding: spacing.space3,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    transition: motion.transitionFast,
    ':hover': {
      borderColor: colors.border,
      backgroundColor: colors.rowHover,
    },
  },
  fileCardRejected: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerSurface,
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
    paddingTop: '6px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
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
      borderColor: colors.brandAccent,
      boxShadow: `0 0 0 1px ${colors.brandAccent}`,
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
});

export function UploadDrawer({
  isOpen,
  onClose,
  stagedFiles,
  stagedEmptyFolders = [],
  currentPath,
  accounts = [],
  onUploadComplete,
  onClearFiles,
}: UploadDrawerProps) {
  const [previews, setPreviews] = useState<PlacementItemPreview[]>([]);
  const [isPlanning, setIsPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({});

  const [isUploading, setIsUploading] = useState(false);
  const [fileProgress, setFileProgress] = useState<
    Record<string, { loaded: number; total: number; status: 'pending' | 'uploading' | 'complete' | 'error'; error?: string }>
  >({});

  const normalizedItems = useMemo(() => {
    return stagedFiles.map((item) => {
      if ('virtualPath' in item && 'file' in item) {
        const vPath = item.virtualPath.startsWith('/') ? item.virtualPath : '/' + item.virtualPath;
        return {
          file: item.file,
          virtualPath: vPath,
          key: vPath,
        };
      }
      const rel = (item as any).webkitRelativePath || item.name;
      const cleanBase = currentPath === '/' ? '' : currentPath;
      const vPath = `${cleanBase}/${rel}`.replace(/\/+/g, '/');
      return {
        file: item,
        virtualPath: vPath,
        key: vPath,
      };
    });
  }, [stagedFiles, currentPath]);

  // Compute total size and valid files
  const { totalBytes, allRejected } = useMemo(() => {
    let bytes = 0;
    normalizedItems.forEach((it) => (bytes += it.file.size));
    const allExceed = normalizedItems.length > 0 && normalizedItems.every((it) => it.file.size > CEILING_14_25_GB);
    return { totalBytes: bytes, allRejected: allExceed };
  }, [normalizedItems]);

  // Request placement plan whenever staged files change
  useEffect(() => {
    if (!isOpen || normalizedItems.length === 0) {
      setPreviews([]);
      setPlanError(null);
      setFileProgress({});
      setSelectedAccounts({});
      return;
    }

    let isMounted = true;
    setIsPlanning(true);
    setPlanError(null);

    const items = normalizedItems.map((it) => {
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
      .$post({
        json: {
          items: eligibleItems.map((e) => ({ virtualPath: e.virtualPath, sizeBytes: e.sizeBytes })),
        },
      })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(('error' in errData ? errData.error : null) || `Planning error ${res.status}`);
        }
        return res.json();
      })
      .then((planData) => {
        if (!isMounted) return;
        const decisions = Array.isArray(planData.decisions) ? planData.decisions : [];
        const mapped: PlacementItemPreview[] = items.map((orig) => {
          if (orig.rejected) return orig;
          const matched = decisions.find(
            (d: { virtualPath: string }) => d.virtualPath === orig.virtualPath
          );
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
        if (!isMounted) return;
        setPlanError(err instanceof Error ? err.message : String(err));
        setPreviews(items);
      })
      .finally(() => {
        if (isMounted) setIsPlanning(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, normalizedItems]);

  // Overall transfer progress computation
  const overallProgress = useMemo(() => {
    let totalLoaded = 0;
    let completedCount = 0;
    normalizedItems.forEach((it) => {
      const p = fileProgress[it.key];
      if (p) {
        totalLoaded += p.loaded;
        if (p.status === 'complete') completedCount += 1;
      }
    });
    const percent = totalBytes > 0 ? Math.min(100, Math.round((totalLoaded / totalBytes) * 100)) : 0;
    return { totalLoaded, percent, completedCount };
  }, [normalizedItems, fileProgress, totalBytes]);

  const handleStartUpload = useCallback(async () => {
    if (isUploading || normalizedItems.length === 0) return;

    setIsUploading(true);

    if (stagedEmptyFolders && stagedEmptyFolders.length > 0) {
      for (const folderPath of stagedEmptyFolders) {
        try {
          const name = folderPath.split('/').filter(Boolean).pop() || folderPath;
          await client.api.folders.$post({
            json: { virtualPath: folderPath, name },
          });
        } catch {
          // Continue if already exists
        }
      }
    }

    const initialProgress: Record<string, { loaded: number; total: number; status: 'pending' | 'uploading' | 'complete' | 'error' }> = {};
    normalizedItems.forEach((it) => {
      initialProgress[it.key] = {
        loaded: 0,
        total: it.file.size,
        status: it.file.size > CEILING_14_25_GB ? 'error' : 'pending',
      };
    });
    setFileProgress(initialProgress);

    for (let i = 0; i < normalizedItems.length; i++) {
      const item = normalizedItems[i];
      if (item.file.size > CEILING_14_25_GB) continue;

      const chosenAccountId =
        selectedAccounts[item.key] ||
        previews.find((p) => p.virtualPath === item.virtualPath)?.targetAccountId;
      const accountParam = chosenAccountId ? `&accountId=${encodeURIComponent(chosenAccountId)}` : '';

      setFileProgress((prev) => ({
        ...prev,
        [item.key]: { loaded: 0, total: item.file.size, status: 'uploading' },
      }));

      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const uploadUrl = `/api/files/upload?virtualPath=${encodeURIComponent(item.virtualPath)}&sizeBytes=${item.file.size}&mimeType=${encodeURIComponent(item.file.type || 'application/octet-stream')}${accountParam}`;

          xhr.open('POST', uploadUrl, true);
          xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setFileProgress((prev) => ({
                ...prev,
                [item.key]: { loaded: e.loaded, total: e.total, status: 'uploading' },
              }));
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              setFileProgress((prev) => ({
                ...prev,
                [item.key]: { loaded: item.file.size, total: item.file.size, status: 'complete' },
              }));
              resolve();
            } else {
              let errMsg = `Upload failed (${xhr.status})`;
              try {
                const parsed = JSON.parse(xhr.responseText);
                if (parsed.error) errMsg = parsed.error;
              } catch {}
              setFileProgress((prev) => ({
                ...prev,
                [item.key]: { loaded: 0, total: item.file.size, status: 'error', error: errMsg },
              }));
              reject(new Error(errMsg));
            }
          };

          xhr.onerror = () => {
            const errMsg = 'Network stream error';
            setFileProgress((prev) => ({
              ...prev,
              [item.key]: { loaded: 0, total: item.file.size, status: 'error', error: errMsg },
            }));
            reject(new Error(errMsg));
          };

          xhr.send(item.file);
        });
      } catch (err) {
        // Individual file error; continue to next file
      }
    }

    setIsUploading(false);
    await onUploadComplete();
  }, [isUploading, normalizedItems, stagedEmptyFolders, onUploadComplete, selectedAccounts, previews]);

  const hasUnallocatedFiles = normalizedItems.some((it) => {
    if (it.file.size > CEILING_14_25_GB) return false;
    const chosen =
      selectedAccounts[it.key] ||
      previews.find((p) => p.virtualPath === it.virtualPath)?.targetAccountId;
    return !chosen;
  });

  if (!isOpen) return null;

  return (
    <>
      <div {...stylex.props(styles.backdrop)} onClick={!isUploading ? onClose : undefined} />
      <div {...stylex.props(styles.drawer)} role="dialog" aria-modal="true" aria-label="Upload files">
        <div {...stylex.props(styles.drawerHeader)}>
          <div {...stylex.props(styles.titleGroup)}>
            <IconUpload size={20} strokeWidth={2.5} />
            <h2 {...stylex.props(styles.title)}>Upload & allocation</h2>
          </div>
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

        <div {...stylex.props(styles.summaryBar)}>
          <div {...stylex.props(styles.summaryMainRow)}>
            <div {...stylex.props(styles.destinationGroup)}>
              <span {...stylex.props(styles.destinationLabel)}>Destination:</span>
              <span {...stylex.props(styles.destinationPill)} title={currentPath}>
                <IconFolder size={12} />
                <span>{currentPath === '/' ? 'Root (/)' : currentPath}</span>
              </span>
            </div>
            <span {...stylex.props(styles.stagedStats)}>
              {normalizedItems.length} {normalizedItems.length === 1 ? 'file' : 'files'}{stagedEmptyFolders && stagedEmptyFolders.length > 0 ? ` + ${stagedEmptyFolders.length} folder${stagedEmptyFolders.length === 1 ? '' : 's'}` : ''} · {formatBytes(totalBytes)}
            </span>
          </div>

          <div {...stylex.props(styles.summarySubRow)}>
            <div {...stylex.props(styles.statusIndicator)}>
              <div
                {...stylex.props(
                  styles.statusDot,
                  (isUploading || isPlanning) && styles.statusDotActive,
                  overallProgress.completedCount === normalizedItems.length && normalizedItems.length > 0 && styles.statusDotComplete
                )}
              />
              <span>
                {isPlanning
                  ? 'Calculating placement...'
                  : isUploading
                  ? `Uploading ${Math.min(overallProgress.completedCount + 1, normalizedItems.length)} of ${normalizedItems.length} (${overallProgress.percent}%)`
                  : overallProgress.completedCount === normalizedItems.length && normalizedItems.length > 0
                  ? 'All transfers complete'
                  : allRejected
                  ? 'All files exceed ceiling'
                  : 'Ready to upload'}
              </span>
            </div>
          </div>

          {(isUploading || (overallProgress.completedCount > 0 && overallProgress.completedCount === normalizedItems.length)) && (
            <div {...stylex.props(styles.progressBarContainer)}>
              <div
                {...stylex.props(
                  styles.progressBarFill,
                  overallProgress.completedCount === normalizedItems.length && normalizedItems.length > 0 && styles.progressBarComplete
                )}
                style={{ width: `${overallProgress.percent}%` }}
              />
            </div>
          )}
        </div>

        <div {...stylex.props(styles.fileList)}>
          {planError && (
            <div {...stylex.props(styles.fileCard, styles.fileCardRejected)}>
              <span {...stylex.props(styles.planErrorNotice)}>
                Placement calculation notice: {planError}
              </span>
            </div>
          )}

          {normalizedItems.map((item) => {
            const preview = previews.find((p) => p.virtualPath === item.virtualPath);
            const prog = fileProgress[item.key];
            const isRejected = item.file.size > CEILING_14_25_GB || preview?.rejected;
            const pct = prog && prog.total > 0 ? Math.round((prog.loaded / prog.total) * 100) : 0;
            const chosenAccountId = selectedAccounts[item.key] || preview?.targetAccountId || '';
            const chosenAcc = accounts.find((a) => a.id === chosenAccountId);

            return (
              <div
                key={item.key}
                {...stylex.props(styles.fileCard, isRejected && styles.fileCardRejected)}
              >
                {/* Header row: file name + size or completion status */}
                <div {...stylex.props(styles.fileCardHeader)}>
                  <div {...stylex.props(styles.fileInfoGroup)}>
                    <IconFile size={16} {...stylex.props(styles.fileIcon)} />
                    <div {...stylex.props(styles.fileTitleCol)}>
                      <span {...stylex.props(styles.fileName)} title={item.virtualPath}>
                        {item.file.name}
                      </span>
                      <span
                        {...stylex.props(styles.fileVirtualPath)}
                        title={item.virtualPath}
                      >
                        {item.virtualPath}
                      </span>
                    </div>
                  </div>

                  {isRejected ? (
                    <span {...stylex.props(styles.badge, styles.badgeError)}>
                      &gt; 14.25 GB Ceiling
                    </span>
                  ) : prog?.status === 'complete' ? (
                    <span {...stylex.props(styles.badge, styles.badgeSuccess)}>
                      <IconCheck size={12} /> Complete
                    </span>
                  ) : prog?.status === 'error' ? (
                    <span {...stylex.props(styles.badge, styles.badgeError)} title={prog.error}>
                      Failed
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

                {/* Allocation row: drive selector dropdown */}
                {!isRejected && (
                  <div {...stylex.props(styles.driveAllocationRow)}>
                    <div {...stylex.props(styles.driveSelectorGroup)}>
                      <span {...stylex.props(styles.driveLabel)}>Drive:</span>
                      {accounts && accounts.length > 0 ? (
                        <div {...stylex.props(styles.selectWrapper)}>
                          <select
                            aria-label={`Select target drive for ${item.virtualPath}`}
                            title={chosenAcc ? `${chosenAcc.displayName || chosenAcc.id} (${chosenAcc.email || chosenAcc.id})` : 'Select drive'}
                            value={chosenAccountId}
                            disabled={isUploading || prog?.status === 'complete'}
                            {...stylex.props(styles.accountSelect)}
                            onChange={(e) => {
                              const val = e.target.value;
                              setSelectedAccounts((prev) => ({ ...prev, [item.key]: val }));
                            }}
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
                              } else if (acc.id === preview?.targetAccountId && !selectedAccounts[item.key]) {
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

                {prog && (prog.status === 'uploading' || prog.status === 'complete') && (
                  <div {...stylex.props(styles.miniProgressContainer)}>
                    <div
                      {...stylex.props(
                        styles.miniProgressFill,
                        prog.status === 'complete' && styles.progressBarComplete
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div {...stylex.props(styles.footer)}>
          <button
            type="button"
            {...stylex.props(styles.secondaryBtn)}
            onClick={() => {
              onClearFiles();
              onClose();
            }}
            disabled={isUploading}
          >
            {overallProgress.completedCount === normalizedItems.length && normalizedItems.length > 0
              ? 'Close'
              : 'Cancel'}
          </button>

          <button
            type="button"
            {...stylex.props(styles.primaryBtn)}
            onClick={handleStartUpload}
            disabled={
              isUploading ||
              (isPlanning && !normalizedItems.every((it) => selectedAccounts[it.key])) ||
              allRejected ||
              normalizedItems.length === 0 ||
              hasUnallocatedFiles
            }
          >
            <IconUpload size={16} strokeWidth={2.5} />
            {isUploading ? 'Uploading...' : 'Start upload'}
          </button>
        </div>
      </div>
    </>
  );
}

