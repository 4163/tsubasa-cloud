import React, { useState, useEffect, useCallback, useMemo } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconTrash, IconRotateCcw, IconFile, IconCheck } from './Icons';
import type { FileRecord } from '../../server/db/schema.js';
import { ConfirmPurgeModal } from './ConfirmPurgeModal.js';

interface TrashModalProps {
  isOpen: boolean;
  onClose: () => void;
  onActionComplete: () => Promise<void>;
}

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 110,
    padding: spacing.space4,
    boxSizing: 'border-box',
    transition: motion.transitionFast,
  },
  modal: {
    width: '680px',
    maxWidth: '100%',
    maxHeight: '85vh',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.modal,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.25)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    zIndex: 120,
    boxSizing: 'border-box',
  },
  header: {
    height: '56px',
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    flexShrink: 0,
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
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    paddingTop: spacing.space4,
    paddingBottom: spacing.space4,
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    gap: spacing.space4,
  },
  summaryText: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  emptyTrashBtn: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.compact,
    backgroundColor: colors.danger,
    color: '#ffffff',
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: '600',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    transition: motion.transitionFast,
    ':hover': {
      opacity: 0.9,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },

  listScroll: {
    flex: 1,
    overflowY: 'auto',
    padding: spacing.space4,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  itemRow: {
    padding: spacing.space3,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
    },
  },
  itemInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
    flex: 1,
  },
  itemIcon: {
    color: colors.secondaryText,
    flexShrink: 0,
  },
  itemTexts: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  itemName: {
    fontSize: typography.fontSizeBody,
    fontWeight: '600',
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemPath: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: typography.fontFamilyMono,
  },
  itemMetaRight: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    flexShrink: 0,
  },
  accountBadge: {
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.secondaryText,
  },
  sizeText: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
    minWidth: '60px',
    textAlign: 'right',
  },
  actionBtns: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
  iconBtn: {
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    cursor: 'pointer',
    padding: spacing.space1,
    borderRadius: radius.compact,
    color: colors.secondaryText,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.surfaceAlt,
      color: colors.primaryText,
      borderColor: colors.border,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  iconBtnDanger: {
    ':hover': {
      backgroundColor: colors.dangerSurface,
      color: colors.danger,
      borderColor: colors.danger,
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
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function TrashModal({ isOpen, onClose, onActionComplete }: TrashModalProps) {
  const [trashedFiles, setTrashedFiles] = useState<FileRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const loadTrash = useCallback(async () => {
    setIsLoading(true);
    setErrorNotice(null);
    try {
      const res = await fetch('/api/trash');
      if (res.ok) {
        const data = await res.json();
        setTrashedFiles(data.files || []);
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(err.error || 'Failed to query trash');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadTrash();
      setConfirmEmpty(false);
    }
  }, [isOpen, loadTrash]);

  const totalBytes = useMemo(() => {
    return trashedFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
  }, [trashedFiles]);

  const handleRestore = async (file: FileRecord) => {
    setActiveActionId(file.id);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/restore`, {
        method: 'POST',
      });
      if (res.ok) {
        await loadTrash();
        await onActionComplete();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(err.error || 'Failed to restore file');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handlePurgeSingle = async (file: FileRecord) => {
    setActiveActionId(file.id);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/permanent`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await loadTrash();
        await onActionComplete();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(err.error || 'Failed to permanently delete file');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleEmptyTrash = async () => {
    setActiveActionId('empty');
    try {
      const res = await fetch('/api/trash/empty', {
        method: 'DELETE',
      });
      if (res.ok) {
        setConfirmEmpty(false);
        await loadTrash();
        await onActionComplete();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorNotice(err.error || 'Failed to empty trash');
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div {...stylex.props(styles.backdrop)} onClick={onClose}>
      <div
        {...stylex.props(styles.modal)}
        role="dialog"
        aria-modal="true"
        aria-label="Trash management"
        onClick={(e) => e.stopPropagation()}
      >
        <div {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.titleGroup)}>
            <IconTrash size={18} />
            <h2 {...stylex.props(styles.title)}>Trash management</h2>
          </div>
          <button type="button" {...stylex.props(styles.closeBtn)} onClick={onClose} aria-label="Close modal">
            <IconClose size={16} />
          </button>
        </div>

        <ConfirmPurgeModal
          isOpen={confirmEmpty}
          onClose={() => setConfirmEmpty(false)}
          onConfirm={handleEmptyTrash}
          itemCount={trashedFiles.length}
          totalBytes={totalBytes}
        />

        <div {...stylex.props(styles.summaryBar)}>
          <span {...stylex.props(styles.summaryText)}>
            {trashedFiles.length} item{trashedFiles.length === 1 ? '' : 's'} ({formatBytes(totalBytes)} recoverable quota)
          </span>

          {trashedFiles.length > 0 && !confirmEmpty && (
            <button
              type="button"
              {...stylex.props(styles.emptyTrashBtn)}
              onClick={() => setConfirmEmpty(true)}
              disabled={isLoading || activeActionId !== null}
            >
              <IconTrash size={14} />
              Empty trash
            </button>
          )}
        </div>

        <div {...stylex.props(styles.listScroll)}>
          {errorNotice && (
            <div style={{ padding: '8px 12px', borderRadius: '6px', backgroundColor: colors.dangerSurface, color: colors.danger, fontSize: '12px' }}>
              {errorNotice}
            </div>
          )}

          {trashedFiles.map((file) => (
            <div key={file.id} {...stylex.props(styles.itemRow)}>
              <div {...stylex.props(styles.itemInfo)}>
                <IconFile size={16} {...stylex.props(styles.itemIcon)} />
                <div {...stylex.props(styles.itemTexts)}>
                  <span {...stylex.props(styles.itemName)}>
                    {file.name}
                  </span>
                  <span {...stylex.props(styles.itemPath)}>
                    {file.virtualPath}
                  </span>
                </div>
              </div>

              <div {...stylex.props(styles.itemMetaRight)}>
                <span {...stylex.props(styles.accountBadge)}>{file.accountId}</span>
                <span {...stylex.props(styles.sizeText)}>{formatBytes(file.sizeBytes)}</span>

                <div {...stylex.props(styles.actionBtns)}>
                  <button
                    type="button"
                    {...stylex.props(styles.iconBtn)}
                    aria-label="Restore file"
                    onClick={() => handleRestore(file)}
                    disabled={activeActionId === file.id}
                  >
                    <IconRotateCcw size={14} />
                  </button>

                  <button
                    type="button"
                    {...stylex.props(styles.iconBtn, styles.iconBtnDanger)}
                    aria-label="Delete permanently"
                    onClick={() => handlePurgeSingle(file)}
                    disabled={activeActionId === file.id}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}

          {!isLoading && trashedFiles.length === 0 && (
            <div {...stylex.props(styles.emptyNotice)}>
              <IconCheck size={28} color={colors.success} />
              <div style={{ fontSize: '14px', fontWeight: '600', color: colors.primaryText }}>
                Trash is empty
              </div>
              <p style={{ fontSize: '12px', margin: 0, color: colors.secondaryText }}>
                Soft-deleted files across connected accounts will appear here before permanent purging.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

