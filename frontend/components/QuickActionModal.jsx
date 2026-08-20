'use client';

import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../lib/api.js';
import { EVENT_TYPE_LABELS } from '../lib/tyreLifecycle.js';

// Tyre-scoped quick actions on the tyre detail page. Previously every event
// type could only be logged from the separate /log-event page; this covers
// the lifecycle-advancing actions someone is most likely to want while
// already looking at one specific tyre (rotate it, pull it for repair, send
// it for retread, resolve a retread, file/resolve a warranty claim, scrap
// it). NSD/pressure readings, replacement, inter-bus transfer, and
// send-to-store/condemnation remain on /log-event, unchanged.
export default function QuickActionModal({ tyre, eventType, onClose, onSaved }) {
  const [fields, setFields] = useState({});
  const [busPositions, setBusPositions] = useState([]);
  const [destBuses, setDestBuses] = useState([]);
  const [destPositions, setDestPositions] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (eventType === 'rotation' && tyre.current_bus_id) {
      api.get(`/buses/${tyre.current_bus_id}`).then((b) => setBusPositions(b.position_labels || []));
    }
    if (eventType === 'puncture_repair') {
      api.get('/buses?pageSize=100').then((r) => setDestBuses(r.data));
    }
  }, [eventType, tyre.current_bus_id]);

  useEffect(() => {
    if (fields.bus_id) {
      api.get(`/buses/${fields.bus_id}`).then((b) => setDestPositions(b.position_labels || []));
    } else {
      setDestPositions([]);
    }
  }, [fields.bus_id]);

  function set(key, value) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post('/events', { event_type: eventType, tyre_id: tyre.id, ...fields });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function renderFields() {
    switch (eventType) {
      case 'rotation':
        return (
          <>
            <div className="field">
              <label>To Position</label>
              <select value={fields.to_position || ''} onChange={(e) => set('to_position', e.target.value)} required>
                <option value="">Select position</option>
                {busPositions.filter((p) => p !== tyre.current_position).map((p) => <option key={p} value={p}>{p}</option>)}
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
      case 'retread_sent':
        return (
          <>
            <div className="field">
              <label>Vendor Name</label>
              <input value={fields.vendor_name || ''} onChange={(e) => set('vendor_name', e.target.value)} required />
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
              <input value={fields.vendor_name || ''} onChange={(e) => set('vendor_name', e.target.value)} />
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
      default:
        return null;
    }
  }

  return (
    <Modal title={EVENT_TYPE_LABELS[eventType] || eventType} onClose={onClose} width={440}>
      <form onSubmit={handleSubmit}>
        {renderFields()}
        {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}
        <div className="form-actions">
          <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Log Event'}</button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
