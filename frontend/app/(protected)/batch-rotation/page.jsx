'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Search, Info } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import { ROLES, FLEET_WIDE_ROLES } from '../../../lib/roles.js';
import PageHeader from '../../../components/PageHeader.jsx';
import EmptyState from '../../../components/EmptyState.jsx';
import LoadingState from '../../../components/LoadingState.jsx';
import Modal from '../../../components/Modal.jsx';
import BusTyreDiagram from '../../../components/BusTyreDiagram.jsx';
import BusSelect from '../../../components/BusSelect.jsx';

// Excel Parity Gap-Closure: the "Tyre Rotation" sheet rotates every tyre on
// a bus in one session (up to 6 positions swapped together, each with its
// own NSD), rather than one rotation event at a time. Mirrors
// batch-inspection/page.jsx's bus-diagram / click-a-position / fill-a-modal
// pattern exactly, but assigns a destination position + NSD per tyre and
// submits through the new POST /events/batch-rotation endpoint.
//
// Note: each rotation still validates its destination position is free at
// the moment it's applied (server-side, same as a single rotation event),
// applied one at a time in submission order -- a true circular swap (A->B's
// slot, B->A's slot) can fail on the leg that resolves first if the target
// slot hasn't been vacated yet. Any rotation that fails this way shows in
// the per-item error list below and can be resubmitted once the rest have
// vacated their slots.
export default function BatchRotationPage() {
  const { user } = useAuth();
  const canWrite = [ROLES.ADMIN, ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR].includes(user?.role);
  const isFleetWide = FLEET_WIDE_ROLES.includes(user?.role);

  const [depots, setDepots] = useState([]);
  const [depotId, setDepotId] = useState(user?.depot_id || '');

  const [busId, setBusId] = useState('');
  const [bus, setBus] = useState(null);
  const [rotations, setRotations] = useState({});
  // Tyres bumped off an occupied target position and sent to Spare/Store
  // instead of another position on this bus, keyed by tyre id -> the
  // send_to_store fields needed to dismount them. Kept separate from
  // `rotations` (which is only ever position-to-position moves on this bus).
  const [spareDismounts, setSpareDismounts] = useState({});
  const [odometerKm, setOdometerKm] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [tyreSearch, setTyreSearch] = useState('');
  const [activeSlot, setActiveSlot] = useState(null);
  const [modalToPosition, setModalToPosition] = useState('');
  const [modalNsd, setModalNsd] = useState('');

  // Occupied-target handling for the slot modal below: picking a position
  // that already has a tyre on it requires deciding what happens to that
  // occupant. It can only be sent to Spare or moved to a position that's
  // currently empty (never the slot the primary tyre is itself vacating),
  // so resolving it never depends on submission order.
  const [occupantMode, setOccupantMode] = useState('spare');
  const [occupantTo, setOccupantTo] = useState('');
  const [occupantNsd, setOccupantNsd] = useState('');
  const [occupantStoredAt, setOccupantStoredAt] = useState('');

  useEffect(() => {
    api.get('/depots').then(setDepots).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isFleetWide && user?.depot_id) setDepotId(user.depot_id);
  }, [isFleetWide, user?.depot_id]);

  useEffect(() => {
    setBusId('');
  }, [depotId]);

  useEffect(() => {
    setBus(null);
    setRotations({});
    setSpareDismounts({});
    setResult(null);
    setError('');
    setTyreSearch('');
    setOdometerKm('');
    setReason('');
    if (busId) {
      api.get(`/buses/${busId}`).then(setBus).catch((err) => setError(err.message));
    }
  }, [busId]);

  function setRotation(tyreId, field, value) {
    setRotations((r) => ({ ...r, [tyreId]: { ...r[tyreId], [field]: value } }));
  }

  // Positions already claimed as a destination by another tyre in this same
  // batch aren't offered again, so the diagram can't be used to build an
  // obviously-conflicting submission client-side.
  const claimedPositions = new Set(Object.values(rotations).map((r) => r.to_position).filter(Boolean));

  const tyreByPosition = Object.fromEntries((bus?.tyre_position_map || []).map((s) => [s.position, s.tyre]));
  const modalOccupant = activeSlot?.tyre && modalToPosition ? tyreByPosition[modalToPosition] : null;
  const showOccupantBump = !!(
    modalOccupant &&
    modalOccupant.id !== activeSlot?.tyre?.id &&
    !rotations[modalOccupant.id]?.to_position &&
    !spareDismounts[modalOccupant.id]
  );
  const occupantEmptyPositions = (bus?.position_labels || []).filter(
    (p) => p !== activeSlot?.position && p !== modalToPosition && !claimedPositions.has(p) && !tyreByPosition[p]
  );

  function openSlotModal(slot) {
    setActiveSlot(slot);
    setOccupantMode('spare');
    setOccupantTo('');
    setOccupantNsd('');
    setOccupantStoredAt(bus?.depot_name ? `${bus.depot_name} Store` : '');
    if (slot.tyre) {
      const existing = rotations[slot.tyre.id] || {};
      setModalToPosition(existing.to_position ?? '');
      setModalNsd(existing.nsd_value ?? '');
    }
  }

  // Re-derives occupant defaults whenever the target position changes while
  // the modal is open (rather than only at open-time), so picking a
  // different occupied position mid-edit re-prefills its NSD.
  useEffect(() => {
    if (!activeSlot?.tyre) return;
    const occ = tyreByPosition[modalToPosition];
    if (occ && occ.id !== activeSlot.tyre.id) {
      setOccupantMode('spare');
      setOccupantTo('');
      setOccupantNsd(occ.last_nsd_value != null ? String(occ.last_nsd_value) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalToPosition]);

  function closeTyreModal() {
    setActiveSlot(null);
    setModalToPosition('');
    setModalNsd('');
  }

  // Undoes a bump this tyre previously staged for some other occupant, if
  // that occupant's plan is still the one this tyre created (the user may
  // have since edited that occupant's own slot directly, in which case its
  // entry belongs to them now and must not be touched).
  function retractPriorBump(tyreId, prevBumpedId) {
    if (!prevBumpedId) return;
    setRotations((r) => {
      if (r[prevBumpedId]?.bumpedBy !== tyreId) return r;
      const next = { ...r };
      delete next[prevBumpedId];
      return next;
    });
    setSpareDismounts((d) => {
      if (d[prevBumpedId]?.bumpedBy !== tyreId) return d;
      const next = { ...d };
      delete next[prevBumpedId];
      return next;
    });
  }

  function saveRotation(e) {
    e.preventDefault();
    const tyreId = activeSlot.tyre.id;
    const prevBumpedId = rotations[tyreId]?.bumpedOccupantId;
    if (prevBumpedId && prevBumpedId !== modalOccupant?.id) {
      retractPriorBump(tyreId, prevBumpedId);
    }

    // Re-saving without touching the target position (showOccupantBump is
    // false the second time around, since the occupant's own entry now
    // exists) must still remember that this tyre is the one that staged it,
    // so a later retarget can find and retract it.
    let bumpedOccupantId = modalOccupant && (rotations[modalOccupant.id]?.bumpedBy === tyreId || spareDismounts[modalOccupant.id]?.bumpedBy === tyreId)
      ? modalOccupant.id
      : undefined;
    if (showOccupantBump) {
      bumpedOccupantId = modalOccupant.id;
      if (occupantMode === 'spare') {
        setSpareDismounts((d) => ({
          ...d,
          [modalOccupant.id]: {
            nsd_value: occupantNsd,
            stored_at: occupantStoredAt,
            reason: `Bumped from ${modalToPosition} during rotation of ${activeSlot.tyre.tyre_number}`,
            bumpedBy: tyreId,
          },
        }));
      } else {
        setRotations((r) => ({
          ...r,
          [modalOccupant.id]: { to_position: occupantTo, nsd_value: '', bumpedBy: tyreId },
        }));
      }
    }

    setRotations((r) => ({
      ...r,
      [tyreId]: { to_position: modalToPosition, nsd_value: modalNsd, bumpedOccupantId },
    }));
    closeTyreModal();
  }

  function clearRotation() {
    const tyreId = activeSlot.tyre.id;
    retractPriorBump(tyreId, rotations[tyreId]?.bumpedOccupantId);
    setRotations((r) => {
      const next = { ...r };
      delete next[tyreId];
      return next;
    });
    closeTyreModal();
  }

  function renderTyreButton(slot) {
    const query = tyreSearch.trim().toLowerCase();
    const isHighlighted = !!query && (
      slot.position.toLowerCase().includes(query) ||
      (slot.tyre && slot.tyre.tyre_number.toLowerCase().includes(query))
    );

    if (!slot.tyre) {
      return (
        <button
          type="button"
          key={slot.position}
          className={`bus-diagram-tyre empty${isHighlighted ? ' highlighted' : ''}`}
          onClick={() => openSlotModal(slot)}
        >
          <span className="position-code">{slot.position}</span>
          <span className="reading-summary">Empty</span>
        </button>
      );
    }

    const rotation = rotations[slot.tyre.id];
    const hasRotation = !!rotation && !!rotation.to_position;
    const isSpared = !!spareDismounts[slot.tyre.id];

    return (
      <button
        type="button"
        key={slot.position}
        className={`bus-diagram-tyre${hasRotation || isSpared ? ' has-reading' : ''}${isHighlighted ? ' highlighted' : ''}`}
        onClick={() => openSlotModal(slot)}
      >
        <span className="position-code">{slot.position}</span>
        <span className="tyre-number">{slot.tyre.tyre_number}</span>
        {hasRotation && <span className="reading-summary">&rarr; {rotation.to_position}</span>}
        {isSpared && <span className="reading-summary">&rarr; Spare</span>}
      </button>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setResult(null);

    const rotationEntries = Object.entries(rotations)
      .filter(([, r]) => r.to_position)
      .map(([tyreId, r]) => ({
        tyre_id: Number(tyreId),
        to_position: r.to_position,
        ...(r.nsd_value !== undefined && r.nsd_value !== '' ? { nsd_value: Number(r.nsd_value) } : {}),
      }));
    const dismountEntries = Object.entries(spareDismounts).map(([tyreId, d]) => ({ tyre_id: Number(tyreId), ...d }));

    if (rotationEntries.length === 0 && dismountEntries.length === 0) {
      setError('Assign at least one tyre a new position before submitting.');
      return;
    }

    setSubmitting(true);
    try {
      const created = [];
      const errors = [];

      // Spare/store dismounts vacate their position independent of the bus's
      // position graph, so they're always safe to apply first -- unlike the
      // rotations below, they can never fail on "position not free yet".
      for (const d of dismountEntries) {
        try {
          const events = await api.post('/events', {
            event_type: 'send_to_store',
            tyre_id: d.tyre_id,
            nsd_value: Number(d.nsd_value),
            stored_at: d.stored_at,
            reason: d.reason,
          });
          created.push(...(Array.isArray(events) ? events : [events]));
        } catch (err) {
          errors.push({ tyre_id: d.tyre_id, error: err.message });
        }
      }

      if (rotationEntries.length > 0) {
        const data = await api.post('/events/batch-rotation', {
          bus_id: Number(busId),
          rotations: rotationEntries,
          odometer_km: odometerKm === '' ? undefined : Number(odometerKm),
          reason: reason || undefined,
        });
        created.push(...data.created);
        errors.push(...data.errors);
      }

      setResult({ created, errors });
      setRotations({});
      setSpareDismounts({});
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!canWrite) {
    return <div className="card error-text">Access denied. Batch rotation is restricted to Tyre Supervisors, Depot Managers, and Administrators.</div>;
  }

  const mountedSlots = bus ? bus.tyre_position_map.filter((slot) => slot.tyre) : [];
  const step1Done = !!depotId;
  const step2Done = !!busId;
  const step3Done = !!result;

  return (
    <div>
      <PageHeader title="Batch Rotation" description="Rotate every tyre on a bus in one session: click a tyre, assign its new position and NSD, then submit the whole bus at once." />

      <div className="step-indicator">
        <div className={`step-indicator-item ${step1Done ? 'done' : 'active'}`}>
          <span className="step-indicator-num">1</span> Select Depot
        </div>
        <div className="step-indicator-sep" />
        <div className={`step-indicator-item ${step2Done ? 'done' : step1Done ? 'active' : ''}`}>
          <span className="step-indicator-num">2</span> Select Bus
        </div>
        <div className="step-indicator-sep" />
        <div className={`step-indicator-item ${step3Done ? 'done' : step2Done ? 'active' : ''}`}>
          <span className="step-indicator-num">3</span> Assign Positions
        </div>
        <div className="step-indicator-sep" />
        <div className={`step-indicator-item ${step3Done ? 'done' : ''}`}>
          <span className="step-indicator-num">4</span> Submit
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <div className="field" style={{ maxWidth: 260 }}>
            <label>Depot</label>
            <select value={depotId} onChange={(e) => setDepotId(e.target.value)} disabled={!isFleetWide}>
              <option value="">Select a depot</option>
              {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div style={{ maxWidth: 300, flex: '1 1 260px' }}>
            <BusSelect value={busId} onChange={(b) => setBusId(b ? b.id : '')} depotId={depotId} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row"><h3>Assign Positions</h3></div>

        {!depotId ? (
          <EmptyState title="Select a depot to begin" description="Pick a depot above, then a bus, to rotate its mounted tyres." />
        ) : !busId ? (
          <EmptyState title="Select a bus to rotate its tyres" description="Choose a bus from the dropdown above to load its tyre position map." />
        ) : !bus ? (
          <LoadingState label="Loading bus..." />
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="field" style={{ maxWidth: 320, margin: '0 auto 1rem' }}>
              <label>Find Tyre (position or tyre number)</label>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  value={tyreSearch}
                  onChange={(e) => setTyreSearch(e.target.value)}
                  placeholder="e.g. RLO or TYR-0003"
                  style={{ paddingLeft: '2rem' }}
                />
              </div>
            </div>

            <BusTyreDiagram positionMap={bus.tyre_position_map} renderTyre={renderTyreButton} />

            {mountedSlots.length === 0 && (
              <p style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '-0.5rem' }}>
                No tyres are mounted on this bus yet.
              </p>
            )}

            <div className="toolbar" style={{ marginTop: '1rem' }}>
              <div className="field" style={{ maxWidth: 200 }}>
                <label>Odometer Reading (km)</label>
                <input type="number" min="0" value={odometerKm} onChange={(e) => setOdometerKm(e.target.value)} />
              </div>
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label>Reason</label>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. scheduled rotation" />
              </div>
            </div>

            {error && <div className="error-text" style={{ marginTop: '0.75rem' }}>{error}</div>}
            {result && (
              <div style={{ marginTop: '0.75rem' }}>
                <div className="status-banner success">
                  <CheckCircle2 size={16} /> <span>{result.created.length} rotation(s) recorded.</span>
                </div>
                {result.errors.length > 0 && (
                  <div className="error-text">
                    {result.errors.map((e, i) => <div key={i}>Tyre {e.tyre_id}: {e.error}</div>)}
                  </div>
                )}
              </div>
            )}
            <button type="submit" disabled={submitting || mountedSlots.length === 0} style={{ marginTop: '0.75rem' }}>
              {submitting ? 'Submitting...' : 'Submit Batch Rotation'}
            </button>
          </form>
        )}
      </div>

      {activeSlot && !activeSlot.tyre && (
        <Modal title={`Position ${activeSlot.position} (Empty)`} onClose={closeTyreModal} width={380}>
          <div className="status-banner info">
            <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>No tyre is currently mounted at position {activeSlot.position}, so there's nothing to rotate here.</span>
          </div>
          <p style={{ marginTop: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            Mount a tyre here first via <strong>Log Event</strong> (Tyre Fitment) or the <strong>Tyres</strong> page.
          </p>
          <div className="form-actions">
            <Link href="/log-event"><button type="button">Go to Log Event</button></Link>
            <button type="button" className="secondary" onClick={closeTyreModal}>Close</button>
          </div>
        </Modal>
      )}

      {activeSlot && activeSlot.tyre && (
        <Modal title={`${activeSlot.position} : ${activeSlot.tyre.tyre_number}`} onClose={closeTyreModal} width={380}>
          <form onSubmit={saveRotation}>
            <div className="field">
              <label>New Position</label>
              <select value={modalToPosition} onChange={(e) => setModalToPosition(e.target.value)} required>
                <option value="">Select position</option>
                {(bus.position_labels || [])
                  .filter((p) => p !== activeSlot.position && !claimedPositions.has(p))
                  .map((p) => (
                    <option key={p} value={p}>
                      {p}{tyreByPosition[p] ? ` (occupied by ${tyreByPosition[p].tyre_number})` : ''}
                    </option>
                  ))}
              </select>
            </div>
            {showOccupantBump && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '0.75rem', margin: '0.5rem 0' }}>
                <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                  <strong>{modalToPosition}</strong> is occupied by <strong>{modalOccupant.tyre_number}</strong>. Choose what happens to it:
                </div>
                <div className="field" style={{ display: 'flex', gap: '1rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontWeight: 400 }}>
                    <input type="radio" checked={occupantMode === 'spare'} onChange={() => setOccupantMode('spare')} /> Send to Spare
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontWeight: 400 }}>
                    <input
                      type="radio"
                      checked={occupantMode === 'move'}
                      onChange={() => setOccupantMode('move')}
                      disabled={occupantEmptyPositions.length === 0}
                    /> Move to an empty position
                  </label>
                </div>
                {occupantMode === 'spare' ? (
                  <>
                    <div className="field">
                      <label>{modalOccupant.tyre_number} &mdash; Current NSD</label>
                      <div className="input-suffix-wrap">
                        <input type="number" step="0.01" min="0" max="25" value={occupantNsd} onChange={(e) => setOccupantNsd(e.target.value)} required />
                        <span className="input-suffix">mm</span>
                      </div>
                    </div>
                    <div className="field">
                      <label>{modalOccupant.tyre_number} &mdash; Stored At</label>
                      <input value={occupantStoredAt} onChange={(e) => setOccupantStoredAt(e.target.value)} placeholder="e.g. Depot Store Bay 2" required />
                    </div>
                  </>
                ) : (
                  <div className="field">
                    <label>{modalOccupant.tyre_number} &mdash; New Position</label>
                    <select value={occupantTo} onChange={(e) => setOccupantTo(e.target.value)} required>
                      <option value="">Select position</option>
                      {occupantEmptyPositions.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}
            <div className="field">
              <label>NSD Value</label>
              <div className="input-suffix-wrap">
                <input type="number" step="0.01" min="0" max="25" value={modalNsd} onChange={(e) => setModalNsd(e.target.value)} />
                <span className="input-suffix">mm</span>
              </div>
            </div>
            <div className="form-actions">
              <button type="submit">Save</button>
              {rotations[activeSlot.tyre.id]?.to_position && (
                <button type="button" className="secondary" onClick={clearRotation}>Clear</button>
              )}
              <button type="button" className="secondary" onClick={closeTyreModal}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
