'use client';

import React from 'react';
import Link from 'next/link';

// When onClick or href is given, the whole tile becomes a drill-down
// affordance (dashboard KPI -> filtered list), matching the "Tyres by
// Status" bar chart's click-through pattern.
export default function StatCard({ label, value, sublabel, accent, icon: Icon, onClick, href }) {
  const clickable = !!(onClick || href);
  const content = (
    <>
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
    </>
  );

  if (href) {
    return (
      <Link href={href} className="stat-card stat-card-clickable" style={accent ? { '--stat-accent': accent } : undefined}>
        {content}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div
        className="stat-card stat-card-clickable"
        style={accent ? { '--stat-accent': accent } : undefined}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      >
        {content}
      </div>
    );
  }

  return (
    <div className="stat-card" style={accent ? { '--stat-accent': accent } : undefined}>
      {content}
    </div>
  );
}
