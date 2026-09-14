'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Printer } from 'lucide-react';
import { api, downloadFile } from '../../../../lib/api.js';
import { useAuth } from '../../../../components/AuthContext.jsx';
import { useSettings } from '../../../../components/SettingsContext.jsx';
import { ROLES } from '../../../../lib/roles.js';
import { formatPressure } from '../../../../lib/units.js';
import { formatDate } from '../../../../lib/dates.js';
import Pagination from '../../../../components/Pagination.jsx';
import PageHeader from '../../../../components/PageHeader.jsx';
import LoadingState from '../../../../components/LoadingState.jsx';
import AmendEventModal from '../../../../components/AmendEventModal.jsx';
import LifecycleTimeline from '../../../../components/LifecycleTimeline.jsx';
import LifecycleProgressBar from '../../../../components/LifecycleProgressBar.jsx';
import QuickActionModal from '../../../../components/QuickActionModal.jsx';
import QRCode from 'qrcode';
import { EVENT_TYPE_LABELS, statusBadgeClass, describeEvent as describeEventShared } from '../../../../lib/tyreLifecycle.js';

const AMEND_ROLES = [ROLES.ADMIN, ROLES.DEPOT_MANAGER];
const WRITE_ROLES = [ROLES.ADMIN, ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR];
const ELEVATED_ROLES = [ROLES.ADMIN, ROLES.DEPOT_MANAGER];

// Quick actions available on the tyre detail page itself, alongside the
// full event picker on /log-event. `elevated` mirrors the backend's
// ELEVATED_EVENT_TYPES (Depot Manager/Administrator only); `requiresMounted`
// hides the action when the tyre has no current_bus_id, the same
// precondition /log-event already enforces via TyreSelect's mountedOnly.
// `onlyStatus` restricts an action to tyres currently in that status --
// today just Reactivate, which only makes sense for a Scrapped tyre.
const QUICK_ACTIONS = [
  { eventType: 'rotation', label: 'Rotate', requiresMounted: true },
  { eventType: 'send_to_repair', label: 'Send to Repair' },
  { eventType: 'puncture_repair', label: 'Repair Completed' },
  { eventType: 'retread_sent', label: 'Send to Retread' },
  { eventType: 'retread_completed', label: 'Retread Completed' },
  { eventType: 'warranty_claim', label: 'Warranty Claim' },
  { eventType: 'condemnation', label: 'Scrap', elevated: true },
  // Only ever shown for a Scrapped tyre (see the filter below) -- reverses a
  // condemnation, bringing the tyre back to In Store.
  { eventType: 'reactivation', label: 'Reactivate', elevated: true, onlyStatus: 'Scrapped' },
];

function describeEvent(e, pressureUnit) {
  return describeEventShared(e, pressureUnit, formatPressure);
}

export default function TyreDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const { pressureUnit } = useSettings();
  const canAmend = AMEND_ROLES.includes(user?.role);
  const canWrite = WRITE_ROLES.includes(user?.role);
  const canElevated = ELEVATED_ROLES.includes(user?.role);
  const [tyre, setTyre] = useState(null);
  const [error, setError] = useState('');
  const [quickActionType, setQuickActionType] = useState(null);

  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [eventType, setEventType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [historyError, setHistoryError] = useState('');

  const [amendmentsMap, setAmendmentsMap] = useState({});
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [amendingEvent, setAmendingEvent] = useState(null);
  const [busMap, setBusMap] = useState({});

  const [qrCodeUrl, setQrCodeUrl] = useState('');

  function reloadTyre() {
    return api.get(`/tyres/${id}`).then(setTyre).catch((err) => setError(err.message));
  }

  useEffect(() => {
    reloadTyre();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (tyre) {
      const payload = `EBTMS:TYRE:V1:${tyre.tyre_number}`;
      QRCode.toDataURL(payload, { width: 100, margin: 1 })
        .then(setQrCodeUrl)
        .catch((err) => console.error('Failed to generate QR:', err));
    }
  }, [tyre]);

  useEffect(() => {
    if (!canAmend) return;
    api.get('/buses?pageSize=100').then((r) => {
      setBusMap(Object.fromEntries(r.data.map((b) => [b.id, b.registration_no])));
    });
  }, [canAmend]);

  async function loadAmendments(eventList) {
    const map = {};
    await Promise.all(eventList.map(async (ev) => {
      try {
        map[ev.id] = await api.get(`/events/${ev.id}/amendments`);
      } catch {
        map[ev.id] = [];
      }
    }));
    setAmendmentsMap(map);
  }

  async function loadEvents() {
    setHistoryError('');
    try {
      const params = new URLSearchParams({ tyre_id: id, page: String(page), pageSize: String(pageSize) });
      if (eventType) params.set('event_type', eventType);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const data = await api.get(`/events?${params.toString()}`);
      setEvents(data.data);
      setTotal(data.total);
      setExpandedIds(new Set());
      loadAmendments(data.data);
    } catch (err) {
      setHistoryError(err.message);
    }
  }

  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, eventType, from, to, page]);

  async function handleQuickActionSaved() {
    setQuickActionType(null);
    await Promise.all([reloadTyre(), loadEvents()]);
  }

  function toggleExpand(eventId) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }

  async function handleAmendmentSaved(event) {
    setAmendingEvent(null);
    const amendments = await api.get(`/events/${event.id}/amendments`);
    setAmendmentsMap((prev) => ({ ...prev, [event.id]: amendments }));
    setExpandedIds((prev) => new Set(prev).add(event.id));
  }

  if (error) return <div className="card error-text">{error}</div>;
  if (!tyre) return <div className="card"><LoadingState label="Loading tyre..." /></div>;

  const handlePrintPdf = async () => {
    try {
      await downloadFile(`/tyres/${id}/export-pdf`, `Tyre_Card_${tyre.tyre_number}.pdf`);
    } catch (err) {
      alert('Failed to download PDF: ' + err.message);
    }
  };

  return (
    <div>
      <PageHeader
        backHref="/tyres"
        backLabel="Back to Tyres"
        title={tyre.tyre_number}
        actions={<button onClick={handlePrintPdf}><Printer size={15} /> Print / Export Tyre Card PDF</button>}
      />

      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1.25rem' }}>
        <div className="detail-grid" style={{ flex: '1 1 500px' }}>
          <div><div className="detail-label">Brand / Manufacturer</div><div className="detail-value">{tyre.brand}</div></div>
          <div><div className="detail-label">Model / Type</div><div className="detail-value">{tyre.model || '-'}</div></div>
          <div><div className="detail-label">Size</div><div className="detail-value">{tyre.size || '-'}</div></div>
          <div><div className="detail-label">Date of Purchase</div><div className="detail-value">{formatDate(tyre.purchase_date)}</div></div>
          <div><div className="detail-label">Initial NSD</div><div className="detail-value">{tyre.initial_nsd != null ? `${tyre.initial_nsd} mm` : '-'}</div></div>
          <div><div className="detail-label">Status</div><div className="detail-value"><span className={`badge ${statusBadgeClass(tyre.status)}`}>{tyre.status}</span></div></div>
          <div><div className="detail-label">Current Depot</div><div className="detail-value">{tyre.depot_name || '-'}</div></div>
          <div>
            <div className="detail-label">Current Bus / Position</div>
            <div className="detail-value">
              {tyre.bus_registration_no ? (
                <>
                  <Link href={`/buses/${tyre.current_bus_id}`}>{tyre.bus_registration_no}</Link> / {tyre.current_position}
                </>
              ) : '-' }
            </div>
          </div>
        </div>
        {qrCodeUrl && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderLeft: '1px solid var(--border)', paddingLeft: '1.5rem', flexShrink: 0 }}>
            <img src={qrCodeUrl} alt="EBTMS Tyre QR" style={{ width: 100, height: 100 }} />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem', textAlign: 'center' }}>
              Scan to open digital tyre card
            </span>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title-row"><h3>Lifecycle Stage</h3></div>
        <LifecycleProgressBar status={tyre.status} />
      </div>

      {canWrite && (
        <div className="card">
          <div className="card-title-row"><h3>Quick Actions</h3></div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {QUICK_ACTIONS.filter((a) => {
              // A Scrapped tyre can only be Reactivated -- every other action
              // here would just fail server-side (Scrapped is a dead end for
              // everything but that one explicit, audited exception).
              if (tyre.status === 'Scrapped') return a.onlyStatus === 'Scrapped' && canElevated;
              if (a.onlyStatus) return false;
              return (!a.elevated || canElevated) && (!a.requiresMounted || tyre.current_bus_id);
            }).map((a) => (
              <button key={a.eventType} type="button" className="secondary" onClick={() => setQuickActionType(a.eventType)}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title-row"><h3>Tyre Card History</h3></div>
        <div className="toolbar">
          <div className="field" style={{ minWidth: 180 }}>
            <label>Event Type</label>
            <select value={eventType} onChange={(e) => { setPage(1); setEventType(e.target.value); }}>
              <option value="">All types</option>
              {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>From</label>
            <input type="date" value={from} onChange={(e) => { setPage(1); setFrom(e.target.value); }} />
          </div>
          <div className="field">
            <label>To</label>
            <input type="date" value={to} onChange={(e) => { setPage(1); setTo(e.target.value); }} />
          </div>
        </div>

        {historyError && <div className="error-text">{historyError}</div>}
        <LifecycleTimeline
          events={events}
          pressureUnit={pressureUnit}
          formatPressure={formatPressure}
          amendmentsMap={amendmentsMap}
          expandedIds={expandedIds}
          onToggleExpand={toggleExpand}
          canAmend={canAmend}
          onAmend={setAmendingEvent}
          busMap={busMap}
        />
        <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
      </div>

      {amendingEvent && (
        <AmendEventModal
          event={amendingEvent}
          eventTypeLabel={EVENT_TYPE_LABELS[amendingEvent.event_type]}
          onClose={() => setAmendingEvent(null)}
          onSaved={() => handleAmendmentSaved(amendingEvent)}
        />
      )}

      {quickActionType && (
        <QuickActionModal
          tyre={tyre}
          eventType={quickActionType}
          onClose={() => setQuickActionType(null)}
          onSaved={handleQuickActionSaved}
        />
      )}
    </div>
  );
}
