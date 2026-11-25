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
  setThemeChoice(choice: DesktopThemeChoice): void;
  onAuthCompleted(callback: (payload: DesktopAuthCompletedPayload) => void): () => void;
}

declare global {
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

