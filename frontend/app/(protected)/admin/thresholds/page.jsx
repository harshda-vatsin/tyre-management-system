'use client';

import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../../../../lib/api.js';
import { useAuth } from '../../../../components/AuthContext.jsx';
import { ROLES } from '../../../../lib/roles.js';
import Modal from '../../../../components/Modal.jsx';
import ConfirmDialog from '../../../../components/ConfirmDialog.jsx';
import RowActionsMenu from '../../../../components/RowActionsMenu.jsx';
import PageHeader from '../../../../components/PageHeader.jsx';
import LoadingState from '../../../../components/LoadingState.jsx';

const PARAMETER_INFO = {
  NSD: { label: 'NSD (Tread Depth)', unit: 'mm', usesMinMax: false, scopes: ['GLOBAL', 'DEPOT'] },
  PRESSURE: { label: 'Tyre Pressure', unit: 'psi', usesMinMax: true, scopes: ['GLOBAL', 'BUS_MODEL'] },
  INSPECTION_INTERVAL: { label: 'Inspection Interval', unit: 'days', usesMinMax: false, scopes: ['GLOBAL'] },
  ESCALATION_DAYS: { label: 'Alert Escalation', unit: 'days', usesMinMax: false, scopes: ['GLOBAL'], noCritical: true },
};

function emptyValueForm(info) {
  return info.usesMinMax
    ? { warning_min: '', warning_max: '', critical_min: '', critical_max: '', unit: info.unit }
    : { warning_max: '', critical_max: '', unit: info.unit };
}

export default function AdminThresholdsPage() {
  const { user } = useAuth();
  const canWrite = user?.role === ROLES.ADMIN;
  const [thresholds, setThresholds] = useState([]);
  const [depots, setDepots] = useState([]);
  const [busModels, setBusModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editing, setEditing] = useState(null); // threshold row being edited
  const [editForm, setEditForm] = useState(null);

  const [newParam, setNewParam] = useState('');
  const [newScopeId, setNewScopeId] = useState('');
  const [newForm, setNewForm] = useState(null);

  const [deactivateTarget, setDeactivateTarget] = useState(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [t, d, m] = await Promise.all([api.get('/thresholds'), api.get('/depots'), api.get('/bus-models')]);
      setThresholds(t);
      setDepots(d);
      setBusModels(m);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function startEdit(th) {
    const info = PARAMETER_INFO[th.parameter_type];
    setEditing(th);
    setEditForm(
      info.usesMinMax
        ? { warning_min: th.warning_min ?? '', warning_max: th.warning_max ?? '', critical_min: th.critical_min ?? '', critical_max: th.critical_max ?? '', unit: th.unit || info.unit }
        : { warning_max: th.warning_max ?? '', critical_max: th.critical_max ?? '', unit: th.unit || info.unit }
    );
  }

  async function saveEdit(e) {
    e.preventDefault();
    setError('');
    try {
      const payload = Object.fromEntries(Object.entries(editForm).map(([k, v]) => [k, v === '' ? null : (k === 'unit' ? v : Number(v))]));
      await api.put(`/thresholds/${editing.id}`, payload);
      setEditing(null);
      setEditForm(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function startNew(paramType) {
    setNewParam(paramType);
    setNewScopeId('');
    setNewForm(emptyValueForm(PARAMETER_INFO[paramType]));
  }

  async function saveNew(e) {
    e.preventDefault();
    setError('');
    try {
      const scopeType = PARAMETER_INFO[newParam].scopes.find((s) => s !== 'GLOBAL');
      const payload = {
        parameter_type: newParam,
        scope_type: scopeType,
        scope_id: Number(newScopeId),
        ...Object.fromEntries(Object.entries(newForm).map(([k, v]) => [k, v === '' || k === 'unit' ? v : Number(v)])),
      };
      await api.post('/thresholds', payload);
      setNewParam('');
      setNewForm(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDeactivate() {
    setError('');
    try {
      await api.patch(`/thresholds/${deactivateTarget.id}/deactivate`);
      setDeactivateTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
      setDeactivateTarget(null);
    }
  }

  function scopeLabel(th) {
    if (th.scope_type === 'GLOBAL') return 'Global';
    if (th.scope_type === 'DEPOT') return `Depot: ${th.depot_name}`;
    if (th.scope_type === 'BUS_MODEL') return `Bus Model: ${th.bus_model_name}`;
    return th.scope_type;
  }

  function renderValueFields(info, formState, setFormState) {
    if (info.usesMinMax) {
      return (
        <>
          <div className="field"><label>Warning Min</label><input type="number" value={formState.warning_min} onChange={(e) => setFormState({ ...formState, warning_min: e.target.value })} required /></div>
          <div className="field"><label>Warning Max</label><input type="number" value={formState.warning_max} onChange={(e) => setFormState({ ...formState, warning_max: e.target.value })} required /></div>
          <div className="field"><label>Critical Min</label><input type="number" value={formState.critical_min} onChange={(e) => setFormState({ ...formState, critical_min: e.target.value })} required /></div>
          <div className="field"><label>Critical Max</label><input type="number" value={formState.critical_max} onChange={(e) => setFormState({ ...formState, critical_max: e.target.value })} required /></div>
        </>
      );
    }
    return (
      <>
        <div className="field"><label>Warning Threshold</label><input type="number" value={formState.warning_max} onChange={(e) => setFormState({ ...formState, warning_max: e.target.value })} required /></div>
        {!info.noCritical && (
          <div className="field"><label>Critical Threshold</label><input type="number" value={formState.critical_max} onChange={(e) => setFormState({ ...formState, critical_max: e.target.value })} required /></div>
        )}
      </>
    );
  }

  function describeValues(th) {
    const info = PARAMETER_INFO[th.parameter_type];
    if (info.usesMinMax) {
      return `Warning: ${th.warning_min}-${th.warning_max} ${th.unit || ''} | Critical: ${th.critical_min}-${th.critical_max} ${th.unit || ''}`;
    }
    return `Warning: ${th.warning_max} ${th.unit || ''}${info.noCritical ? '' : ` | Critical: ${th.critical_max} ${th.unit || ''}`}`;
  }

  if (loading) return <div className="card"><LoadingState label="Loading thresholds..." /></div>;

  return (
    <div>
      <PageHeader title="Threshold Configuration" description="Global default limits per parameter, with optional depot or bus-model overrides." />
      {error && <div className="error-text" style={{ marginBottom: '1rem' }}>{error}</div>}

      {Object.entries(PARAMETER_INFO).map(([paramType, info]) => {
        const rows = thresholds.filter((t) => t.parameter_type === paramType);
        const globalRow = rows.find((r) => r.scope_type === 'GLOBAL');
        const overrideRows = rows.filter((r) => r.scope_type !== 'GLOBAL');
        const overrideScope = info.scopes.find((s) => s !== 'GLOBAL');
        const scopeOptions = overrideScope === 'DEPOT' ? depots : overrideScope === 'BUS_MODEL' ? busModels : [];
        const usedScopeIds = new Set(overrideRows.map((r) => r.scope_id));
        const availableScopeOptions = scopeOptions.filter((s) => !usedScopeIds.has(s.id));

        return (
          <div className="card" key={paramType}>
            <div className="card-title-row"><h3>{info.label}</h3></div>

            {globalRow && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 0.9rem', background: 'var(--surface-muted)', borderRadius: 'var(--radius-md)', marginBottom: overrideRows.length ? '0.75rem' : 0 }}>
                <div>
                  <span className="badge badge-info" style={{ marginRight: '0.5rem' }}>Global Default</span>
                  <span style={{ fontSize: '0.85rem' }}>{describeValues(globalRow)}</span>
                </div>
                {canWrite && (
                  <button className="secondary" style={{ padding: '0.3rem 0.7rem', fontSize: '0.78rem' }} onClick={() => startEdit(globalRow)}>Edit</button>
                )}
              </div>
            )}

            {overrideRows.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Override Scope</th>
                      <th>Values</th>
                      <th>Last Updated By</th>
                      {canWrite && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {overrideRows.map((th) => (
                      <tr key={th.id}>
                        <td>{scopeLabel(th)}</td>
                        <td>{describeValues(th)}</td>
                        <td>{th.updated_by_username || '—'}</td>
                        {canWrite && (
                          <td>
                            <RowActionsMenu
                              actions={[
                                { label: 'Edit', onClick: () => startEdit(th) },
                                { label: 'Deactivate', danger: true, onClick: () => setDeactivateTarget(th) },
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

            {canWrite && overrideScope && (
              <button className="secondary" style={{ marginTop: '0.85rem' }} onClick={() => startNew(paramType)} disabled={availableScopeOptions.length === 0}>
                <Plus size={14} /> Add {overrideScope === 'DEPOT' ? 'Depot' : 'Bus Model'} Override
              </button>
            )}
          </div>
        );
      })}

      {editing && (
        <Modal title={`Edit Threshold — ${scopeLabel(editing)}`} onClose={() => setEditing(null)}>
          <form onSubmit={saveEdit}>
            {renderValueFields(PARAMETER_INFO[editing.parameter_type], editForm, setEditForm)}
            <div className="form-actions">
              <button type="submit">Save</button>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {newParam && (
        <Modal title={`Add ${PARAMETER_INFO[newParam].scopes.find((s) => s !== 'GLOBAL') === 'DEPOT' ? 'Depot' : 'Bus Model'} Override — ${PARAMETER_INFO[newParam].label}`} onClose={() => setNewParam('')}>
          <form onSubmit={saveNew}>
            <div className="field">
              <label>{PARAMETER_INFO[newParam].scopes.find((s) => s !== 'GLOBAL') === 'DEPOT' ? 'Depot' : 'Bus Model'}</label>
              <select value={newScopeId} onChange={(e) => setNewScopeId(e.target.value)} required>
                <option value="">Select</option>
                {(PARAMETER_INFO[newParam].scopes.find((s) => s !== 'GLOBAL') === 'DEPOT' ? depots : busModels)
                  .filter((s) => !thresholds.some((t) => t.parameter_type === newParam && t.scope_id === s.id))
                  .map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            {renderValueFields(PARAMETER_INFO[newParam], newForm, setNewForm)}
            <div className="form-actions">
              <button type="submit">Add Override</button>
              <button type="button" className="secondary" onClick={() => setNewParam('')}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {deactivateTarget && (
        <ConfirmDialog
          title="Deactivate Override"
          message="Deactivate this override? The scope will fall back to the global threshold."
          confirmLabel="Deactivate"
          onConfirm={handleDeactivate}
          onCancel={() => setDeactivateTarget(null)}
        />
      )}
    </div>
  );
}
