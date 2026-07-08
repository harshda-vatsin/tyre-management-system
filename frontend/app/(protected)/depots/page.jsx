'use client';

import React, { useEffect, useState } from 'react';
import { Plus, Warehouse } from 'lucide-react';
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

const EMPTY_FORM = { name: '', code: '', region: '', address: '' };
const STATUS_OPTIONS = [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }];

export default function DepotsPage() {
  const { user } = useAuth();
  const canWrite = user?.role === ROLES.ADMIN;

  const [depots, setDepots] = useState([]);
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
      const data = await api.get(`/depots?${params.toString()}`);
      setDepots(data);
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

  function startEdit(depot) {
    setEditingId(depot.id);
    setForm({ name: depot.name, code: depot.code, region: depot.region || '', address: depot.address || '' });
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
        await api.put(`/depots/${editingId}`, form);
      } else {
        await api.post('/depots', form);
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
      await api.patch(`/depots/${statusTarget.id}/status`, { is_active: !statusTarget.is_active });
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
        title="Depots"
        description="Depot master data — regional facilities operating the fleet."
        actions={canWrite && (
          <button onClick={startCreate}><Plus size={15} /> Add Depot</button>
        )}
      />

      <div className="card">
        <FilterBar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Name, code, or region"
          values={filters}
          onSelectChange={(key, value) => setFilters((f) => ({ ...f, [key]: value }))}
          selects={[{ key: 'is_active', label: 'Status', options: STATUS_OPTIONS }]}
        />
        {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}
        {loading ? (
          <LoadingState label="Loading depots..." />
        ) : depots.length === 0 ? (
          <EmptyState
            icon={Warehouse}
            title="No depots match these filters"
            description="Create your first depot to start assigning buses and tyres to it."
            action={canWrite && <button onClick={startCreate}><Plus size={15} /> Add Depot</button>}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Code</th>
                  <th>Region</th>
                  <th>Address</th>
                  <th>Active Buses</th>
                  <th>Total Tyres</th>
                  <th>Status</th>
                  {canWrite && <th></th>}
                </tr>
              </thead>
              <tbody>
                {depots.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td>{d.code}</td>
                    <td>{d.region}</td>
                    <td className="wrap">{d.address}</td>
                    <td>{d.active_bus_count}</td>
                    <td>{d.total_tyre_count}</td>
                    <td><span className={`badge ${d.is_active ? 'badge-success' : ''}`}>{d.is_active ? 'Active' : 'Inactive'}</span></td>
                    {canWrite && (
                      <td>
                        <RowActionsMenu
                          actions={[
                            { label: 'Edit', onClick: () => startEdit(d) },
                            { label: d.is_active ? 'Deactivate' : 'Activate', danger: d.is_active, onClick: () => setStatusTarget(d) },
                          ]}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen && (
        <Modal title={editingId ? 'Edit Depot' : 'New Depot'} onClose={closeModal}>
          <form onSubmit={handleSubmit}>
            <div className="field">
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label>Code</label>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
            </div>
            <div className="field">
              <label>Region</label>
              <input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
            </div>
            <div className="field">
              <label>Address</label>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            {error && <div className="error-text">{error}</div>}
            <div className="form-actions">
              <button type="submit">{editingId ? 'Save Changes' : 'Create Depot'}</button>
              <button type="button" className="secondary" onClick={closeModal}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {statusTarget && (
        <ConfirmDialog
          title={statusTarget.is_active ? 'Deactivate Depot' : 'Activate Depot'}
          message={statusTarget.is_active
            ? `Deactivate "${statusTarget.name}"? It stays in the system with its full history — nothing is deleted.`
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
