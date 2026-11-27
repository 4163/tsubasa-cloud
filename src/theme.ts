import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

export const SITE_THEME_STORAGE_KEY = 'tsubasa-site-theme';
export const SITE_THEME_SYNC_MESSAGE_TYPE = 'tsubasa:site-theme-sync';

export type SiteTheme = 'light' | 'dark';
export type SiteCanvasBackdrop = 'home' | 'policy';

const CANVAS_BACKDROP_COLORS: Record<SiteCanvasBackdrop, Record<SiteTheme, string>> = {
  home: { light: '#cedcd3', dark: '#294138' },
  policy: { light: '#f2f6f2', dark: '#142520' },
};

type SiteThemeToggleListener = (theme: SiteTheme) => void;

const themeToggleListeners = new Set<SiteThemeToggleListener>();

export function subscribeSiteThemeToggle(listener: SiteThemeToggleListener): () => void {
  themeToggleListeners.add(listener);
  return () => {
    themeToggleListeners.delete(listener);
  };
}

function notifySiteThemeToggle(theme: SiteTheme): void {
  for (const listener of themeToggleListeners) {
    listener(theme);
  }
}

interface SiteThemeContextValue {
  theme: SiteTheme;
  isDark: boolean;
  toggleTheme: (event?: React.MouseEvent<HTMLButtonElement>) => void;
}

const ThemeContext = createContext<SiteThemeContextValue | null>(null);

function readStoredTheme(): SiteTheme | null {
  try {
    const stored = localStorage.getItem(SITE_THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // Ignore storage access errors in restricted contexts.
  }
  return null;
}

export function readInitialSiteTheme(): SiteTheme {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') {
      return attr;
    }
  }
  const stored = readStoredTheme();
  if (stored) {
    return stored;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function applySiteTheme(theme: SiteTheme, backdrop: SiteCanvasBackdrop = 'home'): void {
  if (typeof document === 'undefined') return;
  const isDark = theme === 'dark';
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  root.style.backgroundColor = CANVAS_BACKDROP_COLORS[backdrop][theme];
  root.style.color = isDark ? '#e5f2eb' : '#111d18';
  root.classList.toggle('dark', isDark);
}

function getTransitionOrigin(event?: React.MouseEvent<HTMLButtonElement>): { x: number; y: number } {
  if (event) {
    // Keyboard activation sets detail === 0; use the button's geometric center.
    if (event.detail !== 0 && (event.clientX !== 0 || event.clientY !== 0)) {
      return { x: event.clientX, y: event.clientY };
    }
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }
  return {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  };
}

export function ThemeProvider({
  backdrop = 'home',
  children,
}: {
  backdrop?: SiteCanvasBackdrop;
  children: React.ReactNode;
}) {
  const [theme, setTheme] = useState<SiteTheme>(() => readInitialSiteTheme());
  const activeTransitionsRef = useRef(0);

  useLayoutEffect(() => {
    applySiteTheme(theme, backdrop);
  }, [theme, backdrop]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = (event: MediaQueryListEvent) => {
      if (readStoredTheme() !== null) return;
      const next: SiteTheme = event.matches ? 'dark' : 'light';
      applySiteTheme(next, backdrop);
      setTheme(next);
    };
    mql.addEventListener('change', onSystemChange);
    return () => mql.removeEventListener('change', onSystemChange);
  }, [backdrop]);

  const toggleTheme = useCallback((event?: React.MouseEvent<HTMLButtonElement>) => {
    const next: SiteTheme = theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(SITE_THEME_STORAGE_KEY, next);
    } catch {
      // Best-effort persistence.
    }
    notifySiteThemeToggle(next);

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const doc = document as Document & {
      startViewTransition?: (updateCallback: () => void) => {
        ready: Promise<void>;
        finished: Promise<void>;
      };
    };

    if (prefersReducedMotion || typeof doc.startViewTransition !== 'function') {
      applySiteTheme(next, backdrop);
      setTheme(next);
      return;
    }

    const { x, y } = getTransitionOrigin(event);
    const maxRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    activeTransitionsRef.current += 1;
    document.documentElement.classList.add('theme-transitioning');

    let transition: { ready: Promise<void>; finished: Promise<void> };
    try {
      transition = doc.startViewTransition(() => {
        flushSync(() => {
          applySiteTheme(next, backdrop);
          setTheme(next);
        });
      });
    } catch {
      activeTransitionsRef.current = Math.max(0, activeTransitionsRef.current - 1);
      if (activeTransitionsRef.current === 0) {
        document.documentElement.classList.remove('theme-transitioning');
      }
      applySiteTheme(next, backdrop);
      setTheme(next);
      return;
    }

    transition.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${maxRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 420,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            pseudoElement: '::view-transition-new(root)',
          },
        );
      })
      .catch(() => {
        // Ignore aborted view transitions.
      });

    transition.finished
      .catch(() => {
        // Ignore aborted view transitions.
      })
      .finally(() => {
        activeTransitionsRef.current = Math.max(0, activeTransitionsRef.current - 1);
        if (activeTransitionsRef.current === 0) {
          document.documentElement.classList.remove('theme-transitioning');
        }
      });
  }, [theme, backdrop]);

  return React.createElement(
    ThemeContext.Provider,
    { value: { theme, isDark: theme === 'dark', toggleTheme } },
    children,
  );
}

export function useSiteTheme(): SiteThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useSiteTheme must be used inside SiteLayout');
  }
  return ctx;
}
