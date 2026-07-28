'use client';

import React, { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { formatDateTime } from '../../../lib/dates.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import { ROLES, FLEET_WIDE_ROLES } from '../../../lib/roles.js';
import PageHeader from '../../../components/PageHeader.jsx';
import EmptyState from '../../../components/EmptyState.jsx';
import LoadingState from '../../../components/LoadingState.jsx';
import Pagination from '../../../components/Pagination.jsx';
import BusSelect from '../../../components/BusSelect.jsx';

const AXES = [
  { key: 'toe', label: 'Toe' },
  { key: 'caster', label: 'Caster' },
  { key: 'camber', label: 'Camber' },
  { key: 'sai', label: 'SAI' },
];
const STATUS_OPTIONS = ['Done', 'Pending'];

function emptyMeasurements(positions) {
  const m = {};
  for (const p of positions) {
    m[p] = {};
    for (const axis of AXES) {
      m[p][`${axis.key}_before`] = '';
      m[p][`${axis.key}_after`] = '';
    }
  }
  return m;
}

// FR-WA-01: bus-scoped alignment record -- pick a depot, a bus, enter the
// job's current KM / due date / remarks, then a before/after measurement
// per axle position per the standard Toe/Caster/Camber/SAI axes, mirroring
// the Excel "Wheel Alignment" sheet's layout. Compliance (in/out of the
// GLOBAL threshold range) is computed server-side, not here.
export default function WheelAlignmentPage() {
  const { user } = useAuth();
  const canWrite = [ROLES.ADMIN, ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR].includes(user?.role);
  const isFleetWide = FLEET_WIDE_ROLES.includes(user?.role);

  const [depots, setDepots] = useState([]);
  const [depotId, setDepotId] = useState(user?.depot_id || '');
  const [busId, setBusId] = useState('');
  const [bus, setBus] = useState(null);

  const [form, setForm] = useState({ alignment_date: '', current_km: '', due_date: '', status: 'Done', remarks: '' });
  const [measurements, setMeasurements] = useState({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const [history, setHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 10;

  useEffect(() => { api.get('/depots').then(setDepots).catch(() => {}); }, []);

  useEffect(() => {
    if (!isFleetWide && user?.depot_id) setDepotId(user.depot_id);
  }, [isFleetWide, user?.depot_id]);

  useEffect(() => { setBusId(''); }, [depotId]);

  useEffect(() => {
    setBus(null);
    setMeasurements({});
    setMessage('');
    setError('');
    if (busId) {
      api.get(`/buses/${busId}`).then((b) => {
        setBus(b);
        setMeasurements(emptyMeasurements(b.position_labels || []));
      }).catch((err) => setError(err.message));
    }
  }, [busId]);

  async function loadHistory(targetPage = 1) {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ page: String(targetPage), pageSize: String(pageSize) });
      if (busId) params.set('bus_id', busId);
      else if (depotId) params.set('depot_id', depotId);
      const data = await api.get(`/wheel-alignments?${params.toString()}`);
      setHistory(data);
      setPage(targetPage);
    } catch (err) {
      setError(err.message);
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    if (depotId || busId) loadHistory(1);
    else setHistory(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depotId, busId]);

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setMeasurement(position, field, value) {
    setMeasurements((m) => ({ ...m, [position]: { ...m[position], [field]: value } }));
  }

  if (!canWrite) {
    return <div className="card error-text">Access denied. Wheel alignment logging is restricted to Tyre Supervisors, Depot Managers, and Administrators.</div>;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setMessage('');
    if (!bus) {
      setError('Select a bus first');
      return;
    }
    const measurementRows = Object.entries(measurements).map(([position, vals]) => {
      const row = { position };
      for (const axis of AXES) {
        for (const suffix of ['before', 'after']) {
          const key = `${axis.key}_${suffix}`;
          row[key] = vals[key] === '' || vals[key] == null ? null : Number(vals[key]);
        }
      }
      return row;
    });

    setSaving(true);
    try {
      await api.post('/wheel-alignments', {
        bus_id: Number(busId),
        alignment_date: form.alignment_date || undefined,
        current_km: form.current_km === '' ? null : Number(form.current_km),
        due_date: form.due_date || null,
        status: form.status,
        remarks: form.remarks || null,
        measurements: measurementRows,
      });
      setMessage('Wheel alignment record saved.');
      setMeasurements(emptyMeasurements(bus.position_labels || []));
      setForm({ alignment_date: '', current_km: '', due_date: '', status: 'Done', remarks: '' });
      loadHistory(1);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title="Wheel Alignment" description="Log per-axle Toe/Caster/Camber/SAI measurements against the standard range, and review past alignment jobs." />

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
        <div className="card-title-row"><h3>New Alignment Record</h3></div>
        {!depotId ? (
          <EmptyState title="Select a depot to begin" description="Pick a depot above, then a bus, to log an alignment job." />
        ) : !busId ? (
          <EmptyState title="Select a bus to log an alignment" description="Choose a bus from the search box above to load its axle positions." />
        ) : !bus ? (
          <LoadingState label="Loading bus..." />
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="toolbar">
              <div className="field" style={{ maxWidth: 180 }}>
                <label>Alignment Date</label>
                <input type="date" value={form.alignment_date} onChange={(e) => setField('alignment_date', e.target.value)} />
              </div>
              <div className="field" style={{ maxWidth: 160 }}>
                <label>Current KM</label>
                <input type="number" min="0" value={form.current_km} onChange={(e) => setField('current_km', e.target.value)} />
              </div>
              <div className="field" style={{ maxWidth: 180 }}>
                <label>Due Date</label>
                <input type="date" value={form.due_date} onChange={(e) => setField('due_date', e.target.value)} />
              </div>
              <div className="field" style={{ maxWidth: 140 }}>
                <label>Status</label>
                <select value={form.status} onChange={(e) => setField('status', e.target.value)}>
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label>Remarks</label>
                <input value={form.remarks} onChange={(e) => setField('remarks', e.target.value)} placeholder="e.g. all positions within range" />
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th rowSpan={2} style={{ verticalAlign: 'bottom' }}>Position</th>
                    {AXES.map((a) => <th key={a.key} colSpan={2} style={{ textAlign: 'center' }}>{a.label}</th>)}
                  </tr>
                  <tr>
                    {AXES.map((a) => (
                      <React.Fragment key={a.key}>
                        <th style={{ fontWeight: 400 }}>Before</th>
                        <th style={{ fontWeight: 400 }}>After</th>
                      </React.Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(bus.position_labels || []).map((position) => (
                    <tr key={position}>
                      <td><strong>{position}</strong></td>
                      {AXES.map((a) => (
                        <React.Fragment key={a.key}>
                          <td>
                            <input
                              type="number" step="0.01" style={{ width: 80 }}
                              value={measurements[position]?.[`${a.key}_before`] ?? ''}
                              onChange={(e) => setMeasurement(position, `${a.key}_before`, e.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              type="number" step="0.01" style={{ width: 80 }}
                              value={measurements[position]?.[`${a.key}_after`] ?? ''}
                              onChange={(e) => setMeasurement(position, `${a.key}_after`, e.target.value)}
                            />
                          </td>
                        </React.Fragment>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {error && <div className="error-text" style={{ marginTop: '0.75rem' }}>{error}</div>}
            {message && (
              <div className="status-banner success" style={{ marginTop: '0.75rem' }}>
                <CheckCircle2 size={16} /> <span>{message}</span>
              </div>
            )}
            <button type="submit" disabled={saving} style={{ marginTop: '0.75rem' }}>
              {saving ? 'Saving...' : 'Save Alignment Record'}
            </button>
          </form>
        )}
      </div>

      <div className="card">
        <div className="card-title-row"><h3>History</h3></div>
        {!depotId && !busId ? (
          <EmptyState title="Select a depot or bus above to view past alignment records" />
        ) : historyLoading ? (
          <LoadingState label="Loading history..." />
        ) : !history || history.data.length === 0 ? (
          <EmptyState title="No wheel alignment records yet" />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Bus</th>
                    <th>Package</th>
                    <th>Current KM</th>
                    <th>Due Date</th>
                    <th>Status</th>
                    <th>Compliance</th>
                    <th>Performed By</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDateTime(row.alignment_date)}</td>
                      <td>{row.bus_registration_no}</td>
                      <td>{row.package_name || '-'}</td>
                      <td>{row.current_km ?? '-'}</td>
                      <td>{row.due_date || '-'}</td>
                      <td><span className={`badge ${row.status === 'Done' ? 'badge-success' : 'badge-warning'}`}>{row.status}</span></td>
                      <td><span className={`badge ${row.compliance_overall === 'Out of Range' ? 'badge-critical' : 'badge-success'}`}>{row.compliance_overall}</span></td>
                      <td>{row.performed_by_username || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={pageSize} total={history.total} onPageChange={loadHistory} />
          </>
        )}
      </div>
    </div>
  );
}
