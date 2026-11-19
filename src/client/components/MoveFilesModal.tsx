import React, { useState, useEffect, useRef, useMemo, useId } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as stylex from '@stylexjs/stylex';
import { colors, layout, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconFolder } from './Icons.js';
import { formatBytes } from '../utils/format.js';
import { evaluateAccountTransferCandidate } from '../utils/accountTransfer.js';
import { ModalDialog } from './ModalDialog.js';
import { ModalHeader, modalChromeStyles } from './ModalChrome.js';
import { SelectField } from './SelectField.js';
import { useScrollableKeyboardNav } from '../hooks/useScrollableKeyboardNav.js';
import type { AccountItem, MoveFileItem } from '../types.js';

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
    width: layout.drawerWidth,
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
    outline: 'none',
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
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
  const submittingRef = useRef(false);
  const firstEligibleIdRef = useRef(firstEligibleId);
  firstEligibleIdRef.current = firstEligibleId;
  const wasOpenRef = useRef(false);
  const prevSourceAccountIdRef = useRef<string | undefined>(sourceAccount?.id);
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

  useScrollableKeyboardNav({
    scrollRef: fileListRef,
    enabled: isOpen && files.length > 0,
  });

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      prevSourceAccountIdRef.current = sourceAccount?.id;
      submittingRef.current = false;
      return;
    }

    if (!wasOpenRef.current || prevSourceAccountIdRef.current !== sourceAccount?.id) {
      setTargetAccountId(firstEligibleIdRef.current);
      setError(null);
      setIsLoading(false);
      submittingRef.current = false;
    }

    wasOpenRef.current = true;
    prevSourceAccountIdRef.current = sourceAccount?.id;
  }, [isOpen, sourceAccount?.id]);

  const currentTarget = candidateAccounts.find((acc) => acc.id === targetAccountId);
  const currentCanHold = currentTarget
    ? evaluateAccountTransferCandidate(currentTarget, effectiveTotalBytes).canHold
    : false;

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (
      submittingRef.current ||
      isLoading ||
      !targetAccountId ||
      !currentCanHold ||
      effectiveFileIds.length === 0
    ) {
      return;
    }

    submittingRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      await onConfirm(effectiveFileIds, targetAccountId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
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
      <ModalHeader
        titleId={titleId}
        title="Move files to another account"
        icon={<IconFolder size={16} />}
        onClose={onClose}
        isBusy={isLoading}
        closeAriaLabel="Close"
      />

      <form onSubmit={handleSubmit}>
        <div {...stylex.props(modalChromeStyles.body, modalChromeStyles.bodySpaced)}>
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
              <div
                ref={fileListRef}
                role="region"
                aria-label="Files to move"
                tabIndex={0}
                {...stylex.props(styles.fileListContainer)}
              >
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

          <div {...stylex.props(modalChromeStyles.fieldGroup)}>
            <label htmlFor={selectId} {...stylex.props(modalChromeStyles.label)}>Target storage account</label>
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
              {error && <span {...stylex.props(modalChromeStyles.errorMessage)}>{error}</span>}
            </div>
          </div>
        </div>

        <div {...stylex.props(modalChromeStyles.footer)}>
          <button
            type="button"
            {...stylex.props(modalChromeStyles.cancelBtn, modalChromeStyles.cancelBtnSurface)}
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            type="submit"
            {...stylex.props(modalChromeStyles.primaryBtn)}
            disabled={isLoading || !targetAccountId || !currentCanHold || effectiveFileIds.length === 0}
          >
            {isLoading ? 'Moving...' : 'Move files'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
