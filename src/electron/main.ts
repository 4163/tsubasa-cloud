import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
  type NativeImage,
} from 'electron';
import {
  isValidThemeChoice,
  mapThemeChoiceToNativeSource,
  readDesktopPrefs,
  resolveElectronHomeDir,
  resolveShellBackgroundColor,
  writeDesktopPrefs,
  type DesktopThemeChoice,
} from './paths.js';
import { startServerHost, type ServerHostHandle } from './serverHost.js';
import { TrayMenuController } from './trayMenu.js';
import { createRimmedWindow, RIM_INSET_PX, type RimmedWindowHandle } from './windowRim.js';

const APP_NAME = 'Tsubasa~ Cloud';
const APP_USER_MODEL_ID = 'com.tsubasa.cloud';
const FALLBACK_REVEAL_MS = 2500;
const AUTOSTART_ARG = '--autostart';

const startedFromAutostart = process.argv.includes(AUTOSTART_ARG);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, '..', '..');
const PRELOAD_PATH = path.join(MODULE_DIR, 'preload.cjs');
const TRAY_PRELOAD_PATH = path.join(MODULE_DIR, 'trayPreload.cjs');
const APP_ICON_PATH = path.join(PACKAGE_ROOT, 'build', 'icon.ico');

app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let mainWindow: RimmedWindowHandle | null = null;
let tray: Tray | null = null;
let trayMenu: TrayMenuController | null = null;
let serverHost: ServerHostHandle | null = null;
let homeDir = '';
let currentThemeChoice: DesktopThemeChoice = 'auto';
let isQuitting = false;
let teardownComplete = false;
let teardownPromise: Promise<void> | null = null;

function restoreMainWindow(): void {
  if (!mainWindow || mainWindow.win.isDestroyed()) {
    return;
  }
  const { win, webContents } = mainWindow;
  if (win.isMinimized()) {
    win.restore();
  }
  if (!win.isVisible()) {
    win.show();
  }
  win.focus();
  if (!webContents.isDestroyed()) {
    webContents.focus();
  }
}

function tryParseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isHttpProtocol(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function isDownloadApiPath(pathname: string): boolean {
  return /^\/api\/files\/[^/]+\/download(?:\/|$)/.test(pathname);
}

function readIcoPngFrames(icoPath: string): Map<number, Buffer> {
  const frames = new Map<number, Buffer>();
  let buf: Buffer;
  try {
    buf = fs.readFileSync(icoPath);
  } catch {
    return frames;
  }

  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    return frames;
  }

  const count = buf.readUInt16LE(4);
  if (buf.length < 6 + count * 16) {
    return frames;
  }

  for (let i = 0; i < count; i++) {
    const entryOffset = 6 + i * 16;
    const widthByte = buf.readUInt8(entryOffset);
    const width = widthByte === 0 ? 256 : widthByte;
    const size = buf.readUInt32LE(entryOffset + 8);
    const offset = buf.readUInt32LE(entryOffset + 12);

    if (size < 8 || offset + size > buf.length) {
      continue;
    }
    if (
      buf[offset] === 0x89 &&
      buf[offset + 1] === 0x50 &&
      buf[offset + 2] === 0x4e &&
      buf[offset + 3] === 0x47
    ) {
      frames.set(width, buf.subarray(offset, offset + size));
    }
  }

  return frames;
}

function createTrayIcon(icoFrames: Map<number, Buffer>): NativeImage {
  const traySpecs: ReadonlyArray<{ scaleFactor: number; size: number }> = [
    { scaleFactor: 1, size: 16 },
    { scaleFactor: 1.25, size: 20 },
    { scaleFactor: 1.5, size: 24 },
    { scaleFactor: 2, size: 32 },
  ];

  if (traySpecs.every(({ size }) => icoFrames.has(size))) {
    const icon = nativeImage.createEmpty();
    for (const { scaleFactor, size } of traySpecs) {
      const buffer = icoFrames.get(size)!;
      icon.addRepresentation({ scaleFactor, width: size, height: size, buffer });
    }
    return icon;
  }

  return nativeImage.createFromPath(APP_ICON_PATH);
}

function isAutostartSupported(): boolean {
  return app.isPackaged && process.platform === 'win32';
}

function getAutostartEnabled(): boolean {
  if (!isAutostartSupported()) {
    return false;
  }
  const settings = app.getLoginItemSettings({
    path: process.execPath,
    args: [AUTOSTART_ARG],
  });
  return Boolean(settings.openAtLogin);
}

function setAutostartEnabled(enabled: boolean): void {
  if (!isAutostartSupported()) {
    return;
  }
  if (enabled) {
    app.setLoginItemSettings({
      openAtLogin: true,
      enabled: true,
      name: APP_USER_MODEL_ID,
      path: process.execPath,
      args: [AUTOSTART_ARG],
    });
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: false,
    name: APP_USER_MODEL_ID,
    path: process.execPath,
    args: [AUTOSTART_ARG],
  });
}

function resolveIsDarkTheme(): boolean {
  if (currentThemeChoice === 'dark') return true;
  if (currentThemeChoice === 'light') return false;
  return nativeTheme.shouldUseDarkColors;
}

function createTray(icoFrames: Map<number, Buffer>): void {
  const icon = createTrayIcon(icoFrames);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);

  trayMenu = new TrayMenuController({
    appName: APP_NAME,
    preloadPath: TRAY_PRELOAD_PATH,
    getState: () => ({
      isDark: resolveIsDarkTheme(),
      autostartEnabled: getAutostartEnabled(),
      autostartAvailable: isAutostartSupported(),
    }),
    onShow: () => restoreMainWindow(),
    onToggleAutostart: () => {
      if (!isAutostartSupported()) return;
      setAutostartEnabled(!getAutostartEnabled());
    },
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });

  tray.on('click', () => {
    trayMenu?.hide();
    restoreMainWindow();
  });

  tray.on('right-click', () => {
    if (tray) {
      void trayMenu?.toggle(tray);
    }
  });
}

function registerIpcHandlers(): void {
  ipcMain.on('tsubasa:set-title', (_event, rawTitle: unknown) => {
    if (typeof rawTitle !== 'string') return;
    const trimmed = rawTitle.trim();
    if (!trimmed || !mainWindow || mainWindow.win.isDestroyed()) return;
    mainWindow.win.setTitle(trimmed);
  });

  ipcMain.on('tsubasa:get-theme-choice', (event) => {
    event.returnValue = currentThemeChoice;
  });

  ipcMain.on('tsubasa:set-theme-choice', (_event, rawChoice: unknown) => {
    if (!isValidThemeChoice(rawChoice)) return;
    currentThemeChoice = rawChoice;
    nativeTheme.themeSource = mapThemeChoiceToNativeSource(rawChoice);
    writeDesktopPrefs(homeDir, { themeChoice: rawChoice });
    mainWindow?.refresh();
    trayMenu?.syncState();
  });

  nativeTheme.on('updated', () => {
    if (currentThemeChoice !== 'auto') return;
    mainWindow?.refresh();
    trayMenu?.syncState();
  });
}

function createMainWindow(host: ServerHostHandle): RimmedWindowHandle {
  const useEmbeddedExeIcon = process.platform === 'win32' && app.isPackaged;

  const rim = createRimmedWindow({
    windowOptions: {
      width: 1280 + RIM_INSET_PX * 2,
      height: 800 + RIM_INSET_PX * 2,
      minWidth: 640 + RIM_INSET_PX * 2,
      minHeight: 480 + RIM_INSET_PX * 2,
      show: false,
      title: APP_NAME,
      ...(useEmbeddedExeIcon ? {} : { icon: APP_ICON_PATH }),
      autoHideMenuBar: true,
    },
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
    isDark: resolveIsDarkTheme,
    resolveContentBg: () =>
      resolveShellBackgroundColor(currentThemeChoice, nativeTheme.shouldUseDarkColors),
  });

  const { win, webContents } = rim;

  win.removeMenu();

  let revealed = false;
  let fallbackRevealTimer: ReturnType<typeof setTimeout> | null = null;
  if (!startedFromAutostart) {
    const showOnce = () => {
      if (revealed || win.isDestroyed()) return;
      revealed = true;
      if (fallbackRevealTimer) {
        clearTimeout(fallbackRevealTimer);
        fallbackRevealTimer = null;
      }
      win.show();
      if (!webContents.isDestroyed()) {
        webContents.focus();
      }
    };
    fallbackRevealTimer = setTimeout(showOnce, FALLBACK_REVEAL_MS);
    webContents.once('did-finish-load', showOnce);
  }

  const allowedOrigins = new Set<string>();
  const rendererOrigin = tryParseUrl(host.rendererUrl)?.origin;
  const serverOrigin = tryParseUrl(host.serverUrl)?.origin;
  if (rendererOrigin) allowedOrigins.add(rendererOrigin);
  if (serverOrigin) allowedOrigins.add(serverOrigin);

  webContents.setWindowOpenHandler(({ url }) => {
    const parsed = tryParseUrl(url);
    if (parsed && isHttpProtocol(parsed)) {
      const isInternal = allowedOrigins.has(parsed.origin);
      if (isInternal && isDownloadApiPath(parsed.pathname)) {
        return { action: 'deny' };
      }
      if (!isInternal) {
        void shell.openExternal(url);
      }
    }
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    const parsed = tryParseUrl(url);
    if (parsed && isHttpProtocol(parsed) && !allowedOrigins.has(parsed.origin)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    if (fallbackRevealTimer) {
      clearTimeout(fallbackRevealTimer);
      fallbackRevealTimer = null;
    }
    if (mainWindow === rim) {
      mainWindow = null;
    }
  });

  void webContents.loadURL(host.rendererUrl);
  return rim;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    restoreMainWindow();
  });

  app.on('window-all-closed', () => {
    if (isQuitting) {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    isQuitting = true;
    if (teardownComplete) {
      return;
    }
    event.preventDefault();
    if (!teardownPromise) {
      teardownPromise = (async () => {
        try {
          if (trayMenu) {
            trayMenu.destroy();
            trayMenu = null;
          }
          if (tray && !tray.isDestroyed()) {
            tray.destroy();
          }
          tray = null;
          if (serverHost) {
            await serverHost.close();
            serverHost = null;
          }
        } catch (err) {
          console.error('Error during Electron shutdown:', err);
        } finally {
          teardownComplete = true;
          app.quit();
        }
      })();
    }
  });

  void app
    .whenReady()
    .then(async () => {
      homeDir = resolveElectronHomeDir({
        isPackaged: app.isPackaged,
        execPath: process.execPath,
        userDataPath: app.getPath('userData'),
        packageRoot: PACKAGE_ROOT,
      });
      process.env.TSUBASA_HOME = homeDir;

      const prefs = readDesktopPrefs(homeDir);
      currentThemeChoice = prefs.themeChoice;
      nativeTheme.themeSource = mapThemeChoiceToNativeSource(currentThemeChoice);

      registerIpcHandlers();

      serverHost = await startServerHost({
        isPackaged: app.isPackaged,
        homeDir,
        packageRoot: PACKAGE_ROOT,
        onAuthCompleted: (payload) => {
          if (mainWindow && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('tsubasa:auth-completed', payload);
          }
        },
      });

      const icoFrames = readIcoPngFrames(APP_ICON_PATH);
      createTray(icoFrames);
      mainWindow = createMainWindow(serverHost);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Fatal Electron startup error:', err);
      dialog.showErrorBox(APP_NAME, `Failed to start Tsubasa~ Cloud:\n\n${message}`);
      isQuitting = true;
      teardownComplete = true;
      app.quit();
    });
}
