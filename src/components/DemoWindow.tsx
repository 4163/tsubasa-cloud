import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, radius } from '../tokens.stylex';
import { SITE_THEME_SYNC_MESSAGE_TYPE, type SiteTheme, subscribeSiteThemeToggle } from '../theme';
import { siteUrl } from '../url';

const DEMO_THEME_STORAGE_KEY = 'tsubasa-demo-theme-choice';

function resolveInitialDemoTheme(): SiteTheme {
  try {
    const stored = localStorage.getItem(DEMO_THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Ignore storage access errors in restricted contexts.
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

const styles = stylex.create({
  frame: {
    boxSizing: 'border-box',
    width: '1280px',
    maxWidth: '100%',
    height: '720px',
    marginInline: 'auto',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.card,
    overflow: 'hidden',
    display: 'flex',
    '@media (max-width: 768px)': {
      width: '100%',
      height: '540px',
    },
  },
  canvasLight: {
    backgroundColor: '#eef2ec',
  },
  canvasDark: {
    backgroundColor: '#0b1412',
  },
  iframe: {
    display: 'block',
    width: '100%',
    height: '100%',
    borderWidth: 0,
  },
});

export function DemoWindow() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [demoTheme, setDemoTheme] = useState<SiteTheme>(() => resolveInitialDemoTheme());
  const canvasStyle = demoTheme === 'dark' ? styles.canvasDark : styles.canvasLight;
  const frameProps = stylex.props(styles.frame, canvasStyle);

  useEffect(() => {
    return subscribeSiteThemeToggle((theme) => {
      setDemoTheme(theme);
      const targetWindow = iframeRef.current?.contentWindow;
      if (!targetWindow) return;
      targetWindow.postMessage(
        { type: SITE_THEME_SYNC_MESSAGE_TYPE, theme },
        window.location.origin,
      );
    });
  }, []);

  return (
    <div
      {...frameProps}
      className={[frameProps.className, 'grain-masked', 'grain-masked-none'].filter(Boolean).join(' ')}
      data-demo-window=""
      data-demo-theme={demoTheme}
    >
      <iframe
        ref={iframeRef}
        src={siteUrl('/demo/index.html')}
        title="Tsubasa~ Cloud interactive demo"
        {...stylex.props(styles.iframe, canvasStyle)}
      />
    </div>
  );
}
