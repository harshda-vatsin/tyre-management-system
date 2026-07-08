'use client';

import React from 'react';
import { AuthProvider } from './AuthContext.jsx';
import { SettingsProvider } from './SettingsContext.jsx';

export default function Providers({ children }) {
  return (
    <AuthProvider>
      <SettingsProvider>{children}</SettingsProvider>
    </AuthProvider>
  );
}
