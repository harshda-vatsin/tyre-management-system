'use client';

import React, { useState } from 'react';
import Modal from './Modal.jsx';
import TyreSelect from './TyreSelect.jsx';
import { api } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';
import { ROLES } from '../lib/roles.js';

// Bus-centric counterpart to Log Event's "Fitment (Mount from Store)" case
// (see log-event/page.jsx) -- same fitment_created call, same occupied-
// position handling (createFitmentCreated in tyreEvents.js), just entered
// from the bus diagram instead of starting from a tyre. `occupant` is the
// slot's current tyre (or null for an empty position); confirming with an
// occupant present is the "approval" step -- a same-session confirmation
// gated to Admin/Depot Manager, not a queued multi-user workflow (there is
// no pending-request concept anywhere else in this app).
export default function MountTyreModal({ bus, position, occupant, onClose, onSaved }) {
  const { user } = useAuth();
  const canElevated = [ROLES.ADMIN, ROLES.DEPOT_MANAGER].includes(user?.role);

  const [tyre, setTyre] = useState(null);
  const [reason, setReason] = useState('');
  const [odometerKm, setOdometerKm] = useState('');
  const [occupantNsd, setOccupantNsd] = useState(occupant?.last_nsd_value != null ? String(occupant.last_nsd_value) : '');
  const [occupantStoredAt, setOccupantStoredAt] = useState(bus?.depot_name ? `${bus.depot_name} Store` : '');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const blocked = occupant && !canElevated;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!tyre) { setError('Select a tyre first'); return; }
    if (blocked) { setError(`Sending ${occupant.tyre_number} to Spare requires a Depot Manager or Administrator`); return; }
    if (occupant && !confirmed) { setError(`Confirm displacing ${occupant.tyre_number} to Spare before mounting`); return; }

    setSaving(true);
    try {
      await api.post('/events', {
        event_type: 'fitment_created',
        tyre_id: tyre.id,
        bus_id: bus.id,
        position,
        reason: reason || undefined,
        odometer_km: odometerKm || undefined,
        ...(occupant ? { displace_nsd_value: Number(occupantNsd), displace_stored_at: occupantStoredAt } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Mount Tyre — ${position} on ${bus.registration_no}`} onClose={onClose} width={440}>
      <form onSubmit={handleSubmit}>
        <TyreSelect label="Tyre to Mount (from stock)" status="In Store" value={tyre?.id} onChange={setTyre} />

        {occupant && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '0.75rem', margin: '0.5rem 0' }}>
            {blocked ? (
              <div className="error-text" style={{ fontSize: '0.85rem' }}>
                <strong>{position}</strong> is occupied by <strong>{occupant.tyre_number}</strong>. Sending a mounted tyre to Spare requires a Depot Manager or Administrator.
              </div>
            ) : (
              <>
                <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                  <strong>{position}</strong> is occupied by <strong>{occupant.tyre_number}</strong>. It will be sent to Spare to make room:
                </div>
                <div className="field">
                  <label>{occupant.tyre_number} &mdash; Current NSD</label>
                  <div className="input-suffix-wrap">
                    <input type="number" step="0.01" min="0" max="25" value={occupantNsd} onChange={(e) => { setOccupantNsd(e.target.value); setConfirmed(false); }} required />
                    <span className="input-suffix">mm</span>
                  </div>
                </div>
                <div className="field">
                  <label>{occupant.tyre_number} &mdash; Stored At</label>
                  <input value={occupantStoredAt} onChange={(e) => { setOccupantStoredAt(e.target.value); setConfirmed(false); }} placeholder="e.g. Depot Store Bay 2" required />
                </div>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem', fontWeight: 400, fontSize: '0.85rem', marginTop: '0.5rem' }}>
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                  I confirm {occupant.tyre_number} is being pulled from {position} and sent to Spare at the NSD/location above.
                </label>
              </>
            )}
          </div>
        )}

        <div className="field">
          <label>Odometer Reading (km)</label>
          <input type="number" min="0" value={odometerKm} onChange={(e) => setOdometerKm(e.target.value)} />
        </div>
        <div className="field">
          <label>Reason</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. new fitment" />
        </div>

        {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}
        <div className="form-actions">
          <button type="submit" disabled={saving || blocked}>{saving ? 'Saving...' : 'Mount Tyre'}</button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
