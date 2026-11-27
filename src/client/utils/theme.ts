export type EffectiveTheme = 'light' | 'dark';
export type ThemeChoice = 'auto' | 'light' | 'dark';

export const THEME_STORAGE_KEY = __DEMO_MODE__ ? 'tsubasa-demo-theme-choice' : 'tsubasa-theme-choice';

export function readThemeChoice(): ThemeChoice {
  if (typeof window === 'undefined') return 'auto';
  try {
    const desktopChoice = window.tsubasaDesktop?.getThemeChoice?.();
    if (desktopChoice === 'light' || desktopChoice === 'dark' || desktopChoice === 'auto') {
      return desktopChoice;
    }
  } catch {
    // Fall through to localStorage if the desktop bridge is unavailable.
  }
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'auto') {
      return saved;
    }
  } catch {
    // Ignore storage access errors in restricted browser contexts.
  }
  return 'auto';
}

export function saveThemeChoice(choice: ThemeChoice): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Ignore storage access errors in restricted browser contexts.
  }
}

export function readInitialTheme(): EffectiveTheme {
  if (typeof window === 'undefined') return 'dark';
  const saved = readThemeChoice();
  if (saved === 'light' || saved === 'dark') {
    return saved;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyDocumentTheme(theme: EffectiveTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.backgroundColor = theme === 'dark' ? '#0b1412' : '#eef2ec';
  document.documentElement.style.color = theme === 'dark' ? '#e5f2eb' : '#111d18';
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}
