'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { THEME_STORAGE_KEY, DEFAULT_THEME, isValidTheme } from '../lib/theme.js';

const ThemeContext = createContext(null);

// The <head> beforeInteractive script in app/layout.jsx already set
// data-theme on <html> (from localStorage, or DEFAULT_THEME) before this
// component's first client render, so reading it back here -- rather than
// localStorage again -- keeps the two in one place.
function getInitialTheme() {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const attr = document.documentElement.getAttribute('data-theme');
  return isValidTheme(attr) ? attr : DEFAULT_THEME;
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(getInitialTheme);

  const setTheme = useCallback((next) => {
    if (!isValidTheme(next)) return;
    setThemeState(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (e) {
      // Storage unavailable (private browsing, etc.) -- theme still applies
      // for this session, it just won't persist across visits.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
