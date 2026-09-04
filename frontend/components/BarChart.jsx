'use client';

import React from 'react';

// Horizontal bar chart, plain HTML/CSS. Every bar carries a visible numeric
// label (not just color) per the dataviz relief rule -- some of the validated
// categorical slots used here (aqua, yellow) fall under 3:1 contrast on white.
// When onBarClick is given, rows with a nonzero value become clickable
// (button semantics, keyboard-operable) -- e.g. dashboard drill-downs.
export default function BarChart({ data, valueSuffix = '', onBarClick }) {
  const max = Math.max(1, ...data.map((d) => d.value));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      {data.map((d) => {
        const clickable = !!onBarClick && d.value > 0;
        return (
          <div
            key={d.label}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? () => onBarClick(d) : undefined}
            onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBarClick(d); } } : undefined}
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr 48px',
              alignItems: 'center',
              gap: '0.6rem',
              cursor: clickable ? 'pointer' : 'default',
              borderRadius: 4,
            }}
            className={clickable ? 'bar-chart-row-clickable' : undefined}
          >
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={d.label}>{d.label}</span>
            <div style={{ background: 'var(--surface-muted)', borderRadius: 4, height: 10, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${(d.value / max) * 100}%`,
                  minWidth: d.value > 0 ? 4 : 0,
                  height: '100%',
                  background: d.color,
                  borderRadius: 4,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <span style={{ fontSize: '0.8rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
              {d.value}{valueSuffix}
            </span>
          </div>
        );
      })}
    </div>
  );
}
