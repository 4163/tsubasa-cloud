import React from 'react';
import ReactDOM from 'react-dom/client';
import * as stylex from '@stylexjs/stylex';
import { colors, darkColors } from './tokens.stylex.js';
import { useResolvedTheme } from './hooks/useResolvedTheme.js';
import { readThemeChoice } from './utils/theme.js';
import { DemoWorkspaceBackdrop } from './demo/backdrop.js';
import { useTabLock } from './utils/useTabLock.js';
import { applyWindowTitle, BASE_WINDOW_TITLE } from './utils/windowTitle.js';
import './global.css';

const App = React.lazy(() => import('./App.js'));
const TabBlockedModal = React.lazy(() =>
  import('./components/TabBlockedModal.js').then((m) => ({ default: m.TabBlockedModal }))
);

const gateStyles = stylex.create({
  checkingShell: {
    position: 'fixed',
    inset: 0,
    backgroundColor: colors.canvas,
  },
});

function CheckingShell() {
  const effectiveTheme = useResolvedTheme();
  const themeChoice = readThemeChoice();

  React.useEffect(() => {
    applyWindowTitle(BASE_WINDOW_TITLE);
  }, []);

  return (
    <div
      {...stylex.props(gateStyles.checkingShell, effectiveTheme === 'dark' && darkColors)}
      data-theme={effectiveTheme}
    >
      {__DEMO_MODE__ && (
        <DemoWorkspaceBackdrop
          effectiveTheme={effectiveTheme}
          themeChoice={themeChoice}
          isDemoMode={true}
        />
      )}
    </div>
  );
}

function TabLockGate() {
  const { status, ownerKind, authCompleted } = useTabLock();

  if (status === 'checking') {
    return <CheckingShell />;
  }

  return (
    <React.Suspense fallback={<CheckingShell />}>
      {status === 'blocked' ? (
        <TabBlockedModal ownerKind={ownerKind} authCompleted={authCompleted} />
      ) : (
        <App />
      )}
    </React.Suspense>
  );
}

function DemoReadyGate({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        window.parent.postMessage({ type: 'tsubasa:demo-ready' }, window.location.origin);
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, []);

  return <>{children}</>;
}

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      {__DEMO_MODE__ ? (
        <React.Suspense fallback={<CheckingShell />}>
          <DemoReadyGate>
            <App />
          </DemoReadyGate>
        </React.Suspense>
      ) : (
        <TabLockGate />
      )}
    </React.StrictMode>
  );
}

