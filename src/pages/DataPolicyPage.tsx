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
  heading: {
    margin: 0,
    fontSize: '14px',
    fontWeight: '600',
    lineHeight: '1.35',
    color: colors.headingText,
  },
  body: {
    margin: 0,
    fontSize: '13px',
    lineHeight: '1.5',
    color: colors.primaryText,
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
});

export function DataPolicyPage() {
  const { isDark } = useSiteTheme();
  const medallionProps = stylex.props(styles.medallion);

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
            <h2 {...stylex.props(styles.heading)}>Self-hosted with zero developer access</h2>
            <p {...stylex.props(styles.body)}>
              Tsubasa~ Cloud runs locally on your computer. The developer operates no backend
              servers, collects no telemetry or analytics, and never sees your Google account, OAuth
              credentials, or files.
            </p>
          </section>

          <section {...stylex.props(styles.item)}>
            <h2 {...stylex.props(styles.heading)}>How Google Drive access works</h2>
            <p {...stylex.props(styles.body)}>
              You create and supply your own Google Cloud OAuth client. Tsubasa connects directly
              from your machine to Google Drive APIs to list, upload, download, organize, and share
              files inside your <code {...stylex.props(styles.code)}>_Tsubasa~ Pool</code> folders.
            </p>
          </section>

          <section {...stylex.props(styles.item)}>
            <h2 {...stylex.props(styles.heading)}>What stays on your device</h2>
            <p {...stylex.props(styles.body)}>
              OAuth tokens stay in your local <code {...stylex.props(styles.code)}>.oauths/</code>{' '}
              directory. Your file index stays in your local{' '}
              <code {...stylex.props(styles.code)}>data/tsubasa.db</code> file.
            </p>
          </section>

          <section {...stylex.props(styles.item)}>
            <h2 {...stylex.props(styles.heading)}>Google API Limited Use and revocation</h2>
            <p {...stylex.props(styles.body)}>
              Google Drive data is used strictly to operate the local file manager on your device.
              Revoke access at any time from your Google Account permissions page or by deleting{' '}
              <code {...stylex.props(styles.code)}>.oauths/</code> and{' '}
              <code {...stylex.props(styles.code)}>data/</code>.
            </p>
          </section>

          <section {...stylex.props(styles.item)}>
            <h2 {...stylex.props(styles.heading)}>This website</h2>
            <p {...stylex.props(styles.body)}>
              Static site with no tracking cookies or analytics. The interactive demo stores only
              dummy text and metadata records locally in your browser via IndexedDB, never real file
              contents, and saves your light or dark theme choice in{' '}
              <code {...stylex.props(styles.code)}>localStorage</code>.
            </p>
          </section>

          <section {...stylex.props(styles.item)}>
            <h2 {...stylex.props(styles.heading)}>Contact</h2>
            <p {...stylex.props(styles.body)}>
              Email{' '}
              <a href="mailto:x4163x@gmail.com" {...stylex.props(styles.link)}>
                x4163x@gmail.com
              </a>
              , Discord <code {...stylex.props(styles.code)}>x4163#8170</code>, or open a{' '}
              <a
                href="https://github.com/4163/tsubasa-cloud/issues"
                target="_blank"
                rel="noreferrer"
                {...stylex.props(styles.link)}
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
