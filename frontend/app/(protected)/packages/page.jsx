'use client';

import React, { useEffect, useState } from 'react';
import { Plus, Package as PackageIcon } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import { ROLES } from '../../../lib/roles.js';
import PageHeader from '../../../components/PageHeader.jsx';
import Modal from '../../../components/Modal.jsx';
import RowActionsMenu from '../../../components/RowActionsMenu.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import EmptyState from '../../../components/EmptyState.jsx';
import LoadingState from '../../../components/LoadingState.jsx';
import FilterBar from '../../../components/FilterBar.jsx';

const EMPTY_FORM = { name: '', code: '' };
const STATUS_OPTIONS = [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }];

// Package is a contractual/route grouping tracked independently of Depot
// (see MIS Depth Expansion notes) -- this page mirrors depots/page.jsx
// exactly, minus CSV import (not needed at this scale).
export default function PackagesPage() {
  const { user } = useAuth();
  const canWrite = user?.role === ROLES.ADMIN;

  const [packages, setPackages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState(null);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ is_active: '' });

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (filters.is_active) params.set('is_active', filters.is_active);
      const data = await api.get(`/packages?${params.toString()}`);
      setPackages(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters]);

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError('');
    setModalOpen(true);
  }

  function startEdit(pkg) {
    setEditingId(pkg.id);
    setForm({ name: pkg.name, code: pkg.code });
    setError('');
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      if (editingId) {
        await api.put(`/packages/${editingId}`, form);
      } else {
        await api.post('/packages', form);
      }
      closeModal();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleStatusChange() {
    setError('');
    try {
      await api.patch(`/packages/${statusTarget.id}/status`, { is_active: !statusTarget.is_active });
      setStatusTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
      setStatusTarget(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Packages"
        description="Contractual/route package groupings, tracked independently of Depot."
        actions={canWrite && <button onClick={startCreate}><Plus size={15} /> Add Package</button>}
      />

      <div className="card">
        <FilterBar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Name or code"
          values={filters}
          onSelectChange={(key, value) => setFilters((f) => ({ ...f, [key]: value }))}
          selects={[{ key: 'is_active', label: 'Status', options: STATUS_OPTIONS }]}
        />
        {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}
        {loading ? (
          <LoadingState label="Loading packages..." />
        ) : packages.length === 0 ? (
          <EmptyState
            icon={PackageIcon}
            title="No packages match these filters"
            description="Create your first package to start assigning buses to it."
            action={canWrite && <button onClick={startCreate}><Plus size={15} /> Add Package</button>}
          />
        ) : (
          <>
            <div className="table-wrap desktop-only">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Code</th>
                    <th>Active Buses</th>
                    <th>Total Tyres</th>
                    <th>Status</th>
                    {canWrite && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {packages.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>{p.code}</td>
                      <td>{p.active_bus_count}</td>
                      <td>{p.total_tyre_count}</td>
                      <td><span className={`badge ${p.is_active ? 'badge-success' : ''}`}>{p.is_active ? 'Active' : 'Inactive'}</span></td>
                      {canWrite && (
                        <td>
                          <RowActionsMenu
                            actions={[
                              { label: 'Edit', onClick: () => startEdit(p) },
                              { label: p.is_active ? 'Deactivate' : 'Activate', danger: p.is_active, onClick: () => setStatusTarget(p) },
                            ]}
                          />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mobile-list-cards mobile-only">
              {packages.map((p) => (
                <div key={p.id} className="mobile-record-card">
                  <div className="mobile-card-row mobile-card-header">
                    <span className="mobile-card-title">{p.name}</span>
                    <span className={`badge ${p.is_active ? 'badge-success' : ''}`}>{p.is_active ? 'Active' : 'Inactive'}</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Code</span>
                    <span className="mobile-card-value">{p.code}</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Active Buses / Tyres</span>
                    <span className="mobile-card-value">{p.active_bus_count} Buses / {p.total_tyre_count} Tyres</span>
                  </div>
                  {canWrite && (
                    <div className="mobile-card-footer">
                      <button className="secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => startEdit(p)}>Edit</button>
                      <button className={p.is_active ? 'danger' : 'success'} style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setStatusTarget(p)}>
                        {p.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {modalOpen && (
        <Modal title={editingId ? 'Edit Package' : 'New Package'} onClose={closeModal}>
          <form onSubmit={handleSubmit}>
            <div className="field">
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label>Code</label>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. P-1" required />
            </div>
            {error && <div className="error-text">{error}</div>}
            <div className="form-actions">
              <button type="submit">{editingId ? 'Save Changes' : 'Create Package'}</button>
              <button type="button" className="secondary" onClick={closeModal}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {statusTarget && (
        <ConfirmDialog
          title={statusTarget.is_active ? 'Deactivate Package' : 'Activate Package'}
          message={statusTarget.is_active
            ? `Deactivate "${statusTarget.name}"? It stays in the system with its full history. Nothing is deleted.`
            : `Reactivate "${statusTarget.name}"?`}
          confirmLabel={statusTarget.is_active ? 'Deactivate' : 'Activate'}
          danger={statusTarget.is_active}
          onConfirm={handleStatusChange}
          onCancel={() => setStatusTarget(null)}
        />
      )}
    </div>
  );
}
