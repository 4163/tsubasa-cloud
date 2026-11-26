import * as stylex from '@stylexjs/stylex';
import { colors, layout, motion, radius, spacing, typography } from '../tokens.stylex.js';

const REPO_URL = 'https://github.com/4163/tsubasa-cloud';

const styles = stylex.create({
  footer: {
    position: 'sticky',
    bottom: 0,
    zIndex: -1,
    width: '100%',
    backgroundColor: colors.surface,
  },
  inner: {
    width: '100%',
    maxWidth: '1120px',
    minHeight: layout.headerHeight,
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    boxSizing: 'border-box',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.space4,
    textAlign: 'center',
    fontFamily: typography.fontFamilyBody,
    fontSize: '13px',
    lineHeight: '1.5',
    color: colors.secondaryText,
  },
  signature: {
    margin: 0,
    color: colors.primaryText,
    fontWeight: '500',
  },
  separator: {
    color: colors.secondaryText,
    userSelect: 'none',
  },
  link: {
    color: {
      default: colors.brandAccent,
      ':hover': colors.brandAccentHover,
    },
    fontWeight: '600',
    textDecoration: 'underline',
    textUnderlineOffset: '4px',
    textDecorationThickness: {
      default: '1px',
      ':hover': '2px',
    },
    cursor: 'pointer',
    borderRadius: radius.compact,
    outline: 'none',
    transition: motion.transitionFast,
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '3px',
    },
  },
});

export function RevealingFooter() {
  return (
    <footer {...stylex.props(styles.footer)}>
      <div {...stylex.props(styles.inner)}>
        <a href={REPO_URL} target="_blank" rel="noreferrer" {...stylex.props(styles.link)}>
          Tsubasa~ Cloud
        </a>
        <span aria-hidden="true" {...stylex.props(styles.separator)}>
          ◦
        </span>
        <span {...stylex.props(styles.signature)}>x4163</span>
      </div>
    </footer>
  );
}
