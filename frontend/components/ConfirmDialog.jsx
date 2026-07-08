'use client';

import React from 'react';
import Modal from './Modal.jsx';

// Styled replacement for window.confirm(...) used before destructive/state-
// changing actions (delete, deactivate, etc.).
export default function ConfirmDialog({ title = 'Confirm', message, confirmLabel = 'Confirm', danger = true, onConfirm, onCancel }) {
  return (
    <Modal title={title} onClose={onCancel} width={400}>
      <p style={{ marginTop: 0 }}>{message}</p>
      <div className="form-actions">
        <button type="button" className={danger ? 'danger' : ''} onClick={onConfirm}>{confirmLabel}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </Modal>
  );
}
