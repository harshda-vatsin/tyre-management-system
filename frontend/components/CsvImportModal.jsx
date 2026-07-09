'use client';

import React, { useState } from 'react';
import { UploadCloud, FileDown, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import Modal from './Modal.jsx';
import { uploadFile } from '../lib/api.js';

// Builds the downloadable CSV template from the same `columns` definition
// CsvImportModal already uses to document the required/optional column
// contract, so the template can never drift out of sync with it -- one
// column list, two renderings (hint text + template file).
function buildTemplateCsv(columns) {
  const header = columns.map((c) => c.key).join(',');
  const example = columns.map((c) => c.example ?? '').join(',');
  return `${header}\n${example}\n`;
}

function downloadCsv(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Generic CSV Bulk Import modal, reused for depots/buses/tyres. `entity`
// selects the backend importer (POST /api/imports/:entity) and doubles as
// the template filename (depots_template.csv, etc.); `columns` documents the
// CSV header contract in the UI and drives the downloadable template. The
// list behind the modal is refreshed as soon as any row succeeds
// (onImported), but the modal itself stays open afterward so the import
// summary/error report stays visible and another file can be imported
// without reopening the modal.
export default function CsvImportModal({ entity, title, columns, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);

  async function handleImport() {
    if (!file) {
      setError('Choose a CSV file first');
      return;
    }
    setError('');
    setImporting(true);
    try {
      const data = await uploadFile(`/imports/${entity}`, file);
      setResult(data);
      if (data.created.length > 0) onImported();
    } catch (err) {
      // The backend returns HTTP 400 (not 2xx) when every row in the file
      // failed, even though the response body is still a well-formed import
      // result (created: [], errors: [...], totalRows) -- api.js's generic
      // uploadFile() throws on any non-2xx, so that result has to be
      // recovered from the thrown error's attached `data` here rather than
      // falling through to the plain error banner.
      if (err.data && Array.isArray(err.data.errors) && Array.isArray(err.data.created)) {
        setResult(err.data);
      } else {
        setError(err.message);
      }
    } finally {
      setImporting(false);
    }
  }

  function handleDownloadTemplate() {
    downloadCsv(`${entity}_template.csv`, buildTemplateCsv(columns));
  }

  const required = columns.filter((c) => c.required).map((c) => c.key);
  const optional = columns.filter((c) => !c.required).map((c) => c.key);

  // Success (green): every row imported. Warning (yellow): a mix of
  // successes and failures. Error (red): every row failed.
  let summaryVariant = 'success';
  let SummaryIcon = CheckCircle2;
  if (result) {
    if (result.created.length === 0) {
      summaryVariant = 'error';
      SummaryIcon = XCircle;
    } else if (result.errors.length > 0) {
      summaryVariant = 'warning';
      SummaryIcon = AlertTriangle;
    }
  }

  return (
    <Modal title={title} onClose={onClose} width={560}>
      <button type="button" className="secondary" onClick={handleDownloadTemplate} style={{ marginBottom: '1rem' }}>
        <FileDown size={15} /> Download CSV Template
      </button>

      <div className="field">
        <label>CSV File</label>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => { setFile(e.target.files[0] || null); setResult(null); setError(''); }}
        />
      </div>
      <div className="field-hint" style={{ marginBottom: '0.85rem' }}>
        First row must be a header row. Required columns: <strong>{required.join(', ')}</strong>.
        {optional.length > 0 && <> Optional: {optional.join(', ')}.</>}
      </div>

      {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}

      {result && (
        <div className={`status-banner ${summaryVariant}`} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700 }}>
            <SummaryIcon size={16} />
            <span>Import Complete</span>
          </div>
          <div className="detail-grid" style={{ gridTemplateColumns: 'repeat(3, auto)', gap: '1.5rem', marginTop: '0.65rem' }}>
            <div>
              <div className="detail-label">Total Rows</div>
              <div className="detail-value">{result.totalRows}</div>
            </div>
            <div>
              <div className="detail-label">Created</div>
              <div className="detail-value">{result.created.length}</div>
            </div>
            <div>
              <div className="detail-label">Failed</div>
              <div className="detail-value">{result.errors.length}</div>
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto', marginTop: '0.85rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>CSV Row</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.map((e, i) => (
                    <tr key={i}>
                      <td>Row {e.row}</td>
                      <td className="wrap">{e.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="form-actions">
        <button type="button" onClick={handleImport} disabled={importing || !file}>
          <UploadCloud size={15} /> {importing ? 'Importing...' : 'Import'}
        </button>
        <button type="button" className="secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
