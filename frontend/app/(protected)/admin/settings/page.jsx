'use client';

import React, { useEffect, useState } from 'react';
import { api } from '../../../../lib/api.js';
import { useAuth } from '../../../../components/AuthContext.jsx';
import { useSettings } from '../../../../components/SettingsContext.jsx';
import { ROLES } from '../../../../lib/roles.js';
import PageHeader from '../../../../components/PageHeader.jsx';
import LoadingState from '../../../../components/LoadingState.jsx';

// SRS §8.3 System Parameter Configuration. Pressure unit is the one
// parameter with a concrete implementation today -- readings and thresholds
// stay stored in PSI regardless; this only changes what the rest of the UI
// displays and accepts input in.
export default function AdminSettingsPage() {
  const { user } = useAuth();
  const { pressureUnit, refresh } = useSettings();
  const canWrite = user?.role === ROLES.ADMIN;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [misImportEnabled, setMisImportEnabled] = useState('true');
  const [misImportSaving, setMisImportSaving] = useState(false);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    api.get('/settings').then((data) => {
      if (data.mis_import_enabled) setMisImportEnabled(data.mis_import_enabled);
    }).catch(() => {});
  }, []);

  async function handleUnitChange(unit) {
    if (unit === pressureUnit) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await api.put('/settings/pressure_unit', { value: unit });
      await refresh();
      setSuccess(`Pressure unit set to ${unit}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleMisImportToggle(enabled) {
    const value = enabled ? 'true' : 'false';
    setMisImportSaving(true);
    setError('');
    setSuccess('');
    try {
      await api.put('/settings/mis_import_enabled', { value });
      setMisImportEnabled(value);
      setSuccess(`MIS Excel Import ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setMisImportSaving(false);
    }
  }

  if (!canWrite) {
    return <div className="card error-text">Access denied. System parameters are Administrator-only.</div>;
  }

  return (
    <div>
      <PageHeader title="System Parameters" description="Fleet-wide display and unit preferences." />

      <div className="card">
        <div className="card-title-row"><h3>Pressure Unit</h3></div>
        <p className="card-subtitle">
          Controls how tyre pressure is displayed and entered across EBTMS. Stored readings and configured
          thresholds always stay in PSI internally, so switching units never changes any historical data.
        </p>
        {error && <div className="error-text" style={{ marginBottom: '0.75rem' }}>{error}</div>}
        {success && <div className="success-text" style={{ marginBottom: '0.75rem' }}>{success}</div>}
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Unit</label>
          <select value={pressureUnit} disabled={saving} onChange={(e) => handleUnitChange(e.target.value)}>
            <option value="PSI">PSI</option>
            <option value="kPa">kPa</option>
          </select>
        </div>
        {saving && <LoadingState label="Saving..." />}
      </div>

      <div className="card">
        <div className="card-title-row"><h3>MIS Excel Import</h3></div>
        <p className="card-subtitle">
          Kill switch for the MIS Excel importer. Disabling this immediately blocks new uploads, previews,
          confirms, and cancellations -- imports already committed are unaffected. Use this if an issue
          surfaces in production and there isn't time to deploy a fix.
        </p>
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Status</label>
          <select
            value={misImportEnabled}
            disabled={misImportSaving}
            onChange={(e) => handleMisImportToggle(e.target.value === 'true')}
          >
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </div>
        {misImportSaving && <LoadingState label="Saving..." />}
      </div>
    </div>
  );
}
