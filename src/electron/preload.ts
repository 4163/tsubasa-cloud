import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type DesktopThemeChoice = 'auto' | 'light' | 'dark';

interface DesktopAuthCompletedPayload {
  account?: string;
  poolId?: number;
  conflicts?: number;
}

contextBridge.exposeInMainWorld('tsubasaDesktop', {
  isElectron: true as const,
  setTitle(title: string): void {
    if (typeof title === 'string') {
      ipcRenderer.send('tsubasa:set-title', title);
    }
  },
  setThemeChoice(choice: DesktopThemeChoice): void {
    if (choice === 'auto' || choice === 'light' || choice === 'dark') {
      ipcRenderer.send('tsubasa:set-theme-choice', choice);
    }
  },
  onAuthCompleted(callback: (payload: DesktopAuthCompletedPayload) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: DesktopAuthCompletedPayload) => {
      callback(payload ?? {});
    };
    ipcRenderer.on('tsubasa:auth-completed', listener);
    return () => {
      ipcRenderer.removeListener('tsubasa:auth-completed', listener);
    };
  },
});
