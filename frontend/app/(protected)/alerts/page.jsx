'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, Clock, CheckCircle2, Flame } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import { ROLES, FLEET_WIDE_ROLES } from '../../../lib/roles.js';
import FilterBar from '../../../components/FilterBar.jsx';
import Pagination from '../../../components/Pagination.jsx';
import Modal from '../../../components/Modal.jsx';
import PageHeader from '../../../components/PageHeader.jsx';
import StatCard from '../../../components/StatCard.jsx';
import EmptyState from '../../../components/EmptyState.jsx';
import LoadingState from '../../../components/LoadingState.jsx';
import { SeverityBadge, StatusBadge, EscalatedBadge } from '../../../components/AlertBadges.jsx';

const STATUS_OPTIONS = ['Open', 'Acknowledged', 'Resolved'];
const SEVERITY_OPTIONS = ['Warning', 'Critical'];
const PARAMETER_OPTIONS = [
  { value: 'NSD', label: 'NSD' },
  { value: 'PRESSURE', label: 'Pressure' },
  { value: 'INSPECTION', label: 'Inspection' },
];

export default function AlertsPage() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const canWrite = [ROLES.ADMIN, ROLES.NATIONAL_FLEET_MANAGER, ROLES.DEPOT_MANAGER].includes(user?.role);
  const isFleetWide = FLEET_WIDE_ROLES.includes(user?.role);

  const [alerts, setAlerts] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState(null);

  // Supports deep-linking from dashboard drill-downs (e.g. /alerts?depot_id=3&status=Open).
  const [filters, setFilters] = useState({
    search: searchParams.get('search') || '',
    status: searchParams.get('status') || '',
    severity: searchParams.get('severity') || '',
    parameter_type: searchParams.get('parameter_type') || '',
    escalated: searchParams.get('escalated') || '',
    depot_id: searchParams.get('depot_id') || '',
  });
  const [depots, setDepots] = useState([]);

  const hasActiveFilters = Object.values(filters).some((v) => v !== '');

  const [resolveTarget, setResolveTarget] = useState(null);
  const [resolveNote, setResolveNote] = useState('');
  const [resolveError, setResolveError] = useState('');

  const [viewTarget, setViewTarget] = useState(null);
  const [detailAlert, setDetailAlert] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  async function handleViewDetails(id) {
    setViewTarget(id);
    setDetailAlert(null);
    setDetailLoading(true);
    setDetailError('');
    try {
      const data = await api.get(`/alerts/${id}`);
      setDetailAlert(data);
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setDetailLoading(false);
    }
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
      const data = await api.get(`/alerts?${params.toString()}`);
      setAlerts(data.data);
      setTotal(data.total);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadSummary() {
    // Reuses the existing /alerts list endpoint (which already returns a
    // `total` independent of pageSize) with different status/severity
    // filters instead of adding a new backend aggregate endpoint.
    try {
      const [openRes, ackRes, resolvedRes, criticalRes] = await Promise.all([
        api.get('/alerts?status=Open&pageSize=1'),
        api.get('/alerts?status=Acknowledged&pageSize=1'),
        api.get('/alerts?status=Resolved&pageSize=1'),
        api.get('/alerts?status=Open&severity=Critical&pageSize=1'),
      ]);
      setSummary({
        open: openRes.total,
        acknowledged: ackRes.total,
        resolved: resolvedRes.total,
        critical: criticalRes.total,
      });
    } catch (err) {
      // Non-fatal: summary row simply stays hidden.
    }
  }

  useEffect(() => { api.get('/depots').then(setDepots).catch(() => {}); }, []);
  useEffect(() => { loadSummary(); }, []);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page]);

  async function handleAcknowledge(id) {
    setError('');
    try {
      await api.patch(`/alerts/${id}/acknowledge`);
      await load();
      await loadSummary();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleResolve(e) {
    e.preventDefault();
    setResolveError('');
    try {
      await api.patch(`/alerts/${resolveTarget.id}/resolve`, { resolution_note: resolveNote });
      setResolveTarget(null);
      setResolveNote('');
      await load();
      await loadSummary();
    } catch (err) {
      setResolveError(err.message);
    }
  }

  return (
    <div>
      <PageHeader title="Alerts" description="Threshold breaches and inspection overdue alerts across the fleet." />

      {summary && (
        <div className="stat-grid">
          <StatCard label="Open" value={summary.open} accent="#475467" icon={AlertTriangle} />
          <StatCard label="Acknowledged" value={summary.acknowledged} accent="#1d4ed8" icon={Clock} />
          <StatCard label="Resolved" value={summary.resolved} accent="#1a7f37" icon={CheckCircle2} />
          <StatCard label="Critical (Open)" value={summary.critical} accent="#b3261e" icon={Flame} />
        </div>
      )}

      <div className="card">
        <FilterBar
          search={filters.search || ''}
          onSearchChange={(value) => { setPage(1); setFilters((f) => ({ ...f, search: value })); }}
          searchPlaceholder="Search tyre or bus..."
          values={filters}
          onSelectChange={(key, value) => { setPage(1); setFilters((f) => ({ ...f, [key]: value })); }}
          selects={[
            { key: 'status', label: 'Status', options: STATUS_OPTIONS.map((s) => ({ value: s, label: s })) },
            { key: 'severity', label: 'Severity', options: SEVERITY_OPTIONS.map((s) => ({ value: s, label: s })) },
            { key: 'parameter_type', label: 'Parameter', options: PARAMETER_OPTIONS },
            { key: 'escalated', label: 'Escalated', options: [{ value: 'true', label: 'Escalated only' }] },
            ...(isFleetWide ? [{ key: 'depot_id', label: 'Depot', options: depots.map((d) => ({ value: d.id, label: d.name })) }] : []),
          ]}
        />
        {error && <div className="error-text">{error}</div>}
        {loading ? (
          <LoadingState label="Loading alerts..." />
        ) : alerts.length === 0 ? (
          hasActiveFilters ? (
            <EmptyState
              icon={CheckCircle2}
              title="No alerts match these filters"
              description="Try resetting your filters or search query to find other alerts."
              action={
                <button
                  className="secondary"
                  onClick={() => {
                    setPage(1);
                    setFilters({
                      search: '',
                      status: '',
                      severity: '',
                      parameter_type: '',
                      escalated: '',
                      depot_id: '',
                    });
                  }}
                >
                  Reset Filters
                </button>
              }
            />
          ) : (
            <EmptyState
              icon={CheckCircle2}
              title="All systems normal"
              description={
                isFleetWide
                  ? "There are no active or historical threshold breaches across the fleet. Every tyre is within its safe operating limits."
                  : "There are no active or historical threshold breaches for tyres in your assigned depot."
              }
              action={
                canWrite && (
                  <Link href="/log-event">
                    <button type="button">Log Tyre Event</button>
                  </Link>
                )
              }
            />
          )
        ) : (
          <>
            <div className="table-wrap desktop-only">
              <table>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Status</th>
                    <th>Parameter</th>
                    <th>Tyre</th>
                    <th>Bus</th>
                    <th>Depot</th>
                    <th>Reading / Threshold</th>
                    <th>Age</th>
                    {canWrite && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => handleViewDetails(a.id)}
                      style={{ cursor: 'pointer' }}
                      className={a.severity === 'Critical' && a.status !== 'Resolved' ? 'row-accent-critical' : ''}
                    >
                      <td><SeverityBadge severity={a.severity} /> <EscalatedBadge isEscalated={a.is_escalated} /></td>
                      <td><StatusBadge status={a.status} /></td>
                      <td>{a.parameter_type}</td>
                      <td><Link href={`/tyres/${a.tyre_id}`} onClick={(e) => e.stopPropagation()}>{a.tyre_number}</Link></td>
                      <td>{a.bus_registration_no || '-'}</td>
                      <td>{a.depot_name || '-'}</td>
                      <td>{a.reading_value ?? '-'} / {a.threshold_value ?? '-'}</td>
                      <td>{a.age_days}d</td>
                      {canWrite && (
                        <td>
                          <div style={{ display: 'flex', gap: '0.4rem' }}>
                            <Link href={`/alerts/${a.id}`} onClick={(e) => e.stopPropagation()}>View</Link>
                            {a.status === 'Open' && (
                              <button className="secondary" style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }} onClick={(e) => { e.stopPropagation(); handleAcknowledge(a.id); }}>Acknowledge</button>
                            )}
                            {a.status !== 'Resolved' && (
                              <button style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }} onClick={(e) => { e.stopPropagation(); setResolveTarget(a); }}>Resolve</button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mobile-list-cards mobile-only">
              {alerts.map((a) => (
                <div
                  key={a.id}
                  className={`mobile-record-card ${a.severity === 'Critical' && a.status !== 'Resolved' ? 'row-accent-critical' : ''}`}
                  onClick={() => handleViewDetails(a.id)}
                  style={{ cursor: 'pointer', borderLeft: a.severity === 'Critical' && a.status !== 'Resolved' ? '4px solid var(--danger)' : undefined }}
                >
                  <div className="mobile-card-row mobile-card-header">
                    <span className="mobile-card-title">{a.parameter_type} Alert</span>
                    <span className="mobile-card-value">Age: {a.age_days}d</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Tyre / Bus</span>
                    <span className="mobile-card-value">
                      <Link href={`/tyres/${a.tyre_id}`} onClick={(e) => e.stopPropagation()}>{a.tyre_number}</Link>
                      {a.bus_registration_no ? ` / ${a.bus_registration_no}` : ''}
                    </span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Depot</span>
                    <span className="mobile-card-value">{a.depot_name || '-'}</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Reading / Threshold</span>
                    <span className="mobile-card-value">{a.reading_value ?? '-'} / {a.threshold_value ?? '-'}</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Status & Severity</span>
                    <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                      <SeverityBadge severity={a.severity} />
                      <StatusBadge status={a.status} />
                      <EscalatedBadge isEscalated={a.is_escalated} />
                    </div>
                  </div>
                  {canWrite && (
                    <div className="mobile-card-footer" onClick={(e) => e.stopPropagation()}>
                      <Link href={`/alerts/${a.id}`} className="btn secondary" style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}>View Details</Link>
                      {a.status === 'Open' && (
                        <button className="secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => handleAcknowledge(a.id)}>Acknowledge</button>
                      )}
                      {a.status !== 'Resolved' && (
                        <button style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setResolveTarget(a)}>Resolve</button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
          </>
        )}
      </div>

      {resolveTarget && (
        <Modal title={`Resolve Alert: ${resolveTarget.tyre_number} / ${resolveTarget.parameter_type}`} onClose={() => setResolveTarget(null)}>
          <form onSubmit={handleResolve}>
            <div className="field">
              <label>Resolution Note (required)</label>
              <input value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} required />
            </div>
            {resolveError && <div className="error-text">{resolveError}</div>}
            <div className="form-actions">
              <button type="submit">Resolve</button>
              <button type="button" className="secondary" onClick={() => setResolveTarget(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {viewTarget && (
        <Modal title={`Alert Details: #${viewTarget}`} onClose={() => { setViewTarget(null); setDetailAlert(null); }}>
          {detailLoading && <LoadingState label="Loading details..." />}
          {detailError && <p className="error-text">{detailError}</p>}
          {detailAlert && (
            <div className="detail-grid">
              <div><div className="detail-label">Severity</div><div className="detail-value"><SeverityBadge severity={detailAlert.severity} /> <EscalatedBadge isEscalated={detailAlert.is_escalated} /></div></div>
              <div><div className="detail-label">Status</div><div className="detail-value"><StatusBadge status={detailAlert.status} /></div></div>
              <div><div className="detail-label">Parameter</div><div className="detail-value">{detailAlert.parameter_type}</div></div>
              <div><div className="detail-label">Tyre</div><div className="detail-value">{detailAlert.tyre_number}</div></div>
              <div><div className="detail-label">Bus</div><div className="detail-value">{detailAlert.bus_registration_no || '-'}</div></div>
              <div><div className="detail-label">Depot</div><div className="detail-value">{detailAlert.depot_name || '-'}</div></div>
              <div><div className="detail-label">Reading / Threshold</div><div className="detail-value">{detailAlert.reading_value ?? '-'} / {detailAlert.threshold_value ?? '-'}</div></div>
              <div><div className="detail-label">Resolved At</div><div className="detail-value">{detailAlert.resolved_at || '-'}</div></div>
              <div><div className="detail-label">Resolved By</div><div className="detail-value">{detailAlert.resolved_at ? (detailAlert.resolved_by_username || 'System') : '-'}</div></div>
              <div style={{ gridColumn: '1 / -1' }}><div className="detail-label">Resolution Note</div><div className="detail-value">{detailAlert.resolution_note || '-'}</div></div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
