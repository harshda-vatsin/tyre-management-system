'use client';

/**
 * @file page.jsx
 * @description Frontend Login page.
 * Provides a user credential submission form interface, manages state indicators,
 * and calls the authentication context login method.
 */

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Truck } from 'lucide-react';
import { useAuth } from '../../components/AuthContext.jsx';

/**
 * LoginPage functional component.
 * Displays username and password forms, showing error status if auth validation fails.
 * 
 * @returns {React.ReactNode} Login layout structure
 */
export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  /**
   * Submission handler for the login form.
   * Prevents default reload, clears previous error states, and routes to home on success.
   * 
   * @param {React.FormEvent} e - Form event
   */
  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      router.push('/');
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-brand">
          <div className="sidebar-brand-mark"><Truck size={17} color="#fff" /></div>
          <div className="sidebar-brand-text" style={{ color: 'var(--text)' }}>
            <strong style={{ color: 'var(--text)' }}>EBTMS</strong>
          </div>
        </div>
        <h2>Sign in</h2>
        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button type="submit" disabled={loading} style={{ width: '100%' }}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
