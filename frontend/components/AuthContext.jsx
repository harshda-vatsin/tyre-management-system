'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, logoutSession, restoreSession, startSession, subscribeSession } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // Starts null on both server and client to avoid a hydration mismatch,
  // then restores the session after mount (client-only) by exchanging the
  // HttpOnly refresh cookie for a fresh access token. `ready` tells
  // ProtectedRoute to hold off redirecting until that attempt finishes, so a
  // page refresh doesn't bounce a signed-in user to /login.
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Keeps React state in step with api.js: refreshes update the user
    // (role/depot changes), and a dead refresh session signs the user out.
    const unsubscribe = subscribeSession((next) => {
      if (!cancelled) setUser(next);
    });
    restoreSession().then((restored) => {
      if (cancelled) return;
      setUser(restored);
      setReady(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const login = useCallback(async (username, password) => {
    const data = await api.post('/auth/login', { username, password });
    startSession(data);
    return data.user;
  }, []);

  const logout = useCallback(() => logoutSession(), []);

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
