import React from 'react';
import ReactDOM from 'react-dom/client';
import * as stylex from '@stylexjs/stylex';
import { colors, darkColors } from './tokens.stylex.js';
import { useResolvedTheme } from './hooks/useResolvedTheme.js';
import { useTabLock } from './utils/useTabLock.js';
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
  return (
    <div
      {...stylex.props(gateStyles.checkingShell, effectiveTheme === 'dark' && darkColors)}
      data-theme={effectiveTheme}
    />
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

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <TabLockGate />
    </React.StrictMode>
  );
}

