'use client';

import React from 'react';

export default function StatCard({ label, value, sublabel, accent, icon: Icon }) {
  return (
    <div className="stat-card" style={accent ? { '--stat-accent': accent } : undefined}>
      {Icon && (
        <div className="stat-card-icon" style={{ background: `${accent}1a`, color: accent }}>
          <Icon size={18} />
        </div>
      )}
      <div style={{ minWidth: 0 }}>
        <div className="stat-card-label">{label}</div>
        <div className="stat-card-value">{value}</div>
        {sublabel && <div className="stat-card-sublabel">{sublabel}</div>}
      </div>
    </div>
  );
}
