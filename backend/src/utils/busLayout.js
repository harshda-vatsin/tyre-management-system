/**
 * @file busLayout.js
 * @description FR-BM-XX: predefined tyre position layouts keyed by total tyre
 * count. An admin only enters how many tyre positions a bus model has; the
 * position codes are generated from this fixed table, never manually
 * configured (no axle/left/right builder). Front axle is always a single
 * wheel per side (FL/FR); each additional rear axle contributes a dual
 * (inner+outer) wheel pair per side, prefixed by axle number from the 2nd
 * rear axle onward (R2L-O, R2L-I, ...).
 */

const LAYOUTS = {
  4: ['FL', 'FR', 'RL', 'RR'],
  6: ['FL', 'FR', 'RL-O', 'RL-I', 'RR-I', 'RR-O'],
  10: ['FL', 'FR', 'RL-O', 'RL-I', 'RR-I', 'RR-O', 'R2L-O', 'R2L-I', 'R2R-I', 'R2R-O'],
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

module.exports = { SUPPORTED_TYRE_COUNTS, getPositionLayout };
