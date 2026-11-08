import React from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import { IconMenu, IconSearch, IconClose, IconMonitor, IconSun, IconMoon } from './Icons';

export type ThemeChoice = 'auto' | 'light' | 'dark';

interface HeaderProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  onToggleMobileMenu?: () => void;
}

const styles = stylex.create({
  header: {
    height: layout.headerHeight,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    boxSizing: 'border-box',
    gap: spacing.space4,
    zIndex: 10,
  },
  leftGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space4,
    flex: 1,
    maxWidth: layout.searchMaxWidth,
  },
  mobileMenuBtn: {
    display: 'none',
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    padding: spacing.space2,
    color: colors.primaryText,
    borderRadius: radius.compact,
    ':hover': {
      backgroundColor: colors.rowHover,
    },
    '@media (max-width: 768px)': {
      display: 'inline-flex',
    },
  },
  searchContainer: {
    display: 'flex',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.button,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space3,
    height: layout.searchHeight,
    width: '100%',
    boxSizing: 'border-box',
    transition: motion.transitionFast,
    ':focus-within': {
      borderColor: colors.accentGold,
      boxShadow: `0 0 0 2px ${colors.focusRing}`,
    },
  },
  searchIcon: {
    width: '14px',
    height: '14px',
    color: colors.secondaryText,
    marginRight: spacing.space2,
    flexShrink: 0,
  },
  searchInput: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    outline: 'none',
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    width: '100%',
    padding: '0',
    '::placeholder': {
      color: colors.dimText,
    },
  },
  clearBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    color: colors.secondaryText,
    padding: spacing.space1,
    fontSize: '12px',
    lineHeight: '1',
    ':hover': {
      color: colors.primaryText,
    },
  },
  rightGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space4,
  },
  themeSelector: {
    display: 'inline-flex',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.button,
    padding: '2px',
    gap: '2px',
    boxSizing: 'border-box',
  },
  themeBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    borderRadius: radius.compact,
    color: colors.secondaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: '500',
    paddingTop: '3px',
    paddingBottom: '3px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    boxSizing: 'border-box',
    transition: motion.transitionFast,
    ':hover': {
      color: colors.primaryText,
      backgroundColor: colors.surface,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
  },
  themeBtnActive: {
    backgroundColor: colors.surfaceElevated,
    color: colors.primaryText,
    boxShadow: '0 1px 2px rgba(17, 29, 24, 0.08)',
    cursor: 'pointer',
    ':hover': {
      backgroundColor: colors.surfaceElevated,
      color: colors.primaryText,
    },
  },
  iconSvg: {
    width: '13px',
    height: '13px',
  },
});

export function Header({
  searchQuery,
  onSearchChange,
  theme,
  onThemeChange,
  onToggleMobileMenu,
}: HeaderProps) {
  return (
    <header {...stylex.props(styles.header)}>
      <div {...stylex.props(styles.leftGroup)}>
        {onToggleMobileMenu && (
          <button
            type="button"
            {...stylex.props(styles.mobileMenuBtn)}
            onClick={onToggleMobileMenu}
            aria-label="Toggle navigation drawer"
          >
            <IconMenu {...stylex.props(styles.iconSvg)} />
          </button>
        )}

        <div {...stylex.props(styles.searchContainer)}>
          <IconSearch {...stylex.props(styles.searchIcon)} />
          <input
            type="text"
            placeholder="Search pooled files and directories..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            {...stylex.props(styles.searchInput)}
          />
          {searchQuery && (
            <button
              type="button"
              {...stylex.props(styles.clearBtn)}
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
            >
              <IconClose size={12} />
            </button>
          )}
        </div>
      </div>

      <div {...stylex.props(styles.rightGroup)}>
        <div {...stylex.props(styles.themeSelector)} role="group" aria-label="Theme mode">
          <button
            type="button"
            {...stylex.props(styles.themeBtn, theme === 'auto' && styles.themeBtnActive)}
            onClick={() => onThemeChange('auto')}
            title="Follow system theme"
          >
            <IconMonitor {...stylex.props(styles.iconSvg)} />
            Auto
          </button>

          <button
            type="button"
            {...stylex.props(styles.themeBtn, theme === 'light' && styles.themeBtnActive)}
            onClick={() => onThemeChange('light')}
            title="Light mode"
          >
            <IconSun {...stylex.props(styles.iconSvg)} />
            Light
          </button>

          <button
            type="button"
            {...stylex.props(styles.themeBtn, theme === 'dark' && styles.themeBtnActive)}
            onClick={() => onThemeChange('dark')}
            title="Dark mode"
          >
            <IconMoon {...stylex.props(styles.iconSvg)} />
            Dark
          </button>
        </div>
      </div>
    </header>
  );
}
