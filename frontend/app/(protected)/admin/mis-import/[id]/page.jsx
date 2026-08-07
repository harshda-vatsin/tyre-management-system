'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PlayCircle, Ban, XCircle, CheckCircle2, FileWarning } from 'lucide-react';
import { api } from '../../../../../lib/api.js';
import { useAuth } from '../../../../../components/AuthContext.jsx';
import { ROLES } from '../../../../../lib/roles.js';
import { formatDateTime } from '../../../../../lib/dates.js';
import PageHeader from '../../../../../components/PageHeader.jsx';
import LoadingState from '../../../../../components/LoadingState.jsx';
import EmptyState from '../../../../../components/EmptyState.jsx';
import Pagination from '../../../../../components/Pagination.jsx';
import ConfirmDialog from '../../../../../components/ConfirmDialog.jsx';

const STATUS_BADGE = {
  previewed: 'badge-info',
  queued: 'badge-warning',
  running: 'badge-warning',
  committed: 'badge-success',
  failed: 'badge-critical',
  cancelled: '',
};

const ROW_OUTCOME_LABELS = {
  stored: 'Stored',
  rejected_shape: 'Rejected -- missing data',
  rejected_lifecycle: 'Failed unexpectedly',
  skipped_exact_duplicate: 'Skipped -- exact duplicate',
  flagged_conflicting_duplicate: 'Flagged -- conflicting duplicate',
};

const SHEET_OUTCOME_LABELS = {
  stored: 'Stored',
  rejected_shape: 'Rejected',
  rejected_lifecycle: 'Failed',
  skipped_exact_duplicate: 'Duplicate (skipped)',
  flagged_conflicting_duplicate: 'Duplicate (flagged)',
};

export default function MisImportDetailPage() {
  const { user } = useAuth();

  if (user?.role !== ROLES.ADMIN) {
    return <div className="card error-text">Access denied. MIS Excel Import is restricted to Administrators.</div>;
  }

  return <MisImportDetailContent />;
}

function MisImportDetailContent() {
  const { id } = useParams();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const [rowOutcomeFilter, setRowOutcomeFilter] = useState('');
  const [rows, setRows] = useState([]);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowsPage, setRowsPage] = useState(1);
  const rowsPageSize = 25;
  const [rowsLoading, setRowsLoading] = useState(false);

  const loadSession = useCallback(async () => {
    try {
      const data = await api.get(`/mis-imports/${id}`);
      setSession(data);
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // Poll while the background job is actually in flight -- pointless (and a
  // little noisy) once the session has reached a terminal status.
  useEffect(() => {
    if (!session || !['queued', 'running'].includes(session.status)) return undefined;
    const timer = setInterval(loadSession, 2000);
    return () => clearInterval(timer);
  }, [session, loadSession]);

  const loadRows = useCallback(async () => {
    setRowsLoading(true);
    try {
      const params = new URLSearchParams({ page: String(rowsPage), pageSize: String(rowsPageSize) });
      if (rowOutcomeFilter) params.set('outcome', rowOutcomeFilter);
      const data = await api.get(`/mis-imports/${id}/rows?${params.toString()}`);
      setRows(data.rows || []);
      setRowsTotal(data.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setRowsLoading(false);
    }
  }, [id, rowOutcomeFilter, rowsPage]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  async function handleConfirm() {
    setActionBusy(true);
    setActionError('');
    try {
      await api.post(`/mis-imports/${id}/confirm`, {});
      setConfirmOpen(false);
      await loadSession();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleCancel() {
    setActionBusy(true);
    setActionError('');
    try {
      await api.post(`/mis-imports/${id}/cancel`, {});
      setCancelOpen(false);
      await loadSession();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionBusy(false);
    }
  }

  if (loading) return <LoadingState label="Loading import session..." />;
  if (error && !session) return <div className="card error-text">{error}</div>;
  if (!session) return null;

  const progressPct = session.rows_total > 0 ? Math.min(100, Math.round((session.rows_stored / session.rows_total) * 100)) : 0;

  return (
    <div>
      <PageHeader
        title={session.original_filename}
        description={`Import session #${session.id} -- uploaded ${formatDateTime(session.created_at)}`}
        backHref="/admin/mis-import"
        backLabel="All Imports"
        actions={<span className={`badge ${STATUS_BADGE[session.status] || ''}`} style={{ fontSize: '0.85rem' }}>{session.status}</span>}
      />

      {actionError && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{actionError}</div>}

      <div className="card">
        <div className="detail-grid">
          <div><div className="detail-label">Rows Parsed</div><div className="detail-value">{session.rows_total}</div></div>
          <div><div className="detail-label">Rows Stored</div><div className="detail-value">{session.rows_stored}</div></div>
          <div><div className="detail-label">Events Linked</div><div className="detail-value">{session.events_linked}</div></div>
          <div><div className="detail-label">Events Unlinked</div><div className="detail-value">{session.events_unlinked}</div></div>
          <div><div className="detail-label">Duplicates Skipped</div><div className="detail-value">{session.rows_skipped_duplicate}</div></div>
        </div>

        {['queued', 'running'].includes(session.status) && (
          <div style={{ marginTop: '1.1rem' }}>
            <div style={{ height: 8, borderRadius: 4, background: 'var(--primary-soft)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progressPct}%`, background: 'var(--primary)', transition: 'width 0.4s ease' }} />
            </div>
            <div className="field-hint" style={{ marginTop: '0.5rem' }}>
              {session.status === 'queued'
                ? 'Waiting for a worker to pick this import up...'
                : `Committing -- ${session.rows_stored} of ${session.rows_total} rows processed so far.`}
            </div>
          </div>
        )}

        {session.status === 'failed' && (
          <div className="status-banner error" style={{ marginTop: '1rem' }}>
            <XCircle size={16} />
            <span>{session.error_summary || 'The import job failed for an unknown reason.'}</span>
          </div>
        )}

        {session.status === 'committed' && (
          <div className="status-banner success" style={{ marginTop: '1rem' }}>
            <CheckCircle2 size={16} />
            <span>Committed {formatDateTime(session.completed_at)}. Every row below is now a permanent MIS record.</span>
          </div>
        )}

        {session.status === 'cancelled' && (
          <div className="status-banner" style={{ marginTop: '1rem' }}>
            <Ban size={16} />
            <span>This import was cancelled before it ran. Nothing was written to the database.</span>
          </div>
        )}

        {session.status === 'previewed' && (
          <div className="form-actions" style={{ marginTop: '1.25rem' }}>
            <button type="button" onClick={() => setConfirmOpen(true)}>
              <PlayCircle size={15} /> Confirm Import
            </button>
            <button type="button" className="secondary" onClick={() => setCancelOpen(true)}>
              <Ban size={15} /> Discard
            </button>
          </div>
        )}
      </div>

      {session.sheets && session.sheets.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Per-Sheet Breakdown</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sheet</th>
                  <th>Status</th>
                  <th>Rows Parsed</th>
                  <th>Stored</th>
                  <th>Outcomes</th>
                </tr>
              </thead>
              <tbody>
                {session.sheets.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td>
                      {s.status === 'ok' ? (
                        <span className="badge badge-success">Recognized</span>
                      ) : (
                        <span className="badge badge-warning" title="No parser matches this sheet's name or column headers">
                          {s.status === 'version_mismatch' ? 'Unrecognized format' : 'Unrecognized sheet'}
                        </span>
                      )}
                    </td>
                    <td>{s.totalParsed ?? '-'}</td>
                    <td>{s.stored ?? '-'}</td>
                    <td className="wrap">
                      {s.outcomeBreakdown
                        ? Object.entries(s.outcomeBreakdown)
                            .map(([key, count]) => `${SHEET_OUTCOME_LABELS[key] || key}: ${count}`)
                            .join(', ')
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: '0.85rem' }}>
          <h3 style={{ margin: 0 }}>Row Detail</h3>
          <div className="field" style={{ minWidth: 240, marginLeft: 'auto' }}>
            <label>Outcome</label>
            <select value={rowOutcomeFilter} onChange={(e) => { setRowOutcomeFilter(e.target.value); setRowsPage(1); }}>
              <option value="">All outcomes</option>
              {Object.entries(ROW_OUTCOME_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        {rowsLoading ? (
          <LoadingState label="Loading rows..." />
        ) : rows.length === 0 ? (
          <EmptyState icon={FileWarning} title="No rows match this filter" />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Sheet</th>
                    <th>Row</th>
                    <th>Outcome</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.source_sheet}</td>
                      <td>{r.source_row}</td>
                      <td>{ROW_OUTCOME_LABELS[r.outcome] || r.outcome}</td>
                      <td className="wrap">{r.failure_reason || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={rowsPage} pageSize={rowsPageSize} total={rowsTotal} onPageChange={setRowsPage} />
          </>
        )}
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title="Confirm Import"
          message={`This will permanently create ${session.rows_total ? session.rows_stored : ''} MIS records and their lifecycle events. This cannot be undone from here.`}
          confirmLabel={actionBusy ? 'Confirming...' : 'Confirm Import'}
          danger={false}
          onConfirm={handleConfirm}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {cancelOpen && (
        <ConfirmDialog
          title="Discard Import"
          message="This discards the preview. The uploaded file and its preview results will no longer lead anywhere -- nothing has been written to the database."
          confirmLabel={actionBusy ? 'Discarding...' : 'Discard'}
          onConfirm={handleCancel}
          onCancel={() => setCancelOpen(false)}
        />
      )}
    </div>
  );
}
