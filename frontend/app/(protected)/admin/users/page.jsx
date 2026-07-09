'use client';

import React, { useEffect, useState } from 'react';
import { Plus, Users as UsersIcon, KeyRound } from 'lucide-react';
import { api } from '../../../../lib/api.js';
import { useAuth } from '../../../../components/AuthContext.jsx';
import { ROLES } from '../../../../lib/roles.js';
import PageHeader from '../../../../components/PageHeader.jsx';
import Drawer from '../../../../components/Drawer.jsx';
import Modal from '../../../../components/Modal.jsx';
import RowActionsMenu from '../../../../components/RowActionsMenu.jsx';
import ConfirmDialog from '../../../../components/ConfirmDialog.jsx';
import EmptyState from '../../../../components/EmptyState.jsx';
import LoadingState from '../../../../components/LoadingState.jsx';
import FilterBar from '../../../../components/FilterBar.jsx';
import Pagination from '../../../../components/Pagination.jsx';

const ALL_ROLES = Object.values(ROLES);
const DEPOT_SCOPED_ROLES = [ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR];

function emptyForm() {
  return { username: '', email: '', full_name: '', role: ROLES.TYRE_SUPERVISOR, depot_id: '', password: '' };
}

export default function AdminUsersPage() {
  const { user: me } = useAuth();

  if (me?.role !== ROLES.ADMIN) {
    return <div className="card error-text">Access denied. User management is restricted to Administrators.</div>;
  }

  return <AdminUsersContent me={me} />;
}

function AdminUsersContent({ me }) {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ role: '', is_active: '' });
  const [depots, setDepots] = useState([]);

  const [form, setForm] = useState(emptyForm());
  const [editingId, setEditingId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState(null);
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (filters.role) params.set('role', filters.role);
      if (filters.is_active) params.set('is_active', filters.is_active);
      const data = await api.get(`/users?${params.toString()}`);
      setUsers(data.data);
      setTotal(data.total);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { api.get('/depots').then(setDepots).catch(() => {}); }, []);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters, page]);

  function needsDepot(role) {
    return DEPOT_SCOPED_ROLES.includes(role);
  }

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setError('');
    setDrawerOpen(true);
  }

  function startEdit(u) {
    setEditingId(u.id);
    setForm({ username: u.username, email: u.email, full_name: u.full_name, role: u.role, depot_id: u.depot_id || '', password: '' });
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
      const payload = {
        username: form.username,
        email: form.email,
        full_name: form.full_name,
        role: form.role,
        depot_id: needsDepot(form.role) ? Number(form.depot_id) : (form.depot_id ? Number(form.depot_id) : null),
      };
      if (editingId) {
        await api.put(`/users/${editingId}`, payload);
      } else {
        await api.post('/users', { ...payload, password: form.password });
      }
      closeDrawer();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleStatusChange() {
    setError('');
    try {
      await api.patch(`/users/${statusTarget.id}/status`, { is_active: !statusTarget.is_active });
      setStatusTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
      setStatusTarget(null);
    }
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    setResetError('');
    try {
      await api.post(`/users/${resetTarget.id}/reset-password`, { new_password: resetPassword });
      setResetTarget(null);
      setResetPassword('');
    } catch (err) {
      setResetError(err.message);
    }
  }

  return (
    <div>
      <PageHeader
        title="Users"
        description="Accounts, roles, and depot scoping for everyone with system access."
        actions={<button onClick={startCreate}><Plus size={15} /> Add User</button>}
      />

      <div className="card">
        <FilterBar
          search={search}
          onSearchChange={(v) => { setPage(1); setSearch(v); }}
          searchPlaceholder="Username, email, or name"
          values={filters}
          onSelectChange={(key, value) => { setPage(1); setFilters((f) => ({ ...f, [key]: value })); }}
          selects={[
            { key: 'role', label: 'Role', options: ALL_ROLES.map((r) => ({ value: r, label: r })) },
            { key: 'is_active', label: 'Status', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }] },
          ]}
        />
        {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}
        {loading ? (
          <LoadingState label="Loading users..." />
        ) : users.length === 0 ? (
          <EmptyState icon={UsersIcon} title="No users match these filters" />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Username</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Depot</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.full_name}</td>
                      <td>{u.username}</td>
                      <td>{u.email}</td>
                      <td>{u.role}</td>
                      <td>{depots.find((d) => d.id === u.depot_id)?.name || '-'}</td>
                      <td><span className={`badge ${u.is_active ? 'badge-success' : ''}`}>{u.is_active ? 'Active' : 'Inactive'}</span></td>
                      <td>
                        <RowActionsMenu
                          actions={[
                            { label: 'Edit', onClick: () => startEdit(u) },
                            { label: 'Reset Password', onClick: () => setResetTarget(u) },
                            {
                              label: u.is_active ? 'Deactivate' : 'Activate',
                              danger: u.is_active,
                              hidden: u.is_active && u.id === me.id,
                              onClick: () => setStatusTarget(u),
                            },
                          ]}
                        />
                      </td>
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
          title={editingId ? 'Edit User' : 'New User'}
          onClose={closeDrawer}
          footer={(
            <>
              <button type="submit" form="user-form">{editingId ? 'Save Changes' : 'Create User'}</button>
              <button type="button" className="secondary" onClick={closeDrawer}>Cancel</button>
            </>
          )}
        >
          <form id="user-form" onSubmit={handleSubmit}>
            <div className="field">
              <label>Username</label>
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
            </div>
            <div className="field">
              <label>Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div className="field">
              <label>Full Name</label>
              <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
            </div>
            <div className="field">
              <label>Role</label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {ALL_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Assigned Depot {needsDepot(form.role) ? '(required)' : '(optional)'}</label>
              <select value={form.depot_id} onChange={(e) => setForm({ ...form, depot_id: e.target.value })} required={needsDepot(form.role)}>
                <option value="">{needsDepot(form.role) ? 'Select depot' : 'All depots'}</option>
                {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            {!editingId && (
              <div className="field">
                <label>Initial Password</label>
                <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
                <span className="field-hint">Min 8 characters, at least one letter and one number.</span>
              </div>
            )}
            {error && <div className="error-text">{error}</div>}
          </form>
        </Drawer>
      )}

      {resetTarget && (
        <Modal title={`Reset Password: ${resetTarget.username}`} onClose={() => setResetTarget(null)}>
          <form onSubmit={handleResetPassword}>
            <div className="field">
              <label>New Password</label>
              <input type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} required minLength={8} />
            </div>
            {resetError && <div className="error-text">{resetError}</div>}
            <div className="form-actions">
              <button type="submit"><KeyRound size={15} /> Reset Password</button>
              <button type="button" className="secondary" onClick={() => setResetTarget(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {statusTarget && (
        <ConfirmDialog
          title={statusTarget.is_active ? 'Deactivate User' : 'Activate User'}
          message={statusTarget.is_active
            ? `Deactivate "${statusTarget.username}"? They will no longer be able to sign in.`
            : `Reactivate "${statusTarget.username}"?`}
          confirmLabel={statusTarget.is_active ? 'Deactivate' : 'Activate'}
          danger={statusTarget.is_active}
          onConfirm={handleStatusChange}
          onCancel={() => setStatusTarget(null)}
        />
      )}
    </div>
  );
}
