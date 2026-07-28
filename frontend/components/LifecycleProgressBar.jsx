'use client';

import React from 'react';
import { ALL_STATUSES, normalizeStatus } from '../lib/tyreLifecycle.js';

// Simple 6-status indicator highlighting a tyre's current operational
// status. Not a literal linear progression -- In Store/Active are the two
// normal resting states, and Under Repair/Under Retread/Warranty are
// detours that can be entered from (and return to) either one, so this is
// a status-picker visual, not a strict step-by-step wizard.
export default function LifecycleProgressBar({ status }) {
  const current = normalizeStatus(status);

  return (
    <div className="lifecycle-progress-bar">
      {ALL_STATUSES.map((s) => (
        <div className={`lifecycle-progress-step ${s === current ? 'lifecycle-progress-current' : ''}`} key={s}>
          <span className="lifecycle-progress-dot" />
          <span className="lifecycle-progress-label">{s}</span>
        </div>
      ))}
    </div>
  );
}
