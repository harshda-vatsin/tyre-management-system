'use client';

import React, { useEffect, useState } from 'react';
import { api } from '../../../lib/api.js';
import { FLEET_WIDE_ROLES } from '../../../lib/roles.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import Pagination from '../../../components/Pagination.jsx';
import PageHeader from '../../../components/PageHeader.jsx';
import Modal from '../../../components/Modal.jsx';
import EmptyState from '../../../components/EmptyState.jsx';
import LoadingState from '../../../components/LoadingState.jsx';

const ENTITY_LABELS = {
  tyre: 'Tyre',
  tyre_event: 'Tyre Event',
  user: 'User',
  alert: 'Alert',
  threshold: 'Threshold',
  depot: 'Depot',
  bus_model: 'Bus Model',
  bus: 'Bus',
};

const ACTION_BADGE = { CREATE: 'badge-success', UPDATE: 'badge-warning', DELETE: 'badge-critical', TRANSFER: 'badge-info' };

function humanizeEntity(type) {
  return ENTITY_LABELS[type] || type;
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value.includes(' ') && !value.includes('T') ? value.replace(' ', 'T') + 'Z' : value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function AuditLogPage() {
  const { user } = useAuth();
  const isAuthorized = FLEET_WIDE_ROLES.includes(user?.role);

  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 15;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [filters, setFilters] = useState({
    search: '',
    action: '',
    entityType: '',
    username: '',
    from: '',
    to: '',
  });

  const [viewEntry, setViewEntry] = useState(null);

  useEffect(() => {
    if (isAuthorized) {
      const t = setTimeout(loadLogs, 200);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthorized, filters, page]);

  async function loadLogs() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (filters.search) params.set('search', filters.search);
      if (filters.action) params.set('action', filters.action);
      if (filters.entityType) params.set('entity_type', filters.entityType);
      if (filters.username) params.set('username', filters.username);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);

      const res = await api.get(`/audit?${params.toString()}`);
      setLogs(res.data || []);
      setTotal(res.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleFilterChange(key, value) {
    setPage(1);
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function handleReset() {
    setPage(1);
    setFilters({
      search: '',
      action: '',
      entityType: '',
      username: '',
      from: '',
      to: '',
    });
  }

  function getChangedFields(beforeStr, afterStr) {
    try {
      const before = beforeStr ? JSON.parse(beforeStr) : {};
      const after = afterStr ? JSON.parse(afterStr) : {};
      const allKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
      const changes = [];
      for (const key of allKeys) {
        if (['created_at', 'updated_at'].includes(key)) continue;
        const bVal = before[key];
        const aVal = after[key];
        if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
          changes.push({
            field: key,
            before: bVal !== undefined ? JSON.stringify(bVal) : '(none)',
            after: aVal !== undefined ? JSON.stringify(aVal) : '(none)',
          });
        }
      }
      return changes;
    } catch (e) {
      return [];
    }
  }

  if (!isAuthorized) {
    return (
      <div className="card error-text">
        Access denied. Audit logs are restricted to Fleet-Wide roles.
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Audit Log" description="Every create, update, delete, and transfer performed in the system." />

      <div className="card">
        <div className="toolbar">
          <div className="field" style={{ minWidth: 160 }}>
            <label>Search</label>
            <input
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
              placeholder="User, action, entity..."
            />
          </div>
          <div className="field" style={{ minWidth: 120 }}>
            <label>Action</label>
            <select value={filters.action} onChange={(e) => handleFilterChange('action', e.target.value)}>
              <option value="">All</option>
              <option value="CREATE">CREATE</option>
              <option value="UPDATE">UPDATE</option>
              <option value="DELETE">DELETE</option>
              <option value="TRANSFER">TRANSFER</option>
            </select>
          </div>
          <div className="field" style={{ minWidth: 140 }}>
            <label>Entity Type</label>
            <select value={filters.entityType} onChange={(e) => handleFilterChange('entityType', e.target.value)}>
              <option value="">All</option>
              {Object.entries(ENTITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 120 }}>
            <label>User</label>
            <input
              value={filters.username}
              onChange={(e) => handleFilterChange('username', e.target.value)}
              placeholder="Username"
            />
          </div>
          <div className="field">
            <label>From</label>
            <input
              type="date"
              value={filters.from}
              onChange={(e) => handleFilterChange('from', e.target.value)}
            />
          </div>
          <div className="field">
            <label>To</label>
            <input
              type="date"
              value={filters.to}
              onChange={(e) => handleFilterChange('to', e.target.value)}
            />
          </div>
          <div>
            <button type="button" className="secondary" onClick={handleReset}>Reset</button>
          </div>
        </div>

        {error && <div className="error-text" style={{ marginBottom: '1rem' }}>{error}</div>}

        {loading ? (
          <LoadingState label="Loading audit logs..." />
        ) : logs.length === 0 ? (
          <EmptyState title="No audit log entries found" />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date/Time</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Entity Type</th>
                    <th>Entity ID</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr
                      key={log.id}
                      onClick={() => setViewEntry(log)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>{formatDate(log.created_at)}</td>
                      <td>{log.username}</td>
                      <td>
                        <span className={`badge ${ACTION_BADGE[log.action] || ''}`}>
                          {log.action}
                        </span>
                      </td>
                      <td>{humanizeEntity(log.entity_type)}</td>
                      <td>{log.entity_id || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={loadLogs}
            />
          </>
        )}
      </div>

      {viewEntry && (
        <Modal title={`Audit Entry Details (#${viewEntry.id})`} onClose={() => setViewEntry(null)} width={800}>
          <div className="detail-grid" style={{ marginBottom: '1.5rem' }}>
            <div><div className="detail-label">Date / Time</div><div className="detail-value">{formatDate(viewEntry.created_at)}</div></div>
            <div><div className="detail-label">User</div><div className="detail-value">{viewEntry.username} (ID: {viewEntry.user_id || 'system'})</div></div>
            <div><div className="detail-label">Action</div><div className="detail-value"><span className={`badge ${ACTION_BADGE[viewEntry.action] || ''}`}>{viewEntry.action}</span></div></div>
            <div><div className="detail-label">Entity Type</div><div className="detail-value">{humanizeEntity(viewEntry.entity_type)}</div></div>
            <div><div className="detail-label">Entity ID</div><div className="detail-value">{viewEntry.entity_id || '—'}</div></div>
          </div>

          {viewEntry.action === 'UPDATE' && (
            <div style={{ marginBottom: '1.5rem' }}>
              <h4 style={{ margin: '0 0 0.5rem 0' }}>Changed Fields</h4>
              {getChangedFields(viewEntry.before_json, viewEntry.after_json).length > 0 ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Field Name</th>
                        <th>State Before</th>
                        <th>State After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {getChangedFields(viewEntry.before_json, viewEntry.after_json).map((c) => (
                        <tr key={c.field}>
                          <td style={{ fontWeight: 600 }}>{c.field}</td>
                          <td style={{ color: 'var(--danger)', textDecoration: 'line-through' }}>{c.before}</td>
                          <td style={{ color: 'var(--success)', fontWeight: 600 }}>{c.after}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', margin: 0 }}>No record attribute modifications detected.</p>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1rem', fontSize: '0.8rem' }}>
            <div>
              <h4 style={{ margin: '0 0 0.5rem 0' }}>Before State</h4>
              <pre style={{ background: 'var(--surface-muted)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', overflowX: 'auto', maxHeight: '250px' }}>
                {viewEntry.before_json ? JSON.stringify(JSON.parse(viewEntry.before_json), null, 2) : '—'}
              </pre>
            </div>
            <div>
              <h4 style={{ margin: '0 0 0.5rem 0' }}>After State</h4>
              <pre style={{ background: 'var(--surface-muted)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', overflowX: 'auto', maxHeight: '250px' }}>
                {viewEntry.after_json ? JSON.stringify(JSON.parse(viewEntry.after_json), null, 2) : '—'}
              </pre>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
