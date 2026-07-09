'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bus, CircleDot, AlertTriangle, ShieldCheck, PartyPopper } from 'lucide-react';
import { api } from '../lib/api.js';
import StatCard from './StatCard.jsx';
import BarChart from './BarChart.jsx';
import PageHeader from './PageHeader.jsx';
import EmptyState from './EmptyState.jsx';
import LoadingState from './LoadingState.jsx';
import { TYRE_STATUS_COLORS, ALERT_SEVERITY_COLORS } from '../lib/dashboardColors.js';
import { SeverityBadge } from './AlertBadges.jsx';

export default function DepotDashboard({ depotId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // SRS §7.2: "Active alerts at depot level with tyre number, bus, alert
  // type, and date raised" -- a real inline table, not just the severity
  // chart + a link out to the full Alerts page.
  const [activeAlerts, setActiveAlerts] = useState(null);

  useEffect(() => {
    setData(null);
    setError('');
    api.get(`/dashboard/depot?depot_id=${depotId}`).then(setData).catch((err) => setError(err.message));
  }, [depotId]);

  useEffect(() => {
    setActiveAlerts(null);
    api.get(`/alerts?depot_id=${depotId}&status=Open&pageSize=5`).then((res) => setActiveAlerts(res.data)).catch(() => setActiveAlerts([]));
  }, [depotId]);

  if (error) return <div className="card error-text">{error}</div>;
  if (!data) return <div className="card"><LoadingState label="Loading dashboard..." /></div>;

  const tyreStatusData = Object.entries(data.tyre_status_counts).map(([label, value]) => ({
    label, value, color: TYRE_STATUS_COLORS[label],
  }));
  const alertSeverityData = Object.entries(data.active_alert_counts).map(([label, value]) => ({
    label, value, color: ALERT_SEVERITY_COLORS[label],
  }));
  const noActiveAlerts = data.fleet_health.active_alerts === 0;

  return (
    <div>
      <PageHeader
        title={`${data.depot.name} | Depot Dashboard`}
        description={`${data.depot.region} · ${data.depot.code}`}
        actions={onBack && <button className="secondary" onClick={onBack}>&larr; Back to National Dashboard</button>}
      />

      <div className="stat-grid">
        <StatCard label="Buses" value={data.fleet_health.total_buses} accent="#2a78d6" icon={Bus} />
        <StatCard label="Tyres" value={data.fleet_health.total_tyres} accent="#1baf7a" icon={CircleDot} />
        <StatCard label="Active Alerts" value={data.fleet_health.active_alerts} accent="#b3261e" icon={AlertTriangle} />
        <StatCard label="Compliance" value={`${data.fleet_health.compliance_pct}%`} sublabel={`${data.compliance.compliant_buses}/${data.compliance.total_buses} buses up to date`} accent="#1a7f37" icon={ShieldCheck} />
      </div>

      <div className="grid-2col">
        <div className="card">
          <div className="card-title-row"><h3>Tyre Status</h3></div>
          <BarChart data={tyreStatusData} />
        </div>
        <div className="card">
          <div className="card-title-row"><h3>Active Alerts by Severity</h3></div>
          {noActiveAlerts ? (
            <EmptyState icon={PartyPopper} title="No active alerts" description="Every tyre parameter in this depot is within threshold." />
          ) : (
            <>
              <BarChart data={alertSeverityData} />
              <div style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
                <Link href={`/alerts?depot_id=${depotId}&status=Open`}>View open alerts for this depot &rarr;</Link>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title-row"><h3>Active Alerts</h3></div>
        {activeAlerts === null ? (
          <LoadingState label="Loading alerts..." />
        ) : activeAlerts.length === 0 ? (
          <EmptyState icon={PartyPopper} title="No open alerts" description="Nothing currently needs attention in this depot." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Parameter</th>
                  <th>Tyre</th>
                  <th>Bus</th>
                  <th>Date Raised</th>
                </tr>
              </thead>
              <tbody>
                {activeAlerts.map((a) => (
                  <tr key={a.id}>
                    <td><SeverityBadge severity={a.severity} /></td>
                    <td>{a.parameter_type}</td>
                    <td><Link href={`/tyres/${a.tyre_id}`}>{a.tyre_number}</Link></td>
                    <td>{a.bus_registration_no || '-'}</td>
                    <td>{a.opened_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
          <Link href={`/alerts?depot_id=${depotId}&status=Open`}>View all open alerts for this depot &rarr;</Link>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row"><h3>Bus Summary</h3></div>
        {data.bus_summaries.length === 0 ? (
          <EmptyState title="No buses in this depot" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Bus</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>In Service</th>
                  <th>Flagged Tyres</th>
                </tr>
              </thead>
              <tbody>
                {data.bus_summaries.map((b) => (
                  <tr key={b.id}>
                    <td><Link href={`/buses/${b.id}`}>{b.registration_no}</Link></td>
                    <td>{b.model_name}</td>
                    <td><span className="badge">{b.status}</span></td>
                    <td>{b.tyre_counts['In Service'] || 0}</td>
                    <td>{b.flagged_count > 0 ? <span className="badge badge-critical">{b.flagged_count}</span> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid-2col">
        <div className="card">
          <div className="card-title-row"><h3>Tyres in Store</h3></div>
          {data.tyres_in_store.length === 0 ? (
            <EmptyState title="No tyres in store" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tyre</th>
                    <th>Brand</th>
                    <th>Last NSD</th>
                    <th>Days in Storage</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tyres_in_store.map((t) => (
                    <tr key={t.tyre_id}>
                      <td><Link href={`/tyres/${t.tyre_id}`}>{t.tyre_number}</Link></td>
                      <td>{t.brand}</td>
                      <td>{t.last_nsd_value != null ? `${t.last_nsd_value} mm` : '-'}</td>
                      <td>{t.days_in_storage}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-title-row"><h3>Upcoming Inspections</h3></div>
          {data.upcoming_inspections.length === 0 ? (
            <EmptyState title="Nothing due soon" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tyre</th>
                    <th>Bus</th>
                    <th>Days Since Last Reading</th>
                  </tr>
                </thead>
                <tbody>
                  {data.upcoming_inspections.map((t) => (
                    <tr key={t.tyre_id}>
                      <td><Link href={`/tyres/${t.tyre_id}`}>{t.tyre_number}</Link></td>
                      <td>{t.bus_registration_no || '-'}</td>
                      <td>{t.days_since_last_reading}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
            <Link href="/inspection-compliance">View full inspection compliance &rarr;</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
