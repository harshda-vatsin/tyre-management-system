'use client';

import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Reusable searchable bus picker, mirroring TyreSelect's combobox pattern:
// a single input that live-searches instead of a separate search box next to
// a plain <select>. Scoped to `depotId` (the backend's own /buses depot_id
// filter already exists; this just reuses it) -- disabled until a depot is
// chosen, and clears itself whenever the depot changes.
export default function BusSelect({ value, onChange, depotId, label = 'Bus', placeholder = 'Search registration number...' }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSelected(null);
    setQuery('');
    setResults([]);
    setOpen(false);
  }, [depotId]);

  useEffect(() => {
    if (!depotId) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      const params = new URLSearchParams({ depot_id: String(depotId), pageSize: '50' });
      if (query) params.set('search', query);
      api.get(`/buses?${params.toString()}`)
        .then((data) => {
          setResults(data.data);
          setOpen(true);
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query, depotId]);

  useEffect(() => {
    if (!value) {
      setSelected(null);
      setQuery('');
    }
  }, [value]);

  function handleSelect(bus) {
    setSelected(bus);
    setQuery(bus.registration_no);
    setOpen(false);
    onChange(bus);
  }

  const disabled = !depotId;

  return (
    <div className="field" style={{ position: 'relative' }}>
      <label>{label}</label>
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); if (selected) { setSelected(null); onChange(null); } }}
        onFocus={() => !disabled && results.length && setOpen(true)}
        placeholder={disabled ? 'Select a depot first' : placeholder}
        disabled={disabled}
        autoComplete="off"
      />
      {open && !disabled && (
        <ul
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
            background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 6,
            listStyle: 'none', margin: 0, padding: '0.25rem 0', maxHeight: 220, overflowY: 'auto',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {loading && <li style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>Loading...</li>}
          {!loading && results.length === 0 && (
            <li style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>No buses match.</li>
          )}
          {!loading && results.map((b) => (
            <li
              key={b.id}
              onClick={() => handleSelect(b)}
              style={{ padding: '0.4rem 0.6rem', cursor: 'pointer', fontSize: '0.85rem' }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <strong>{b.registration_no}</strong> — {b.bus_model_name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
