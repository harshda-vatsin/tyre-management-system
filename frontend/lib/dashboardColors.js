// Validated categorical palette (dataviz skill, fixed order, see
// scripts/validate_palette.js "#2a78d6,#1baf7a,#eda100,#e34948" --mode light).
// Reused by both National and Depot dashboards so tyre-status colors never
// drift between the two views. Now sourced from lib/tyreLifecycle.js, which
// maps every status (legacy + new lifecycle vocabulary) to one of these same
// 4 colors via its category, so re-exported here for existing imports.
export { TYRE_STATUS_COLORS } from './tyreLifecycle.js';

// Reuses the app's existing badge ink colors (Business Rules Engine
// milestone) rather than a fresh palette, so alert severity reads the same
// color everywhere it appears.
export const ALERT_SEVERITY_COLORS = {
  Warning: '#9a6700',
  Critical: '#b3261e',
};
