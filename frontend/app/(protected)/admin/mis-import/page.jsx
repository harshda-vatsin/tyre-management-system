'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FileSpreadsheet, Plus } from 'lucide-react';
import { api } from '../../../../lib/api.js';
import { useAuth } from '../../../../components/AuthContext.jsx';
import { ROLES } from '../../../../lib/roles.js';
import { formatDateTime } from '../../../../lib/dates.js';
import PageHeader from '../../../../components/PageHeader.jsx';
import EmptyState from '../../../../components/EmptyState.jsx';
import LoadingState from '../../../../components/LoadingState.jsx';
import Pagination from '../../../../components/Pagination.jsx';
import MisImportUploadModal from '../../../../components/MisImportUploadModal.jsx';

const STATUS_BADGE = {
  previewed: 'badge-info',
  queued: 'badge-warning',
  running: 'badge-warning',
  committed: 'badge-success',
  failed: 'badge-critical',
  cancelled: '',
};

export default function MisImportListPage() {
  const { user } = useAuth();

  if (user?.role !== ROLES.ADMIN) {
    return <div className="card error-text">Access denied. MIS Excel Import is restricted to Administrators.</div>;
  }

  return <MisImportListContent />;
}

function MisImportListContent() {
  const router = useRouter();
  const [sessions, setSessions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 15;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showUpload, setShowUpload] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/mis-imports?page=${page}&pageSize=${pageSize}`);
      setSessions(res.rows || []);
      setTotal(res.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="MIS Excel Import"
        description="Import the company's monthly MIS workbook -- Consumption, Puncture Repair, Retread, Scrap, Warranty, NSD, Rotation, and Wheel Alignment sheets all at once."
        actions={
          <button type="button" onClick={() => setShowUpload(true)}>
            <Plus size={15} /> New Import
          </button>
        }
      />

      <div className="card">
        {loading ? (
          <LoadingState label="Loading import sessions..." />
        ) : error ? (
          <div className="error-text">{error}</div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={FileSpreadsheet}
            title="No imports yet"
            description="Upload a workbook to see a full preview before anything is written to the database."
            action={<button type="button" onClick={() => setShowUpload(true)}><Plus size={15} /> New Import</button>}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Status</th>
                    <th>Rows Total</th>
                    <th>Rows Stored</th>
                    <th>Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td><Link href={`/admin/mis-import/${s.id}`}>{s.original_filename}</Link></td>
                      <td><span className={`badge ${STATUS_BADGE[s.status] || ''}`}>{s.status}</span></td>
                      <td>{s.rows_total}</td>
                      <td>{s.rows_stored}</td>
                      <td>{formatDateTime(s.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
          </>
        )}
      </div>

      {showUpload && (
        <MisImportUploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={(sessionId) => router.push(`/admin/mis-import/${sessionId}`)}
        />
      )}
    </div>
  );
}
