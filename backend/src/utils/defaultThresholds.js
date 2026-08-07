/**
 * @file defaultThresholds.js
 * @description The system's baseline GLOBAL threshold set (SRS 8.1) --
 * NSD/Pressure breach bounds plus the Inspection Interval/Escalation Days
 * compliance clocks. Extracted from seed.js so it has exactly one
 * definition, shared by the full demo seeder (src/seed.js) and the
 * standalone config-only reseed (src/seedThresholds.js) -- the latter
 * exists for restoring this configuration to an existing database (e.g.
 * after a bulk data import) without touching any other table the way
 * seed.js's clearAll() does.
 */

const DEFAULT_GLOBAL_THRESHOLDS = [
  { parameter_type: 'NSD', scope_type: 'GLOBAL', scope_id: null, warning_min: null, warning_max: 4, critical_min: null, critical_max: 2, unit: 'mm' },
  { parameter_type: 'PRESSURE', scope_type: 'GLOBAL', scope_id: null, warning_min: 90, warning_max: 120, critical_min: 80, critical_max: 130, unit: 'psi' },
  { parameter_type: 'INSPECTION_INTERVAL', scope_type: 'GLOBAL', scope_id: null, warning_min: null, warning_max: 7, critical_min: null, critical_max: 14, unit: 'days' },
  { parameter_type: 'ESCALATION_DAYS', scope_type: 'GLOBAL', scope_id: null, warning_min: null, warning_max: 3, critical_min: null, critical_max: null, unit: 'days' },
];

module.exports = { DEFAULT_GLOBAL_THRESHOLDS };
