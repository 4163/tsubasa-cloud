import * as stylex from '@stylexjs/stylex';
import { colors, radius, spacing, typography } from '../tokens.stylex';
import { BrandMark } from '../components/BrandMark';
import { useSiteTheme } from '../theme';

const styles = stylex.create({
  wrapper: {
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '960px',
    marginInline: 'auto',
    paddingBlock: spacing.space8,
    paddingInline: spacing.space6,
    display: 'grid',
    gridTemplateColumns: '264px minmax(0, 1fr)',
    alignItems: 'center',
    columnGap: '36px',
    rowGap: spacing.space8,
    '@media (max-width: 768px)': {
      gridTemplateColumns: '1fr',
      justifyItems: 'center',
      rowGap: spacing.space6,
      paddingBlock: spacing.space7,
    },
  },
  medallion: {
    width: '264px',
    '@media (max-width: 768px)': {
      width: '192px',
    },
  },
  medallionMark: {
    width: '100%',
  },
  medallionMarkDark: {
    filter: `drop-shadow(1px 0 0 ${colors.primaryText}) drop-shadow(-1px 0 0 ${colors.primaryText}) drop-shadow(0 1px 0 ${colors.primaryText}) drop-shadow(0 -1px 0 ${colors.primaryText}) drop-shadow(1px 1px 0 ${colors.primaryText}) drop-shadow(-1px 1px 0 ${colors.primaryText}) drop-shadow(1px -1px 0 ${colors.primaryText}) drop-shadow(-1px -1px 0 ${colors.primaryText})`,
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    width: '100%',
  },
  title: {
    margin: 0,
    fontFamily: typography.fontFamilyBrand,
    fontSize: '32px',
    fontWeight: '600',
    lineHeight: '1.15',
    letterSpacing: '0.02em',
    color: colors.headingText,
    '@media (max-width: 768px)': {
      fontSize: '26px',
      textAlign: 'center',
    },
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  mobileGradientText: {
    backgroundAttachment: {
      default: null,
      '@media (max-width: 768px)': 'fixed',
    },
    backgroundSize: {
      default: null,
      '@media (max-width: 768px)': '100% 100%',
    },
    backgroundClip: {
      default: null,
      '@media (max-width: 768px)': 'text',
    },
    WebkitBackgroundClip: {
      default: null,
      '@media (max-width: 768px)': 'text',
    },
    WebkitTextFillColor: {
      default: null,
      '@media (max-width: 768px)': 'transparent',
    },
  },
  heading: {
    margin: 0,
    fontSize: '14px',
    fontWeight: '600',
    lineHeight: '1.35',
    color: colors.headingText,
  },
  headingLight: {
    backgroundImage: {
      default: null,
      '@media (max-width: 768px)': `linear-gradient(to left, ${colors.headingText} ${spacing.space6}, ${colors.textBlack} calc(100% - ${spacing.space6}))`,
    },
  },
  body: {
    margin: 0,
    fontSize: '13px',
    lineHeight: '1.5',
    color: colors.primaryText,
  },
  bodyLight: {
    backgroundImage: {
      default: null,
      '@media (max-width: 768px)': `linear-gradient(to left, ${colors.primaryText} ${spacing.space6}, ${colors.textBlack} calc(100% - ${spacing.space6}))`,
    },
  },
  code: {
    fontFamily: typography.fontFamilyMono,
    fontSize: '12px',
    paddingBlock: '1px',
    paddingInline: '4px',
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    color: colors.primaryText,
  },
  link: {
    color: colors.brandAccent,
    fontWeight: '600',
    textDecoration: 'underline',
    textUnderlineOffset: '3px',
    outlineOffset: '2px',
    outline: {
      default: 'none',
      ':focus-visible': `2px solid ${colors.focusRing}`,
    },
  },
  linkLight: {
    backgroundImage: {
      default: null,
      '@media (max-width: 768px)': `linear-gradient(to left, ${colors.brandAccent} ${spacing.space6}, ${colors.brandAccentDeep} calc(100% - ${spacing.space6}))`,
    },
  },
});

function InlineCode({ isDark, children }: { isDark: boolean; children: string }) {
  return (
    <code {...stylex.props(styles.code)}>
      <span {...stylex.props(!isDark && styles.mobileGradientText, !isDark && styles.bodyLight)}>
        {children}
      </span>
    </code>
  );
}

export function DataPolicyPage() {
  const { isDark } = useSiteTheme();
  const medallionProps = stylex.props(styles.medallion);
  const headingProps = stylex.props(
    styles.heading,
    !isDark && styles.mobileGradientText,
    !isDark && styles.headingLight,
  );
  const bodyProps = stylex.props(
    styles.body,
    !isDark && styles.mobileGradientText,
    !isDark && styles.bodyLight,
  );
  const linkProps = stylex.props(
    styles.link,
    !isDark && styles.mobileGradientText,
    !isDark && styles.linkLight,
  );

  return (
    <article {...stylex.props(styles.wrapper)}>
      <div
        {...medallionProps}
        className={[medallionProps.className, 'grain-masked', 'grain-masked-brand-mark']
          .filter(Boolean)
          .join(' ')}
      >
        <BrandMark
          alt="Tsubasa~ Cloud mark"
          xstyle={[styles.medallionMark, isDark && styles.medallionMarkDark]}
        />
      </div>

      <div {...stylex.props(styles.content)}>
        <h1 {...stylex.props(styles.title)}>Data Policy</h1>

        <div {...stylex.props(styles.list)}>
          <section {...stylex.props(styles.item)}>
            <h2 {...headingProps}>Self-hosted with zero developer access</h2>
            <p {...bodyProps}>
              Tsubasa~ Cloud runs locally on your computer. The developer operates no backend
              servers, collects no telemetry or analytics, and never sees your Google account data,
              OAuth credentials, or files.
            </p>
          </section>

          <section {...stylex.props(styles.item)}>
            <h2 {...headingProps}>How Google Drive access works</h2>
            <p {...bodyProps}>
              You create and supply your own Google Cloud OAuth client. Tsubasa connects directly
              from your machine to Google Drive APIs to list, upload, download, organize, and share
              files inside your <InlineCode isDark={isDark}>_Tsubasa~ Pool</InlineCode> folders.
            </p>
          </section>

          <section {...stylex.props(styles.item)}>
            <h2 {...headingProps}>What stays on your device</h2>
            <p {...bodyProps}>
              OAuth tokens stay in your local <InlineCode isDark={isDark}>.oauths/</InlineCode>{' '}
              directory. Your file index stays in your local{' '}
              <InlineCode isDark={isDark}>data/tsubasa.db</InlineCode> file.
            </p>
          </section>

          <section {...stylex.props(styles.item)}>
            <h2 {...headingProps}>Google API Limited Use and revocation</h2>
            <p {...bodyProps}>
              Google Drive data is used strictly to operate the local file manager on your device.
              Disconnect at any time by revoking access in your Google Account permissions, removing
              the account in the app, or deleting your local credentials and data.
            </p>
          </section>

          <section {...stylex.props(styles.item)}>
            <h2 {...headingProps}>This website</h2>
            <p {...bodyProps}>
              Static site with no tracking cookies or analytics. The interactive demo stores only
              dummy text and metadata records locally in your browser via IndexedDB, never real file
              contents.
            </p>
          </section>

          <section {...stylex.props(styles.item)}>
            <h2 {...headingProps}>Contact</h2>
            <p {...bodyProps}>
              Email{' '}
              <a href="mailto:x4163x@gmail.com" {...linkProps}>
                x4163x@gmail.com
              </a>
              , Discord <InlineCode isDark={isDark}>x4163#8170</InlineCode>, or open a{' '}
              <a
                href="https://github.com/4163/tsubasa-cloud/issues"
                target="_blank"
                rel="noreferrer"
                {...linkProps}
              >
                GitHub issue
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </article>
  );
}
