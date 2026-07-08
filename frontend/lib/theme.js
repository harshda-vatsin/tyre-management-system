// Theme system contract: light is the only default, ever. This constant --
// and the pre-hydration script in app/layout.jsx -- are the two places that
// decide the initial theme, and neither of them reads prefers-color-scheme.
export const THEME_STORAGE_KEY = 'ebtms_theme';
export const DEFAULT_THEME = 'light';

export function isValidTheme(value) {
  return value === 'light' || value === 'dark';
}
