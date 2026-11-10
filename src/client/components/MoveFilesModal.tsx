import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconFolder, IconChevronDown } from './Icons.js';
import { formatBytes } from '../utils/format.js';
import type { AccountItem } from './Sidebar.js';

export interface MoveFileItem {
  id: string;
  name: string;
  virtualPath?: string;
  sizeBytes: number;
}

export interface MoveFilesModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceAccount: AccountItem | null;
  files: MoveFileItem[];
  accounts: AccountItem[];
  onConfirm: (fileIds: string[], targetAccountId: string) => Promise<void> | void;
}

function formatGbCompact(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function formatFilePath(file: MoveFileItem): string {
  const p = file.virtualPath || file.name;
  return p.startsWith('/') ? p : `/${p}`;
}

function evaluateCandidate(acc: AccountItem, totalBytes: number) {
  const isDriveDisabled = Boolean(acc.isDisabled);
  const hasHeadroom = acc.headroomBytes >= totalBytes;
  const remainingBudget = acc.transferStats?.remainingUploadBytes24h ?? 750 * 1024 * 1024 * 1024;
  const hasTransferBudget = remainingBudget >= totalBytes;
  const canHold = !isDriveDisabled && acc.authorized && hasHeadroom && hasTransferBudget;

  let labelSuffix = '';
  if (isDriveDisabled) {
    labelSuffix = ' (Disabled)';
  } else if (!acc.authorized) {
    labelSuffix = ' (Unauthorized)';
  } else if (!hasHeadroom) {
    labelSuffix = ` (No headroom: needs ${formatGbCompact(totalBytes)} GB)`;
  } else if (!hasTransferBudget) {
    labelSuffix = ' (24h transfer limit reached)';
  } else {
    labelSuffix = ` (${formatGbCompact(acc.headroomBytes)} GB free)`;
  }

  return { canHold, labelSuffix };
}

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(11, 20, 18, 0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 110,
    padding: spacing.space4,
    boxSizing: 'border-box',
    transition: motion.transitionFast,
  },
  modal: {
    width: '460px',
    maxWidth: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    zIndex: 120,
    boxSizing: 'border-box',
  },
  header: {
    height: '48px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
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
    fontSize: typography.fontSizeSection,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    margin: 0,
  },
  closeBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    color: colors.secondaryText,
    padding: spacing.space1,
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
  body: {
    padding: spacing.space5,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space4,
    backgroundColor: colors.surface,
  },
  accountCard: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  accountName: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
  },
  accountMeta: {
    fontSize: typography.fontSizeMeta,
    fontFamily: typography.fontFamilyMono,
    color: colors.secondaryText,
  },
  accountFilesInfo: {
    fontSize: typography.fontSizeMeta,
    fontFamily: typography.fontFamilyBody,
    color: colors.primaryText,
    fontWeight: typography.fontWeightBody,
    marginTop: spacing.space1,
  },
  fileListGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  fileListLabel: {
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    color: colors.secondaryText,
  },
  fileListContainer: {
    height: '140px',
    maxHeight: '140px',
    overflowY: 'auto',
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    padding: spacing.space1,
    position: 'relative',
    boxSizing: 'border-box',
  },
  virtualTrack: {
    width: '100%',
    position: 'relative',
  },
  fileRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    height: '26px',
    borderRadius: radius.compact,
    boxSizing: 'border-box',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
    },
  },
  fileName: {
    fontSize: typography.fontSizeMeta,
    fontFamily: typography.fontFamilyBody,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    minWidth: 0,
  },
  fileSize: {
    fontSize: typography.fontSizeMeta,
    fontFamily: typography.fontFamilyMono,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
    marginLeft: spacing.space2,
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  label: {
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    color: colors.secondaryText,
  },
  selectWrapper: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    width: '100%',
  },
  select: {
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    width: '100%',
    height: '34px',
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.compact,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space9,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    color: colors.primaryText,
    outline: 'none',
    boxSizing: 'border-box',
    cursor: 'pointer',
    transition: motion.transitionFast,
    ':hover': {
      borderColor: colors.primaryText,
    },
    ':focus': {
      borderColor: colors.accentGold,
      outline: `2px solid ${colors.focusRing}`,
      outlineOffset: '-1px',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  selectChevron: {
    position: 'absolute',
    right: spacing.space3,
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: colors.secondaryText,
    display: 'flex',
    alignItems: 'center',
  },
  errorMessage: {
    fontSize: typography.fontSizeMeta,
    color: colors.danger,
    fontFamily: typography.fontFamilyMono,
  },
  footer: {
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
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
  cancelBtn: {
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
    fontWeight: typography.fontWeightBody,
    cursor: 'pointer',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
      borderColor: colors.primaryText,
    },
  },
  confirmBtn: {
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
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
});

export function MoveFilesModal({
  isOpen,
  onClose,
  sourceAccount,
  files,
  accounts,
  onConfirm,
}: MoveFilesModalProps) {
  const effectiveFileIds = useMemo(() => files.map((f) => f.id), [files]);
  const effectiveTotalBytes = useMemo(
    () => files.reduce((sum, f) => sum + (f.sizeBytes || 0), 0),
    [files]
  );

  const candidateAccounts = useMemo(
    () =>
      accounts.filter(
        (acc) =>
          (!sourceAccount || acc.id !== sourceAccount.id) &&
          (!sourceAccount?.poolId || acc.poolId === sourceAccount.poolId)
      ),
    [accounts, sourceAccount]
  );

  const firstEligibleId = useMemo(() => {
    const eligible = candidateAccounts.find(
      (acc) => evaluateCandidate(acc, effectiveTotalBytes).canHold
    );
    return eligible?.id ?? candidateAccounts[0]?.id ?? '';
  }, [candidateAccounts, effectiveTotalBytes]);

  const [targetAccountId, setTargetAccountId] = useState<string>(firstEligibleId);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const fileListRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => fileListRef.current,
    estimateSize: () => 26,
    overscan: 5,
  });

  useEffect(() => {
    if (isOpen) {
      setTargetAccountId(firstEligibleId);
      setError(null);
      setIsLoading(false);
      const timer = setTimeout(() => {
        selectRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, firstEligibleId]);

  if (!isOpen) return null;

  const currentTarget = candidateAccounts.find((acc) => acc.id === targetAccountId);
  const currentCanHold = currentTarget
    ? evaluateCandidate(currentTarget, effectiveTotalBytes).canHold
    : false;

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isLoading || !targetAccountId || !currentCanHold || effectiveFileIds.length === 0) return;

    setIsLoading(true);
    setError(null);
    try {
      await onConfirm(effectiveFileIds, targetAccountId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      {...stylex.props(styles.backdrop)}
      onClick={!isLoading ? onClose : undefined}
      onKeyDown={handleKeyDown}
    >
      <div
        {...stylex.props(styles.modal)}
        role="dialog"
        aria-modal="true"
        aria-label="Move files to another account"
        onClick={(e) => e.stopPropagation()}
      >
        <div {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.titleGroup)}>
            <IconFolder size={16} />
            <h2 {...stylex.props(styles.title)}>Move files to another account</h2>
          </div>
          <button
            type="button"
            {...stylex.props(styles.closeBtn)}
            onClick={onClose}
            disabled={isLoading}
            aria-label="Close"
          >
            <IconClose size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div {...stylex.props(styles.body)}>
            <div {...stylex.props(styles.accountCard)}>
              <span {...stylex.props(styles.accountName)}>
                {sourceAccount ? sourceAccount.displayName || sourceAccount.id : 'Unknown account'}
              </span>
              <span {...stylex.props(styles.accountMeta)}>
                {sourceAccount?.email || sourceAccount?.id || ''}
              </span>
              <span {...stylex.props(styles.accountFilesInfo)}>
                {effectiveFileIds.length} file{effectiveFileIds.length === 1 ? '' : 's'} ({formatBytes(effectiveTotalBytes)})
              </span>
            </div>

            {files.length > 0 && (
              <div {...stylex.props(styles.fileListGroup)}>
                <span {...stylex.props(styles.fileListLabel)}>
                  Files to move ({files.length})
                </span>
                <div ref={fileListRef} {...stylex.props(styles.fileListContainer)}>
                  <div
                    {...stylex.props(styles.virtualTrack)}
                    style={{ height: `${virtualizer.getTotalSize()}px` }}
                  >
                    {virtualizer.getVirtualItems().map((virtualRow) => {
                      const file = files[virtualRow.index];
                      if (!file) return null;
                      const displayPath = formatFilePath(file);
                      return (
                        <div
                          key={file.id}
                          {...stylex.props(styles.fileRow)}
                          style={{
                            height: `${virtualRow.size}px`,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          <span {...stylex.props(styles.fileName)} title={displayPath}>
                            {displayPath}
                          </span>
                          <span {...stylex.props(styles.fileSize)}>
                            {formatBytes(file.sizeBytes)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            <div {...stylex.props(styles.fieldGroup)}>
              <label {...stylex.props(styles.label)}>Target storage account</label>
              <div {...stylex.props(styles.selectWrapper)}>
                <select
                  ref={selectRef}
                  value={targetAccountId}
                  onChange={(e) => {
                    setTargetAccountId(e.target.value);
                    if (error) setError(null);
                  }}
                  disabled={isLoading || candidateAccounts.length === 0}
                  {...stylex.props(styles.select)}
                >
                  {candidateAccounts.length === 0 ? (
                    <option value="" disabled>
                      No candidate accounts available
                    </option>
                  ) : (
                    candidateAccounts.map((acc) => {
                      const { canHold, labelSuffix } = evaluateCandidate(
                        acc,
                        effectiveTotalBytes
                      );
                      const optTitle = `${acc.displayName || acc.id} (${acc.email || acc.id})${labelSuffix}`;
                      return (
                        <option
                          key={acc.id}
                          value={acc.id}
                          disabled={!canHold}
                          title={optTitle}
                        >
                          {(acc.displayName || acc.id) + labelSuffix}
                        </option>
                      );
                    })
                  )}
                </select>
                <div {...stylex.props(styles.selectChevron)}>
                  <IconChevronDown size={14} strokeWidth={2.5} />
                </div>
              </div>
              {error && <span {...stylex.props(styles.errorMessage)}>{error}</span>}
            </div>
          </div>

          <div {...stylex.props(styles.footer)}>
            <button
              type="button"
              {...stylex.props(styles.cancelBtn)}
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              type="submit"
              {...stylex.props(styles.confirmBtn)}
              disabled={isLoading || !targetAccountId || !currentCanHold || effectiveFileIds.length === 0}
            >
              {isLoading ? 'Moving...' : 'Move files'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
