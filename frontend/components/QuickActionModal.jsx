'use client';

import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../lib/api.js';
import { EVENT_TYPE_LABELS } from '../lib/tyreLifecycle.js';
import { useAuth } from './AuthContext.jsx';
import { ROLES } from '../lib/roles.js';

// Tyre-scoped quick actions on the tyre detail page. Previously every event
// type could only be logged from the separate /log-event page; this covers
// the lifecycle-advancing actions someone is most likely to want while
// already looking at one specific tyre (rotate it, pull it for repair, send
// it for retread, resolve a retread, file/resolve a warranty claim, scrap
// it). NSD/pressure readings, replacement, inter-bus transfer, and
// send-to-store remain on /log-event, unchanged. The 'condemnation' case
// below is labeled "Scrap" in the UI (see lib/tyreLifecycle.js) -- it
// absorbed the old separate 'scrap' event type's paperwork fields.
export default function QuickActionModal({ tyre, eventType, onClose, onSaved }) {
  const { user } = useAuth();
  const canElevated = [ROLES.ADMIN, ROLES.DEPOT_MANAGER].includes(user?.role);

  const [fields, setFields] = useState({});
  const [busPositions, setBusPositions] = useState([]);
  const [destBuses, setDestBuses] = useState([]);
  const [destPositions, setDestPositions] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Rotation target-occupancy handling: when the chosen "To Position" is
  // already occupied, the occupant has to go somewhere before this rotation
  // can be applied -- either a direct swap (the two tyres trade positions),
  // Spare, or a currently-empty position. All three are submitted as one
  // atomic /events/rotation-set call (see tyreEvents.js's createRotationSet),
  // which is what makes the swap option possible at all: neither tyre's
  // destination is free until the other has already moved.
  const [bus, setBus] = useState(null);
  const [occupantMode, setOccupantMode] = useState('swap');
  const [occupantTo, setOccupantTo] = useState('');
  const [occupantNsd, setOccupantNsd] = useState('');
  const [occupantStoredAt, setOccupantStoredAt] = useState('');

  // Puncture Repair's optional remount, target-occupancy handling: same
  // "send the resident tyre to Spare inline" pattern as rotation above, but
  // (like Log Event's Fitment/Transfer forms) there's only one thing to do
  // with an occupant here, not three -- see displaceOccupantIfAny in
  // tyreEvents.js. Gated to Admin/Depot Manager since it's really a Send to
  // Store happening inline and puncture_repair itself isn't elevated.
  const [remountBus, setRemountBus] = useState(null);
  const [remountOccupantNsd, setRemountOccupantNsd] = useState('');
  const [remountOccupantStoredAt, setRemountOccupantStoredAt] = useState('');

  useEffect(() => {
    if (eventType === 'rotation' && tyre.current_bus_id) {
      api.get(`/buses/${tyre.current_bus_id}`).then((b) => { setBusPositions(b.position_labels || []); setBus(b); });
    }
    if (eventType === 'puncture_repair') {
      api.get('/buses?pageSize=100').then((r) => setDestBuses(r.data));
    }
  }, [eventType, tyre.current_bus_id]);

  useEffect(() => {
    if (fields.bus_id) {
      api.get(`/buses/${fields.bus_id}`).then((b) => { setDestPositions(b.position_labels || []); setRemountBus(b); });
    } else {
      setDestPositions([]);
      setRemountBus(null);
    }
  }, [fields.bus_id]);

  const occupant = (bus?.tyre_position_map || []).find((s) => s.position === fields.to_position)?.tyre || null;
  const emptyPositions = busPositions.filter((p) => p !== tyre.current_position && !(bus?.tyre_position_map || []).find((s) => s.position === p)?.tyre);
  const remountOccupant = eventType === 'puncture_repair'
    ? (remountBus?.tyre_position_map || []).find((s) => s.position === fields.position)?.tyre || null
    : null;

  useEffect(() => {
    setOccupantMode('swap');
    setOccupantTo('');
    setOccupantNsd(occupant?.last_nsd_value != null ? String(occupant.last_nsd_value) : '');
    setOccupantStoredAt(bus?.depot_name ? `${bus.depot_name} Store` : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.to_position]);

  useEffect(() => {
    setRemountOccupantNsd(remountOccupant?.last_nsd_value != null ? String(remountOccupant.last_nsd_value) : '');
    setRemountOccupantStoredAt(remountBus?.depot_name ? `${remountBus.depot_name} Store` : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.position]);

  useEffect(() => {
    setFields((f) => {
      if (!remountOccupant) {
        if (f.displace_nsd_value === undefined && f.displace_stored_at === undefined) return f;
        const { displace_nsd_value, displace_stored_at, displace_reason, ...rest } = f;
        return rest;
      }
      return { ...f, displace_nsd_value: remountOccupantNsd, displace_stored_at: remountOccupantStoredAt };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remountOccupant, remountOccupantNsd, remountOccupantStoredAt]);

  function set(key, value) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (remountOccupant && !canElevated) {
      setError(`Position ${fields.position} is occupied by ${remountOccupant.tyre_number}. Sending a mounted tyre to Spare requires a Depot Manager or Administrator.`);
      return;
    }
    setSaving(true);
    try {
      if (eventType === 'rotation' && occupant) {
        // See log-event/page.jsx's identical handling -- the two tyres
        // involved always move together in one atomic call, since neither's
        // destination is guaranteed free until the other has already
        // vacated it (most obviously for a direct swap).
        const moves = [{
          tyre_id: tyre.id,
          to_position: fields.to_position,
          ...(fields.nsd_value !== undefined && fields.nsd_value !== '' ? { nsd_value: Number(fields.nsd_value) } : {}),
          reason: fields.reason || undefined,
        }];
        if (occupantMode === 'spare') {
          moves.push({
            tyre_id: occupant.id,
            dismount: true,
            nsd_value: Number(occupantNsd),
            stored_at: occupantStoredAt,
            reason: `Bumped from ${fields.to_position} during rotation of ${tyre.tyre_number}`,
          });
        } else if (occupantMode === 'swap') {
          moves.push({ tyre_id: occupant.id, to_position: tyre.current_position });
        } else {
          moves.push({ tyre_id: occupant.id, to_position: occupantTo });
        }
        await api.post('/events/rotation-set', { bus_id: tyre.current_bus_id, moves });
      } else {
        await api.post('/events', { event_type: eventType, tyre_id: tyre.id, ...fields });
      }
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
                {busPositions.filter((p) => p !== tyre.current_position).map((p) => {
                  const occ = (bus?.tyre_position_map || []).find((s) => s.position === p)?.tyre;
                  return <option key={p} value={p}>{p}{occ ? ` (occupied by ${occ.tyre_number})` : ''}</option>;
                })}
              </select>
            </div>
            {occupant && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '0.75rem', margin: '0.5rem 0' }}>
                <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                  <strong>{fields.to_position}</strong> is occupied by <strong>{occupant.tyre_number}</strong>. Choose what happens to it:
                </div>
                <div className="field" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontWeight: 400 }}>
                    <input type="radio" checked={occupantMode === 'swap'} onChange={() => setOccupantMode('swap')} /> Swap positions with it
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontWeight: 400 }}>
                    <input type="radio" checked={occupantMode === 'spare'} onChange={() => setOccupantMode('spare')} /> Send to Spare
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontWeight: 400 }}>
                    <input
                      type="radio"
                      checked={occupantMode === 'move'}
                      onChange={() => setOccupantMode('move')}
                      disabled={emptyPositions.length === 0}
                    /> Move to an empty position
                  </label>
                </div>
                {occupantMode === 'swap' && (
                  <span className="field-hint" style={{ display: 'block' }}>
                    {occupant.tyre_number} will move to {tyre.current_position} &mdash; this tyre's current spot.
                  </span>
                )}
                {occupantMode === 'spare' && (
                  <>
                    <div className="field">
                      <label>{occupant.tyre_number} &mdash; Current NSD</label>
                      <div className="input-suffix-wrap">
                        <input type="number" step="0.01" min="0" max="25" value={occupantNsd} onChange={(e) => setOccupantNsd(e.target.value)} required />
                        <span className="input-suffix">mm</span>
                      </div>
                    </div>
                    <div className="field">
                      <label>{occupant.tyre_number} &mdash; Stored At</label>
                      <input value={occupantStoredAt} onChange={(e) => setOccupantStoredAt(e.target.value)} placeholder="e.g. Depot Store Bay 2" required />
                    </div>
                  </>
                )}
                {occupantMode === 'move' && (
                  <div className="field">
                    <label>{occupant.tyre_number} &mdash; New Position</label>
                    <select value={occupantTo} onChange={(e) => setOccupantTo(e.target.value)} required>
                      <option value="">Select position</option>
                      {emptyPositions.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}
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
              <>
                <div className="field">
                  <label>Position</label>
                  <select value={fields.position || ''} onChange={(e) => set('position', e.target.value)} required>
                    <option value="">Select position</option>
                    {destPositions.map((p) => {
                      const occ = (remountBus?.tyre_position_map || []).find((s) => s.position === p)?.tyre;
                      return <option key={p} value={p}>{p}{occ ? ` (occupied by ${occ.tyre_number})` : ''}</option>;
                    })}
                  </select>
                </div>
                {remountOccupant && (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '0.75rem', margin: '0.5rem 0' }}>
                    {canElevated ? (
                      <>
                        <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                          <strong>{fields.position}</strong> is occupied by <strong>{remountOccupant.tyre_number}</strong>. It will be sent to Spare to make room:
                        </div>
                        <div className="field">
                          <label>{remountOccupant.tyre_number} &mdash; Current NSD</label>
                          <div className="input-suffix-wrap">
                            <input type="number" step="0.01" min="0" max="25" value={remountOccupantNsd} onChange={(e) => setRemountOccupantNsd(e.target.value)} required />
                            <span className="input-suffix">mm</span>
                          </div>
                        </div>
                        <div className="field">
                          <label>{remountOccupant.tyre_number} &mdash; Stored At</label>
                          <input value={remountOccupantStoredAt} onChange={(e) => setRemountOccupantStoredAt(e.target.value)} placeholder="e.g. Depot Store Bay 2" required />
                        </div>
                      </>
                    ) : (
                      <div className="error-text" style={{ fontSize: '0.85rem' }}>
                        <strong>{fields.position}</strong> is occupied by <strong>{remountOccupant.tyre_number}</strong>. Sending a mounted tyre to Spare requires a Depot Manager or Administrator &mdash; choose a free position, or leave this remount blank.
                      </div>
                    )}
                  </div>
                )}
              </>
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
      case 'condemnation':
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
