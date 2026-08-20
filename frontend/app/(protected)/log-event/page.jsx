'use client';

import React, { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import { ROLES } from '../../../lib/roles.js';
import TyreSelect from '../../../components/TyreSelect.jsx';
import PageHeader from '../../../components/PageHeader.jsx';
import { EVENT_TYPES as ALL_EVENT_TYPES, statusBadgeClass } from '../../../lib/tyreLifecycle.js';

const EVENT_TYPES = ALL_EVENT_TYPES.filter((t) => !t.hiddenFromLogEvent);

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
      // "Today" per IST, not the viewing browser's own local timezone --
      // the app's server-side timestamps are all IST-displayed, so the
      // default date here should match rather than drift for a viewer
      // whose machine is set to a different timezone.
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date())
        .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
      setFields({ event_date: `${parts.year}-${parts.month}-${parts.day}` });
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
    if (['fitment_created', 'puncture_repair'].includes(eventType)) {
      api.get('/buses?pageSize=100').then((r) => setDestBuses(r.data));
    }
  }, [tyre, eventType]);

  useEffect(() => {
    const busId = fields.to_bus_id || fields.bus_id;
    if (busId) {
      api.get(`/buses/${busId}`).then((b) => setDestPositions(b.position_labels));
    } else {
      setDestPositions([]);
    }
  }, [fields.to_bus_id, fields.bus_id]);

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
      case 'nsd_reading': {
        const groovesFilled = ['nsd_g1', 'nsd_g2', 'nsd_g3', 'nsd_g4'].every((k) => fields[k] !== undefined && fields[k] !== '');
        return (
          <>
            <div className="field">
              <label>NSD Value{groovesFilled ? ' (auto: min of grooves below)' : ''}</label>
              <div className="input-suffix-wrap">
                <input type="number" step="0.01" value={fields.nsd_value || ''} onChange={(e) => set('nsd_value', e.target.value)} required={!groovesFilled} />
                <span className="input-suffix">mm</span>
              </div>
            </div>
            <div className="field">
              <label>Per-Groove Readings (optional)</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {['nsd_g1', 'nsd_g2', 'nsd_g3', 'nsd_g4'].map((key, i) => (
                  <div className="input-suffix-wrap" key={key}>
                    <input
                      type="number" step="0.01" min="0" max="25"
                      placeholder={`G${i + 1}`}
                      value={fields[key] || ''}
                      onChange={(e) => set(key, e.target.value)}
                    />
                  </div>
                ))}
              </div>
              <span className="field-hint">If all 4 groove points are entered and NSD Value is left blank, NSD Value is taken as their minimum.</span>
            </div>
            <div className="field">
              <label>Event Date</label>
              <input type="date" value={fields.event_date || ''} onChange={(e) => set('event_date', e.target.value)} required />
            </div>
          </>
        );
      }
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
              <label>NSD Value</label>
              <div className="input-suffix-wrap">
                <input type="number" step="0.01" min="0" max="25" value={fields.nsd_value || ''} onChange={(e) => set('nsd_value', e.target.value)} />
                <span className="input-suffix">mm</span>
              </div>
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
      case 'send_to_repair':
        return (
          <>
            <div className="field">
              <label>NSD Value</label>
              <div className="input-suffix-wrap">
                <input type="number" step="0.01" min="0" max="25" value={fields.nsd_value || ''} onChange={(e) => set('nsd_value', e.target.value)} />
                <span className="input-suffix">mm</span>
              </div>
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. puncture found" />
            </div>
            <div className="field">
              <label>Odometer Reading (km)</label>
              <input type="number" min="0" value={fields.odometer_km || ''} onChange={(e) => set('odometer_km', e.target.value)} />
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
              <label>Repair Cost</label>
              <input type="number" step="0.01" value={fields.repair_cost || ''} onChange={(e) => set('repair_cost', e.target.value)} />
            </div>
            <div className="field">
              <label>Patch Size</label>
              <input value={fields.patch_size || ''} onChange={(e) => set('patch_size', e.target.value)} placeholder="e.g. 30mm" />
            </div>
            <div className="field">
              <label>Supervisor Name</label>
              <input value={fields.supervisor_name || ''} onChange={(e) => set('supervisor_name', e.target.value)} />
            </div>
            <div className="field">
              <label>Tyre Man Name</label>
              <input value={fields.tyre_man_name || ''} onChange={(e) => set('tyre_man_name', e.target.value)} />
            </div>
            <div className="field">
              <label>Odometer Reading (km)</label>
              <input type="number" min="0" value={fields.odometer_km || ''} onChange={(e) => set('odometer_km', e.target.value)} />
            </div>
            <div className="field">
              <label>Notes</label>
              <input value={fields.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="e.g. nail in tread" />
            </div>
            <div className="form-section-title" style={{ marginTop: '0.5rem' }}>Remount (optional)</div>
            <span className="field-hint" style={{ display: 'block', marginBottom: '0.5rem' }}>
              A repaired tyre often goes back onto a different bus than the one it came off. Leave blank to just return it to store.
            </span>
            <div className="field">
              <label>Bus</label>
              <select value={fields.bus_id || ''} onChange={(e) => set('bus_id', e.target.value)}>
                <option value="">Return to store (no remount)</option>
                {destBuses.map((b) => <option key={b.id} value={b.id}>{b.registration_no} ({b.depot_name})</option>)}
              </select>
            </div>
            {fields.bus_id && (
              <div className="field">
                <label>Position</label>
                <select value={fields.position || ''} onChange={(e) => set('position', e.target.value)} required>
                  <option value="">Select position</option>
                  {destPositions.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            )}
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
                <input type="number" step="0.01" min="0" max="25" value={fields.nsd_value || ''} onChange={(e) => set('nsd_value', e.target.value)} required />
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
                <input type="number" step="0.01" min="0" max="25" value={fields.nsd_value || ''} onChange={(e) => set('nsd_value', e.target.value)} required />
                <span className="input-suffix">mm</span>
              </div>
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. below minimum NSD" required />
            </div>
          </>
        );
      case 'fitment_created':
        return (
          <>
            <div className="field">
              <label>Bus</label>
              <select value={fields.bus_id || ''} onChange={(e) => set('bus_id', e.target.value)} required>
                <option value="">Select bus</option>
                {destBuses.map((b) => <option key={b.id} value={b.id}>{b.registration_no} ({b.depot_name})</option>)}
              </select>
            </div>
            <div className="field">
              <label>Position</label>
              <select value={fields.position || ''} onChange={(e) => set('position', e.target.value)} required disabled={!fields.bus_id}>
                <option value="">Select position</option>
                {destPositions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Odometer Reading (km)</label>
              <input type="number" min="0" value={fields.odometer_km || ''} onChange={(e) => set('odometer_km', e.target.value)} />
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. new fitment" />
            </div>
          </>
        );
      case 'reservation':
        return (
          <div className="field">
            <label>Reason</label>
            <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. allocated to next fitment run" />
          </div>
        );
      case 'inspection_completed':
        return (
          <div className="field">
            <label>Notes</label>
            <input value={fields.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="e.g. all checks passed" />
          </div>
        );
      case 'retread_sent':
        return (
          <>
            <div className="field">
              <label>Vendor Name</label>
              <input value={fields.vendor_name || ''} onChange={(e) => set('vendor_name', e.target.value)} placeholder="e.g. Acme Retreads" required />
            </div>
            <div className="field">
              <label>Vendor Location</label>
              <input value={fields.vendor_location || ''} onChange={(e) => set('vendor_location', e.target.value)} />
            </div>
            <div className="field">
              <label>Gate Pass No.</label>
              <input value={fields.gate_pass_no || ''} onChange={(e) => set('gate_pass_no', e.target.value)} />
            </div>
            <div className="field">
              <label>Purpose</label>
              <select value={fields.retread_purpose || ''} onChange={(e) => set('retread_purpose', e.target.value)}>
                <option value="">Select</option>
                <option value="Retread">Retread</option>
                <option value="Cut Repair">Cut Repair</option>
              </select>
            </div>
            <div className="field">
              <label>Odometer Reading (km)</label>
              <input type="number" min="0" value={fields.odometer_km || ''} onChange={(e) => set('odometer_km', e.target.value)} />
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. tread worn, retread eligible" />
            </div>
          </>
        );
      case 'retread_completed':
        return (
          <>
            <div className="field">
              <label>Outcome</label>
              <select value={fields.outcome || ''} onChange={(e) => set('outcome', e.target.value)}>
                <option value="">Select</option>
                <option value="Done">Done</option>
                <option value="Rejected">Rejected</option>
              </select>
            </div>
            <div className="field">
              <label>Vendor Name</label>
              <input value={fields.vendor_name || ''} onChange={(e) => set('vendor_name', e.target.value)} placeholder="e.g. Acme Retreads" />
            </div>
            <div className="field">
              <label>Vendor Location</label>
              <input value={fields.vendor_location || ''} onChange={(e) => set('vendor_location', e.target.value)} />
            </div>
            <div className="field">
              <label>Invoice No.</label>
              <input value={fields.invoice_no || ''} onChange={(e) => set('invoice_no', e.target.value)} />
            </div>
            <div className="field">
              <label>Invoice Date</label>
              <input type="date" value={fields.invoice_date || ''} onChange={(e) => set('invoice_date', e.target.value)} />
            </div>
            <div className="field">
              <label>Retread Cost</label>
              <input type="number" step="0.01" value={fields.retread_cost || ''} onChange={(e) => set('retread_cost', e.target.value)} />
            </div>
            {fields.outcome === 'Rejected' && (
              <div className="field">
                <label>Rejected Reason</label>
                <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. carcass damage, not retreadable" />
              </div>
            )}
            <div className="field">
              <label>Notes</label>
              <input value={fields.notes || ''} onChange={(e) => set('notes', e.target.value)} />
            </div>
          </>
        );
      case 'warranty_claim':
        return (
          <>
            <div className="field">
              <label>Outcome</label>
              <select value={fields.outcome || ''} onChange={(e) => set('outcome', e.target.value)}>
                <option value="">Submit new claim</option>
                <option value="approved">Decision: Approved</option>
                <option value="rejected">Decision: Rejected</option>
                <option value="closed">Close claim (return to store)</option>
              </select>
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. premature wear" required={!fields.outcome} />
            </div>
            <div className="field">
              <label>Vendor Location</label>
              <input value={fields.vendor_location || ''} onChange={(e) => set('vendor_location', e.target.value)} />
            </div>
            <div className="field">
              <label>Approved By</label>
              <input value={fields.approved_by || ''} onChange={(e) => set('approved_by', e.target.value)} />
            </div>
          </>
        );
      case 'scrap':
        return (
          <>
            <div className="field">
              <label>Scrap Value</label>
              <input type="number" step="0.01" value={fields.scrap_value || ''} onChange={(e) => set('scrap_value', e.target.value)} />
            </div>
            <div className="field">
              <label>Vendor Name</label>
              <input value={fields.vendor_name || ''} onChange={(e) => set('vendor_name', e.target.value)} />
            </div>
            <div className="field">
              <label>Vendor Location</label>
              <input value={fields.vendor_location || ''} onChange={(e) => set('vendor_location', e.target.value)} />
            </div>
            <div className="field">
              <label>Gate Pass No.</label>
              <input value={fields.gate_pass_no || ''} onChange={(e) => set('gate_pass_no', e.target.value)} />
            </div>
            <div className="field">
              <label>Invoice No.</label>
              <input value={fields.invoice_no || ''} onChange={(e) => set('invoice_no', e.target.value)} />
            </div>
            <div className="field">
              <label>Invoice Date</label>
              <input type="date" value={fields.invoice_date || ''} onChange={(e) => set('invoice_date', e.target.value)} />
            </div>
            <div className="field">
              <label>Approved By</label>
              <input value={fields.approved_by || ''} onChange={(e) => set('approved_by', e.target.value)} />
            </div>
            <div className="field">
              <label>Store Manager</label>
              <input value={fields.store_manager || ''} onChange={(e) => set('store_manager', e.target.value)} />
            </div>
            <div className="field">
              <label>NSD Value</label>
              <div className="input-suffix-wrap">
                <input type="number" step="0.01" min="0" max="25" value={fields.nsd_value || ''} onChange={(e) => set('nsd_value', e.target.value)} />
                <span className="input-suffix">mm</span>
              </div>
            </div>
            <div className="field">
              <label>Odometer Reading (km)</label>
              <input type="number" min="0" value={fields.odometer_km || ''} onChange={(e) => set('odometer_km', e.target.value)} />
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. end of usable tread life" required />
            </div>
          </>
        );
      case 'scrap_disposal':
        return (
          <>
            <div className="field">
              <label>Milestone</label>
              <select value={fields.milestone || ''} onChange={(e) => set('milestone', e.target.value)} required>
                <option value="">Select</option>
                <option value="Disposed">Disposed</option>
                <option value="Archived">Archived</option>
              </select>
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={fields.reason || ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. disposed per policy" />
            </div>
          </>
        );
      default:
        return null;
    }
  }

  const needsMountedTyre = ['nsd_reading', 'pressure_reading', 'rotation', 'replacement', 'inter_bus_transfer', 'inspection_completed'].includes(eventType);

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <PageHeader title="Log Event" description="Record a tyre card event: reading, movement, repair, or lifecycle change." />

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
                <span className={`badge ${statusBadgeClass(tyre.status)}`}>{tyre.status}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', marginTop: '0.4rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Bus</span>
                {tyre.bus_registration_no ? (
                  <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>
                    {tyre.bus_registration_no} <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>/ {tyre.current_position}</span>
                  </span>
                ) : (
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Not mounted — in depot: {tyre.depot_name || '-'}</span>
                )}
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
