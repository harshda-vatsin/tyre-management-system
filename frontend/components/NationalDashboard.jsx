'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Warehouse, Bus, CircleDot, AlertTriangle, ShieldCheck, ArrowRight, PartyPopper } from 'lucide-react';
import { api } from '../lib/api.js';
import StatCard from './StatCard.jsx';
import BarChart from './BarChart.jsx';
import PageHeader from './PageHeader.jsx';
import EmptyState from './EmptyState.jsx';
import LoadingState from './LoadingState.jsx';
import { TYRE_STATUS_COLORS, ALERT_SEVERITY_COLORS } from '../lib/dashboardColors.js';

export default function NationalDashboard({ onDrillDown }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/dashboard/national').then(setData).catch((err) => setError(err.message));
  }, []);

  if (error) return <div className="card error-text">{error}</div>;
  if (!data) return <div className="card"><LoadingState label="Loading dashboard..." /></div>;

  const tyreStatusData = Object.entries(data.tyre_status_counts).map(([label, value]) => ({
    label, value, color: TYRE_STATUS_COLORS[label],
  }));
  const alertSeverityData = Object.entries(data.active_alert_counts).map(([label, value]) => ({
    label, value, color: ALERT_SEVERITY_COLORS[label],
  }));
  const noActiveAlerts = data.fleet_summary.active_alerts === 0;

  return (
    <div>
      <PageHeader title="National Dashboard" description="Fleet-wide tyre health, alerts, and compliance across every depot." />

      <div className="stat-grid">
        <StatCard label="Depots" value={data.fleet_summary.total_depots} accent="#4a3aa7" icon={Warehouse} />
        <StatCard label="Buses" value={data.fleet_summary.total_buses} accent="#2a78d6" icon={Bus} />
        <StatCard label="Tyres" value={data.fleet_summary.total_tyres} accent="#1baf7a" icon={CircleDot} />
        <StatCard label="Active Alerts" value={data.fleet_summary.active_alerts} accent="#b3261e" icon={AlertTriangle} />
        <StatCard label="Fleet Compliance" value={`${data.fleet_summary.overall_compliance_pct}%`} accent="#1a7f37" icon={ShieldCheck} />
      </div>

      <div className="grid-2col">
        <div className="card">
          <div className="card-title-row"><h3>Tyres by Status</h3></div>
          <BarChart data={tyreStatusData} />
        </div>
        <div className="card">
          <div className="card-title-row"><h3>Active Alerts by Severity</h3></div>
          {noActiveAlerts ? (
            <EmptyState icon={PartyPopper} title="No active alerts" description="Every tyre parameter across the fleet is within threshold." />
          ) : (
            <>
              <BarChart data={alertSeverityData} />
              <div style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
                <Link href="/alerts?status=Open">View all open alerts &rarr;</Link>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="grid-2col">
        <div className="card">
          <div className="card-title-row"><h3>Inspection Compliance</h3></div>
          <BarChart
            data={[
              { label: 'Due', value: data.inspection_counts.due, color: '#eda100' },
              { label: 'Overdue', value: data.inspection_counts.overdue, color: '#e34948' },
            ]}
          />
          <div style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
            <Link href="/inspection-compliance">View inspection compliance &rarr;</Link>
          </div>
        </div>
        <div className="card">
          <div className="card-title-row"><h3>Top 10 Flagged Buses</h3></div>
          {data.top_flagged_buses.length === 0 ? (
            <EmptyState title="No flagged buses" description="No bus currently has tyres in breach of threshold." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Bus</th>
                    <th>Depot</th>
                    <th>Flagged Tyres</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top_flagged_buses.map((b) => (
                    <tr key={b.bus_id}>
                      <td><Link href={`/buses/${b.bus_id}`}>{b.registration_no}</Link></td>
                      <td>
                        <button className="secondary" style={{ padding: '0.2rem 0.6rem', fontSize: '0.78rem' }} onClick={() => onDrillDown(b.depot_id)}>
                          {b.depot_name}
                        </button>
                      </td>
                      <td><span className="badge badge-critical">{b.flagged_count}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title-row"><h3>Depot-wise Compliance Score</h3></div>
        <p className="card-subtitle">Percentage of buses whose mounted tyres all have up-to-date readings.</p>
        {data.depot_compliance_scores.length === 0 ? (
          <EmptyState title="No depots with mounted tyres yet" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Depot</th>
                  <th>Compliant Buses</th>
                  <th>Total Buses</th>
                  <th>Compliance</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.depot_compliance_scores.map((d) => (
                  <tr key={d.depot_id}>
                    <td>{d.depot_name}</td>
                    <td>{d.compliant_buses}</td>
                    <td>{d.total_buses}</td>
                    <td>
                      <span className={`badge ${d.compliance_pct >= 80 ? 'badge-success' : d.compliance_pct >= 50 ? 'badge-warning' : 'badge-critical'}`}>
                        {d.compliance_pct}%
                      </span>
                    </td>
                    <td>
                      <button className="secondary" onClick={() => onDrillDown(d.depot_id)}>
                        View Depot <ArrowRight size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
