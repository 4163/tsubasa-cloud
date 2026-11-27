/// <reference types="vite/client" />

import 'react';

export type DesktopThemeChoice = 'auto' | 'light' | 'dark';

export interface DesktopAuthCompletedPayload {
  account?: string;
  poolId?: number;
  conflicts?: number;
}

export interface TsubasaDesktopBridge {
  readonly isElectron: true;
  setTitle(title: string): void;
  getThemeChoice(): DesktopThemeChoice;
  setThemeChoice(choice: DesktopThemeChoice): void;
  isElevated?(): Promise<boolean>;
  onAuthCompleted(callback: (payload: DesktopAuthCompletedPayload) => void): () => void;
}

declare global {
  const __APP_VERSION__: string;
  const __DEMO_MODE__: boolean;
  interface Window {
    tsubasaDesktop?: TsubasaDesktopBridge;
  }
}

declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string | boolean;
    directory?: string | boolean;
  }
}

