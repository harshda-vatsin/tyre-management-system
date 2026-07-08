'use client';

import React from 'react';
import { Search } from 'lucide-react';

// Generic search + select-filter row shared by Buses, Tyres, Users, Alerts,
// Inspection Compliance and Audit Log list pages.
// `selects` is an array of { key, label, options: [{ value, label }] }.
export default function FilterBar({ search, onSearchChange, searchPlaceholder = 'Search...', selects = [], values, onSelectChange }) {
  return (
    <div className="toolbar">
      <div className="field" style={{ minWidth: 220 }}>
        <label>Search</label>
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            style={{ paddingLeft: '2rem' }}
          />
        </div>
      </div>
      {selects.map((sel) => (
        <div className="field" style={{ minWidth: 160 }} key={sel.key}>
          <label>{sel.label}</label>
          <select value={values[sel.key] || ''} onChange={(e) => onSelectChange(sel.key, e.target.value)}>
            <option value="">All</option>
            {sel.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}
