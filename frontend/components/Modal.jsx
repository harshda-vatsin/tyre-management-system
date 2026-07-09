'use client';

import React from 'react';
import { X } from 'lucide-react';

export default function Modal({ title, onClose, children, width = 440 }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal-panel" style={{ width: '100%', maxWidth: `${width}px` }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
