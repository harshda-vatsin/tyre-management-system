'use client';

import React from 'react';
import { getPositionLayout, SUPPORTED_TYRE_COUNTS } from '../lib/busLayout.js';

// Shared Bus Model form fields (Name, Manufacturer, Tyre Count), used by the
// Bus Models admin page and by the "Other - Add New Model" quick-create
// popup on the Buses page, so the two creation paths can never drift out of
// sync. FR-BM-XX: the admin only picks a total tyre count from the
// predefined set: tyre positions are system-generated from it, never
// manually configured.
export function emptyBusModelForm() {
  return { name: '', manufacturer: '', num_positions: SUPPORTED_TYRE_COUNTS[0] };
}

export default function BusModelFields({ form, setForm }) {
  const generatedCodes = getPositionLayout(form.num_positions) || [];

  return (
    <>
      <div className="field">
        <label>Name</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      </div>
      <div className="field">
        <label>Manufacturer</label>
        <input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} />
      </div>

      <div className="field">
        <label>Number of Tyre Positions</label>
        <select
          value={form.num_positions}
          onChange={(e) => setForm({ ...form, num_positions: Number(e.target.value) })}
        >
          {SUPPORTED_TYRE_COUNTS.map((count) => (
            <option key={count} value={count}>{count}</option>
          ))}
        </select>
        <span className="field-hint">The visual bus layout and position codes are generated automatically.</span>
      </div>

      <div className="field">
        <label>Generated Tyre Positions ({generatedCodes.length})</label>
        <div className="position-preview">
          {generatedCodes.map((code) => <span key={code} className="badge badge-info">{code}</span>)}
        </div>
        <span className="field-hint">Codes are assigned automatically, not editable.</span>
      </div>
    </>
  );
}
