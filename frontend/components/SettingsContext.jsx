'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';

const SettingsContext = createContext(null);

// SRS §8.3: system-wide display parameters (pressure unit today). Fetched
// once per session after login -- every component that displays or accepts
// a pressure value reads pressureUnit from here rather than re-fetching.
export function SettingsProvider({ children }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState({ pressure_unit: 'PSI' });

  const refresh = useCallback(() => {
    api.get('/settings').then(setSettings).catch(() => {});
  }, []);

  useEffect(() => {
    if (user) refresh();
  }, [user, refresh]);

  return (
    <SettingsContext.Provider value={{ pressureUnit: settings.pressure_unit || 'PSI', refresh }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
