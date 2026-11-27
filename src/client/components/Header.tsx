import React from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import { IconMenu, IconSearch, IconClose, IconMonitor, IconSun, IconMoon, IconGitHub, IconRefreshCw } from './Icons';
import type { ThemeChoice } from '../utils/theme.js';
import { useMediaQuery } from '../utils/useBeforeUnload.js';

interface HeaderProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  onToggleMobileMenu?: () => void;
  isMobileMenuOpen?: boolean;
  mobileMenuControlsId?: string;
  onResetDemo?: () => void;
  isResettingDemo?: boolean;
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
    contain: 'layout style paint',
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
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    padding: spacing.space2,
    color: colors.primaryText,
    borderRadius: radius.compact,
    outline: 'none',
    ':hover': {
      backgroundColor: colors.rowHover,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '2px',
    },
    '@media (max-width: 768px)': {
      display: 'inline-flex',
    },
    '@media (pointer: coarse)': {
      minWidth: '40px',
      minHeight: '40px',
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
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
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
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    color: colors.secondaryText,
    padding: spacing.space1,
    borderRadius: radius.compact,
    fontSize: '12px',
    lineHeight: '1',
    outline: 'none',
    ':hover': {
      color: colors.primaryText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    '@media (pointer: coarse)': {
      minWidth: '36px',
      minHeight: '36px',
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
    height: '28px',
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.button,
    padding: '2px',
    gap: '2px',
    boxSizing: 'border-box',
    '@media (pointer: coarse)': {
      height: 'auto',
    },
  },
  themeBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    borderRadius: radius.compact,
    color: colors.secondaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: '500',
    height: '22px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    boxSizing: 'border-box',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      color: colors.primaryText,
      backgroundColor: colors.surface,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
  themeBtnActive: {
    backgroundColor: colors.surfaceElevated,
    color: colors.primaryText,
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
  githubLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '28px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.button,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    color: colors.secondaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: '500',
    textDecoration: 'none',
    boxSizing: 'border-box',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.surface,
      color: colors.primaryText,
      borderColor: colors.border,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '2px',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
  githubText: {
    '@media (max-width: 600px)': {
      display: 'none',
    },
  },
  resetDemoBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '28px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.button,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    color: colors.secondaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: '500',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.surface,
      color: colors.primaryText,
      borderColor: colors.border,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '2px',
    },
    ':disabled': {
      opacity: 0.6,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
});

export function Header({
  searchQuery,
  onSearchChange,
  theme,
  onThemeChange,
  onToggleMobileMenu,
  isMobileMenuOpen = false,
  mobileMenuControlsId = 'mobile-sidebar-dialog',
  onResetDemo,
  isResettingDemo = false,
}: HeaderProps) {
  const isGitHubIconOnly = useMediaQuery('(max-width: 600px)');

  return (
    <header {...stylex.props(styles.header)}>
      <div {...stylex.props(styles.leftGroup)}>
        {onToggleMobileMenu && (
          <button
            type="button"
            {...stylex.props(styles.mobileMenuBtn)}
            onClick={onToggleMobileMenu}
            aria-label="Toggle navigation drawer"
            aria-expanded={isMobileMenuOpen}
            aria-controls={mobileMenuControlsId}
            title="Menu"
          >
            <IconMenu {...stylex.props(styles.iconSvg)} />
          </button>
        )}

        <div {...stylex.props(styles.searchContainer)}>
          <IconSearch {...stylex.props(styles.searchIcon)} />
          <input
            type="text"
            placeholder="Search pooled files and directories..."
            aria-label="Search pooled files and directories"
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
              title="Clear search"
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
            aria-label="Follow system theme"
            aria-pressed={theme === 'auto'}
          >
            <IconMonitor {...stylex.props(styles.iconSvg)} />
            Auto
          </button>

          <button
            type="button"
            {...stylex.props(styles.themeBtn, theme === 'light' && styles.themeBtnActive)}
            onClick={() => onThemeChange('light')}
            aria-label="Light mode"
            aria-pressed={theme === 'light'}
          >
            <IconSun {...stylex.props(styles.iconSvg)} />
            Light
          </button>

          <button
            type="button"
            {...stylex.props(styles.themeBtn, theme === 'dark' && styles.themeBtnActive)}
            onClick={() => onThemeChange('dark')}
            aria-label="Dark mode"
            aria-pressed={theme === 'dark'}
          >
            <IconMoon {...stylex.props(styles.iconSvg)} />
            Dark
          </button>
        </div>

        <a
          href="https://github.com/4163/tsubasa-cloud"
          target="_blank"
          rel="noopener noreferrer"
          {...stylex.props(styles.githubLink)}
          aria-label="GitHub repository"
          title={isGitHubIconOnly ? 'GitHub' : undefined}
        >
          <IconGitHub size={14} />
          <span {...stylex.props(styles.githubText)}>GitHub</span>
        </a>

        {__DEMO_MODE__ && onResetDemo && (
          <button
            type="button"
            {...stylex.props(styles.resetDemoBtn)}
            onClick={onResetDemo}
            disabled={isResettingDemo}
            aria-label={isResettingDemo ? 'Resetting demo' : 'Reset demo'}
            title={isGitHubIconOnly ? (isResettingDemo ? 'Resetting...' : 'Reset demo') : undefined}
          >
            <IconRefreshCw size={13} />
            <span {...stylex.props(styles.githubText)}>
              {isResettingDemo ? 'Resetting...' : 'Reset demo'}
            </span>
          </button>
        )}
      </div>
    </header>
  );
}
