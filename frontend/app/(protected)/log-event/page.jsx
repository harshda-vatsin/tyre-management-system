'use client';

import React, { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import { ROLES } from '../../../lib/roles.js';
import TyreSelect from '../../../components/TyreSelect.jsx';
import PageHeader from '../../../components/PageHeader.jsx';

const EVENT_TYPES = [
  { value: 'nsd_reading', label: 'NSD Reading' },
  { value: 'pressure_reading', label: 'Pressure Reading' },
  { value: 'rotation', label: 'Tyre Rotation' },
  { value: 'replacement', label: 'Tyre Replacement' },
  { value: 'puncture_repair', label: 'Puncture Repair' },
  { value: 'inter_bus_transfer', label: 'Inter-Bus Transfer' },
  { value: 'send_to_store', label: 'Sending to Store', elevated: true },
  { value: 'condemnation', label: 'Condemnation', elevated: true },
];

const STATUS_BADGE = { 'In Service': 'badge-success', 'In Store': 'badge-info', Condemned: 'badge-critical', 'Under Repair': 'badge-warning' };

export default function LogEventPage() {
  const { user } = useAuth();
  const canWrite = [ROLES.ADMIN, ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR].includes(user?.role);
  const canElevated = [ROLES.ADMIN, ROLES.DEPOT_MANAGER].includes(user?.role);

  const availableTypes = EVENT_TYPES.filter((t) => !t.elevated || canElevated);

  const [eventType, setEventType] = useState('nsd_reading');
  const [tyre, setTyre] = useState(null);
  const [fields, setFields] = useState({});
  const [busPositions, setBusPositions] = useState([]);
  const [destBuses, setDestBuses] = useState([]);
  const [destPositions, setDestPositions] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setTyre(null);
    if (eventType === 'nsd_reading') {
      const localDate = new Date();
      const year = localDate.getFullYear();
      const month = String(localDate.getMonth() + 1).padStart(2, '0');
      const day = String(localDate.getDate()).padStart(2, '0');
      const todayStr = `${year}-${month}-${day}`;
      setFields({ event_date: todayStr });
    } else {
      setFields({});
    }
    setMessage('');
    setError('');
  }, [eventType]);

  useEffect(() => {
    if (tyre?.current_bus_id && ['rotation'].includes(eventType)) {
      api.get(`/buses/${tyre.current_bus_id}`).then((b) => setBusPositions(b.position_labels));
    } else {
      setBusPositions([]);
    }
    if (tyre?.current_bus_id && eventType === 'inter_bus_transfer') {
      api.get('/buses?pageSize=100').then((r) => setDestBuses(r.data.filter((b) => b.id !== tyre.current_bus_id)));
    }
  }, [tyre, eventType]);

  useEffect(() => {
    if (fields.to_bus_id) {
      api.get(`/buses/${fields.to_bus_id}`).then((b) => setDestPositions(b.position_labels));
    } else {
      setDestPositions([]);
    }
  }, [fields.to_bus_id]);

  if (!canWrite) {
    return <div className="card error-text">Access denied. Event logging is restricted to Tyre Supervisors, Depot Managers, and Administrators.</div>;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setMessage('');
    if (!tyre) {
      setError('Select a tyre first');
      return;
    }
    if (eventType === 'nsd_reading') {
      const val = Number(fields.nsd_value);
      if (fields.nsd_value === undefined || fields.nsd_value === null || fields.nsd_value === '' || isNaN(val) || val < 0 || val > 25) {
        setError('NSD (mm) must be between 0 and 25');
        return;
      }
    }
    if (eventType === 'pressure_reading') {
      const val = Number(fields.pressure_value);
      if (fields.pressure_value === undefined || fields.pressure_value === null || fields.pressure_value === '' || isNaN(val) || val < 0 || val > 200) {
        setError('Pressure (psi) must be between 0 and 200');
        return;
      }
    }
    try {
      const payload = { event_type: eventType, tyre_id: tyre.id, ...fields };
      const result = await api.post('/events', payload);
      const count = Array.isArray(result) ? result.length : 1;
      setMessage(`Event logged successfully (${count} tyre card ${count === 1 ? 'entry' : 'entries'} created).`);
      setTyre(null);
      setFields({});
    } catch (err) {
      setError(err.message);
    }
  }

  function set(key, value) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  function renderTypeFields() {
    switch (eventType) {
      case 'nsd_reading':
        return (
          <>
            <div className="field">
              <label>NSD Value</label>
              <div className="input-suffix-wrap">
                <input type="number" step="0.1" value={fields.nsd_value || ''} onChange={(e) => set('nsd_value', e.target.value)} required />
                <span className="input-suffix">mm</span>
              </div>
            </div>
            <div className="field">
              <label>Event Date</label>
              <input type="date" value={fields.event_date || ''} onChange={(e) => set('event_date', e.target.value)} required />
            </div>
          </>
        );
      case 'pressure_reading':
        return (
          <div className="field">
            <label>Pressure Value</label>
            <div className="input-suffix-wrap">
              <input type="number" step="0.1" value={fields.pressure_value || ''} onChange={(e) => set('pressure_value', e.target.value)} required />
              <span className="input-suffix">psi</span>
            </div>
          </div>
        );
      case 'rotation':
        return (
          <>
            <div className="field">
              <label>To Position</label>
              <select value={fields.to_position || ''} onChange={(e) => set('to_position', e.target.value)} required disabled={!tyre}>
                <option value="">{tyre ? 'Select position' : 'Select a mounted tyre first'}</option>
                {busPositions.filter((p) => p !== tyre?.current_position).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. wear equalisation" />
            </div>
          </>
        );
      case 'replacement':
        return (
          <>
            <TyreSelect
              label="New Tyre (from stock)"
              status="In Store"
              value={fields.new_tyre_id}
              onChange={(t) => set('new_tyre_id', t?.id)}
            />
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. worn tread" required />
            </div>
          </>
        );
      case 'puncture_repair':
        return (
          <>
            <div className="field">
              <label>Repair Type</label>
              <select value={fields.repair_type || ''} onChange={(e) => set('repair_type', e.target.value)} required>
                <option value="">Select</option>
                <option value="plug">Plug</option>
                <option value="patch">Patch</option>
                <option value="tube">Tube</option>
              </select>
            </div>
            <div className="field">
              <label>Notes</label>
              <input value={fields.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="e.g. nail in tread" />
            </div>
          </>
        );
      case 'inter_bus_transfer':
        return (
          <>
            <div className="field">
              <label>Destination Bus</label>
              <select value={fields.to_bus_id || ''} onChange={(e) => set('to_bus_id', e.target.value)} required disabled={!tyre}>
                <option value="">{tyre ? 'Select bus' : 'Select a mounted tyre first'}</option>
                {destBuses.map((b) => <option key={b.id} value={b.id}>{b.registration_no} ({b.depot_name})</option>)}
              </select>
            </div>
            <div className="field">
              <label>Destination Position</label>
              <select value={fields.to_position || ''} onChange={(e) => set('to_position', e.target.value)} required disabled={!fields.to_bus_id}>
                <option value="">Select position</option>
                {destPositions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. fleet rebalancing" />
            </div>
          </>
        );
      case 'send_to_store':
        return (
          <>
            <div className="field">
              <label>Current NSD</label>
              <div className="input-suffix-wrap">
                <input type="number" step="0.1" min="0" max="25" value={fields.nsd_value || ''} onChange={(e) => set('nsd_value', e.target.value)} required />
                <span className="input-suffix">mm</span>
              </div>
            </div>
            <div className="field">
              <label>Stored At</label>
              <input value={fields.stored_at || ''} onChange={(e) => set('stored_at', e.target.value)} placeholder="e.g. Depot Store Bay 2" required />
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. end of rotation cycle" required />
            </div>
          </>
        );
      case 'condemnation':
        return (
          <>
            <div className="field">
              <label>NSD at Condemnation</label>
              <div className="input-suffix-wrap">
                <input type="number" step="0.1" min="0" max="25" value={fields.nsd_value || ''} onChange={(e) => set('nsd_value', e.target.value)} required />
                <span className="input-suffix">mm</span>
              </div>
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. below minimum NSD" required />
            </div>
          </>
        );
      default:
        return null;
    }
  }

  const needsMountedTyre = ['nsd_reading', 'pressure_reading', 'rotation', 'replacement', 'inter_bus_transfer'].includes(eventType);

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <PageHeader title="Log Event" description="Record a tyre card event — reading, movement, repair, or lifecycle change." />

      <div className="card">
        <div className="form-section-title">Event Type</div>
        <div className="field">
          <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
            {availableTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-section-title">Tyre</div>
          <TyreSelect
            label={eventType === 'replacement' ? 'Tyre Being Replaced' : 'Tyre Number'}
            mountedOnly={needsMountedTyre}
            value={tyre?.id}
            onChange={setTyre}
          />

          {tyre && (
            <div className="card" style={{ background: 'var(--surface-muted)', boxShadow: 'none', border: '1px solid var(--border)', padding: '0.85rem 1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div>
                  <strong>{tyre.tyre_number}</strong>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}> · {tyre.brand}</span>
                </div>
                <span className={`badge ${STATUS_BADGE[tyre.status] || ''}`}>{tyre.status}</span>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
                {tyre.bus_registration_no ? `Mounted on ${tyre.bus_registration_no} / ${tyre.current_position}` : `In depot: ${tyre.depot_name || '—'}`}
              </div>
            </div>
          )}

          <div className="form-section-title">Details</div>
          {renderTypeFields()}

          {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}
          {message && (
            <div className="status-banner success" style={{ marginBottom: '0.75rem' }}>
              <CheckCircle2 size={16} /> <span>{message}</span>
            </div>
          )}
          <button type="submit">Log Event</button>
        </form>
      </div>
    </div>
  );
}
