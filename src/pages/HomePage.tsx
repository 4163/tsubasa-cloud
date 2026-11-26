import * as stylex from '@stylexjs/stylex';
import { colors, motion, radius, spacing, typography } from '../tokens.stylex';
import { DummyWindow } from '../components/DummyWindow';
import { siteUrl } from '../url';

const styles = stylex.create({
  page: {
    boxSizing: 'border-box',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '48px',
    paddingTop: '40px',
    paddingBottom: '64px',
    paddingInline: spacing.space6,
    '@media (max-width: 768px)': {
      gap: '32px',
      paddingTop: '28px',
      paddingBottom: '48px',
    },
  },
  heroContent: {
    width: '100%',
    maxWidth: '838px',
    marginInline: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: spacing.space7,
  },
  bannerFrame: {
    width: '100%',
    maxWidth: '838px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.card,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  bannerImg: {
    display: 'block',
    width: '100%',
    height: 'auto',
  },
  heroTitle: {
    margin: 0,
    fontFamily: typography.fontFamilyBrand,
    fontSize: '40px',
    fontWeight: '600',
    lineHeight: '1.15',
    letterSpacing: '0.02em',
    color: colors.headingText,
    '@media (max-width: 768px)': {
      fontSize: '30px',
    },
  },
  heroCopy: {
    margin: 0,
    maxWidth: '620px',
    fontSize: '15px',
    lineHeight: '1.65',
    color: colors.primaryText,
  },
  ctaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.space5,
  },
  primaryLink: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '40px',
    paddingInline: spacing.space7,
    borderRadius: radius.button,
    backgroundColor: {
      default: colors.brandAccent,
      ':hover': colors.brandAccentHover,
    },
    color: colors.brandAccentText,
    fontSize: '14px',
    fontWeight: '600',
    textDecoration: 'none',
    transition: motion.transitionFast,
    outlineOffset: '2px',
    outline: {
      default: 'none',
      ':focus-visible': `2px solid ${colors.focusRing}`,
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
    },
  },
  previewSection: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing.space6,
  },
  previewTitle: {
    margin: 0,
    fontFamily: typography.fontFamilyBrand,
    fontSize: '26px',
    fontWeight: '600',
    lineHeight: '1.2',
    letterSpacing: '0.02em',
    color: colors.primaryText,
    textAlign: 'center',
    '@media (max-width: 768px)': {
      fontSize: '22px',
    },
  },
});

export function HomePage() {
  const bannerFrameProps = stylex.props(styles.bannerFrame);

  return (
    <div {...stylex.props(styles.page)}>
      <section {...stylex.props(styles.heroContent)}>
        <div
          {...bannerFrameProps}
          className={[bannerFrameProps.className, 'grain-masked'].filter(Boolean).join(' ')}
        >
          <picture>
            <source srcSet={siteUrl('/assets/banner-mono.webp')} type="image/webp" />
            <img
              src={siteUrl('/assets/banner-mono.png')}
              alt="Tsubasa~ Cloud illustration"
              width={1600}
              height={383}
              fetchPriority="high"
              {...stylex.props(styles.bannerImg)}
            />
          </picture>
        </div>

        <h1 {...stylex.props(styles.heroTitle)}>Tsubasa~ Cloud</h1>

        <p {...stylex.props(styles.heroCopy)}>
          Tsubasa~ Cloud combines personal Google Drive accounts into one virtual drive on your
          computer. Files stay whole on a single account without splitting, and each pool mirrors
          its folder tree in Google Drive so you can still browse everything on drive.google.com.
          Run the Windows desktop app or open it locally in your browser.
        </p>

        <div {...stylex.props(styles.ctaRow)}>
          <a
            href="https://github.com/4163/tsubasa-cloud/releases"
            target="_blank"
            rel="noreferrer"
            {...stylex.props(styles.primaryLink)}
          >
            Download
          </a>
        </div>
      </section>

      <section {...stylex.props(styles.previewSection)} aria-labelledby="workspace-preview-heading">
        <h2 id="workspace-preview-heading" {...stylex.props(styles.previewTitle)}>
          Workspace Preview
        </h2>
        <DummyWindow />
      </section>
    </div>
  );
}
