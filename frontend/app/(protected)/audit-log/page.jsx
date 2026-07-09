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
import {
  formatAuditEntry,
  formatFieldLabel,
  formatValue,
  humanizeEventType,
  humanizePosition,
  ACTION_LABELS,
} from '../../../lib/auditFormatter.js';

const ENTITY_LABELS = {
  tyre: 'Tyre',
  bus: 'Bus',
  depot: 'Depot',
  tyre_event: 'Tyre event',
  threshold: 'Threshold',
  user: 'User',
  system_setting: 'System setting',
};

const ACTION_BADGE = {
  CREATE: 'badge-success',
  UPDATE: 'badge-warning',
  DELETE: 'badge-critical',
  TRANSFER: 'badge-info',
  AMEND_EVENT: 'badge-warning',
};

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
      const formattedRows = (res.data || []).map(formatAuditEntry);
      
      setLogs(formattedRows);
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

  function getChangedFieldsList(before, after) {
    if (!before || !after) return [];
    try {
      const allKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
      const changes = [];
      for (const key of allKeys) {
        if (['created_at', 'updated_at', 'updated_by', 'id'].includes(key)) continue;
        const bVal = before[key];
        const aVal = after[key];
        if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
          changes.push({
            field: key,
            before: bVal,
            after: aVal,
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

  function renderModalDetails(log) {
    const { action, entity_type, before, after } = log;

    // Threshold modification
    if (entity_type === 'threshold') {
      const isOverride = (after?.scope_type || before?.scope_type) === 'DEPOT';
      return (
        <div style={{ marginBottom: '1rem' }}>
          <div className="form-section-title">Threshold Adjustment Details</div>
          <div className="detail-grid" style={{ gap: '1rem 1.5rem' }}>
            <div><div className="detail-label">Threshold Parameter</div><div className="detail-value">{after?.parameter_type || before?.parameter_type}</div></div>
            <div><div className="detail-label">Scope</div><div className="detail-value">{isOverride ? 'Depot Override' : 'Global'}</div></div>
            {isOverride && (
              <div><div className="detail-label">Depot</div><div className="detail-value">{after?.depot_name || before?.depot_name || `Depot ID: ${after?.scope_id || before?.scope_id}`}</div></div>
            )}
            <div><div className="detail-label">Previous Value</div><div className="detail-value" style={{ color: 'var(--text-danger)', fontWeight: 600 }}>
              {before ? `${before.warning_max || before.warning_min || '—'} ${before.unit || ''}` : 'Not set'}
            </div></div>
            <div><div className="detail-label">New Value</div><div className="detail-value" style={{ color: 'var(--text-success)', fontWeight: 600 }}>
              {after ? `${after.warning_max || after.warning_min || '—'} ${after.unit || ''}` : 'Not set'}
            </div></div>
            {action === 'UPDATE' && before && after && (
              <div style={{ gridColumn: '1 / -1', marginTop: '0.5rem' }}>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Setting Type</th>
                        <th>Previous Value</th>
                        <th>New Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {before.warning_min !== after.warning_min && (
                        <tr>
                          <td>Warning Limit (Min)</td>
                          <td>{formatValue('warning_min', before.warning_min, before)}</td>
                          <td style={{ color: 'var(--text-success)', fontWeight: 600 }}>{formatValue('warning_min', after.warning_min, after)}</td>
                        </tr>
                      )}
                      {before.warning_max !== after.warning_max && (
                        <tr>
                          <td>Warning Limit (Max)</td>
                          <td>{formatValue('warning_max', before.warning_max, before)}</td>
                          <td style={{ color: 'var(--text-success)', fontWeight: 600 }}>{formatValue('warning_max', after.warning_max, after)}</td>
                        </tr>
                      )}
                      {before.critical_min !== after.critical_min && (
                        <tr>
                          <td>Critical Limit (Min)</td>
                          <td>{formatValue('critical_min', before.critical_min, before)}</td>
                          <td style={{ color: 'var(--text-success)', fontWeight: 600 }}>{formatValue('critical_min', after.critical_min, after)}</td>
                        </tr>
                      )}
                      {before.critical_max !== after.critical_max && (
                        <tr>
                          <td>Critical Limit (Max)</td>
                          <td>{formatValue('critical_max', before.critical_max, before)}</td>
                          <td style={{ color: 'var(--text-success)', fontWeight: 600 }}>{formatValue('critical_max', after.critical_max, after)}</td>
                        </tr>
                      )}
                      {before.is_active !== after.is_active && (
                        <tr>
                          <td>Active Status</td>
                          <td>{before.is_active ? 'Active' : 'Inactive'}</td>
                          <td style={{ color: after.is_active ? 'var(--text-success)' : 'var(--text-danger)', fontWeight: 600 }}>
                            {after.is_active ? 'Active' : 'Inactive'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    if (action === 'TRANSFER') {
      return (
        <div style={{ marginBottom: '1.5rem' }}>
          <div className="form-section-title">Transfer Details</div>
          <div className="detail-grid" style={{ gap: '1rem 1.5rem' }}>
            <div>
              <div className="detail-label">From Depot</div>
              <div className="detail-value" style={{ color: 'var(--text-danger)', fontWeight: 600 }}>
                {formatValue('from_depot_id', before?.from_depot_id, before)}
              </div>
            </div>
            <div>
              <div className="detail-label">To Depot</div>
              <div className="detail-value" style={{ color: 'var(--text-success)', fontWeight: 600 }}>
                {formatValue('to_depot_id', after?.to_depot_id, after)}
              </div>
            </div>
            {before?.from_bus_id && (
              <>
                <div>
                  <div className="detail-label">From Bus / Position</div>
                  <div className="detail-value">{formatValue('from_bus_id', before.from_bus_id, before)} / {humanizePosition(before.from_position)}</div>
                </div>
                <div>
                  <div className="detail-label">To Bus / Position</div>
                  <div className="detail-value">{formatValue('to_bus_id', after.to_bus_id, after)} / {humanizePosition(after.to_position)}</div>
                </div>
              </>
            )}
            {after?.reason && (
              <div style={{ gridColumn: '1 / -1' }}>
                <div className="detail-label">Reason</div>
                <div className="detail-value" style={{ fontStyle: 'italic' }}>{after.reason}</div>
              </div>
            )}
          </div>
        </div>
      );
    }

    if (action === 'AMEND_EVENT') {
      const corrVals = after?.corrected_values || {};
      const originalVals = before || {};
      return (
        <div style={{ marginBottom: '1.5rem' }}>
          <div className="form-section-title">Event Correction Details</div>
          <div style={{ marginBottom: '1rem' }}>
            <div className="detail-label">Reason for Amendment</div>
            <div className="detail-value" style={{ padding: '0.5rem', background: 'var(--surface-muted)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--primary)', fontStyle: 'italic' }}>
              {after?.reason || 'No reason provided'}
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Field Name</th>
                  <th>Original Value</th>
                  <th>Amended Value</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(corrVals).map((field) => (
                  <tr key={field}>
                    <td style={{ fontWeight: 600 }}>{formatFieldLabel(field)}</td>
                    <td>{formatValue(field, originalVals[field], originalVals)}</td>
                    <td style={{ color: 'var(--text-success)', fontWeight: 600 }}>
                      {formatValue(field, corrVals[field], corrVals)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    if (action === 'CREATE') {
      const fields = Object.entries(after || {}).filter(([key, val]) => {
        return !['id', 'created_at', 'updated_at', 'updated_by', 'before_json', 'after_json'].includes(key) && val !== null && val !== undefined && val !== '';
      });

      return (
        <div style={{ marginBottom: '1rem' }}>
          <div className="form-section-title">Created Item Details</div>
          <div className="detail-grid" style={{ gap: '0.85rem 1.5rem' }}>
            {fields.map(([key, value]) => (
              <div key={key}>
                <div className="detail-label">{formatFieldLabel(key)}</div>
                <div className="detail-value">{formatValue(key, value, after)}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (action === 'DELETE') {
      const fields = Object.entries(before || {}).filter(([key, val]) => {
        return !['id', 'created_at', 'updated_at', 'updated_by'].includes(key) && val !== null && val !== undefined && val !== '';
      });

      return (
        <div style={{ marginBottom: '1rem' }}>
          <div className="form-section-title">Deactivated Item Details</div>
          <div className="detail-grid" style={{ gap: '0.85rem 1.5rem' }}>
            {fields.map(([key, value]) => (
              <div key={key}>
                <div className="detail-label">{formatFieldLabel(key)}</div>
                <div className="detail-value">{formatValue(key, value, before)}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (action === 'UPDATE') {
      const changes = getChangedFieldsList(before, after);
      return (
        <div style={{ marginBottom: '1rem' }}>
          <div className="form-section-title">Modified Properties</div>
          {changes.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Property Name</th>
                    <th>Previous State</th>
                    <th>New State</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={c.field}>
                      <td style={{ fontWeight: 600 }}>{formatFieldLabel(c.field)}</td>
                      <td style={{ color: 'var(--text-danger)', background: 'rgba(239, 68, 68, 0.05)' }}>
                        {formatValue(c.field, c.before, before)}
                      </td>
                      <td style={{ color: 'var(--text-success)', background: 'rgba(16, 185, 129, 0.05)', fontWeight: 600 }}>
                        {formatValue(c.field, c.after, after)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>
              No visual record attributes were modified (metadata-only update).
            </div>
          )}
        </div>
      );
    }

    return null;
  }

  return (
    <div>
      <PageHeader title="Audit Log" description="Every configuration change, operational event log, and deactivation is recorded here." />

      <div className="card">
        {/* Redesigned Balanced Grid Filter Layout using plain operational terminology */}
        <div className="toolbar" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', alignItems: 'end', marginBottom: '1.25rem' }}>
          
          <div className="field" style={{ margin: 0 }}>
            <label>Find an activity</label>
            <input
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
              placeholder="Search by tyre number, bus number, depot or person"
            />
          </div>

          <div className="field" style={{ margin: 0 }}>
            <label>What happened?</label>
            <select value={filters.action} onChange={(e) => handleFilterChange('action', e.target.value)}>
              <option value="">All activities</option>
              <option value="CREATE">Created</option>
              <option value="UPDATE">Updated</option>
              <option value="DELETE">Deactivated</option>
              <option value="TRANSFER">Transferred</option>
              <option value="AMEND_EVENT">Event amended</option>
            </select>
          </div>

          <div className="field" style={{ margin: 0 }}>
            <label>What was changed?</label>
            <select value={filters.entityType} onChange={(e) => handleFilterChange('entityType', e.target.value)}>
              <option value="">Everything</option>
              {Object.entries(ENTITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>

          <div className="field" style={{ margin: 0 }}>
            <label>Person who made the change</label>
            <input
              value={filters.username}
              onChange={(e) => handleFilterChange('username', e.target.value)}
              placeholder="Search by name or username"
            />
          </div>

          {/* Date range visual grouping */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Date range</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <div className="field" style={{ margin: 0, flex: 1 }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>From</label>
                <input
                  type="date"
                  value={filters.from}
                  onChange={(e) => handleFilterChange('from', e.target.value)}
                  style={{ height: '38px', padding: '0.25rem 0.5rem' }}
                />
              </div>
              <div className="field" style={{ margin: 0, flex: 1 }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>To</label>
                <input
                  type="date"
                  value={filters.to}
                  onChange={(e) => handleFilterChange('to', e.target.value)}
                  style={{ height: '38px', padding: '0.25rem 0.5rem' }}
                />
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="secondary" onClick={handleReset} style={{ width: '100%', height: '38px', padding: '0 1rem' }}>Clear filters</button>
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
                    <th style={{ width: '80px' }}>Log ID</th>
                    <th style={{ width: '170px' }}>Date & Time</th>
                    <th style={{ width: '150px' }}>Person</th>
                    <th style={{ width: '120px' }}>Activity</th>
                    <th style={{ width: '180px' }}>What was changed</th>
                    <th>Change Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr
                      key={log.id}
                      onClick={() => setViewEntry(log)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>#{log.id}</td>
                      <td>{formatDate(log.created_at)}</td>
                      <td style={{ fontWeight: 500 }}>{log.username}</td>
                      <td>
                        <span className={`badge ${ACTION_BADGE[log.action] || ''}`}>
                          {ACTION_LABELS[log.action] || log.action}
                        </span>
                      </td>
                      <td style={{ fontWeight: 600 }}>{log.entityLabel} <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.85rem' }}>{log.entityRef}</span></td>
                      <td className="wrap" style={{ color: 'var(--text-secondary)' }}>{log.changeSummary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
            />
          </>
        )}
      </div>

      {viewEntry && (
        <Modal title={`Activity Details (#${viewEntry.id})`} onClose={() => setViewEntry(null)} width={700}>
          {/* Metadata Section */}
          <div className="form-section-title">Activity Metadata</div>
          <div className="detail-grid" style={{ marginBottom: '1.25rem', gap: '0.75rem 1.5rem' }}>
            <div><div className="detail-label">Date & Time</div><div className="detail-value">{formatDate(viewEntry.created_at)}</div></div>
            <div><div className="detail-label">Person who made the change</div><div className="detail-value">{viewEntry.username} <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>· User ID {viewEntry.user_id || 'system'}</span></div></div>
            <div><div className="detail-label">Activity</div><div className="detail-value"><span className={`badge ${ACTION_BADGE[viewEntry.action] || ''}`}>{ACTION_LABELS[viewEntry.action] || viewEntry.action}</span></div></div>
            <div><div className="detail-label">Changed item type</div><div className="detail-value">{viewEntry.entityLabel}</div></div>
            <div><div className="detail-label">Changed item reference</div><div className="detail-value">{viewEntry.entityRef} <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>· Item ID {viewEntry.entity_id || '—'}</span></div></div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '1rem 0 1.25rem 0' }} />

          {/* Conditional Change Details rendering */}
          {renderModalDetails(viewEntry)}

          <div className="form-actions" style={{ marginTop: '1.5rem' }}>
            <button type="button" className="secondary" onClick={() => setViewEntry(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
