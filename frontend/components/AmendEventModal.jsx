'use client';

import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../lib/api.js';
import { AMENDABLE_FIELDS, FIELD_LABELS } from '../lib/amendableFields.js';

const REPAIR_TYPES = ['plug', 'patch', 'tube'];
const NUMERIC_FIELDS = ['nsd_value', 'pressure_value', 'to_bus_id'];

// Corrects a single tyre_events row via POST /events/:id/correct. The
// original event is never touched (FR-TC-02/NFR-07) -- this only ever
// submits the fields that actually changed as a sparse corrected_values
// patch, alongside a mandatory reason, which the backend layers on as a new
// tyre_event_amendments row.
export default function AmendEventModal({ event, eventTypeLabel, onClose, onSaved }) {
  const fields = AMENDABLE_FIELDS[event.event_type] || [];
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f, event[f] ?? ''])));
  const [reason, setReason] = useState('');
  const [busPositions, setBusPositions] = useState([]);
  const [buses, setBuses] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (fields.includes('to_position') && event.bus_id) {
      api.get(`/buses/${event.bus_id}`).then((b) => setBusPositions(b.position_labels || []));
    }
    if (fields.includes('to_bus_id')) {
      api.get('/buses?pageSize=100').then((r) => setBuses(r.data));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  function set(key, value) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!reason.trim()) {
      setError('An amendment reason is required');
      return;
    }

    const corrected_values = {};
    for (const f of fields) {
      const original = event[f] ?? '';
      const next = values[f] ?? '';
      if (String(next).trim() === String(original).trim()) continue;
      corrected_values[f] = NUMERIC_FIELDS.includes(f) ? Number(next) : next;
    }
    if (Object.keys(corrected_values).length === 0) {
      setError('Change at least one value before saving');
      return;
    }

    setSaving(true);
    try {
      await api.post(`/events/${event.id}/correct`, { reason, corrected_values });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function renderField(key) {
    switch (key) {
      case 'nsd_value':
        return (
          <div className="field" key={key}>
            <label>{FIELD_LABELS[key]}</label>
            <div className="input-suffix-wrap">
              <input type="number" step="0.1" value={values[key]} onChange={(e) => set(key, e.target.value)} required />
              <span className="input-suffix">mm</span>
            </div>
          </div>
        );
      case 'pressure_value':
        return (
          <div className="field" key={key}>
            <label>{FIELD_LABELS[key]}</label>
            <div className="input-suffix-wrap">
              <input type="number" step="0.1" value={values[key]} onChange={(e) => set(key, e.target.value)} required />
              <span className="input-suffix">psi</span>
            </div>
          </div>
        );
      case 'repair_type':
        return (
          <div className="field" key={key}>
            <label>{FIELD_LABELS[key]}</label>
            <select value={values[key]} onChange={(e) => set(key, e.target.value)} required>
              <option value="">Select</option>
              {REPAIR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        );
      case 'to_position':
        return (
          <div className="field" key={key}>
            <label>{FIELD_LABELS[key]}</label>
            <select value={values[key]} onChange={(e) => set(key, e.target.value)} required>
              <option value="">Select position</option>
              {busPositions.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        );
      case 'to_bus_id':
        return (
          <div className="field" key={key}>
            <label>{FIELD_LABELS[key]}</label>
            <select value={values[key]} onChange={(e) => set(key, e.target.value)} required>
              <option value="">Select bus</option>
              {buses.map((b) => <option key={b.id} value={b.id}>{b.registration_no}</option>)}
            </select>
          </div>
        );
      default:
        return (
          <div className="field" key={key}>
            <label>{FIELD_LABELS[key] || key}</label>
            <input value={values[key]} onChange={(e) => set(key, e.target.value)} />
          </div>
        );
    }
  }

  return (
    <Modal title={`Amend Event: ${eventTypeLabel}`} onClose={onClose} width={480}>
      <form onSubmit={handleSubmit}>
        <div className="form-section-title">Corrected Values</div>
        {fields.map(renderField)}

        <div className="form-section-title">Reason</div>
        <div className="field">
          <label>Amendment Reason</label>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Typing error during inspection"
            required
          />
        </div>

        {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}
        <div className="form-actions">
          <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
