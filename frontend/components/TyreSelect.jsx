'use client';

import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Reusable searchable tyre picker used by every Log Event sub-form. `status`
// narrows results (e.g. "In Store" when picking a replacement tyre); `mountedOnly`
// filters to tyres that currently have a bus/position assigned.
export default function TyreSelect({ value, onChange, status, mountedOnly, label = 'Tyre Number', placeholder = 'Search tyre number...' }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!query) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      const params = new URLSearchParams({ search: query, pageSize: '10' });
      if (status) params.set('status', status);
      const data = await api.get(`/tyres?${params.toString()}`);
      const filtered = mountedOnly ? data.data.filter((t) => t.current_bus_id) : data.data;
      setResults(filtered);
      setOpen(true);
    }, 250);
    return () => clearTimeout(t);
  }, [query, status, mountedOnly]);

  useEffect(() => {
    if (!value) {
      setSelected(null);
      setQuery('');
    }
  }, [value]);

  function handleSelect(tyre) {
    setSelected(tyre);
    setQuery(tyre.tyre_number);
    setOpen(false);
    onChange(tyre);
  }

  return (
    <div className="field" style={{ position: 'relative' }}>
      <label>{label}</label>
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); if (selected) { setSelected(null); onChange(null); } }}
        onFocus={() => results.length && setOpen(true)}
        placeholder={placeholder}
        autoComplete="off"
        required
      />
      {open && results.length > 0 && (
        <ul
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
            background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 6,
            listStyle: 'none', margin: 0, padding: '0.25rem 0', maxHeight: 220, overflowY: 'auto',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {results.map((t) => (
            <li
              key={t.id}
              onClick={() => handleSelect(t)}
              style={{ padding: '0.4rem 0.6rem', cursor: 'pointer', fontSize: '0.85rem' }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <strong>{t.tyre_number}</strong> — {t.brand} — <span className="badge">{t.status}</span>
              {t.bus_registration_no ? ` — ${t.bus_registration_no}/${t.current_position}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
