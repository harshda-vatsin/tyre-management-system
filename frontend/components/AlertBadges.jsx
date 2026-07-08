'use client';

import React from 'react';

const STATUS_CLASS = { Open: 'badge-open', Acknowledged: 'badge-acknowledged', Resolved: 'badge-resolved' };
const SEVERITY_CLASS = { Warning: 'badge-warning', Critical: 'badge-critical' };

export function SeverityBadge({ severity }) {
  return <span className={`badge ${SEVERITY_CLASS[severity] || ''}`}>{severity}</span>;
}

export function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_CLASS[status] || ''}`}>{status}</span>;
}

export function EscalatedBadge({ isEscalated }) {
  if (!isEscalated) return null;
  return <span className="badge badge-escalated">Escalated</span>;
}
