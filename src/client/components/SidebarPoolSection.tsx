import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconTrash, IconPlus, IconEdit, IconChevronDown } from './Icons.js';
import type { PoolSummary } from '../types.js';

const styles = stylex.create({
  poolSection: {
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    flexShrink: 0,
  },
  poolHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
  },
  poolHeadingLabel: {
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightSection,
    color: colors.dimText,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  poolHeaderActions: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space1,
  },
  poolActionBtn: {
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    fontSize: typography.fontSizeBadge,
    fontWeight: '600',
    color: colors.secondaryText,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.brandAccent,
      color: colors.primaryText,
    },
    ':focus-visible': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
  poolDeleteBtn: {
    ':hover': {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
      color: colors.danger,
    },
  },
  poolSelectWrapper: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    width: '100%',
  },
  poolSelect: {
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    width: '100%',
    height: '32px',
    paddingLeft: spacing.space3,
    paddingRight: '28px',
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    outline: 'none',
    boxSizing: 'border-box',
    transitionProperty: 'background-color, opacity',
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easingOut,
    ':hover': {
      borderColor: colors.accentGold,
    },
    ':focus': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    ':focus-visible': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
  },
  poolSelectChevron: {
    position: 'absolute',
    right: '8px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: colors.secondaryText,
    display: 'flex',
    alignItems: 'center',
  },
});

interface SidebarPoolSectionProps {
  sortedPools: PoolSummary[];
  activePool?: PoolSummary;
  activePoolId?: number;
  onSelectPool?: (poolId: number) => void;
  onCreatePool?: () => void;
  onRenamePoolPrompt?: (pool: PoolSummary) => void;
  onDeletePoolPrompt?: (pool: PoolSummary) => void;
}

export function SidebarPoolSection({
  sortedPools,
  activePool,
  activePoolId,
  onSelectPool,
  onCreatePool,
  onRenamePoolPrompt,
  onDeletePoolPrompt,
}: SidebarPoolSectionProps) {
  if (sortedPools.length === 0) {
    return null;
  }

  const standardPoolCount = sortedPools.filter((p) => !p.isSharePool).length;

  return (
    <section aria-label="Storage Pool Switcher" {...stylex.props(styles.poolSection)}>
      <div {...stylex.props(styles.poolHeaderRow)}>
        <span {...stylex.props(styles.poolHeadingLabel)}>Storage pool</span>
        <div {...stylex.props(styles.poolHeaderActions)}>
          {activePool && !activePool.isSharePool && onRenamePoolPrompt && (
            <button
              type="button"
              {...stylex.props(styles.poolActionBtn)}
              onClick={() => onRenamePoolPrompt(activePool)}
              aria-label="Rename storage pool"
            >
              <IconEdit size={11} />
              <span>Rename</span>
            </button>
          )}
          {activePool && !activePool.isSharePool && activePool.accountCount === 0 && standardPoolCount > 1 && onDeletePoolPrompt && (
            <button
              type="button"
              {...stylex.props(styles.poolActionBtn, styles.poolDeleteBtn)}
              onClick={() => onDeletePoolPrompt(activePool)}
              aria-label="Delete storage pool"
            >
              <IconTrash size={11} />
              <span>Delete</span>
            </button>
          )}
          {onCreatePool && (
            <button
              type="button"
              {...stylex.props(styles.poolActionBtn)}
              onClick={onCreatePool}
              aria-label="Create new storage pool"
            >
              <IconPlus size={11} strokeWidth={2.5} />
              <span>New</span>
            </button>
          )}
        </div>
      </div>

      <div {...stylex.props(styles.poolSelectWrapper)}>
        <select
          aria-label="Select active storage pool"
          value={activePoolId}
          onChange={(e) => onSelectPool?.(Number(e.target.value))}
          {...stylex.props(styles.poolSelect)}
        >
          {sortedPools.map((pool) => (
            <option key={pool.id} value={pool.id}>
              {pool.name} ({pool.accountCount} {pool.accountCount === 1 ? 'Drive' : 'Drives'})
            </option>
          ))}
        </select>
        <div {...stylex.props(styles.poolSelectChevron)}>
          <IconChevronDown size={14} strokeWidth={2.5} />
        </div>
      </div>
    </section>
  );
}
