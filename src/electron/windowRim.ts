import { execFile } from 'node:child_process';
import os from 'node:os';
import {
  BaseWindow,
  systemPreferences,
  View,
  WebContentsView,
  type BaseWindowConstructorOptions,
  type WebContents,
  type WebPreferences,
} from 'electron';

// Experimental native inset window rim, measured from Chrome's content frame:
// 3px outer frame gap (BaseWindow background) + 1px border (View) around an
// inset WebContentsView with rounded corners. Because the web page lives inside
// the inset WebContentsView, top-layer dialogs and drawers can never paint over
// the frame or border, and view transitions never touch the frame.
const RIM_GAP_PX = 3;
const RIM_BORDER_PX = 1;
const RIM_RADIUS_PX = 8;
export const RIM_INSET_PX = RIM_GAP_PX + RIM_BORDER_PX;

const BORDER_LIGHT = '#c2d1c7';
const BORDER_DARK = '#294138';

let accentOnTitleBars = false;

// Windows 10 paints the focused dark title bar pure black; Windows 11 (build 22000+) uses #202020.
const IS_WINDOWS_11 =
  process.platform === 'win32' && Number(os.release().split('.')[2] ?? 0) >= 22000;

function readAccentOnTitleBars(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\DWM', '/v', 'ColorPrevalence'],
      { windowsHide: true },
      (err, stdout) => resolve(!err && /ColorPrevalence\s+REG_DWORD\s+0x1\b/.test(stdout))
    );
  });
}

function resolveTitleBarColor(isDark: boolean, isFocused: boolean): string {
  if (accentOnTitleBars && isFocused) {
    return `#${systemPreferences.getAccentColor().slice(0, 6)}`;
  }
  if (isDark) {
    if (!isFocused) return '#2b2b2b';
    return IS_WINDOWS_11 ? '#202020' : '#000000';
  }
  return '#ffffff';
}

export interface RimmedWindowHandle {
  win: BaseWindow;
  webContents: WebContents;
  refresh(): void;
}

export function createRimmedWindow(options: {
  windowOptions: BaseWindowConstructorOptions;
  webPreferences: WebPreferences;
  isDark: () => boolean;
  resolveContentBg: () => string;
}): RimmedWindowHandle {
  const { windowOptions, webPreferences, isDark, resolveContentBg } = options;
  const initialDark = isDark();

  const win = new BaseWindow({
    ...windowOptions,
    backgroundColor: resolveTitleBarColor(initialDark, true),
  });

  const borderView = new View();
  borderView.setBorderRadius(RIM_RADIUS_PX);
  borderView.setBackgroundColor(initialDark ? BORDER_DARK : BORDER_LIGHT);

  const contentView = new WebContentsView({ webPreferences });
  contentView.setBorderRadius(RIM_RADIUS_PX - RIM_BORDER_PX);
  contentView.setBackgroundColor(resolveContentBg());

  win.contentView.addChildView(borderView);
  win.contentView.addChildView(contentView);

  let lastW = -1;
  let lastH = -1;

  const layout = () => {
    if (win.isDestroyed()) return;
    const [cw, ch] = win.getContentSize();
    if (cw === lastW && ch === lastH) return;
    lastW = cw;
    lastH = ch;
    borderView.setBounds({
      x: RIM_GAP_PX,
      y: RIM_GAP_PX,
      width: Math.max(0, cw - RIM_GAP_PX * 2),
      height: Math.max(0, ch - RIM_GAP_PX * 2),
    });
    contentView.setBounds({
      x: RIM_INSET_PX,
      y: RIM_INSET_PX,
      width: Math.max(0, cw - RIM_INSET_PX * 2),
      height: Math.max(0, ch - RIM_INSET_PX * 2),
    });
  };

  const refresh = () => {
    if (win.isDestroyed()) return;
    const dark = isDark();
    win.setBackgroundColor(resolveTitleBarColor(dark, win.isFocused()));
    borderView.setBackgroundColor(dark ? BORDER_DARK : BORDER_LIGHT);
    contentView.setBackgroundColor(resolveContentBg());
  };

  const refreshAccent = () => {
    void readAccentOnTitleBars().then((enabled) => {
      accentOnTitleBars = enabled;
      refresh();
    });
  };

  layout();
  win.contentView.on('bounds-changed', layout);
  win.on('focus', refresh);
  win.on('blur', refresh);
  systemPreferences.on('accent-color-changed', refreshAccent);
  systemPreferences.on('color-changed', refreshAccent);

  win.once('closed', () => {
    systemPreferences.removeListener('accent-color-changed', refreshAccent);
    systemPreferences.removeListener('color-changed', refreshAccent);
    if (!contentView.webContents.isDestroyed()) {
      contentView.webContents.close();
    }
  });

  refreshAccent();
  return { win, webContents: contentView.webContents, refresh };
}
