'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, CircleDot, UploadCloud } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { useAuth } from '../../../components/AuthContext.jsx';
import { ROLES, FLEET_WIDE_ROLES } from '../../../lib/roles.js';
import PageHeader from '../../../components/PageHeader.jsx';
import Drawer from '../../../components/Drawer.jsx';
import RowActionsMenu from '../../../components/RowActionsMenu.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import EmptyState from '../../../components/EmptyState.jsx';
import LoadingState from '../../../components/LoadingState.jsx';
import FilterBar from '../../../components/FilterBar.jsx';
import Pagination from '../../../components/Pagination.jsx';
import CsvImportModal from '../../../components/CsvImportModal.jsx';

const IMPORT_COLUMNS = [
  { key: 'tyre_number', required: true, example: 'TY001' },
  { key: 'brand', required: true, example: 'MRF' },
  { key: 'model', example: 'ZTX' },
  { key: 'size', example: '295/80R22.5' },
  { key: 'purchase_date', example: '2025-01-15' },
  { key: 'initial_nsd', example: '18' },
  { key: 'status', example: 'In Store' },
  { key: 'current_bus_id', example: '' },
  { key: 'current_position', example: '' },
  { key: 'current_depot_id', example: '2' },
];

const STATUS_OPTIONS = ['In Service', 'In Store', 'Condemned', 'Under Repair'];
const STATUS_BADGE = { 'In Service': 'badge-success', 'In Store': 'badge-info', Condemned: 'badge-critical', 'Under Repair': 'badge-warning' };

function emptyForm(defaultDepotId) {
  return {
    tyre_number: '', brand: '', model: '', size: '', purchase_date: '', initial_nsd: '',
    status: 'In Store', current_bus_id: '', current_position: '', current_depot_id: defaultDepotId || '',
  };
}

export default function TyresPage() {
  const { user } = useAuth();
  const canWrite = user?.role === ROLES.ADMIN || user?.role === ROLES.DEPOT_MANAGER;
  const isFleetWide = FLEET_WIDE_ROLES.includes(user?.role);

  const [tyres, setTyres] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', depot_id: '', brand: '' });

  const [depots, setDepots] = useState([]);
  const [buses, setBuses] = useState([]);
  const [busPositions, setBusPositions] = useState([]);
  const [form, setForm] = useState(emptyForm(user?.depot_id));
  const [editingId, setEditingId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [importOpen, setImportOpen] = useState(false);

  async function loadLookups() {
    const [d, b] = await Promise.all([api.get('/depots'), api.get('/buses?pageSize=100')]);
    setDepots(d);
    setBuses(b.data);
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (filters.status) params.set('status', filters.status);
      if (filters.depot_id) params.set('depot_id', filters.depot_id);
      if (filters.brand) params.set('brand', filters.brand);
      const data = await api.get(`/tyres?${params.toString()}`);
      setTyres(data.data);
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

  useEffect(() => {
    const bus = buses.find((b) => b.id === Number(form.current_bus_id));
    setBusPositions(bus ? bus.position_labels : []);
  }, [form.current_bus_id, buses]);

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm(user?.depot_id));
    setError('');
    setDrawerOpen(true);
  }

  function startEdit(tyre) {
    setEditingId(tyre.id);
    setForm({
      tyre_number: tyre.tyre_number,
      brand: tyre.brand,
      model: tyre.model || '',
      size: tyre.size || '',
      purchase_date: tyre.purchase_date || '',
      initial_nsd: tyre.initial_nsd ?? '',
      status: tyre.status,
      current_bus_id: tyre.current_bus_id || '',
      current_position: tyre.current_position || '',
      current_depot_id: tyre.current_depot_id || '',
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
      const payload = {
        ...form,
        initial_nsd: form.initial_nsd === '' ? null : Number(form.initial_nsd),
        current_bus_id: form.current_bus_id ? Number(form.current_bus_id) : null,
        current_position: form.current_bus_id ? form.current_position : null,
        current_depot_id: form.current_depot_id ? Number(form.current_depot_id) : null,
      };
      if (editingId) {
        await api.put(`/tyres/${editingId}`, payload);
      } else {
        await api.post('/tyres', payload);
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
      await api.del(`/tyres/${deleteTarget.id}`);
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
        title="Tyres"
        description="Tyre master data: brand, size, status, and current mount."
        actions={canWrite && (
          <>
            <button className="secondary" onClick={() => setImportOpen(true)}><UploadCloud size={15} /> Import CSV</button>
            <button onClick={startCreate}><Plus size={15} /> Add Tyre</button>
          </>
        )}
      />

      <div className="card">
        <FilterBar
          search={search}
          onSearchChange={(v) => { setPage(1); setSearch(v); }}
          searchPlaceholder="Tyre number, brand, or model"
          values={filters}
          onSelectChange={(key, value) => { setPage(1); setFilters((f) => ({ ...f, [key]: value })); }}
          selects={[
            { key: 'status', label: 'Status', options: STATUS_OPTIONS.map((s) => ({ value: s, label: s })) },
            ...(isFleetWide ? [{ key: 'depot_id', label: 'Depot', options: depots.map((d) => ({ value: d.id, label: d.name })) }] : []),
          ]}
        />
        {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}
        {loading ? (
          <LoadingState label="Loading tyres..." />
        ) : tyres.length === 0 ? (
          <EmptyState icon={CircleDot} title="No tyres match these filters" />
        ) : (
          <>
            <div className="table-wrap desktop-only">
              <table>
                <thead>
                  <tr>
                    <th>Tyre Number</th>
                    <th>Brand</th>
                    <th>Status</th>
                    <th>Depot</th>
                    <th>Bus / Position</th>
                    {canWrite && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {tyres.map((t) => (
                    <tr key={t.id}>
                      <td><Link href={`/tyres/${t.id}`}>{t.tyre_number}</Link></td>
                      <td>{t.brand}</td>
                      <td><span className={`badge ${STATUS_BADGE[t.status] || ''}`}>{t.status}</span></td>
                      <td>{t.depot_name || '-'}</td>
                      <td>{t.bus_registration_no ? `${t.bus_registration_no} / ${t.current_position}` : '-'}</td>
                      {canWrite && (
                        <td>
                          <RowActionsMenu
                            actions={[
                              { label: 'Edit', onClick: () => startEdit(t) },
                              { label: 'Delete', danger: true, hidden: user.role !== ROLES.ADMIN, onClick: () => setDeleteTarget(t) },
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
              {tyres.map((t) => (
                <div key={t.id} className="mobile-record-card">
                  <div className="mobile-card-row mobile-card-header">
                    <Link href={`/tyres/${t.id}`} className="mobile-card-title">{t.tyre_number}</Link>
                    <span className={`badge ${STATUS_BADGE[t.status] || ''}`}>{t.status}</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Brand / Size</span>
                    <span className="mobile-card-value">{t.brand} {t.size ? `(${t.size})` : ''}</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Depot</span>
                    <span className="mobile-card-value">{t.depot_name || '-'}</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Bus / Position</span>
                    <span className="mobile-card-value">{t.bus_registration_no ? `${t.bus_registration_no} / ${t.current_position}` : '-'}</span>
                  </div>
                  {canWrite && (
                    <div className="mobile-card-footer">
                      <button className="secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => startEdit(t)}>Edit</button>
                      {user.role === ROLES.ADMIN && (
                        <button className="danger" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setDeleteTarget(t)}>Delete</button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
          </>
        )}
      </div>

      {drawerOpen && (
        <Drawer
          title={editingId ? 'Edit Tyre' : 'New Tyre'}
          onClose={closeDrawer}
          footer={(
            <>
              <button type="submit" form="tyre-form">{editingId ? 'Save Changes' : 'Create Tyre'}</button>
              <button type="button" className="secondary" onClick={closeDrawer}>Cancel</button>
            </>
          )}
        >
          <form id="tyre-form" onSubmit={handleSubmit}>
            <div className="field">
              <label>Tyre Number</label>
              <input value={form.tyre_number} onChange={(e) => setForm({ ...form, tyre_number: e.target.value })} required />
            </div>
            <div className="field">
              <label>Brand / Manufacturer</label>
              <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} required />
            </div>
            <div className="field">
              <label>Model / Type</label>
              <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </div>
            <div className="field">
              <label>Size</label>
              <input value={form.size} onChange={(e) => setForm({ ...form, size: e.target.value })} placeholder="e.g. 275/70 R22.5" />
            </div>
            <div className="field">
              <label>Date of Purchase</label>
              <input type="date" value={form.purchase_date} onChange={(e) => setForm({ ...form, purchase_date: e.target.value })} />
            </div>
            <div className="field">
              <label>Initial NSD</label>
              <div className="input-suffix-wrap">
                <input type="number" step="0.1" value={form.initial_nsd} onChange={(e) => setForm({ ...form, initial_nsd: e.target.value })} />
                <span className="input-suffix">mm</span>
              </div>
            </div>
            <div className="field">
              <label>Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Depot</label>
              <select value={form.current_depot_id} onChange={(e) => setForm({ ...form, current_depot_id: e.target.value })} disabled={!!form.current_bus_id}>
                <option value="">Unassigned</option>
                {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Current Bus</label>
              <select value={form.current_bus_id} onChange={(e) => setForm({ ...form, current_bus_id: e.target.value, current_position: '' })}>
                <option value="">Not mounted (in store)</option>
                {buses.map((b) => <option key={b.id} value={b.id}>{b.registration_no}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Current Position</label>
              <select value={form.current_position} onChange={(e) => setForm({ ...form, current_position: e.target.value })} disabled={!form.current_bus_id}>
                <option value="">Select position</option>
                {busPositions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            {error && <div className="error-text">{error}</div>}
          </form>
        </Drawer>
      )}

      {importOpen && (
        <CsvImportModal
          entity="tyres"
          title="Import Tyres from CSV"
          columns={IMPORT_COLUMNS}
          onClose={() => setImportOpen(false)}
          onImported={load}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete Tyre"
          message={`Delete tyre record "${deleteTarget.tyre_number}"? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
