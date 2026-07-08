'use client';

import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from './ThemeProvider.jsx';

// Sidebar-footer toggle. A real <button> with aria-pressed and a label that
// states the action, so it's operable by keyboard and announced correctly
// by a screen reader -- not just an icon with no accessible name.
export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      className="sidebar-theme-toggle"
      onClick={toggleTheme}
      aria-pressed={isDark}
      aria-label={label}
      title={label}
    >
      {isDark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
