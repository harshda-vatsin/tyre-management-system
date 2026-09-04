'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Clock, AlertOctagon, Gauge } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { FLEET_WIDE_ROLES } from '../../../lib/roles.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import FilterBar from '../../../components/FilterBar.jsx';
import Pagination from '../../../components/Pagination.jsx';
import PageHeader from '../../../components/PageHeader.jsx';
import StatCard from '../../../components/StatCard.jsx';
import EmptyState from '../../../components/EmptyState.jsx';
import LoadingState from '../../../components/LoadingState.jsx';

const STATUS_OPTIONS = ['On Time', 'Due', 'Overdue'];
const STATUS_BADGE_CLASS = { 'On Time': 'badge-success', Due: 'badge-warning', Overdue: 'badge-critical' };

// Mirrors inspection-compliance/page.jsx exactly: "Rotation Due" and
// "Rotation Overdue" are the same underlying list filtered by status, not
// two separate pages. Compliance combines the day-based and KM-based
// rotation interval (whichever is breached first) -- computed server-side
// by rotationService.computeRotationCompliance.
export default function RotationCompliancePage() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const isFleetWide = FLEET_WIDE_ROLES.includes(user?.role);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [threshold, setThreshold] = useState(null);
  const pageSize = 10;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState(null);

  const [search, setSearch] = useState('');
  // Supports deep-linking from dashboard drill-downs (e.g. /rotation-compliance?depot_id=3).
  const [filters, setFilters] = useState({
    status: searchParams.get('status') || 'Due',
    depot_id: searchParams.get('depot_id') || '',
  });
  const [depots, setDepots] = useState([]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (filters.status) params.set('status', filters.status);
      if (filters.depot_id) params.set('depot_id', filters.depot_id);
      const data = await api.get(`/rotation-compliance?${params.toString()}`);
      setRows(data.data);
      setTotal(data.total);
      setThreshold(data.threshold);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadSummary() {
    // Reuses the existing /rotation endpoint with pageSize=1 per status to
    // get counts, rather than adding a new aggregate endpoint.
    try {
      const [onTimeRes, dueRes, overdueRes] = await Promise.all([
        api.get('/rotation-compliance?status=On Time&pageSize=1'),
        api.get('/rotation-compliance?status=Due&pageSize=1'),
        api.get('/rotation-compliance?status=Overdue&pageSize=1'),
      ]);
      const total = onTimeRes.total + dueRes.total + overdueRes.total;
      setSummary({
        onTime: onTimeRes.total,
        due: dueRes.total,
        overdue: overdueRes.total,
        rate: total > 0 ? Math.round((onTimeRes.total / total) * 100) : 100,
      });
    } catch (err) {
      // Non-fatal: summary row simply stays hidden.
    }
  }

  useEffect(() => { api.get('/depots').then(setDepots).catch(() => {}); }, []);
  useEffect(() => { loadSummary(); }, []);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters, page]);

  return (
    <div>
      <PageHeader
        title="Rotation Compliance"
        description={threshold ? `Due at ${threshold.warning_max} days since last rotation, Overdue at ${threshold.critical_max} days (or the equivalent KM-based interval, whichever comes first).` : undefined}
      />

      {summary && (
        <div className="stat-grid">
          <StatCard label="Compliant" value={summary.onTime} accent="#1a7f37" icon={CheckCircle2} />
          <StatCard label="Due" value={summary.due} accent="#9a6700" icon={Clock} />
          <StatCard label="Overdue" value={summary.overdue} accent="#b3261e" icon={AlertOctagon} />
          <StatCard label="Compliance Rate" value={`${summary.rate}%`} accent="#2563eb" icon={Gauge} />
        </div>
      )}

      <div className="card">
        <FilterBar
          search={search}
          onSearchChange={(v) => { setPage(1); setSearch(v); }}
          searchPlaceholder="Tyre number or brand"
          values={filters}
          onSelectChange={(key, value) => { setPage(1); setFilters((f) => ({ ...f, [key]: value })); }}
          selects={[
            { key: 'status', label: 'Compliance', options: STATUS_OPTIONS.map((s) => ({ value: s, label: s })) },
            ...(isFleetWide ? [{ key: 'depot_id', label: 'Depot', options: depots.map((d) => ({ value: d.id, label: d.name })) }] : []),
          ]}
        />
        {error && <div className="error-text">{error}</div>}
        {loading ? (
          <LoadingState label="Loading compliance data..." />
        ) : rows.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="No tyres match these filters" />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tyre</th>
                    <th>Brand</th>
                    <th>Bus</th>
                    <th>Depot</th>
                    <th>Last Rotation</th>
                    <th>Days Since</th>
                    <th>KM Since</th>
                    <th>Compliance</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.tyre_id}>
                      <td><Link href={`/tyres/${r.tyre_id}`}>{r.tyre_number}</Link></td>
                      <td>{r.brand}</td>
                      <td>{r.bus_registration_no ? <Link href={`/buses/${r.current_bus_id}`}>{r.bus_registration_no}</Link> : '-' }</td>
                      <td>{r.depot_name || '-'}</td>
                      <td>{r.last_rotation_date || 'Never'}</td>
                      <td>{r.days_since_last_rotation}d</td>
                      <td>{r.km_since_last_rotation != null ? `${r.km_since_last_rotation} km` : '-'}</td>
                      <td><span className={`badge ${STATUS_BADGE_CLASS[r.rotation_status]}`}>{r.rotation_status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
