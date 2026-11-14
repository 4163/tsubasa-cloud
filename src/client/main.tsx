import React from 'react';
import ReactDOM from 'react-dom/client';
import * as stylex from '@stylexjs/stylex';
import App from './App.js';
import { TabBlockedModal, useResolvedTheme } from './components/TabBlockedModal.js';
import { colors, darkColors } from './tokens.stylex.js';
import { useTabLock } from './utils/useTabLock.js';
import './global.css';

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

  if (status === 'blocked') {
    return <TabBlockedModal ownerKind={ownerKind} />;
  }

  return <App />;
}

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <TabLockGate />
    </React.StrictMode>
  );
}

