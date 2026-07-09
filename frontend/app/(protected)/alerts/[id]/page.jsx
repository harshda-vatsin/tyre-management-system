'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../../../lib/api.js';
import { useAuth } from '../../../../components/AuthContext.jsx';
import { ROLES } from '../../../../lib/roles.js';
import Modal from '../../../../components/Modal.jsx';
import PageHeader from '../../../../components/PageHeader.jsx';
import LoadingState from '../../../../components/LoadingState.jsx';
import { SeverityBadge, StatusBadge, EscalatedBadge } from '../../../../components/AlertBadges.jsx';

export default function AlertDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const canWrite = [ROLES.ADMIN, ROLES.NATIONAL_FLEET_MANAGER, ROLES.DEPOT_MANAGER].includes(user?.role);

  const [alert, setAlert] = useState(null);
  const [error, setError] = useState('');
  const [showResolve, setShowResolve] = useState(false);
  const [resolveNote, setResolveNote] = useState('');
  const [resolveError, setResolveError] = useState('');

  async function load() {
    setError('');
    try {
      const data = await api.get(`/alerts/${id}`);
      setAlert(data);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, [id]);

  async function handleAcknowledge() {
    setError('');
    try {
      await api.patch(`/alerts/${id}/acknowledge`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleResolve(e) {
    e.preventDefault();
    setResolveError('');
    try {
      await api.patch(`/alerts/${id}/resolve`, { resolution_note: resolveNote });
      setShowResolve(false);
      setResolveNote('');
      await load();
    } catch (err) {
      setResolveError(err.message);
    }
  }

  if (error) return <div className="card error-text">{error}</div>;
  if (!alert) return <div className="card"><LoadingState label="Loading alert..." /></div>;

  return (
    <div>
      <PageHeader
        backHref="/alerts"
        backLabel="Back to Alerts"
        title={`Alert #${alert.id} | ${alert.parameter_type}`}
        actions={canWrite && alert.status !== 'Resolved' && (
          <>
            {alert.status === 'Open' && <button className="secondary" onClick={handleAcknowledge}>Acknowledge</button>}
            <button onClick={() => setShowResolve(true)}>Resolve</button>
          </>
        )}
      />

      <div className="card">
        <div className="detail-grid">
          <div><div className="detail-label">Severity</div><div className="detail-value"><SeverityBadge severity={alert.severity} /> <EscalatedBadge isEscalated={alert.is_escalated} /></div></div>
          <div><div className="detail-label">Status</div><div className="detail-value"><StatusBadge status={alert.status} /></div></div>
          <div><div className="detail-label">Age</div><div className="detail-value">{alert.age_days} days</div></div>
          <div><div className="detail-label">Source Reading</div><div className="detail-value">{alert.reading_value ?? '-'} (threshold: {alert.threshold_value ?? '-'}){alert.triggering_event_date ? ` on ${alert.triggering_event_date}` : ''}</div></div>
          <div><div className="detail-label">Tyre</div><div className="detail-value"><Link href={`/tyres/${alert.tyre_id}`}>{alert.tyre_number}</Link></div></div>
          <div><div className="detail-label">Bus</div><div className="detail-value">{alert.bus_id ? <Link href={`/buses/${alert.bus_id}`}>{alert.bus_registration_no}</Link> : '-' }</div></div>
          <div><div className="detail-label">Depot</div><div className="detail-value">{alert.depot_name || '-'}</div></div>
          <div><div className="detail-label">Opened</div><div className="detail-value">{alert.opened_at}</div></div>
          {alert.acknowledged_at && <div><div className="detail-label">Acknowledged</div><div className="detail-value">{alert.acknowledged_at} by {alert.acknowledged_by_username}</div></div>}
          {alert.resolved_at && <div><div className="detail-label">Resolved</div><div className="detail-value">{alert.resolved_at} by {alert.resolved_by_username || 'System'}</div></div>}
          {alert.resolution_note && <div><div className="detail-label">Resolution Note</div><div className="detail-value">{alert.resolution_note}</div></div>}
          {alert.escalated_at && <div><div className="detail-label">Escalated At</div><div className="detail-value">{alert.escalated_at}</div></div>}
        </div>
        {error && <div className="error-text" style={{ marginTop: '0.75rem' }}>{error}</div>}
      </div>

      {showResolve && (
        <Modal title="Resolve Alert" onClose={() => setShowResolve(false)}>
          <form onSubmit={handleResolve}>
            <div className="field">
              <label>Resolution Note (required)</label>
              <input value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} required />
            </div>
            {resolveError && <div className="error-text">{resolveError}</div>}
            <div className="form-actions">
              <button type="submit">Resolve</button>
              <button type="button" className="secondary" onClick={() => setShowResolve(false)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
