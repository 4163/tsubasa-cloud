import * as stylex from '@stylexjs/stylex';
import { colors, layout, motion, radius, spacing, typography } from '../tokens.stylex.js';
import { useSiteTheme } from '../theme.js';
import { siteUrl } from '../url.js';

export interface SiteHeaderProps {
  activeRoute: 'home' | 'data-policy';
}

const styles = stylex.create({
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 10010,
    width: '100%',
    height: layout.headerHeight,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingInline: spacing.space6,
    boxSizing: 'border-box',
    userSelect: 'none',
  },
  inner: {
    width: '100%',
    maxWidth: '1120px',
    display: 'grid',
    gridTemplateColumns: '1fr auto 1fr',
    alignItems: 'center',
    columnGap: {
      default: '24px',
      '@media (max-width: 768px)': spacing.space4,
    },
  },
  leftSlot: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: {
      default: 'flex-end',
      '@media (max-width: 768px)': 'flex-start',
    },
    minWidth: 0,
  },
  spacer: {
    minWidth: 0,
  },
  nav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '28px',
    userSelect: 'none',
  },
  navLink: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    textDecoration: 'none',
    fontFamily: typography.fontFamilyBody,
    fontSize: '13px',
    fontWeight: '600',
    letterSpacing: '0.01em',
    color: colors.secondaryText,
    whiteSpace: 'nowrap',
    outline: 'none',
    borderRadius: radius.compact,
    transition: motion.transitionFast,
    ':hover': {
      color: colors.primaryText,
      textDecoration: 'underline',
      textUnderlineOffset: '6px',
      textDecorationThickness: '1px',
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '4px',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
    },
  },
  navLinkActive: {
    color: colors.primaryText,
    textDecoration: 'underline',
    textDecorationColor: colors.brandAccent,
    textUnderlineOffset: '6px',
    textDecorationThickness: '2px',
    ':hover': {
      color: colors.primaryText,
      textDecorationColor: colors.brandAccent,
      textDecorationThickness: '2px',
    },
  },
  themeToggle: {
    width: '36px',
    height: '36px',
    borderRadius: radius.pill,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    cursor: 'pointer',
    flexShrink: 0,
    outline: 'none',
    userSelect: 'none',
    transform: 'rotate(0deg)',
    transition: 'background-color 100ms ease-out, border-color 100ms ease-out, transform 100ms ease-out',
    ':hover': {
      borderColor: colors.brandAccent,
      backgroundColor: colors.brandAccentSurface,
      transform: 'rotate(15deg)',
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
      width: '44px',
      height: '44px',
    },
  },
  themeIcon: {
    display: 'block',
    pointerEvents: 'none',
  },
});

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...stylex.props(styles.themeIcon)}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...stylex.props(styles.themeIcon)}
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

export function SiteHeader({ activeRoute }: SiteHeaderProps) {
  const { isDark, toggleTheme } = useSiteTheme();
  const nextLabel = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  const headerProps = stylex.props(styles.header);

  return (
    <header {...headerProps} className={`${headerProps.className ?? ''} grain-header`.trim()}>
      <div {...stylex.props(styles.inner)}>
        <div {...stylex.props(styles.leftSlot)}>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleTheme}
            aria-label={nextLabel}
            title={nextLabel}
            {...stylex.props(styles.themeToggle)}
          >
            {isDark ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>

        <nav aria-label="Primary" {...stylex.props(styles.nav)}>
          <a
            href={siteUrl('/')}
            aria-current={activeRoute === 'home' ? 'page' : undefined}
            {...stylex.props(styles.navLink, activeRoute === 'home' && styles.navLinkActive)}
          >
            Home
          </a>
          <a
            href={siteUrl('/data-policy')}
            aria-current={activeRoute === 'data-policy' ? 'page' : undefined}
            {...stylex.props(
              styles.navLink,
              activeRoute === 'data-policy' && styles.navLinkActive,
            )}
          >
            Data Policy
          </a>
        </nav>

        <div aria-hidden="true" {...stylex.props(styles.spacer)} />
      </div>
    </header>
  );
}
