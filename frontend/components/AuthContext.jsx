'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, getUser, setToken, setUser as persistUser } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // Starts null on both server and client to avoid a hydration mismatch,
  // then hydrates from localStorage after mount (client-only). `ready`
  // tells ProtectedRoute to hold off redirecting until that hydration runs.
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setUser(getUser());
    setReady(true);
  }, []);

  const login = useCallback(async (username, password) => {
    const data = await api.post('/auth/login', { username, password });
    setToken(data.token);
    persistUser(data.user);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    persistUser(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, ready, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
