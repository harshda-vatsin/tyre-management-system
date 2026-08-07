'use client';

import React, { useState } from 'react';
import { UploadCloud } from 'lucide-react';
import Modal from './Modal.jsx';
import { uploadFile } from '../lib/api.js';

// Upload + synchronous Preview (dry-run) for the MIS Excel importer. Unlike
// CsvImportModal, this doesn't show results inline -- Preview is a full
// per-sheet, per-row report best read on its own page, so a successful
// upload navigates straight to the new session's detail page instead of
// rendering a summary in the modal itself.
export default function MisImportUploadModal({ onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);

  async function handleUpload() {
    if (!file) {
      setError('Choose an Excel (.xlsx) file first');
      return;
    }
    setError('');
    setUploading(true);
    try {
      const data = await uploadFile('/mis-imports', file);
      onUploaded(data.importSessionId);
    } catch (err) {
      setError(err.message);
      setUploading(false);
    }
  }

  return (
    <Modal title="Import MIS Workbook" onClose={onClose} width={480}>
      <div className="field">
        <label>Excel Workbook (.xlsx)</label>
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => { setFile(e.target.files[0] || null); setError(''); }}
        />
      </div>
      <div className="field-hint" style={{ marginBottom: '0.85rem' }}>
        Every recognized sheet is parsed and validated immediately -- nothing is written to the
        database yet. You'll see a full row-by-row report before anything is committed.
      </div>

      {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}

      <div className="form-actions">
        <button type="button" onClick={handleUpload} disabled={uploading || !file}>
          <UploadCloud size={15} /> {uploading ? 'Uploading & previewing...' : 'Upload & Preview'}
        </button>
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
