'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Search, Info } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import { useSettings } from '../../../components/SettingsContext.jsx';
import { formatPressure, psiToKpa, kpaToPsi } from '../../../lib/units.js';
import { ROLES, FLEET_WIDE_ROLES } from '../../../lib/roles.js';
import PageHeader from '../../../components/PageHeader.jsx';
import EmptyState from '../../../components/EmptyState.jsx';
import LoadingState from '../../../components/LoadingState.jsx';
import Modal from '../../../components/Modal.jsx';
import BusTyreDiagram from '../../../components/BusTyreDiagram.jsx';
import BusSelect from '../../../components/BusSelect.jsx';

// FR-RW-01: supervisor selects a depot, then a bus, the app shows every
// mounted tyre position on a schematic bus diagram, and one submission
// creates the individual NSD/Pressure events.
export default function BatchInspectionPage() {
  const { user } = useAuth();
  const canWrite = [ROLES.ADMIN, ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR].includes(user?.role);
  const isFleetWide = FLEET_WIDE_ROLES.includes(user?.role);

  const [depots, setDepots] = useState([]);
  const [depotId, setDepotId] = useState(user?.depot_id || '');

  const [busId, setBusId] = useState('');
  const [bus, setBus] = useState(null);
  const [readings, setReadings] = useState({});
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Search-to-highlight within the bus diagram (position code or tyre
  // number), and the click-to-enter popup state for a single tyre.
  const [tyreSearch, setTyreSearch] = useState('');
  const [activeSlot, setActiveSlot] = useState(null);
  const [modalNsd, setModalNsd] = useState('');
  const [modalPressure, setModalPressure] = useState('');

  // FR-RW-02: resolved once per bus (not per keystroke) so the modal can show
  // an immediate inline warning as a value is typed, mirroring the same
  // DEPOT/BUS_MODEL-override-then-GLOBAL bounds the server evaluates against.
  const [nsdThreshold, setNsdThreshold] = useState(null);
  const [pressureThreshold, setPressureThreshold] = useState(null);

  useEffect(() => {
    api.get('/depots').then(setDepots).catch(() => {});
  }, []);

  // Depot-scoped roles (Depot Manager, Tyre Supervisor) are locked to their
  // own depot -- the backend already enforces this on every /buses request,
  // this just keeps the UI from offering a choice that would be ignored.
  useEffect(() => {
    if (!isFleetWide && user?.depot_id) setDepotId(user.depot_id);
  }, [isFleetWide, user?.depot_id]);

  // Depot change invalidates whatever bus was selected -- BusSelect resets
  // its own search state internally when depotId changes.
  useEffect(() => {
    setBusId('');
  }, [depotId]);

  useEffect(() => {
    setBus(null);
    setReadings({});
    setResult(null);
    setError('');
    setTyreSearch('');
    setNsdThreshold(null);
    setPressureThreshold(null);
    if (busId) {
      api.get(`/buses/${busId}`).then(setBus).catch((err) => setError(err.message));
    }
  }, [busId]);

  useEffect(() => {
    if (!bus) return;
    api.get(`/thresholds/resolve?parameter_type=NSD&depot_id=${bus.depot_id}`).then(setNsdThreshold).catch(() => {});
    api.get(`/thresholds/resolve?parameter_type=PRESSURE&bus_model_id=${bus.bus_model_id}`).then(setPressureThreshold).catch(() => {});
  }, [bus]);

  function setReading(tyreId, field, value) {
    setReadings((r) => ({ ...r, [tyreId]: { ...r[tyreId], [field]: value } }));
  }

  // Mirrors backend/src/utils/thresholdEngine.js evaluateNsd/evaluatePressure
  // exactly, so the inline hint the supervisor sees while typing matches what
  // the server will actually flag on submit.
  function evaluateNsd(value, threshold) {
    if (!threshold || value === '' || value === undefined) return null;
    const v = Number(value);
    if (threshold.critical_max != null && v <= threshold.critical_max) return 'CRITICAL';
    if (threshold.warning_max != null && v <= threshold.warning_max) return 'WARNING';
    return 'OK';
  }

  function evaluatePressure(value, threshold) {
    if (!threshold || value === '' || value === undefined) return null;
    const v = Number(value);
    const breachesCritical =
      (threshold.critical_min != null && v < threshold.critical_min) ||
      (threshold.critical_max != null && v > threshold.critical_max);
    if (breachesCritical) return 'CRITICAL';
    const breachesWarning =
      (threshold.warning_min != null && v < threshold.warning_min) ||
      (threshold.warning_max != null && v > threshold.warning_max);
    if (breachesWarning) return 'WARNING';
    return 'OK';
  }

  const nsdFlag = evaluateNsd(modalNsd, nsdThreshold);
  const pressureFlag = evaluatePressure(modalPressure, pressureThreshold);

  // Handles both a mounted tyre (opens the NSD/Pressure form, pre-filled with
  // whatever's already entered) and an empty position (no tyre to attach a
  // reading to -- the modal shows that explicitly instead of doing nothing,
  // per the earlier "clicking an empty position looked broken" report).
  function openSlotModal(slot) {
    setActiveSlot(slot);
    if (slot.tyre) {
      const existing = readings[slot.tyre.id] || {};
      setModalNsd(existing.nsd_value ?? '');
      setModalPressure(existing.pressure_value ?? '');
    }
  }

  function closeTyreModal() {
    setActiveSlot(null);
    setModalNsd('');
    setModalPressure('');
  }

  function saveTyreReading(e) {
    e.preventDefault();
    setReading(activeSlot.tyre.id, 'nsd_value', modalNsd);
    setReading(activeSlot.tyre.id, 'pressure_value', modalPressure);
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

    const reading = readings[slot.tyre.id];
    const hasReading = !!reading && (reading.nsd_value !== undefined && reading.nsd_value !== '' || reading.pressure_value !== undefined && reading.pressure_value !== '');

    return (
      <button
        type="button"
        key={slot.position}
        className={`bus-diagram-tyre${hasReading ? ' has-reading' : ''}${isHighlighted ? ' highlighted' : ''}`}
        onClick={() => openSlotModal(slot)}
      >
        <span className="position-code">{slot.position}</span>
        <span className="tyre-number">{slot.tyre.tyre_number}</span>
        {hasReading && (
          <span className="reading-summary">
            {reading.nsd_value !== '' && reading.nsd_value !== undefined ? `${reading.nsd_value}mm` : ''}
            {reading.nsd_value && reading.pressure_value ? ' / ' : ''}
            {reading.pressure_value !== '' && reading.pressure_value !== undefined ? `${reading.pressure_value}psi` : ''}
          </span>
        )}
      </button>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setResult(null);

    const entries = Object.entries(readings)
      .map(([tyreId, vals]) => ({
        tyre_id: Number(tyreId),
        ...(vals.nsd_value !== undefined && vals.nsd_value !== '' ? { nsd_value: Number(vals.nsd_value) } : {}),
        ...(vals.pressure_value !== undefined && vals.pressure_value !== '' ? { pressure_value: Number(vals.pressure_value) } : {}),
      }))
      .filter((r) => r.nsd_value !== undefined || r.pressure_value !== undefined);

    if (entries.length === 0) {
      setError('Enter at least one NSD or Pressure reading before submitting.');
      return;
    }

    setSubmitting(true);
    try {
      const data = await api.post('/events/batch', { bus_id: Number(busId), readings: entries });
      setResult(data);
      setReadings({});
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!canWrite) {
    return <div className="card error-text">Access denied. Batch inspection is restricted to Tyre Supervisors, Depot Managers, and Administrators.</div>;
  }

  const mountedSlots = bus ? bus.tyre_position_map.filter((slot) => slot.tyre) : [];
  const step1Done = !!depotId;
  const step2Done = !!busId;
  const step3Done = !!result;

  return (
    <div>
      <PageHeader title="Batch Inspection" description="Click a tyre on the bus diagram to enter its NSD and/or pressure reading, then submit the whole bus in one session." />

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
          <span className="step-indicator-num">3</span> Review Tyres
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
            <BusSelect value={busId} onChange={(bus) => setBusId(bus ? bus.id : '')} depotId={depotId} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row"><h3>Review Tyres</h3></div>

        {!depotId ? (
          <EmptyState title="Select a depot to begin" description="Pick a depot above, then a bus, to review its mounted tyres." />
        ) : !busId ? (
          <EmptyState title="Select a bus to review its tyres" description="Choose a bus from the dropdown above to load its tyre position map." />
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
                  placeholder="e.g. RL-O or TYR-0003"
                  style={{ paddingLeft: '2rem' }}
                />
              </div>
            </div>

            <BusTyreDiagram positionMap={bus.tyre_position_map} renderTyre={renderTyreButton} />

            {mountedSlots.length === 0 && (
              <p style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '-0.5rem' }}>
                No tyres are mounted on this bus yet. Mount tyres via Log Event or the Tyres page to record readings here.
              </p>
            )}

            {error && <div className="error-text" style={{ marginTop: '0.75rem' }}>{error}</div>}
            {result && (
              <div style={{ marginTop: '0.75rem' }}>
                <div className="status-banner success">
                  <CheckCircle2 size={16} /> <span>{result.created.length} event(s) recorded.</span>
                </div>
                {result.errors.length > 0 && (
                  <div className="error-text">
                    {result.errors.map((e, i) => <div key={i}>Tyre {e.tyre_id}: {e.error}</div>)}
                  </div>
                )}
              </div>
            )}
            <button type="submit" disabled={submitting || mountedSlots.length === 0} style={{ marginTop: '0.75rem' }}>
              {submitting ? 'Submitting...' : 'Submit Batch'}
            </button>
          </form>
        )}
      </div>

      {activeSlot && !activeSlot.tyre && (
        <Modal title={`Position ${activeSlot.position} (Empty)`} onClose={closeTyreModal} width={380}>
          <div className="status-banner info">
            <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>No tyre is currently mounted at position {activeSlot.position}, so there's nothing to log a reading against yet.</span>
          </div>
          <p style={{ marginTop: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            Mount a tyre here first via <strong>Log Event</strong> (Tyre Replacement) or the <strong>Tyres</strong> page, then come back to record its NSD/pressure reading.
          </p>
          <div className="form-actions">
            <Link href="/log-event"><button type="button">Go to Log Event</button></Link>
            <button type="button" className="secondary" onClick={closeTyreModal}>Close</button>
          </div>
        </Modal>
      )}

      {activeSlot && activeSlot.tyre && (
        <Modal title={`${activeSlot.position} : ${activeSlot.tyre.tyre_number}`} onClose={closeTyreModal} width={380}>
          <form onSubmit={saveTyreReading}>
            <div className="field">
              <label>NSD Value</label>
              <div className="input-suffix-wrap">
                <input
                  type="number" step="0.1" min="0" max="25" autoFocus
                  value={modalNsd}
                  onChange={(e) => setModalNsd(e.target.value)}
                  style={nsdFlag === 'CRITICAL' ? { borderColor: 'var(--danger)' } : nsdFlag === 'WARNING' ? { borderColor: 'var(--warning)' } : undefined}
                />
                <span className="input-suffix">mm</span>
              </div>
              {(nsdFlag === 'WARNING' || nsdFlag === 'CRITICAL') && (
                <span className={nsdFlag === 'CRITICAL' ? 'error-text' : 'field-hint'} style={nsdFlag === 'WARNING' ? { color: 'var(--warning)' } : undefined}>
                  {nsdFlag === 'CRITICAL' ? 'Critical: ' : 'Warning: '}
                  at or below the {nsdFlag === 'CRITICAL' ? nsdThreshold.critical_max : nsdThreshold.warning_max}mm threshold.
                </span>
              )}
            </div>
            <div className="field">
              <label>Pressure Value</label>
              <div className="input-suffix-wrap">
                <input
                  type="number" step="0.1" min="0" max="200"
                  value={modalPressure}
                  onChange={(e) => setModalPressure(e.target.value)}
                  style={pressureFlag === 'CRITICAL' ? { borderColor: 'var(--danger)' } : pressureFlag === 'WARNING' ? { borderColor: 'var(--warning)' } : undefined}
                />
                <span className="input-suffix">psi</span>
              </div>
              {(pressureFlag === 'WARNING' || pressureFlag === 'CRITICAL') && (
                <span className={pressureFlag === 'CRITICAL' ? 'error-text' : 'field-hint'} style={pressureFlag === 'WARNING' ? { color: 'var(--warning)' } : undefined}>
                  {pressureFlag === 'CRITICAL' ? 'Critical: ' : 'Warning: '}
                  outside the safe {(pressureFlag === 'CRITICAL' ? pressureThreshold.critical_min : pressureThreshold.warning_min) ?? '-'} to {(pressureFlag === 'CRITICAL' ? pressureThreshold.critical_max : pressureThreshold.warning_max) ?? '-'} psi range.
                </span>
              )}
            </div>
            <div className="form-actions">
              <button type="submit">Save Reading</button>
              <button type="button" className="secondary" onClick={closeTyreModal}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
