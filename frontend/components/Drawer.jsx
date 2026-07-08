'use client';

import React from 'react';
import { X } from 'lucide-react';

// Right-side sliding panel used for Create/Edit forms in place of forms that
// used to sit permanently open above list tables. `footer` is typically the
// Save/Cancel button row so it stays pinned regardless of form length.
export default function Drawer({ title, onClose, children, footer }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h3>{title}</h3>
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </div>
    </div>
  );
}
