/**
 * @file busLayout.js
 * @description FR-BM-XX: predefined tyre position layouts keyed by total tyre
 * count. An admin only enters how many tyre positions a bus model has; the
 * position codes are generated from this fixed table, never manually
 * configured (no axle/left/right builder). Front axle is always a single
 * wheel per side (FL/FR); each additional rear axle contributes a dual
 * (inner+outer) wheel pair per side, prefixed by axle number from the 2nd
 * rear axle onward (R2LO, R2LI, ...). Codes match the terminology real MIS
 * fleet reports use (FR/FL/RRI/RRO/RLI/RLO, no hyphen) rather than an
 * invented house style -- normalizePositionCode() below still accepts a
 * hyphenated variant as input either way.
 */

const LAYOUTS = {
  4: ['FL', 'FR', 'RL', 'RR'],
  6: ['FL', 'FR', 'RLO', 'RLI', 'RRI', 'RRO'],
  10: ['FL', 'FR', 'RLO', 'RLI', 'RRI', 'RRO', 'R2LO', 'R2LI', 'R2RI', 'R2RO'],
};

const SUPPORTED_TYRE_COUNTS = Object.keys(LAYOUTS).map(Number).sort((a, b) => a - b);

/**
 * Resolves the ordered, canonical tyre position codes for a total tyre count.
 * @param {number} numPositions
 * @returns {string[]|null} ordered position codes, or null if unsupported
 */
function getPositionLayout(numPositions) {
  return LAYOUTS[numPositions] || null;
}

// Aliases every LAYOUTS code to itself, plus its hyphen-stripped form -- MIS
// source workbooks commonly write the dual-wheel codes without the hyphen
// (RLO/RLI/RRI/RRO instead of RL-O/RL-I/RR-I/RR-O). Keyed uppercase with
// hyphens/whitespace stripped so lookup is a single normalize-then-Map.get.
const POSITION_ALIASES = new Map();
for (const codes of Object.values(LAYOUTS)) {
  for (const code of codes) {
    POSITION_ALIASES.set(code.replace(/[-\s]/g, '').toUpperCase(), code);
  }
}

/**
 * Maps free-text position codes (e.g. from an imported MIS workbook,
 * possibly hyphenated) to the canonical form LAYOUTS/tyreEvents.js
 * validation expects. Returns the input trimmed/uppercased unchanged if it
 * isn't a recognized alias -- callers validate against the real layout
 * afterward, so an unrecognized code still fails there rather than being
 * silently dropped.
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normalizePositionCode(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const key = trimmed.replace(/[-\s]/g, '').toUpperCase();
  return POSITION_ALIASES.get(key) || trimmed.toUpperCase();
}

module.exports = { SUPPORTED_TYRE_COUNTS, getPositionLayout, normalizePositionCode };
