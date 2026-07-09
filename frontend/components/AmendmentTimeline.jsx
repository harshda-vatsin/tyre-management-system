'use client';

import React from 'react';
import { formatPressure } from '../lib/units.js';
import { formatDateTime } from '../lib/dates.js';
import { AMENDABLE_FIELDS, FIELD_LABELS } from '../lib/amendableFields.js';

function formatFieldValue(key, value, pressureUnit, busMap) {
  if (value === null || value === undefined || value === '') return '—';
  switch (key) {
    case 'nsd_value':
      return `${value} mm`;
    case 'pressure_value':
      return formatPressure(value, pressureUnit) || '—';
    case 'to_bus_id':
      return (busMap && busMap[value]) || `Bus #${value}`;
    case 'repair_type':
      return String(value).charAt(0).toUpperCase() + String(value).slice(1);
    default:
      return String(value);
  }
}

// Renders "Original -> Correction #1 -> Correction #2 -> ..." (oldest first,
// newest last) for one tyre_events row. `amendments` is expected already
// ordered by amended_at ascending (GET /events/:id/amendments's own order),
// so the running `current` values accumulate forward the same way the
// backend applied them.
export default function AmendmentTimeline({ event, amendments, pressureUnit, busMap }) {
  const fields = AMENDABLE_FIELDS[event.event_type] || [];
  let current = Object.fromEntries(fields.map((f) => [f, event[f]]));

  return (
    <div style={{ padding: '0.85rem 0.5rem' }}>
      <div className="detail-label">Original</div>
      <div className="detail-grid" style={{ marginBottom: '0.85rem' }}>
        {fields.map((f) => (
          <div key={f}>
            <div className="detail-label">{FIELD_LABELS[f] || f}</div>
            <div className="detail-value">{formatFieldValue(f, event[f], pressureUnit, busMap)}</div>
          </div>
        ))}
      </div>

      {amendments.map((a, idx) => {
        const corrected = JSON.parse(a.corrected_values_json);
        const before = { ...current };
        current = { ...current, ...corrected };
        return (
          <div
            key={a.id}
            style={{ borderTop: '1px dashed var(--border)', paddingTop: '0.75rem', marginTop: '0.75rem' }}
          >
            <div className="detail-label">Correction #{idx + 1}</div>
            <div className="detail-grid" style={{ marginBottom: '0.5rem' }}>
              {Object.keys(corrected).map((f) => (
                <div key={f}>
                  <div className="detail-label">{FIELD_LABELS[f] || f}</div>
                  <div className="detail-value">
                    <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)' }}>
                      {formatFieldValue(f, before[f], pressureUnit, busMap)}
                    </span>
                    {' → '}
                    <span>{formatFieldValue(f, corrected[f], pressureUnit, busMap)}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="detail-value" style={{ fontWeight: 400 }}>
              <span className="detail-label" style={{ display: 'block' }}>Reason</span>
              {a.reason}
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
              Corrected by {a.amended_by_name || a.amended_by_username || '—'} on {formatDateTime(a.amended_at)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
