import React, { useEffect, useState, useMemo, useCallback } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconUpload, IconFile, IconCheck, IconAlertTriangle } from './Icons';

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
  stagedFiles: File[];
  currentPath: string;
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
    backgroundColor: colors.surfaceElevated,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSubtle,
    boxShadow: '-4px 0 24px rgba(0, 0, 0, 0.18)',
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
  summaryCard: {
    padding: spacing.space5,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space3,
    flexShrink: 0,
  },
  summaryRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  summaryValue: {
    fontWeight: '600',
    color: colors.primaryText,
  },
  progressBarContainer: {
    width: '100%',
    height: '6px',
    borderRadius: radius.pill,
    backgroundColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.accentGold,
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
  },
  fileCardRejected: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerSurface,
  },
  fileCardRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
  },
  fileInfoGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
    flex: 1,
  },
  fileIcon: {
    color: colors.secondaryText,
    flexShrink: 0,
  },
  fileTextGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  fileName: {
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
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
  allocationReason: {
    fontSize: '11px',
    color: colors.dimText,
    fontStyle: 'italic',
  },
  miniProgressContainer: {
    width: '100%',
    height: '3px',
    borderRadius: radius.pill,
    backgroundColor: colors.borderSubtle,
    overflow: 'hidden',
    marginTop: spacing.space1,
  },
  miniProgressFill: {
    height: '100%',
    backgroundColor: colors.primary,
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
    backgroundColor: colors.primary,
    color: colors.surface,
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
      backgroundColor: colors.primaryHover,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function UploadDrawer({
  isOpen,
  onClose,
  stagedFiles,
  currentPath,
  onUploadComplete,
  onClearFiles,
}: UploadDrawerProps) {
  const [previews, setPreviews] = useState<PlacementItemPreview[]>([]);
  const [isPlanning, setIsPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [isUploading, setIsUploading] = useState(false);
  const [fileProgress, setFileProgress] = useState<
    Record<string, { loaded: number; total: number; status: 'pending' | 'uploading' | 'complete' | 'error'; error?: string }>
  >({});

  // Compute total size and valid files
  const { totalBytes, allRejected } = useMemo(() => {
    let bytes = 0;
    stagedFiles.forEach((f) => (bytes += f.size));
    const allExceed = stagedFiles.length > 0 && stagedFiles.every((f) => f.size > CEILING_14_25_GB);
    return { totalBytes: bytes, allRejected: allExceed };
  }, [stagedFiles]);

  // Request placement plan whenever staged files change
  useEffect(() => {
    if (!isOpen || stagedFiles.length === 0) {
      setPreviews([]);
      setPlanError(null);
      setFileProgress({});
      return;
    }

    let isMounted = true;
    setIsPlanning(true);
    setPlanError(null);

    const items = stagedFiles.map((f) => {
      const virtualPath = (currentPath === '/' ? '' : currentPath) + '/' + f.name;
      const isOverCeiling = f.size > CEILING_14_25_GB;
      return {
        virtualPath,
        sizeBytes: f.size,
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

    fetch('/api/storage/placement/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: eligibleItems.map((e) => ({ virtualPath: e.virtualPath, sizeBytes: e.sizeBytes })),
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Planning error ${res.status}`);
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
              ? 'Folder path affinity'
              : matched?.reason === 'best_fit'
              ? 'Folder-cohesion best fit'
              : matched?.reason || 'Folder-cohesion best fit';

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
  }, [isOpen, stagedFiles, currentPath]);

  // Overall transfer progress computation
  const overallProgress = useMemo(() => {
    let totalLoaded = 0;
    let completedCount = 0;
    stagedFiles.forEach((f) => {
      const p = fileProgress[f.name];
      if (p) {
        totalLoaded += p.loaded;
        if (p.status === 'complete') completedCount += 1;
      }
    });
    const percent = totalBytes > 0 ? Math.min(100, Math.round((totalLoaded / totalBytes) * 100)) : 0;
    return { totalLoaded, percent, completedCount };
  }, [stagedFiles, fileProgress, totalBytes]);

  const handleStartUpload = useCallback(async () => {
    if (isUploading || stagedFiles.length === 0) return;

    setIsUploading(true);
    const initialProgress: Record<string, { loaded: number; total: number; status: 'pending' | 'uploading' | 'complete' | 'error' }> = {};
    stagedFiles.forEach((f) => {
      initialProgress[f.name] = {
        loaded: 0,
        total: f.size,
        status: f.size > CEILING_14_25_GB ? 'error' : 'pending',
      };
    });
    setFileProgress(initialProgress);

    for (let i = 0; i < stagedFiles.length; i++) {
      const file = stagedFiles[i];
      if (file.size > CEILING_14_25_GB) continue;

      const virtualPath = (currentPath === '/' ? '' : currentPath) + '/' + file.name;

      setFileProgress((prev) => ({
        ...prev,
        [file.name]: { loaded: 0, total: file.size, status: 'uploading' },
      }));

      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const uploadUrl = `/api/files/upload?virtualPath=${encodeURIComponent(virtualPath)}&sizeBytes=${file.size}&mimeType=${encodeURIComponent(file.type || 'application/octet-stream')}`;

          xhr.open('POST', uploadUrl, true);
          xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setFileProgress((prev) => ({
                ...prev,
                [file.name]: { loaded: e.loaded, total: e.total, status: 'uploading' },
              }));
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              setFileProgress((prev) => ({
                ...prev,
                [file.name]: { loaded: file.size, total: file.size, status: 'complete' },
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
                [file.name]: { loaded: 0, total: file.size, status: 'error', error: errMsg },
              }));
              reject(new Error(errMsg));
            }
          };

          xhr.onerror = () => {
            const errMsg = 'Network stream error';
            setFileProgress((prev) => ({
              ...prev,
              [file.name]: { loaded: 0, total: file.size, status: 'error', error: errMsg },
            }));
            reject(new Error(errMsg));
          };

          xhr.send(file);
        });
      } catch (err) {
        // Individual file error; continue to next file
      }
    }

    setIsUploading(false);
    await onUploadComplete();
  }, [isUploading, stagedFiles, currentPath, onUploadComplete]);

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

        <div {...stylex.props(styles.summaryCard)}>
          <div {...stylex.props(styles.summaryRow)}>
            <span>Target path:</span>
            <span {...stylex.props(styles.summaryValue)}>{currentPath}</span>
          </div>
          <div {...stylex.props(styles.summaryRow)}>
            <span>Staged files:</span>
            <span {...stylex.props(styles.summaryValue)}>
              {stagedFiles.length} file{stagedFiles.length > 1 ? 's' : ''} ({formatBytes(totalBytes)})
            </span>
          </div>
          <div {...stylex.props(styles.summaryRow)}>
            <span>Status:</span>
            <span {...stylex.props(styles.summaryValue)}>
              {isPlanning
                ? 'Calculating best-fit placement...'
                : isUploading
                ? `Uploading (${overallProgress.completedCount}/${stagedFiles.length})`
                : overallProgress.completedCount === stagedFiles.length && stagedFiles.length > 0
                ? 'All transfers complete'
                : 'Ready for placement'}
            </span>
          </div>

          <div {...stylex.props(styles.progressBarContainer)}>
            <div
              {...stylex.props(
                styles.progressBarFill,
                overallProgress.completedCount === stagedFiles.length && stagedFiles.length > 0 && styles.progressBarComplete
              )}
              style={{ width: `${overallProgress.percent}%` }}
            />
          </div>
        </div>

        <div {...stylex.props(styles.fileList)}>
          {planError && (
            <div {...stylex.props(styles.fileCard, styles.fileCardRejected)}>
              <span style={{ fontSize: '12px', fontWeight: '600', color: colors.danger }}>
                Placement calculation notice: {planError}
              </span>
            </div>
          )}

          {stagedFiles.map((file) => {
            const preview = previews.find((p) => p.virtualPath.endsWith('/' + file.name));
            const prog = fileProgress[file.name];
            const isRejected = file.size > CEILING_14_25_GB || preview?.rejected;
            const pct = prog && prog.total > 0 ? Math.round((prog.loaded / prog.total) * 100) : 0;

            return (
              <div
                key={file.name}
                {...stylex.props(styles.fileCard, isRejected && styles.fileCardRejected)}
              >
                <div {...stylex.props(styles.fileCardRow)}>
                  <div {...stylex.props(styles.fileInfoGroup)}>
                    <IconFile size={16} {...stylex.props(styles.fileIcon)} />
                    <div {...stylex.props(styles.fileTextGroup)}>
                      <span {...stylex.props(styles.fileName)} title={file.name}>
                        {file.name}
                      </span>
                      <span {...stylex.props(styles.fileMeta)}>{formatBytes(file.size)}</span>
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
                  ) : preview?.targetAccountId ? (
                    <span {...stylex.props(styles.badge)} title={`Allocated to account ${preview.targetAccountId}`}>
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

                {isRejected && (
                  <div style={{ fontSize: '11px', color: colors.danger, display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <IconAlertTriangle size={12} />
                    Single file ceiling exceeded. Files must fit within 14.25 GB to preserve 750 MB reserve.
                  </div>
                )}

                {!isRejected && preview?.reason && (
                  <div {...stylex.props(styles.allocationReason)}>
                    Placement: {preview.reason}
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
            {overallProgress.completedCount === stagedFiles.length && stagedFiles.length > 0
              ? 'Close'
              : 'Cancel'}
          </button>

          <button
            type="button"
            {...stylex.props(styles.primaryBtn)}
            onClick={handleStartUpload}
            disabled={isUploading || isPlanning || allRejected || stagedFiles.length === 0}
          >
            <IconUpload size={16} strokeWidth={2.5} />
            {isUploading ? 'Uploading...' : 'Start upload'}
          </button>
        </div>
      </div>
    </>
  );
}

