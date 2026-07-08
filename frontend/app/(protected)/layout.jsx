'use client';

import React from 'react';
import ProtectedRoute from '../../components/ProtectedRoute.jsx';

export default function ProtectedLayout({ children }) {
  return <ProtectedRoute>{children}</ProtectedRoute>;
}
