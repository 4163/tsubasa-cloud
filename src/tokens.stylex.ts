import * as stylex from '@stylexjs/stylex';

/**
 * Tsubasa~ Cloud design tokens.
 * Fuses Hanekawa's cool monochrome slate, QuiviT sage-mint surfaces, and gold highlights
 * with Dropbox desktop spatial partitioning and MEGA mobile density.
 *
 * Primary and secondary text pairings on surface/canvas meet 7:1+ WCAG AAA.
 * Intentional hover states, surfaceElevated, surfaceAlt badge pairings, and
 * brandAccentHover/dangerHover sit at >= 5.5:1; disabledText is reserved for disabled controls.
 */
export const colors = stylex.defineVars({
  // Surfaces & canvas
  background: '#eef2ec',
  foreground: '#111d18',
  canvas: '#eef2ec',
  surface: '#f7faf5',
  surfaceContainer: '#f7faf5',
  surfaceElevated: '#ffffff',
  surfaceAlt: '#e4ede7',

  // Text hierarchy (7:1+ on surface/canvas; disabledText reserved for disabled controls)
  primaryText: '#111d18',
  headingText: '#111d18',
  secondaryText: '#2d453b',
  mutedText: '#2d453b',
  dimText: '#3b5249',
  disabledText: '#768d83',

  // Brand & interactive states
  primary: '#111d18',
  primaryHover: '#2a4339',
  brandAccent: '#135349',
  brandAccentHover: '#0d7362',
  brandAccentText: '#ffffff',
  brandAccentSurface: '#e1efe9',
  accentGold: '#deb76c',
  accentGoldHover: '#e8c682',
  accentGoldText: '#111d18',
  accentGoldMarqueeBg: 'rgba(222, 183, 108, 0.14)',
  accentGoldDropBg: 'rgba(222, 183, 108, 0.10)',
  selectionBg: '#dcebe2',
  selectionBorder: '#deb76c',
  rowHover: '#e4ede7',
  focusRing: '#deb76c',

  // Structural strokes & borders
  border: '#8ea194',
  borderSubtle: '#c2d1c7',
  outline: '#8ea194',
  progressTrack: '#b8cbc0',
  poolGold: '#d98e04',

  // Status semantics (7:1+ on surface #f7faf5; hover states >= 5.5:1)
  success: '#116329',
  successSurface: '#e6f4ea',
  warning: '#6b3e00',
  warningSurface: '#f4f2e5',
  warningBorder: '#c9ae72',
  danger: '#82071e',
  dangerSurface: '#fdf2f2',
  dangerBorder: '#f1b5bc',
  dangerTextOnSurface: '#82071e',
  dangerHover: '#c61332',
  dangerText: '#ffffff',
  modalBackdrop: 'rgba(11, 20, 18, 0.65)',
});

/**
 * Dark theme token overrides.
 */
export const darkColors = stylex.createTheme(colors, {
  background: '#0b1412',
  foreground: '#e5f2eb',
  canvas: '#0b1412',
  surface: '#12211d',
  surfaceContainer: '#12211d',
  surfaceElevated: '#28443b',
  surfaceAlt: '#162d26',

  primaryText: '#e5f2eb',
  headingText: '#e5f2eb',
  secondaryText: '#a6c2b5',
  mutedText: '#a6c2b5',
  dimText: '#a6c2b5',
  disabledText: '#4c6359',

  primary: '#e5f2eb',
  primaryHover: '#ffffff',
  brandAccent: '#35c4a8',
  brandAccentHover: '#55dcc0',
  brandAccentText: '#111d18',
  brandAccentSurface: '#0d2721',
  accentGold: '#d4a13c',
  accentGoldHover: '#e6b856',
  accentGoldText: '#111d18',
  accentGoldMarqueeBg: 'rgba(222, 183, 108, 0.14)',
  accentGoldDropBg: 'rgba(222, 183, 108, 0.10)',
  selectionBg: '#1b3b32',
  selectionBorder: '#d4a13c',
  rowHover: '#162d26',
  focusRing: '#d4a13c',

  border: '#456659',
  borderSubtle: '#294138',
  outline: '#456659',
  progressTrack: '#38584c',
  poolGold: '#fbbf24',

  success: '#2dd4bf',
  successSurface: '#0d2a24',
  warning: '#f7d154',
  warningSurface: '#232212',
  warningBorder: '#604d19',
  danger: '#ff9492',
  dangerSurface: '#261615',
  dangerBorder: '#742730',
  dangerTextOnSurface: '#ff9492',
  dangerHover: '#ffc4c2',
  dangerText: '#1c080a',
  modalBackdrop: 'rgba(11, 20, 18, 0.65)',
});

/**
 * Spacing steps.
 */
export const spacing = stylex.defineVars({
  space0: '0px',
  space1: '2px',
  space2: '4px',
  space3: '6px',
  space4: '8px',
  space5: '12px',
  space6: '16px',
  space7: '20px',
  space8: '24px',
  space9: '32px',
  space10: '48px',
});

/**
 * Corner radius scale.
 */
export const radius = stylex.defineVars({
  none: '0px',
  compact: '4px',
  button: '8px',
  card: '8px',
  modal: '12px',
  sheet: '16px',
  pill: '9999px',
});

/**
 * Spatial layout dimensions.
 */
export const layout = stylex.defineVars({
  headerHeight: '56px',
  drawerHeaderHeight: '48px',
  drawerWidth: '460px',
  actionsPortalHeight: '48px',
  sidebarWidth: '280px',
  searchMaxWidth: '520px',
  searchHeight: '36px',
  tableRowHeight: '36px',
  tableRowHeightCompact: '32px',
  tableRowHeightComfort: '38px',
  mobileRowHeight: '64px',
  mobileTouchTarget: '56px',
  loadingSpinnerSize: '28px',
  ditherStripHeight: '6px',
  shareModalWidth: '540px',
  shareDriveListMaxHeight: '180px',
  shareDriveListMaxHeightCoarse: '196px',
  shareResultListMaxHeight: '180px',
});

/**
 * Typography stacks and scale.
 */
export const typography = stylex.defineVars({
  fontFamilyBrand: '"Pixelify Sans", monospace',
  fontFamilyBody: '"Montserrat", system-ui, -apple-system, sans-serif',
  fontFamilyMono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',

  fontSizeBrand: '20px',
  lineHeightBrand: '1.2',
  fontWeightBrand: '600',

  fontSizeTitle: '18px',
  lineHeightTitle: '1.3',
  fontWeightTitle: '600',

  fontSizeSection: '13px',
  lineHeightSection: '1.4',
  fontWeightSection: '600',

  fontSizeBody: '13px',
  lineHeightBody: '1.4',
  fontWeightBody: '400',

  fontSizeTableHeader: '11px',
  lineHeightTableHeader: '1.3',
  fontWeightTableHeader: '600',

  fontSizeMeta: '11px',
  lineHeightMeta: '1.3',
  fontWeightMeta: '400',

  fontSizeBadge: '10px',
  lineHeightBadge: '1.2',
  fontWeightBadge: '600',
});

/**
 * Animation timing.
 */
export const motion = stylex.defineVars({
  durationFast: '150ms',
  easingOut: 'ease-out',
  transitionFast:
    'background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out, opacity 150ms ease-out, transform 150ms ease-out, width 150ms ease-out, filter 150ms ease-out',
  transitionNormal:
    'background-color 200ms ease-out, border-color 200ms ease-out, color 200ms ease-out, opacity 200ms ease-out, transform 200ms ease-out, width 200ms ease-out, filter 200ms ease-out',
  transitionTap:
    'background-color 100ms ease, border-color 100ms ease, color 100ms ease, opacity 100ms ease, transform 100ms ease, filter 100ms ease',
});

