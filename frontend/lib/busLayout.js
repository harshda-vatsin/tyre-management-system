// Frontend mirror of backend/src/utils/busLayout.js, used to render a live
// "this will generate: FL, FR, ..." preview and the bus position diagram.
// The backend remains the single source of truth for what actually gets
// stored (position codes only, unchanged here); this table additionally
// carries visual placement metadata that only the frontend needs, so it's
// the source of truth for where each code sits on the diagram.
//
// Each entry is { code, row, side, slot }:
//   - code: the canonical position code, identical to the backend's.
//   - row:  0-indexed axle row, front to rear (0 = front axle).
//   - side: 'L' or 'R'.
//   - slot: 'single' (front axle, one wheel per side), 'outer', or 'inner'
//           (a dual rear pair) -- purely a lookup key, never derived from
//           the code string.
const LAYOUTS = {
  4: [
    { code: 'FL', row: 0, side: 'L', slot: 'single' },
    { code: 'FR', row: 0, side: 'R', slot: 'single' },
    { code: 'RL', row: 1, side: 'L', slot: 'single' },
    { code: 'RR', row: 1, side: 'R', slot: 'single' },
  ],
  6: [
    { code: 'FL', row: 0, side: 'L', slot: 'single' },
    { code: 'FR', row: 0, side: 'R', slot: 'single' },
    { code: 'RL-O', row: 1, side: 'L', slot: 'outer' },
    { code: 'RL-I', row: 1, side: 'L', slot: 'inner' },
    { code: 'RR-I', row: 1, side: 'R', slot: 'inner' },
    { code: 'RR-O', row: 1, side: 'R', slot: 'outer' },
  ],
  10: [
    { code: 'FL', row: 0, side: 'L', slot: 'single' },
    { code: 'FR', row: 0, side: 'R', slot: 'single' },
    { code: 'RL-O', row: 1, side: 'L', slot: 'outer' },
    { code: 'RL-I', row: 1, side: 'L', slot: 'inner' },
    { code: 'RR-I', row: 1, side: 'R', slot: 'inner' },
    { code: 'RR-O', row: 1, side: 'R', slot: 'outer' },
    { code: 'R2L-O', row: 2, side: 'L', slot: 'outer' },
    { code: 'R2L-I', row: 2, side: 'L', slot: 'inner' },
    { code: 'R2R-I', row: 2, side: 'R', slot: 'inner' },
    { code: 'R2R-O', row: 2, side: 'R', slot: 'outer' },
  ],
};

export const SUPPORTED_TYRE_COUNTS = Object.keys(LAYOUTS).map(Number).sort((a, b) => a - b);

// Unchanged shape (array of code strings) for existing callers such as
// BusModelFields' "this will generate..." preview -- derived from the
// metadata table below, not maintained as a second parallel list.
export function getPositionLayout(numPositions) {
  const meta = LAYOUTS[numPositions];
  return meta ? meta.map((p) => p.code) : null;
}

// Explicit visual placement metadata for BusTyreDiagram. Consumers look up
// a position by its code (a plain equality lookup against this table) --
// they never parse or infer row/side/slot from the code's characters.
export function getLayoutMetadata(numPositions) {
  return LAYOUTS[numPositions] || null;
}
