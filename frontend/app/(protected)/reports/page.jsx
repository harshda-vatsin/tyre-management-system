'use client';

import React, { useEffect, useState } from 'react';
import { FileDown, FileSpreadsheet, Play } from 'lucide-react';
import { api, downloadFile } from '../../../lib/api.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import { FLEET_WIDE_ROLES } from '../../../lib/roles.js';
import Pagination from '../../../components/Pagination.jsx';
import PageHeader from '../../../components/PageHeader.jsx';
import EmptyState from '../../../components/EmptyState.jsx';
import LoadingState from '../../../components/LoadingState.jsx';

function buildQueryString(filters, extra = {}) {
  const params = new URLSearchParams();
  Object.entries({ ...filters, ...extra }).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, v);
  });
  return params.toString();
}

export default function ReportsPage() {
  const { user } = useAuth();
  const isFleetWide = FLEET_WIDE_ROLES.includes(user?.role);

  const [reports, setReports] = useState([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [depots, setDepots] = useState([]);
  const [buses, setBuses] = useState([]);

  const [filterValues, setFilterValues] = useState({});
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const pageSize = 15;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState('');

  useEffect(() => {
    api.get('/reports').then((data) => {
      setReports(data);
      if (data.length) setSelectedKey(data[0].key);
    });
    api.get('/depots').then(setDepots).catch(() => {});
    api.get('/buses?pageSize=200').then((r) => setBuses(r.data)).catch(() => {});
  }, []);

  const selectedReport = reports.find((r) => r.key === selectedKey);

  useEffect(() => {
    setFilterValues({});
    setResult(null);
    setError('');
    setPage(1);
  }, [selectedKey]);

  async function runReport(targetPage = 1) {
    if (!selectedReport) return;
    setLoading(true);
    setError('');
    try {
      const qs = buildQueryString(filterValues, { page: targetPage, pageSize });
      const data = await api.get(`/reports/${selectedKey}?${qs}`);
      setResult(data);
      setPage(targetPage);
    } catch (err) {
      setError(err.message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleExport(format) {
    setExporting(format);
    setError('');
    try {
      const qs = buildQueryString(filterValues);
      await downloadFile(`/reports/${selectedKey}/export?format=${format}&${qs}`, `report.${format}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting('');
    }
  }

  function setFilter(key, value) {
    setFilterValues((f) => ({ ...f, [key]: value }));
  }

  function renderFilterInput(f) {
    if (f.type === 'depot') {
      if (!isFleetWide) return null; // depot is forced server-side to the user's own depot
      return (
        <select value={filterValues[f.key] || ''} onChange={(e) => setFilter(f.key, e.target.value)}>
          <option value="">All</option>
          {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      );
    }
    if (f.type === 'bus') {
      const filteredBuses = filterValues.depot_id
        ? buses.filter((b) => Number(b.depot_id) === Number(filterValues.depot_id))
        : buses;
      return (
        <select value={filterValues[f.key] || ''} onChange={(e) => setFilter(f.key, e.target.value)}>
          <option value="">{f.required ? 'Select a bus' : 'All'}</option>
          {filteredBuses.map((b) => <option key={b.id} value={b.id}>{b.registration_no}</option>)}
        </select>
      );
    }
    if (f.type === 'select') {
      return (
        <select value={filterValues[f.key] || ''} onChange={(e) => setFilter(f.key, e.target.value)}>
          <option value="">All</option>
          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    if (f.type === 'date') {
      return <input type="date" value={filterValues[f.key] || ''} onChange={(e) => setFilter(f.key, e.target.value)} />;
    }
    if (f.type === 'number') {
      return <input type="number" min="0" value={filterValues[f.key] || ''} onChange={(e) => setFilter(f.key, e.target.value)} />;
    }
    return (
      <input
        value={filterValues[f.key] || ''}
        onChange={(e) => setFilter(f.key, e.target.value)}
        placeholder={f.required ? 'Required' : ''}
      />
    );
  }

  return (
    <div>
      <PageHeader title="Reports" description="Standard fleet reports with filterable preview and Excel/PDF export." />

      <div className="card">
        <div className="field" style={{ maxWidth: 360 }}>
          <label>Report</label>
          <select value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)}>
            {reports.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
        </div>

        {selectedReport && (
          <>
            <div className="toolbar">
              {selectedReport.filters.map((f) => {
                const input = renderFilterInput(f);
                if (!input) return null;
                return (
                  <div className="field" key={f.key} style={{ minWidth: 160 }}>
                    <label>{f.label}{f.required ? ' *' : ''}</label>
                    {input}
                  </div>
                );
              })}
              <button onClick={() => runReport(1)} disabled={loading}>
                <Play size={14} /> {loading ? 'Running...' : 'Run Report'}
              </button>
            </div>

            {result && (
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                <button className="secondary" onClick={() => handleExport('xlsx')} disabled={!!exporting}>
                  <FileSpreadsheet size={15} /> {exporting === 'xlsx' ? 'Exporting...' : 'Export Excel'}
                </button>
                <button className="secondary" onClick={() => handleExport('pdf')} disabled={!!exporting}>
                  <FileDown size={15} /> {exporting === 'pdf' ? 'Exporting...' : 'Export PDF'}
                </button>
              </div>
            )}

            {error && <div className="error-text">{error}</div>}

            {loading && <LoadingState label="Loading report..." />}

            {!loading && result && (
              result.data.length === 0 ? (
                <EmptyState title="No data matches these filters" />
              ) : (
                <>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          {selectedReport.columns.map((c) => <th key={c.key}>{c.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {result.data.map((row, i) => (
                          <tr key={i}>
                            {selectedReport.columns.map((c) => <td key={c.key}>{row[c.key] ?? '-'}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pagination page={page} pageSize={pageSize} total={result.total} onPageChange={runReport} />
                </>
              )
            )}

            {!loading && !result && !error && (
              <p style={{ color: 'var(--text-muted)' }}>Set filters and click "Run Report" to preview data.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
