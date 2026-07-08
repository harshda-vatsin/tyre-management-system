'use client';

import React from 'react';
import { getLayoutMetadata } from '../lib/busLayout.js';

// Top-view bus/wheel-position diagram. Placement comes entirely from
// busLayout.js's explicit metadata ({ code, row, side, slot }), looked up
// per position by its code -- never parsed or inferred from the code
// string. Every position sharing a `row` renders on the same CSS grid row
// (guaranteed by the browser's own grid track, not computed offsets), so an
// axle cannot render staggered. `slot` ('outer' | 'inner' | 'single') picks
// which edge of its cell a wheel sits against; that's the only thing that
// varies horizontally within a row.
//
// `renderTyre(slot)` keeps its existing contract: callers (Bus Detail,
// Batch Inspection) still return the full interactive element (Link or
// button, with the existing .bus-diagram-tyre classes and click/nav
// behaviour) for each position -- this component only decides where that
// element sits.
export default function BusTyreDiagram({ positionMap, renderTyre }) {
  const layoutMeta = getLayoutMetadata(positionMap.length);

  // No predefined layout matches this position count (shouldn't happen for
  // a bus created through the normal Bus Model flow, which only offers the
  // supported counts) -- degrade honestly to a single unstyled row rather
  // than guessing at side/axle placement.
  if (!layoutMeta) {
    return (
      <div className="bus-diagram">
        <div className="bus-diagram-body bus-diagram-body-fallback">
          {positionMap.map((slot) => renderTyre(slot))}
        </div>
      </div>
    );
  }

  const metaByCode = new Map(layoutMeta.map((p) => [p.code, p]));
  const rows = new Map();
  let maxRow = 0;

  positionMap.forEach((slot) => {
    const meta = metaByCode.get(slot.position);
    if (!meta) return;
    if (!rows.has(meta.row)) rows.set(meta.row, { L: [], R: [] });
    rows.get(meta.row)[meta.side].push({ slot, meta });
    if (meta.row > maxRow) maxRow = meta.row;
  });

  const rowCount = maxRow + 1;

  function renderCell(rowIndex, side) {
    const entries = rows.get(rowIndex)?.[side] || [];
    return (
      <div className={`bus-diagram-cell cell-${side === 'L' ? 'left' : 'right'}`} style={{ gridRow: rowIndex + 1 }}>
        {entries.map(({ slot, meta }) => (
          <div key={slot.position} className={`bus-diagram-slot slot-${meta.slot === 'inner' ? 'inner' : 'outer'}`}>
            {renderTyre(slot)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="bus-diagram">
      <div className="bus-diagram-body">
        <div className="bus-diagram-end front">FRONT</div>
        <div className="bus-diagram-grid" style={{ gridTemplateRows: `repeat(${rowCount}, var(--row-h))` }}>
          <div className="bus-diagram-chassis" />
          {Array.from({ length: rowCount }, (_, r) => (
            <React.Fragment key={r}>
              {renderCell(r, 'L')}
              {renderCell(r, 'R')}
            </React.Fragment>
          ))}
        </div>
        <div className="bus-diagram-end rear">REAR</div>
      </div>
    </div>
  );
}
