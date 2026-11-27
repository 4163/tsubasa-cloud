import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, radius } from '../tokens.stylex';
import { SITE_THEME_SYNC_MESSAGE_TYPE, type SiteTheme, subscribeSiteThemeToggle } from '../theme';
import { siteUrl } from '../url';

const DEMO_THEME_STORAGE_KEY = 'tsubasa-demo-theme-choice';
const DEMO_READY_MESSAGE_TYPE = 'tsubasa:demo-ready';
const READY_FALLBACK_MS = 250;

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
    backgroundColor: '#f7faf5',
  },
  canvasDark: {
    backgroundColor: '#12211d',
  },
  iframe: {
    position: 'relative',
    zIndex: 1,
    display: 'block',
    width: '100%',
    height: '100%',
    borderWidth: 0,
  },
  iframeLight: {
    colorScheme: 'light',
  },
  iframeDark: {
    colorScheme: 'dark',
  },
  cover: {
    position: 'absolute',
    inset: 0,
    zIndex: 2,
    pointerEvents: 'none',
    borderRadius: 'inherit',
  },
});

export function DemoWindow() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const pendingThemeSyncRef = useRef<SiteTheme | null>(null);
  const isReadyRef = useRef(false);
  const hasDemoSignaledReadyRef = useRef(false);
  const [demoTheme, setDemoTheme] = useState<SiteTheme>(() => resolveInitialDemoTheme());
  const [isReady, setIsReady] = useState(false);
  const canvasStyle = demoTheme === 'dark' ? styles.canvasDark : styles.canvasLight;
  const iframeSchemeStyle = demoTheme === 'dark' ? styles.iframeDark : styles.iframeLight;
  const frameProps = stylex.props(styles.frame, canvasStyle);

  const revealIframe = () => {
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    if (isReadyRef.current) return;
    isReadyRef.current = true;
    setIsReady(true);
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const targetWindow = iframeRef.current?.contentWindow;
      if (!targetWindow || event.source !== targetWindow) return;
      const data = event.data as { type?: unknown } | null;
      if (!data || data.type !== DEMO_READY_MESSAGE_TYPE) return;

      hasDemoSignaledReadyRef.current = true;
      if (pendingThemeSyncRef.current) {
        targetWindow.postMessage(
          { type: SITE_THEME_SYNC_MESSAGE_TYPE, theme: pendingThemeSyncRef.current },
          window.location.origin,
        );
        pendingThemeSyncRef.current = null;
      }
      revealIframe();
    };

    window.addEventListener('message', onMessage);
    const unsubscribeTheme = subscribeSiteThemeToggle((theme) => {
      setDemoTheme(theme);
      const targetWindow = iframeRef.current?.contentWindow;
      if (!hasDemoSignaledReadyRef.current) {
        pendingThemeSyncRef.current = theme;
      }
      if (!targetWindow) return;
      targetWindow.postMessage(
        { type: SITE_THEME_SYNC_MESSAGE_TYPE, theme },
        window.location.origin,
      );
    });

    return () => {
      window.removeEventListener('message', onMessage);
      unsubscribeTheme();
      if (fallbackTimerRef.current !== null) {
        window.clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  }, []);

  const handleIframeLoad = () => {
    if (isReadyRef.current || fallbackTimerRef.current !== null) return;
    fallbackTimerRef.current = window.setTimeout(revealIframe, READY_FALLBACK_MS);
  };

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
        onLoad={handleIframeLoad}
        {...stylex.props(styles.iframe, canvasStyle, iframeSchemeStyle)}
      />
      {!isReady && (
        <div
          aria-hidden="true"
          data-demo-cover=""
          data-demo-theme={demoTheme}
          {...stylex.props(styles.cover, canvasStyle)}
        />
      )}
    </div>
  );
}
