import fs from 'node:fs';
import path from 'node:path';

export type DesktopThemeChoice = 'auto' | 'light' | 'dark';

export interface DesktopPrefs {
  themeChoice: DesktopThemeChoice;
}

export interface ResolveElectronHomeOptions {
  isPackaged: boolean;
  execPath: string;
  userDataPath: string;
  packageRoot: string;
}

const LIGHT_SHELL_BG = '#eef2ec' as const;
const DARK_SHELL_BG = '#0b1412' as const;

export function isValidThemeChoice(value: unknown): value is DesktopThemeChoice {
  return value === 'auto' || value === 'light' || value === 'dark';
}

export function resolveElectronHomeDir(options: ResolveElectronHomeOptions): string {
  const envHome = process.env.TSUBASA_HOME?.trim();
  if (envHome) {
    return path.resolve(envHome);
  }

  if (!options.isPackaged) {
    return path.resolve(options.packageRoot);
  }

  const execDir = path.dirname(options.execPath);
  const portableMarkers = ['.portable', 'data', '.oauths'];
  for (const marker of portableMarkers) {
    if (fs.existsSync(path.join(execDir, marker))) {
      return path.resolve(execDir);
    }
  }

  return path.resolve(options.userDataPath);
}

export function resolveDesktopPrefsPath(homeDir: string): string {
  return path.join(homeDir, 'data', 'desktop-prefs.json');
}

export function readDesktopPrefs(homeDir: string): DesktopPrefs {
  const prefsPath = resolveDesktopPrefsPath(homeDir);
  try {
    const raw = fs.readFileSync(prefsPath, 'utf8');
    const parsed = JSON.parse(raw) as { themeChoice?: unknown };
    if (isValidThemeChoice(parsed?.themeChoice)) {
      return { themeChoice: parsed.themeChoice };
    }
  } catch {
    // Missing or unreadable prefs fall back to system default.
  }
  return { themeChoice: 'auto' };
}

export function writeDesktopPrefs(homeDir: string, prefs: DesktopPrefs): void {
  const prefsPath = resolveDesktopPrefsPath(homeDir);
  const dataDir = path.dirname(prefsPath);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify({ themeChoice: prefs.themeChoice }, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn(
      'Failed to persist desktop-prefs.json:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

export function resolveShellBackgroundColor(
  choice: DesktopThemeChoice,
  shouldUseDarkColors: boolean
): '#eef2ec' | '#0b1412' {
  if (choice === 'light') return LIGHT_SHELL_BG;
  if (choice === 'dark') return DARK_SHELL_BG;
  return shouldUseDarkColors ? DARK_SHELL_BG : LIGHT_SHELL_BG;
}

export function mapThemeChoiceToNativeSource(choice: DesktopThemeChoice): 'system' | 'light' | 'dark' {
  if (choice === 'light') return 'light';
  if (choice === 'dark') return 'dark';
  return 'system';
}
