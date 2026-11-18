import React, { useState, useEffect, useRef, useMemo, useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography } from '../tokens.stylex.js';
import { IconFolder } from './Icons.js';
import { type AccountItem, type PoolSummary } from './Sidebar.js';
import { sortPools } from '../utils/format.js';
import { ModalDialog } from './ModalDialog.js';
import { ModalHeader, modalChromeStyles } from './ModalChrome.js';
import { SelectField } from './SelectField.js';

export interface MovePoolModalProps {
  isOpen: boolean;
  onClose: () => void;
  account: AccountItem | null;
  pools: PoolSummary[];
  activePoolId: number;
  onConfirm: (accountId: string, targetPoolId: number) => Promise<void> | void;
}

const styles = stylex.create({
  surface: {
    width: '440px',
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
    fontWeight: typography.fontWeightSection,
    color: colors.primaryText,
  },
  accountMeta: {
    fontSize: typography.fontSizeMeta,
    fontFamily: typography.fontFamilyMono,
    color: colors.secondaryText,
  },
});

export function MovePoolModal({
  isOpen,
  onClose,
  account,
  pools,
  activePoolId,
  onConfirm,
}: MovePoolModalProps) {
  const sortedPools = useMemo(() => sortPools(pools), [pools]);
  const currentPoolId = account?.poolId ?? activePoolId ?? 1;
  const candidatePools = sortedPools.filter((p) => p.id !== currentPoolId);

  const [targetPoolId, setTargetPoolId] = useState<number>(() => {
    return candidatePools[0]?.id ?? currentPoolId;
  });
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const submittingRef = useRef(false);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const titleId = useId();
  const selectId = useId();
  const effectiveOpen = isOpen && Boolean(account);

  useEffect(() => {
    if (effectiveOpen) {
      const defaultTarget = candidatePools[0]?.id ?? currentPoolId;
      submittingRef.current = false;
      setTargetPoolId(defaultTarget);
      setError(null);
      setIsLoading(false);
    }
  }, [effectiveOpen, account, currentPoolId]);

  const selectedTargetPool = sortedPools.find((p) => p.id === targetPoolId);
  const canMoveToTarget = Boolean(
    selectedTargetPool && selectedTargetPool.id !== currentPoolId
  );

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (submittingRef.current || isLoading || !canMoveToTarget || !account) return;

    submittingRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      await onConfirm(account.id, targetPoolId);
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
      isOpen={effectiveOpen}
      onClose={onClose}
      isBusy={isLoading}
      ariaLabelledBy={titleId}
      initialFocusRef={selectRef}
      surfaceStyle={styles.surface}
    >
      {account && (
        <>
          <ModalHeader
            titleId={titleId}
            title="Move account to pool"
            icon={<IconFolder size={16} />}
            onClose={onClose}
            isBusy={isLoading}
            closeAriaLabel="Close"
          />

          <form onSubmit={handleSubmit}>
            <div {...stylex.props(modalChromeStyles.body, modalChromeStyles.bodySpaced)}>
              <div {...stylex.props(styles.accountCard)}>
                <span {...stylex.props(styles.accountName)}>
                  {account.displayName || account.id}
                </span>
                <span {...stylex.props(styles.accountMeta)}>
                  {account.email || account.id}
                </span>
              </div>

              <div {...stylex.props(modalChromeStyles.fieldGroup)}>
                <label htmlFor={selectId} {...stylex.props(modalChromeStyles.label)}>Target storage pool</label>
                <SelectField
                  id={selectId}
                  selectRef={selectRef}
                  autoFocus
                  value={targetPoolId}
                  onChange={(e) => {
                    setTargetPoolId(Number(e.target.value));
                    if (error) setError(null);
                  }}
                  disabled={isLoading || candidatePools.length === 0}
                >
                  {sortedPools.map((pool) => (
                    <option
                      key={pool.id}
                      value={pool.id}
                      disabled={pool.id === currentPoolId}
                    >
                      {pool.name} ({pool.accountCount} {pool.accountCount === 1 ? 'Drive' : 'Drives'}){pool.id === currentPoolId ? ' (Current)' : ''}
                    </option>
                  ))}
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
                disabled={isLoading || !canMoveToTarget}
              >
                {isLoading ? 'Moving...' : 'Move pool'}
              </button>
            </div>
          </form>
        </>
      )}
    </ModalDialog>
  );
}
