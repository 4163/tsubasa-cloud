import React from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';

const styles = stylex.create({
  sectionHeaderBand: {
    minHeight: '32px',
    paddingTop: spacing.space1,
    paddingBottom: spacing.space1,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
    boxSizing: 'border-box',
  },
  sectionTitle: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeTableHeader,
    fontWeight: typography.fontWeightSection,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: colors.secondaryText,
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
  sectionCountBadge: {
    height: '18px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryText,
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  btnPrimary: {
    height: '26px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: '600',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
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
      paddingLeft: spacing.space4,
      paddingRight: spacing.space4,
    },
  },
  btnSecondary: {
    height: '26px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: '600',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
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
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
      paddingLeft: spacing.space4,
      paddingRight: spacing.space4,
    },
  },
});

export interface DrawerSectionHeaderProps {
  icon?: React.ReactNode;
  title: string;
  count: number | string;
}

export function DrawerSectionHeader({ icon, title, count }: DrawerSectionHeaderProps) {
  return (
    <div {...stylex.props(styles.sectionHeaderBand)}>
      <h3 {...stylex.props(styles.sectionTitle)}>
        {icon}
        <span>{title}</span>
      </h3>
      <span {...stylex.props(styles.sectionCountBadge)}>{count}</span>
    </div>
  );
}

export interface DrawerButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant: 'primary' | 'secondary';
  style?: stylex.StyleXStyles;
}

export function DrawerButton({
  variant,
  style,
  type = 'button',
  children,
  ...rest
}: DrawerButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      {...stylex.props(variant === 'primary' ? styles.btnPrimary : styles.btnSecondary, style)}
    >
      {children}
    </button>
  );
}
