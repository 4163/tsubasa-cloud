import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import * as stylex from '@stylexjs/stylex';
import { colors, darkColors } from './tokens.stylex.js';
import { useTabLock } from './utils/useTabLock.js';
import './global.css';

const App = React.lazy(() => import('./App.js'));
const TabBlockedModal = React.lazy(() =>
  import('./components/TabBlockedModal.js').then((m) => ({ default: m.TabBlockedModal }))
);

type EffectiveTheme = 'light' | 'dark';

function readInitialTheme(): EffectiveTheme {
  if (typeof window === 'undefined') return 'dark';
  try {
    const saved = window.localStorage.getItem('tsubasa-theme-choice');
    if (saved === 'light' || saved === 'dark') {
      return saved;
    }
  } catch {
    // Ignore storage access errors in restricted browser contexts.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyDocumentTheme(theme: EffectiveTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.backgroundColor = theme === 'dark' ? '#0b1412' : '#eef2ec';
  document.documentElement.style.color = theme === 'dark' ? '#e5f2eb' : '#111d18';
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

function useResolvedTheme(): EffectiveTheme {
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(readInitialTheme);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem('tsubasa-theme-choice');
    } catch {
      saved = null;
    }

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

const gateStyles = stylex.create({
  checkingShell: {
    position: 'fixed',
    inset: 0,
    backgroundColor: colors.canvas,
  },
});

function CheckingShell() {
  const effectiveTheme = useResolvedTheme();
  return (
    <div
      {...stylex.props(gateStyles.checkingShell, effectiveTheme === 'dark' && darkColors)}
      data-theme={effectiveTheme}
    />
  );
}

function TabLockGate() {
  const { status, ownerKind } = useTabLock();

  if (status === 'checking') {
    return <CheckingShell />;
  }

  return (
    <React.Suspense fallback={<CheckingShell />}>
      {status === 'blocked' ? <TabBlockedModal ownerKind={ownerKind} /> : <App />}
    </React.Suspense>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <TabLockGate />
    </React.StrictMode>
  );
}

