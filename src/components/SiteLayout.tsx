import React from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, darkColors } from '../tokens.stylex.js';
import { ThemeProvider, useSiteTheme, type SiteCanvasBackdrop } from '../theme.js';
import { SiteHeader } from './SiteHeader.js';
import { RevealingFooter } from './RevealingFooter.js';
import { DitherCanvas, type DitherCanvasVariant } from './DitherCanvas.js';

export interface SiteLayoutProps {
  activeRoute: 'home' | 'data-policy';
  fitViewport?: boolean;
  ditherVariant?: DitherCanvasVariant;
  children: React.ReactNode;
}

const styles = stylex.create({
  root: {
    minHeight: '100dvh',
    color: colors.primaryText,
    position: 'relative',
    isolation: 'isolate',
  },
  foreground: {
    position: 'relative',
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
    overflow: 'clip',
  },
  backdropHome: {
    backgroundColor: colors.canvasHome,
  },
  backdropPolicy: {
    backgroundColor: colors.canvasPolicy,
  },
  main: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  mainCentered: {
    justifyContent: 'safe center',
  },
});

function SiteLayoutInner({
  activeRoute,
  fitViewport = false,
  ditherVariant,
  children,
}: SiteLayoutProps) {
  const { isDark } = useSiteTheme();
  const isHomeCanvas = !ditherVariant && activeRoute === 'home';
  const backdropStyle = isHomeCanvas ? styles.backdropHome : styles.backdropPolicy;

  return (
    <div {...stylex.props(styles.root, backdropStyle, isDark && darkColors)}>
      <div className="grain-overlay" aria-hidden="true" />
      <div {...stylex.props(styles.foreground, backdropStyle)}>
        {isHomeCanvas ? (
          <>
            <DitherCanvas isDark={isDark} variant="home-top" />
            <DitherCanvas isDark={isDark} variant="home-bottom" />
          </>
        ) : (
          <DitherCanvas isDark={isDark} variant={ditherVariant ?? 'policy'} />
        )}
        <SiteHeader activeRoute={activeRoute} />
        <main {...stylex.props(styles.main, fitViewport && styles.mainCentered)}>
          {children}
        </main>
      </div>
      <RevealingFooter />
    </div>
  );
}

export function SiteLayout(props: SiteLayoutProps) {
  const isHomeCanvas = !props.ditherVariant && props.activeRoute === 'home';
  const backdrop: SiteCanvasBackdrop = isHomeCanvas ? 'home' : 'policy';

  return (
    <ThemeProvider backdrop={backdrop}>
      <SiteLayoutInner {...props} />
    </ThemeProvider>
  );
}
