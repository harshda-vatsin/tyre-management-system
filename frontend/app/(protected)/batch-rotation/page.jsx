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
// pattern, but assigns a destination position + NSD per tyre and submits
// the whole set through POST /events/rotation-set as one atomic operation
// (see tyreEvents.js's createRotationSet).
//
// Picking an occupied target never forces an immediate decision about its
// occupant -- a closed rotation cycle (A->B->C->A) only works at all if you
// can assign every tyre's destination in any order, since something always
// has to go "first" and its target is always still occupied at that point.
// A displaced tyre that hasn't been given its own destination or sent to
// Spare shows a "needs destination" badge on the diagram; submission is
// blocked with a list naming exactly which tyre(s) still need resolving.
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
  const [showConflicts, setShowConflicts] = useState(false);

  // Convenience-only "send the displaced occupant to Spare right now"
  // shortcut inside the slot modal -- entirely optional; the alternative is
  // just closing this modal and clicking the occupant's own tile to give it
  // a real rotation destination.
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
    setShowConflicts(false);
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
  const slotByTyreId = Object.fromEntries((bus?.tyre_position_map || []).filter((s) => s.tyre).map((s) => [s.tyre.id, s]));
  const modalOccupant = activeSlot?.tyre && modalToPosition ? tyreByPosition[modalToPosition] : null;
  const modalOccupantResolved = !!(modalOccupant && (rotations[modalOccupant.id]?.to_position || spareDismounts[modalOccupant.id]));

  // A tyre is "displaced" once some other tyre's rotation targets its
  // current position. That's only a problem if the displaced tyre itself
  // has no plan yet (no destination of its own, not sent to Spare) -- once
  // every displaced tyre in the chain has a plan, the whole set is a valid
  // permutation and none of this blocks anything.
  function findUnresolvedConflicts() {
    const conflicts = [];
    for (const [tyreIdStr, r] of Object.entries(rotations)) {
      if (!r.to_position) continue;
      const moverId = Number(tyreIdStr);
      const occupant = tyreByPosition[r.to_position];
      if (!occupant || occupant.id === moverId) continue;
      const resolved = !!rotations[occupant.id]?.to_position || !!spareDismounts[occupant.id];
      if (!resolved) conflicts.push({ occupantId: occupant.id, occupantNumber: occupant.tyre_number, position: r.to_position });
    }
    return conflicts;
  }
  const conflicts = findUnresolvedConflicts();
  const unresolvedIds = new Set(conflicts.map((c) => c.occupantId));

  function openSlotModal(slot) {
    setActiveSlot(slot);
    setOccupantNsd('');
    setOccupantStoredAt(bus?.depot_name ? `${bus.depot_name} Store` : '');
    if (slot.tyre) {
      const existing = rotations[slot.tyre.id] || {};
      setModalToPosition(existing.to_position ?? '');
      setModalNsd(existing.nsd_value ?? '');
    }
  }

  // Re-derives the occupant's default NSD whenever the target position
  // changes while the modal is open (rather than only at open-time), so
  // picking a different occupied position mid-edit re-prefills it.
  useEffect(() => {
    if (!activeSlot?.tyre) return;
    const occ = tyreByPosition[modalToPosition];
    if (occ && occ.id !== activeSlot.tyre.id) {
      setOccupantNsd(occ.last_nsd_value != null ? String(occ.last_nsd_value) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalToPosition]);

  function closeTyreModal() {
    setActiveSlot(null);
    setModalToPosition('');
    setModalNsd('');
  }

  function saveRotation(e) {
    e.preventDefault();
    const tyreId = activeSlot.tyre.id;
    setRotations((r) => ({ ...r, [tyreId]: { to_position: modalToPosition, nsd_value: modalNsd } }));
    closeTyreModal();
  }

  function clearRotation() {
    const tyreId = activeSlot.tyre.id;
    setRotations((r) => {
      const next = { ...r };
      delete next[tyreId];
      return next;
    });
    closeTyreModal();
  }

  // Optional shortcut: resolve the displaced occupant right now instead of
  // closing this modal and clicking its own tile later.
  function sendOccupantToSpareNow() {
    if (!modalOccupant || !occupantNsd || !occupantStoredAt) return;
    setSpareDismounts((d) => ({
      ...d,
      [modalOccupant.id]: {
        nsd_value: occupantNsd,
        stored_at: occupantStoredAt,
        reason: `Bumped from ${modalToPosition} during rotation of ${activeSlot.tyre.tyre_number}`,
      },
    }));
  }

  function undoSpare(tyreId) {
    setSpareDismounts((d) => {
      const next = { ...d };
      delete next[tyreId];
      return next;
    });
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
    const needsDestination = unresolvedIds.has(slot.tyre.id);

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
        {needsDestination && <span className="reading-summary" style={{ color: 'var(--danger, #b3261e)' }}>needs destination</span>}
      </button>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setResult(null);
    setShowConflicts(false);

    if (conflicts.length > 0) {
      setShowConflicts(true);
      return;
    }

    const moves = [
      ...Object.entries(rotations)
        .filter(([, r]) => r.to_position)
        .map(([tyreId, r]) => ({
          tyre_id: Number(tyreId),
          to_position: r.to_position,
          ...(r.nsd_value !== undefined && r.nsd_value !== '' ? { nsd_value: Number(r.nsd_value) } : {}),
          reason: reason || undefined,
        })),
      ...Object.entries(spareDismounts).map(([tyreId, d]) => ({
        tyre_id: Number(tyreId),
        dismount: true,
        nsd_value: Number(d.nsd_value),
        stored_at: d.stored_at,
        reason: d.reason,
      })),
    ];

    if (moves.length === 0) {
      setError('Assign at least one tyre a new position before submitting.');
      return;
    }

    setSubmitting(true);
    try {
      // All-or-nothing: the whole set is validated as one final layout
      // before anything is written (see createRotationSet), so there's no
      // partial-success/per-item-error case left to handle here.
      const created = await api.post('/events/rotation-set', {
        bus_id: Number(busId),
        moves,
        odometer_km: odometerKm === '' ? undefined : Number(odometerKm),
      });
      setResult({ created });
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

            {showConflicts && conflicts.length > 0 && (
              <div className="error-text" style={{ marginTop: '0.75rem' }}>
                <div>These tyres are being displaced but have nowhere to go yet:</div>
                <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
                  {conflicts.map((c) => (
                    <li key={c.occupantId}>
                      <button
                        type="button"
                        onClick={() => openSlotModal(slotByTyreId[c.occupantId])}
                        style={{ padding: 0, border: 'none', background: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
                      >
                        {c.occupantNumber}
                      </button>
                      {' '}is losing position {c.position} &mdash; give it a destination or send it to Spare.
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {error && <div className="error-text" style={{ marginTop: '0.75rem' }}>{error}</div>}
            {result && (
              <div className="status-banner success" style={{ marginTop: '0.75rem' }}>
                <CheckCircle2 size={16} /> <span>{result.created.length} rotation(s) recorded.</span>
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
          {spareDismounts[activeSlot.tyre.id] ? (
            <>
              <div className="status-banner info">
                <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>This tyre is set to be sent to Spare as part of this rotation.</span>
              </div>
              <div className="form-actions">
                <button type="button" className="secondary" onClick={() => undoSpare(activeSlot.tyre.id)}>Undo Spare</button>
                <button type="button" className="secondary" onClick={closeTyreModal}>Close</button>
              </div>
            </>
          ) : (
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
              {modalOccupant && (
                <div className="status-banner info" style={{ margin: '0.5rem 0' }}>
                  <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    <strong>{modalToPosition}</strong> is currently held by <strong>{modalOccupant.tyre_number}</strong>.{' '}
                    {modalOccupantResolved
                      ? 'It already has its own move planned -- no conflict.'
                      : 'It will need a destination too before this can be submitted -- close this and click it on the diagram, or send it to Spare now below.'}
                  </span>
                </div>
              )}
              {modalOccupant && !modalOccupantResolved && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '0.75rem', margin: '0 0 0.75rem' }}>
                  <div className="field">
                    <label>{modalOccupant.tyre_number} &mdash; Current NSD</label>
                    <div className="input-suffix-wrap">
                      <input type="number" step="0.01" min="0" max="25" value={occupantNsd} onChange={(e) => setOccupantNsd(e.target.value)} />
                      <span className="input-suffix">mm</span>
                    </div>
                  </div>
                  <div className="field">
                    <label>{modalOccupant.tyre_number} &mdash; Stored At</label>
                    <input value={occupantStoredAt} onChange={(e) => setOccupantStoredAt(e.target.value)} placeholder="e.g. Depot Store Bay 2" />
                  </div>
                  <button type="button" className="secondary" disabled={!occupantNsd || !occupantStoredAt} onClick={sendOccupantToSpareNow}>
                    Send {modalOccupant.tyre_number} to Spare now
                  </button>
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
          )}
        </Modal>
      )}
    </div>
  );
}
