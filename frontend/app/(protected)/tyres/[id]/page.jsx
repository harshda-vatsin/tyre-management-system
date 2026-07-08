'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Printer } from 'lucide-react';
import { api, downloadFile } from '../../../../lib/api.js';
import { useSettings } from '../../../../components/SettingsContext.jsx';
import { formatPressure } from '../../../../lib/units.js';
import { formatDate } from '../../../../lib/dates.js';
import Pagination from '../../../../components/Pagination.jsx';
import PageHeader from '../../../../components/PageHeader.jsx';
import LoadingState from '../../../../components/LoadingState.jsx';
import EmptyState from '../../../../components/EmptyState.jsx';
import QRCode from 'qrcode';

const EVENT_TYPE_LABELS = {
  nsd_reading: 'NSD Reading',
  pressure_reading: 'Pressure Reading',
  rotation: 'Rotation',
  replacement: 'Replacement',
  puncture_repair: 'Puncture Repair',
  inter_bus_transfer: 'Inter-Bus Transfer',
  send_to_store: 'Sent to Store',
  condemnation: 'Condemnation',
};

const STATUS_BADGE = { 'In Service': 'badge-success', 'In Store': 'badge-info', Condemned: 'badge-critical', 'Under Repair': 'badge-warning' };

function describeEvent(e, pressureUnit) {
  switch (e.event_type) {
    case 'nsd_reading':
      return `NSD: ${e.nsd_value} mm at ${e.position} (${e.bus_registration_no})`;
    case 'pressure_reading':
      return `Pressure: ${formatPressure(e.pressure_value, pressureUnit)} at ${e.position} (${e.bus_registration_no})`;
    case 'rotation':
      return `${e.from_position} → ${e.to_position} on ${e.bus_registration_no}${e.reason ? ` — ${e.reason}` : ''}`;
    case 'replacement':
      return e.to_position
        ? `Installed at ${e.to_position} on ${e.bus_registration_no}, replacing tyre ${e.related_tyre_number}${e.reason ? ` — ${e.reason}` : ''}`
        : `Removed from ${e.from_position} on ${e.bus_registration_no}, replaced by tyre ${e.related_tyre_number}${e.reason ? ` — ${e.reason}` : ''}`;
    case 'puncture_repair':
      return `${e.repair_type} repair${e.notes ? ` — ${e.notes}` : ''}`;
    case 'inter_bus_transfer':
      return `${e.from_bus_registration_no}/${e.from_position} → ${e.to_bus_registration_no}/${e.to_position}${e.reason ? ` — ${e.reason}` : ''}`;
    case 'send_to_store':
      return `Removed from ${e.from_bus_registration_no || '—'}/${e.from_position || '—'}, NSD ${e.nsd_value} mm, stored at ${e.stored_at} — ${e.reason}`;
    case 'condemnation':
      return `Condemned at NSD ${e.nsd_value} mm — ${e.reason}`;
    default:
      return '—';
  }
}

export default function TyreDetailPage() {
  const { id } = useParams();
  const { pressureUnit } = useSettings();
  const [tyre, setTyre] = useState(null);
  const [error, setError] = useState('');

  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [eventType, setEventType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [historyError, setHistoryError] = useState('');

  const [qrCodeUrl, setQrCodeUrl] = useState('');

  useEffect(() => {
    api.get(`/tyres/${id}`).then(setTyre).catch((err) => setError(err.message));
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
      } catch (err) {
        setHistoryError(err.message);
      }
    }
    loadEvents();
  }, [id, eventType, from, to, page]);

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
          <div><div className="detail-label">Model / Type</div><div className="detail-value">{tyre.model || '—'}</div></div>
          <div><div className="detail-label">Size</div><div className="detail-value">{tyre.size || '—'}</div></div>
          <div><div className="detail-label">Date of Purchase</div><div className="detail-value">{formatDate(tyre.purchase_date)}</div></div>
          <div><div className="detail-label">Initial NSD</div><div className="detail-value">{tyre.initial_nsd != null ? `${tyre.initial_nsd} mm` : '—'}</div></div>
          <div><div className="detail-label">Status</div><div className="detail-value"><span className={`badge ${STATUS_BADGE[tyre.status] || ''}`}>{tyre.status}</span></div></div>
          <div><div className="detail-label">Current Depot</div><div className="detail-value">{tyre.depot_name || '—'}</div></div>
          <div>
            <div className="detail-label">Current Bus / Position</div>
            <div className="detail-value">
              {tyre.bus_registration_no ? (
                <>
                  <Link href={`/buses/${tyre.current_bus_id}`}>{tyre.bus_registration_no}</Link> / {tyre.current_position}
                </>
              ) : '—'}
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
        {events.length === 0 ? (
          <EmptyState title="No events recorded yet" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Event Type</th>
                  <th>Details</th>
                  <th>Recorded By</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>{formatDate(e.event_date)}</td>
                    <td><span className="badge">{EVENT_TYPE_LABELS[e.event_type]}</span></td>
                    <td className="wrap">{describeEvent(e, pressureUnit)}</td>
                    <td>{e.performed_by_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
      </div>
    </div>
  );
}
