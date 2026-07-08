'use client';

/**
 * @file ProtectedRoute.jsx
 * @description React authentication route guard component.
 * Restricts rendering of application subpages to logged-in users, redirects anonymous
 * sessions to the `/login` route, and hydrates pages with standard navigation panels.
 */

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from './AuthContext.jsx';
import Layout from './Layout.jsx';

/**
 * Higher-Order Route Guard Component wrapping protected views.
 * 
 * @param {object} props
 * @param {React.ReactNode} props.children - Target child elements to protect
 * @returns {React.ReactNode|null} layout wrapper or null
 */
export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  const router = useRouter();

  // Redirect to login if auth initialization has completed and user is absent
  useEffect(() => {
    if (ready && !user) router.replace('/login');
  }, [ready, user, router]);

  // Wait for localStorage hydration before deciding: rendering null here (not
  // redirecting) avoids bouncing an already-logged-in user to /login on refresh.
  if (!ready || !user) return null;

  return <Layout>{children}</Layout>;
}
