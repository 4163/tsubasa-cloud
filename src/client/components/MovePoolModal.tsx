import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconFolder, IconChevronDown } from './Icons.js';
import { type AccountItem, type PoolSummary } from './Sidebar.js';
import { sortPools } from '../utils/format.js';
import { useDialogLock } from '../utils/useBeforeUnload.js';

export interface MovePoolModalProps {
  isOpen: boolean;
  onClose: () => void;
  account: AccountItem | null;
  pools: PoolSummary[];
  activePoolId: number;
  onConfirm: (accountId: string, targetPoolId: number) => Promise<void> | void;
}

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: colors.modalBackdrop,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 110,
    padding: spacing.space4,
    boxSizing: 'border-box',
    transition: motion.transitionFast,
  },
  modal: {
    width: '440px',
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
    ':disabled': {
      opacity: 0.35,
      color: colors.secondaryText,
      backgroundColor: 'transparent',
      cursor: 'not-allowed',
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
    gap: '4px',
  },
  accountName: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '600',
    color: colors.primaryText,
  },
  accountMeta: {
    fontSize: typography.fontSizeMeta,
    fontFamily: typography.fontFamilyMono,
    color: colors.secondaryText,
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  label: {
    fontSize: typography.fontSizeMeta,
    fontWeight: '600',
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
    paddingRight: '32px',
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
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  selectChevron: {
    position: 'absolute',
    right: '10px',
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
    fontWeight: '500',
    cursor: 'pointer',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
      borderColor: colors.primaryText,
    },
    ':disabled': {
      opacity: 0.5,
      backgroundColor: colors.surface,
      color: colors.secondaryText,
      borderColor: colors.border,
      cursor: 'not-allowed',
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
  const selectRef = useRef<HTMLSelectElement | null>(null);

  useDialogLock(isOpen && Boolean(account), isLoading, onClose);

  useEffect(() => {
    if (isOpen && account) {
      const defaultTarget = candidatePools[0]?.id ?? currentPoolId;
      setTargetPoolId(defaultTarget);
      setError(null);
      setIsLoading(false);
      setTimeout(() => {
        selectRef.current?.focus();
      }, 50);
    }
  }, [isOpen, account, currentPoolId]);

  if (!isOpen || !account) return null;

  const selectedTargetPool = sortedPools.find((p) => p.id === targetPoolId);
  const canMoveToTarget = Boolean(
    selectedTargetPool && selectedTargetPool.id !== currentPoolId
  );

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isLoading || !canMoveToTarget) return;

    setIsLoading(true);
    setError(null);
    try {
      await onConfirm(account.id, targetPoolId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    }
  };

  return (
    <div
      {...stylex.props(styles.backdrop)}
      onClick={() => {
        if (!isLoading) onClose();
      }}
    >
      <div
        {...stylex.props(styles.modal)}
        role="dialog"
        aria-modal="true"
        aria-label="Move account to pool"
        onClick={(e) => e.stopPropagation()}
      >
        <div {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.titleGroup)}>
            <IconFolder size={16} />
            <h2 {...stylex.props(styles.title)}>Move account to pool</h2>
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
                {account.displayName || account.id}
              </span>
              <span {...stylex.props(styles.accountMeta)}>
                {account.email || account.id}
              </span>
            </div>

            <div {...stylex.props(styles.fieldGroup)}>
              <label {...stylex.props(styles.label)}>Target storage pool</label>
              <div {...stylex.props(styles.selectWrapper)}>
                <select
                  ref={selectRef}
                  value={targetPoolId}
                  onChange={(e) => {
                    setTargetPoolId(Number(e.target.value));
                    if (error) setError(null);
                  }}
                  disabled={isLoading || candidatePools.length === 0}
                  {...stylex.props(styles.select)}
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
              disabled={isLoading || !canMoveToTarget}
            >
              {isLoading ? 'Moving...' : 'Move pool'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
