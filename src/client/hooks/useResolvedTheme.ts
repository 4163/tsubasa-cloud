import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  type EffectiveTheme,
  type ThemeChoice,
  readInitialTheme,
  readThemeChoice,
  saveThemeChoice,
  applyDocumentTheme,
} from '../utils/theme.js';
import { runWithViewTransition } from '../utils/workspaceHelpers.js';

export function useThemeChoice() {
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => readThemeChoice());
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() => readInitialTheme());
  const effectiveThemeRef = useRef<EffectiveTheme>(effectiveTheme);
  effectiveThemeRef.current = effectiveTheme;

  const handleThemeChange = useCallback((newTheme: ThemeChoice) => {
    saveThemeChoice(newTheme);
    window.tsubasaDesktop?.setThemeChoice(newTheme);
    runWithViewTransition(() => {
      flushSync(() => {
        setThemeChoice(newTheme);
      });
    });
  }, []);

  useLayoutEffect(() => {
    let active: EffectiveTheme = 'dark';
    if (themeChoice === 'auto') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      active = mql.matches ? 'dark' : 'light';
      effectiveThemeRef.current = active;
      setEffectiveTheme(active);
      applyDocumentTheme(active);
      const listener = (e: MediaQueryListEvent) => {
        const next: EffectiveTheme = e.matches ? 'dark' : 'light';
        effectiveThemeRef.current = next;
        setEffectiveTheme(next);
        applyDocumentTheme(next);
      };
      mql.addEventListener('change', listener);
      return () => mql.removeEventListener('change', listener);
    }
    active = themeChoice;
    effectiveThemeRef.current = active;
    setEffectiveTheme(themeChoice);
    applyDocumentTheme(active);
  }, [themeChoice]);

  useEffect(() => {
    if (!__DEMO_MODE__) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (window.parent === window || event.source !== window.parent) return;
      const data = event.data as { type?: unknown; theme?: unknown } | null;
      if (!data || data.type !== 'tsubasa:site-theme-sync') return;
      if (data.theme !== 'light' && data.theme !== 'dark') return;
      if (data.theme === effectiveThemeRef.current) return;
      effectiveThemeRef.current = data.theme;
      saveThemeChoice(data.theme);
      setThemeChoice(data.theme);
      setEffectiveTheme(data.theme);
      applyDocumentTheme(data.theme);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return { themeChoice, effectiveTheme, handleThemeChange };
}

export function useResolvedTheme(): EffectiveTheme {
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(readInitialTheme);

  useEffect(() => {
    const saved = readThemeChoice();
    if (saved === 'light' || saved === 'dark') {
      setEffectiveTheme(saved);
      applyDocumentTheme(saved);
      return;
    }

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = (isDark: boolean) => {
      const next: EffectiveTheme = isDark ? 'dark' : 'light';
      setEffectiveTheme(next);
      applyDocumentTheme(next);
    };

    sync(mql.matches);
    const onChange = (event: MediaQueryListEvent) => sync(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return effectiveTheme;
}
