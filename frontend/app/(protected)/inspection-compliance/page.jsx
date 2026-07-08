'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
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

// FR-AL-04 + milestone Frontend section: "Inspection Due View" and "Inspection
// Overdue View" are the same underlying list filtered by status, not two
// separate pages/endpoints -- consistent with how NSD/Pressure threshold
// forms were consolidated in the Master Data milestone.
export default function InspectionCompliancePage() {
  const { user } = useAuth();
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
  const [filters, setFilters] = useState({ status: 'Due', depot_id: '' });
  const [depots, setDepots] = useState([]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (filters.status) params.set('status', filters.status);
      if (filters.depot_id) params.set('depot_id', filters.depot_id);
      const data = await api.get(`/inspection-compliance?${params.toString()}`);
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
    // Reuses the existing /inspection-compliance endpoint with pageSize=1 per
    // status to get counts, rather than adding a new aggregate endpoint.
    try {
      const [onTimeRes, dueRes, overdueRes] = await Promise.all([
        api.get('/inspection-compliance?status=On Time&pageSize=1'),
        api.get('/inspection-compliance?status=Due&pageSize=1'),
        api.get('/inspection-compliance?status=Overdue&pageSize=1'),
      ]);
      const total = onTimeRes.total + dueRes.total + overdueRes.total;
      setSummary({
        onTime: onTimeRes.total,
        due: dueRes.total,
        overdue: overdueRes.total,
        rate: total > 0 ? Math.round((onTimeRes.total / total) * 100) : 100,
      });
    } catch (err) {
      // Non-fatal — summary row simply stays hidden.
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
        title="Inspection Compliance"
        description={threshold ? `Due at ${threshold.warning_max} days since last reading, Overdue at ${threshold.critical_max} days (global inspection interval).` : undefined}
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
                    <th>Last Reading</th>
                    <th>Days Since</th>
                    <th>Compliance</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.tyre_id}>
                      <td><Link href={`/tyres/${r.tyre_id}`}>{r.tyre_number}</Link></td>
                      <td>{r.brand}</td>
                      <td>{r.bus_registration_no ? <Link href={`/buses/${r.current_bus_id}`}>{r.bus_registration_no}</Link> : '—'}</td>
                      <td>{r.depot_name || '—'}</td>
                      <td>{r.last_reading_date || 'Never'}</td>
                      <td>{r.days_since_last_reading}d</td>
                      <td><span className={`badge ${STATUS_BADGE_CLASS[r.inspection_status]}`}>{r.inspection_status}</span></td>
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
