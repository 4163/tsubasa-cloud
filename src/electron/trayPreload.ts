import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type TrayMenuAction = 'show' | 'toggle-autostart' | 'quit';

interface TrayMenuState {
  isDark: boolean;
  autostartEnabled: boolean;
  autostartAvailable: boolean;
}

contextBridge.exposeInMainWorld('tsubasaTrayMenu', {
  onState(callback: (state: TrayMenuState) => void): () => void {
    const listener = (_event: IpcRendererEvent, state: TrayMenuState) => {
      if (state && typeof state === 'object') {
        callback(state);
      }
    };
    ipcRenderer.on('tsubasa:tray-state', listener);
    return () => {
      ipcRenderer.removeListener('tsubasa:tray-state', listener);
    };
  },
  invokeAction(action: TrayMenuAction): void {
    if (action === 'show' || action === 'toggle-autostart' || action === 'quit') {
      ipcRenderer.send('tsubasa:tray-action', action);
    }
  },
  dismiss(): void {
    ipcRenderer.send('tsubasa:tray-dismiss');
  },
});
