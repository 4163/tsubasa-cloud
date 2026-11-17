import React, { useState, useEffect, useRef, useMemo, useId } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconFolder } from './Icons.js';
import { formatBytes } from '../utils/format.js';
import { evaluateAccountTransferCandidate } from '../utils/accountTransfer.js';
import { ModalDialog } from './ModalDialog.js';
import { SelectField } from './SelectField.js';
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

function formatFilePath(file: MoveFileItem): string {
  const p = file.virtualPath || file.name;
  return p.startsWith('/') ? p : `/${p}`;
}

const styles = stylex.create({
  surface: {
    width: '460px',
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
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.35,
      color: colors.secondaryText,
      backgroundColor: 'transparent',
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minWidth: '44px',
      minHeight: '44px',
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
  errorMessage: {
    fontSize: typography.fontSizeMeta,
    color: colors.dangerTextOnSurface,
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
      backgroundColor: colors.surface,
      color: colors.secondaryText,
      borderColor: colors.border,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
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
      (acc) => evaluateAccountTransferCandidate(acc, effectiveTotalBytes).canHold
    );
    return eligible?.id ?? candidateAccounts[0]?.id ?? '';
  }, [candidateAccounts, effectiveTotalBytes]);

  const [targetAccountId, setTargetAccountId] = useState<string>(firstEligibleId);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const fileListRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const selectId = useId();

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
    }
  }, [isOpen, firstEligibleId]);

  const currentTarget = candidateAccounts.find((acc) => acc.id === targetAccountId);
  const currentCanHold = currentTarget
    ? evaluateAccountTransferCandidate(currentTarget, effectiveTotalBytes).canHold
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

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      isBusy={isLoading}
      ariaLabelledBy={titleId}
      initialFocusRef={selectRef}
      surfaceStyle={styles.surface}
    >
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.titleGroup)}>
          <IconFolder size={16} />
          <h2 id={titleId} {...stylex.props(styles.title)}>Move files to another account</h2>
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
            <label htmlFor={selectId} {...stylex.props(styles.label)}>Target storage account</label>
            <SelectField
              id={selectId}
              selectRef={selectRef}
              autoFocus
              value={targetAccountId}
              onChange={(e) => {
                setTargetAccountId(e.target.value);
                if (error) setError(null);
              }}
              disabled={isLoading || candidateAccounts.length === 0}
            >
              {candidateAccounts.length === 0 ? (
                <option value="" disabled>
                  No candidate accounts available
                </option>
              ) : (
                candidateAccounts.map((acc) => {
                  const { canHold, optionLabel, optionTitle } =
                    evaluateAccountTransferCandidate(acc, effectiveTotalBytes);
                  return (
                    <option
                      key={acc.id}
                      value={acc.id}
                      disabled={!canHold}
                      title={optionTitle}
                    >
                      {optionLabel}
                    </option>
                  );
                })
              )}
            </SelectField>
            <div role="status" aria-live="polite">
              {error && <span {...stylex.props(styles.errorMessage)}>{error}</span>}
            </div>
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
    </ModalDialog>
  );
}
