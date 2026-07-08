'use client';

import React, { useEffect, useState } from 'react';
import { Plus, Truck } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import { ROLES } from '../../../lib/roles.js';
import PageHeader from '../../../components/PageHeader.jsx';
import Drawer from '../../../components/Drawer.jsx';
import RowActionsMenu from '../../../components/RowActionsMenu.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import EmptyState from '../../../components/EmptyState.jsx';
import LoadingState from '../../../components/LoadingState.jsx';
import BusModelFields, { emptyBusModelForm as emptyForm } from '../../../components/BusModelFields.jsx';

export default function AdminBusModelsPage() {
  const { user } = useAuth();
  const canWrite = user?.role === ROLES.ADMIN;

  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState(emptyForm());
  const [editingId, setEditingId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      const data = await api.get(`/bus-models?${params.toString()}`);
      setModels(data);
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
  }, [search]);

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setError('');
    setDrawerOpen(true);
  }

  function startEdit(m) {
    setEditingId(m.id);
    setForm({
      name: m.name,
      manufacturer: m.manufacturer || '',
      num_positions: m.num_positions || emptyForm().num_positions,
    });
    setError('');
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    setEditingId(null);
    setForm(emptyForm());
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      if (editingId) {
        await api.put(`/bus-models/${editingId}`, form);
      } else {
        await api.post('/bus-models', form);
      }
      closeDrawer();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete() {
    setError('');
    try {
      await api.del(`/bus-models/${deleteTarget.id}`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
      setDeleteTarget(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Bus Models"
        description="Tyre position templates. Buses inherit their position layout from the model they're assigned to."
        actions={canWrite && <button onClick={startCreate}><Plus size={15} /> Add Bus Model</button>}
      />

      <div className="card">
        <div className="toolbar">
          <div className="field" style={{ maxWidth: 320 }}>
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or manufacturer" />
          </div>
        </div>
        {loading ? (
          <LoadingState label="Loading bus models..." />
        ) : models.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="No bus models found"
            description="Add a bus model to define its tyre position layout."
            action={canWrite && <button onClick={startCreate}><Plus size={15} /> Add Bus Model</button>}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Manufacturer</th>
                  <th>Positions</th>
                  <th>Status</th>
                  {canWrite && <th></th>}
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>{m.manufacturer}</td>
                    <td>{m.num_positions} ({m.position_labels.join(', ')})</td>
                    <td><span className={`badge ${m.is_active ? 'badge-success' : ''}`}>{m.is_active ? 'Active' : 'Inactive'}</span></td>
                    {canWrite && (
                      <td>
                        <RowActionsMenu
                          actions={[
                            { label: 'Edit', onClick: () => startEdit(m) },
                            { label: 'Delete', danger: true, onClick: () => setDeleteTarget(m) },
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

      {drawerOpen && (
        <Drawer
          title={editingId ? 'Edit Bus Model' : 'New Bus Model'}
          onClose={closeDrawer}
          footer={(
            <>
              <button type="submit" form="bus-model-form">{editingId ? 'Save Changes' : 'Create Bus Model'}</button>
              <button type="button" className="secondary" onClick={closeDrawer}>Cancel</button>
            </>
          )}
        >
          <form id="bus-model-form" onSubmit={handleSubmit}>
            <BusModelFields form={form} setForm={setForm} />
            {error && <div className="error-text">{error}</div>}
          </form>
        </Drawer>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete Bus Model"
          message={`Delete bus model "${deleteTarget.name}"? This is blocked if any bus uses it.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
