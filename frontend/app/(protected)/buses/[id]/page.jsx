'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeftRight } from 'lucide-react';
import { api } from '../../../../lib/api.js';
import { useAuth } from '../../../../components/AuthContext.jsx';
import { useSettings } from '../../../../components/SettingsContext.jsx';
import { ROLES } from '../../../../lib/roles.js';
import { formatPressure } from '../../../../lib/units.js';
import { formatDate } from '../../../../lib/dates.js';
import Modal from '../../../../components/Modal.jsx';
import PageHeader from '../../../../components/PageHeader.jsx';
import LoadingState from '../../../../components/LoadingState.jsx';
import BusTyreDiagram from '../../../../components/BusTyreDiagram.jsx';

const STATUS_BADGE = { Active: 'badge-success', 'Under Maintenance': 'badge-warning', Decommissioned: 'badge-critical' };

export default function BusDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const { pressureUnit } = useSettings();
  const canTransfer = user?.role === ROLES.ADMIN || user?.role === ROLES.NATIONAL_FLEET_MANAGER;

  const [bus, setBus] = useState(null);
  const [depots, setDepots] = useState([]);
  const [error, setError] = useState('');
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferDepotId, setTransferDepotId] = useState('');
  const [transferNotes, setTransferNotes] = useState('');
  const [transferError, setTransferError] = useState('');

  async function load() {
    setError('');
    try {
      const data = await api.get(`/buses/${id}`);
      setBus(data);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    api.get('/depots').then(setDepots).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleTransfer(e) {
    e.preventDefault();
    setTransferError('');
    try {
      await api.post(`/buses/${id}/transfer`, { to_depot_id: Number(transferDepotId), notes: transferNotes });
      setShowTransfer(false);
      setTransferDepotId('');
      setTransferNotes('');
      await load();
    } catch (err) {
      setTransferError(err.message);
    }
  }

  function renderPositionSlot(slot) {
    if (!slot.tyre) {
      return (
        <div key={slot.position} className="bus-diagram-tyre empty">
          <span className="position-code">{slot.position}</span>
          <span className="reading-summary">Empty</span>
        </div>
      );
    }
    const flagClass = slot.tyre.flag_status === 'CRITICAL' ? ' flag-critical'
      : slot.tyre.flag_status === 'WARNING' ? ' flag-warning'
      : ' has-reading';
    return (
      <Link key={slot.position} href={`/tyres/${slot.tyre.id}`} className={`bus-diagram-tyre${flagClass}`}>
        <span className="position-code">{slot.position}</span>
        <span className="tyre-number">{slot.tyre.tyre_number}</span>
        <span className="reading-summary">{slot.tyre.status}</span>
      </Link>
    );
  }

  if (error) return <div className="card error-text">{error}</div>;
  if (!bus) return <div className="card"><LoadingState label="Loading bus..." /></div>;

  return (
    <div>
      <PageHeader
        backHref="/buses"
        backLabel="Back to Buses"
        title={bus.registration_no}
        actions={canTransfer && (
          <button className="secondary" onClick={() => setShowTransfer(true)}>
            <ArrowLeftRight size={15} /> Transfer to Another Depot
          </button>
        )}
      />

      <div className="card">
        <div className="detail-grid">
          <div><div className="detail-label">Bus ID</div><div className="detail-value">#{bus.id}</div></div>
          <div><div className="detail-label">Chassis Number (VIN)</div><div className="detail-value">{bus.chassis_no}</div></div>
          <div><div className="detail-label">Model / Make</div><div className="detail-value">{bus.bus_model_name} ({bus.bus_model_manufacturer})</div></div>
          <div><div className="detail-label">Associated Depot</div><div className="detail-value">{bus.depot_name}</div></div>
          <div><div className="detail-label">Number of Tyre Positions</div><div className="detail-value">{bus.num_tyre_positions}</div></div>
          <div><div className="detail-label">Year of Manufacture</div><div className="detail-value">{bus.year_of_manufacture || '—'}</div></div>
          <div><div className="detail-label">Date of Entry into Fleet</div><div className="detail-value">{formatDate(bus.date_of_entry_into_fleet)}</div></div>
          <div><div className="detail-label">Status</div><div className="detail-value"><span className={`badge ${STATUS_BADGE[bus.status] || ''}`}>{bus.status}</span></div></div>
          <div><div className="detail-label">Odometer</div><div className="detail-value">{bus.odometer_km.toLocaleString()} km</div></div>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row"><h3>Bus Layout</h3></div>
        <BusTyreDiagram positionMap={bus.tyre_position_map} renderTyre={renderPositionSlot} />
      </div>

      <div className="card">
        <div className="card-title-row"><h3>Tyre Position Map</h3></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Position</th>
                <th>Tyre Number</th>
                <th>Tyre Status</th>
                <th>Last NSD</th>
                <th>Last Pressure</th>
                <th>Last Event Date</th>
              </tr>
            </thead>
            <tbody>
              {bus.tyre_position_map.map((slot) => (
                <tr key={slot.position}>
                  <td>{slot.position}</td>
                  <td>{slot.tyre ? <Link href={`/tyres/${slot.tyre.id}`}>{slot.tyre.tyre_number}</Link> : <span style={{ color: 'var(--text-muted)' }}>Empty</span>}</td>
                  <td>{slot.tyre ? <span className="badge">{slot.tyre.status}</span> : '—'}</td>
                  <td>
                    {slot.tyre?.last_nsd_value != null ? (
                      <span className="reading-value" data-flag={slot.tyre.flag_status || 'unset'}>{slot.tyre.last_nsd_value} mm</span>
                    ) : '—'}
                  </td>
                  <td>
                    {slot.tyre?.last_pressure_value != null ? (
                      <span className="reading-value" data-flag={slot.tyre.flag_status || 'unset'}>{formatPressure(slot.tyre.last_pressure_value, pressureUnit)}</span>
                    ) : '—'}
                  </td>
                  <td>{formatDate(slot.tyre?.last_event_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showTransfer && (
        <Modal title="Transfer Bus" onClose={() => setShowTransfer(false)}>
          <form onSubmit={handleTransfer}>
            <div className="field">
              <label>Destination Depot</label>
              <select value={transferDepotId} onChange={(e) => setTransferDepotId(e.target.value)} required>
                <option value="">Select depot</option>
                {depots.filter((d) => d.id !== bus.depot_id).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Notes</label>
              <input value={transferNotes} onChange={(e) => setTransferNotes(e.target.value)} placeholder="Reason for transfer" />
            </div>
            {transferError && <div className="error-text">{transferError}</div>}
            <div className="form-actions">
              <button type="submit">Confirm Transfer</button>
              <button type="button" className="secondary" onClick={() => setShowTransfer(false)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
