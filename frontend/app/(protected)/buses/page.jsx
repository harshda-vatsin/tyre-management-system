'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Bus as BusIcon, UploadCloud } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import { ROLES, FLEET_WIDE_ROLES } from '../../../lib/roles.js';
import PageHeader from '../../../components/PageHeader.jsx';
import Drawer from '../../../components/Drawer.jsx';
import Modal from '../../../components/Modal.jsx';
import RowActionsMenu from '../../../components/RowActionsMenu.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import EmptyState from '../../../components/EmptyState.jsx';
import LoadingState from '../../../components/LoadingState.jsx';
import FilterBar from '../../../components/FilterBar.jsx';
import Pagination from '../../../components/Pagination.jsx';
import BusModelFields, { emptyBusModelForm } from '../../../components/BusModelFields.jsx';
import CsvImportModal from '../../../components/CsvImportModal.jsx';

const IMPORT_COLUMNS = [
  { key: 'registration_no', required: true, example: 'DL01AB1234' },
  { key: 'chassis_no', required: true, example: 'VIN123456789' },
  { key: 'bus_model_id', required: true, example: '1' },
  { key: 'depot_id', required: true, example: '2' },
  { key: 'year_of_manufacture', required: true, example: '2024' },
  { key: 'date_of_entry_into_fleet', required: true, example: '2024-05-10' },
  { key: 'status', example: 'Active' },
];

const STATUS_OPTIONS = ['Active', 'Under Maintenance', 'Decommissioned'];
const STATUS_BADGE = { Active: 'badge-success', 'Under Maintenance': 'badge-warning', Decommissioned: 'badge-critical' };
const CURRENT_YEAR = new Date().getFullYear();
const OTHER_MODEL_OPTION = '__other__';

// FR-BM-01: Bus Registration Number / Chassis Number (VIN) are standardized
// to trimmed, uppercase form — mirrors the same normalization applied
// server-side in routes/buses.js.
function normalizeCode(value) {
  return value.trim().toUpperCase();
}

function emptyForm(defaultDepotId) {
  return {
    registration_no: '', chassis_no: '', bus_model_id: '', depot_id: defaultDepotId || '',
    year_of_manufacture: '', date_of_entry_into_fleet: '', status: 'Active',
  };
}

export default function BusesPage() {
  const { user } = useAuth();
  const canWrite = user?.role === ROLES.ADMIN || user?.role === ROLES.DEPOT_MANAGER;
  const isFleetWide = FLEET_WIDE_ROLES.includes(user?.role);

  const [buses, setBuses] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', depot_id: '', bus_model_id: '' });

  const [depots, setDepots] = useState([]);
  const [models, setModels] = useState([]);
  const [form, setForm] = useState(emptyForm(user?.depot_id));
  const [editingId, setEditingId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [importOpen, setImportOpen] = useState(false);

  // "Other — Add New Model" quick-create popup, triggered from the Model /
  // Make select. Reuses the same BusModelFields component and /bus-models
  // endpoint as the Bus Models admin page, so there's one creation path.
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [newModelForm, setNewModelForm] = useState(emptyBusModelForm());
  const [newModelError, setNewModelError] = useState('');

  async function loadLookups() {
    const [d, m] = await Promise.all([api.get('/depots'), api.get('/bus-models')]);
    setDepots(d);
    setModels(m);
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (filters.status) params.set('status', filters.status);
      if (filters.depot_id) params.set('depot_id', filters.depot_id);
      if (filters.bus_model_id) params.set('bus_model_id', filters.bus_model_id);
      const data = await api.get(`/buses?${params.toString()}`);
      setBuses(data.data);
      setTotal(data.total);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadLookups(); }, []);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters, page]);

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm(user?.depot_id));
    setError('');
    setDrawerOpen(true);
  }

  function startEdit(bus) {
    setEditingId(bus.id);
    setForm({
      registration_no: bus.registration_no,
      chassis_no: bus.chassis_no,
      bus_model_id: bus.bus_model_id,
      depot_id: bus.depot_id,
      year_of_manufacture: bus.year_of_manufacture || '',
      date_of_entry_into_fleet: bus.date_of_entry_into_fleet || '',
      status: bus.status,
      odometer_km: bus.odometer_km,
    });
    setError('');
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    setEditingId(null);
    setForm(emptyForm(user?.depot_id));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      const { odometer_km, ...restForm } = form;
      const payload = {
        ...restForm,
        registration_no: normalizeCode(form.registration_no),
        chassis_no: normalizeCode(form.chassis_no),
        bus_model_id: Number(form.bus_model_id),
        depot_id: Number(form.depot_id),
      };
      if (editingId) {
        payload.odometer_km = form.odometer_km;
        await api.put(`/buses/${editingId}`, payload);
      } else {
        await api.post('/buses', payload);
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
      await api.del(`/buses/${deleteTarget.id}`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
      setDeleteTarget(null);
    }
  }

  function handleModelSelectChange(value) {
    if (value === OTHER_MODEL_OPTION) {
      setNewModelForm(emptyBusModelForm());
      setNewModelError('');
      setAddModelOpen(true);
      return;
    }
    setForm({ ...form, bus_model_id: value });
  }

  function closeAddModelModal() {
    setAddModelOpen(false);
    setNewModelForm(emptyBusModelForm());
    setNewModelError('');
  }

  async function handleCreateModel(e) {
    e.preventDefault();
    setNewModelError('');
    try {
      const created = await api.post('/bus-models', newModelForm);
      setModels((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setForm((f) => ({ ...f, bus_model_id: created.id }));
      closeAddModelModal();
    } catch (err) {
      setNewModelError(err.message);
    }
  }

  // FR-BM-01: Number of Tyre Positions is not stored on the bus record itself
  // — it's inherited from the selected Bus Model (existing FR-BM-02 relation)
  // — so it's shown here as a derived read-only value, not a duplicate field.
  const selectedModelPositions = models.find((m) => m.id === Number(form.bus_model_id))?.num_positions ?? null;

  return (
    <div>
      <PageHeader
        title="Buses"
        description="Fleet vehicle master data — model, depot assignment, and operating status."
        actions={canWrite && (
          <>
            <button className="secondary" onClick={() => setImportOpen(true)}><UploadCloud size={15} /> Import CSV</button>
            <button onClick={startCreate}><Plus size={15} /> Add Bus</button>
          </>
        )}
      />

      <div className="card">
        <FilterBar
          search={search}
          onSearchChange={(v) => { setPage(1); setSearch(v); }}
          searchPlaceholder="Registration or chassis number"
          values={filters}
          onSelectChange={(key, value) => { setPage(1); setFilters((f) => ({ ...f, [key]: value })); }}
          selects={[
            { key: 'status', label: 'Status', options: STATUS_OPTIONS.map((s) => ({ value: s, label: s })) },
            ...(isFleetWide ? [{ key: 'depot_id', label: 'Depot', options: depots.map((d) => ({ value: d.id, label: d.name })) }] : []),
            { key: 'bus_model_id', label: 'Model', options: models.map((m) => ({ value: m.id, label: m.name })) },
          ]}
        />
        {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}
        {loading ? (
          <LoadingState label="Loading buses..." />
        ) : buses.length === 0 ? (
          <EmptyState icon={BusIcon} title="No buses match these filters" />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Bus ID</th>
                    <th>Bus Registration Number</th>
                    <th>Model / Make</th>
                    <th>Associated Depot</th>
                    <th>Number of Tyre Positions</th>
                    <th>Status</th>
                    <th>Odometer</th>
                    {canWrite && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {buses.map((b) => (
                    <tr key={b.id}>
                      <td>#{b.id}</td>
                      <td><Link href={`/buses/${b.id}`}>{b.registration_no}</Link></td>
                      <td>{b.bus_model_name}</td>
                      <td>{b.depot_name}</td>
                      <td>{b.num_tyre_positions}</td>
                      <td><span className={`badge ${STATUS_BADGE[b.status] || ''}`}>{b.status}</span></td>
                      <td>{b.odometer_km.toLocaleString()} km</td>
                      {canWrite && (
                        <td>
                          <RowActionsMenu
                            actions={[
                              { label: 'Edit', onClick: () => startEdit(b) },
                              { label: 'Delete', danger: true, hidden: user.role !== ROLES.ADMIN, onClick: () => setDeleteTarget(b) },
                            ]}
                          />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
          </>
        )}
      </div>

      {drawerOpen && (
        <Drawer
          title={editingId ? 'Edit Bus' : 'New Bus'}
          onClose={closeDrawer}
          footer={(
            <>
              <button type="submit" form="bus-form">{editingId ? 'Save Changes' : 'Create Bus'}</button>
              <button type="button" className="secondary" onClick={closeDrawer}>Cancel</button>
            </>
          )}
        >
          <form id="bus-form" onSubmit={handleSubmit}>
            <div className="field">
              <label>Bus ID</label>
              <input value={editingId ? `#${editingId}` : 'Auto-generated on save'} disabled />
              <span className="field-hint">Assigned automatically by the system — not editable.</span>
            </div>
            <div className="field">
              <label>Bus Registration Number *</label>
              <input
                value={form.registration_no}
                onChange={(e) => setForm({ ...form, registration_no: e.target.value.toUpperCase() })}
                required
              />
            </div>
            <div className="field">
              <label>Chassis Number (VIN) *</label>
              <input
                value={form.chassis_no}
                onChange={(e) => setForm({ ...form, chassis_no: e.target.value.toUpperCase() })}
                required
              />
            </div>
            <div className="field">
              <label>Model / Make *</label>
              <select value={form.bus_model_id} onChange={(e) => handleModelSelectChange(e.target.value)} required>
                <option value="">Select model</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.num_positions} positions)</option>)}
                <option value={OTHER_MODEL_OPTION}>Other — Add New Model...</option>
              </select>
            </div>
            <div className="field">
              <label>Associated Depot *</label>
              <select
                value={form.depot_id}
                onChange={(e) => setForm({ ...form, depot_id: e.target.value })}
                disabled={!isFleetWide}
                required
              >
                <option value="">Select depot</option>
                {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Number of Tyre Positions</label>
              <input
                value={selectedModelPositions !== null ? selectedModelPositions : ''}
                placeholder="Select a model first"
                disabled
              />
              <span className="field-hint">Derived from the selected Model / Make's tyre position layout — not editable here.</span>
            </div>
            <div className="field">
              <label>Year of Manufacture *</label>
              <input
                type="number"
                max={CURRENT_YEAR}
                value={form.year_of_manufacture}
                onChange={(e) => setForm({ ...form, year_of_manufacture: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <label>Date of Entry into Fleet *</label>
              <input
                type="date"
                value={form.date_of_entry_into_fleet}
                onChange={(e) => setForm({ ...form, date_of_entry_into_fleet: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <label>Status *</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {error && <div className="error-text">{error}</div>}
          </form>
        </Drawer>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete Bus"
          message={`Delete bus "${deleteTarget.registration_no}"? This is blocked if tyres are mounted on it.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {importOpen && (
        <CsvImportModal
          entity="buses"
          title="Import Buses from CSV"
          columns={IMPORT_COLUMNS}
          onClose={() => setImportOpen(false)}
          onImported={load}
        />
      )}

      {addModelOpen && (
        <Modal title="Add New Bus Model" onClose={closeAddModelModal}>
          <form onSubmit={handleCreateModel}>
            <BusModelFields form={newModelForm} setForm={setNewModelForm} />
            {newModelError && <div className="error-text">{newModelError}</div>}
            <div className="form-actions">
              <button type="submit">Create Model</button>
              <button type="button" className="secondary" onClick={closeAddModelModal}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
