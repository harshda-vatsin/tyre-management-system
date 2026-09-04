'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api.js';
import Modal from './Modal.jsx';
import LoadingState from './LoadingState.jsx';
import EmptyState from './EmptyState.jsx';

// Drill-down from a "Tyres by Status" bar chart: lists every tyre currently
// in that status, each linking to its tyre detail page (which renders
// LifecycleProgressBar so the status is explained in context there).
export default function TyreStatusListModal({ status, depotId, onClose }) {
  const [tyres, setTyres] = useState(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    setTyres(null);
    setError('');
    const params = new URLSearchParams({ status, pageSize: '100' });
    if (depotId) params.set('depot_id', String(depotId));
    api.get(`/tyres?${params.toString()}`)
      .then((res) => { setTyres(res.data); setTotal(res.total); })
      .catch((err) => setError(err.message));
  }, [status, depotId]);

  const tyresHref = `/tyres?status=${encodeURIComponent(status)}${depotId ? `&depot_id=${depotId}` : ''}`;

  return (
    <Modal title={`Tyres — ${status}`} onClose={onClose} width={520}>
      {error && <div className="error-text">{error}</div>}
      {!error && tyres === null && <LoadingState label="Loading tyres..." />}
      {!error && tyres !== null && tyres.length === 0 && (
        <EmptyState title={`No tyres with status "${status}"`} />
      )}
      {!error && tyres !== null && tyres.length > 0 && (
        <>
          <div className="table-wrap" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Tyre Number</th>
                  <th>Brand</th>
                  <th>Depot</th>
                  <th>Bus / Position</th>
                </tr>
              </thead>
              <tbody>
                {tyres.map((t) => (
                  <tr key={t.id}>
                    <td><Link href={`/tyres/${t.id}`} onClick={onClose}>{t.tyre_number}</Link></td>
                    <td>{t.brand}</td>
                    <td>{t.depot_name || '-'}</td>
                    <td>{t.bus_registration_no ? `${t.bus_registration_no} / ${t.current_position}` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > tyres.length && (
            <div style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
              Showing {tyres.length} of {total}.{' '}
              <Link href={tyresHref} onClick={onClose}>View all in Tyres &rarr;</Link>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
