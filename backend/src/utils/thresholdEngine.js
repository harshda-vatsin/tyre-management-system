/**
 * @file thresholdEngine.js
 * @description Engine to resolve active thresholds based on scoping rules (precedence: DEPOT/BUS_MODEL override, then GLOBAL)
 * and check input readings (NSD, Pressure, Inspection Age) against resolved warning/critical thresholds.
 */

const db = require('../db');

// SRS 8.1 + milestone precedence rule: Depot/Bus Model override first, then
// Global. NSD only overrides at DEPOT scope; PRESSURE only at BUS_MODEL scope;
// INSPECTION_INTERVAL and ESCALATION_DAYS are GLOBAL-only (see routes/thresholds.js
// ALLOWED_SCOPES, the single source of truth for which scopes are legal per
// parameter -- this module doesn't re-decide that, it just queries in precedence order).

/**
 * Resolves the active parameter threshold based on scope hierarchy:
 * 1. Checks for specific scope overrides (DEPOT for NSD, BUS_MODEL for PRESSURE).
 * 2. Cascades to the GLOBAL scope if no specific override is found.
 * 
 * @param {string} parameterType - Parameter category ('NSD', 'PRESSURE', 'INSPECTION_INTERVAL', 'ESCALATION_DAYS')
 * @param {object} [scopeContext] - Scope context inputs
 * @param {number|null} [scopeContext.depotId] - User's depot ID reference
 * @param {number|null} [scopeContext.busModelId] - Bus model ID reference
 * @returns {object|undefined} The resolved active threshold record row
 */
function resolveThreshold(parameterType, { depotId, busModelId } = {}) {
  if (parameterType === 'NSD' && depotId) {
    const override = db
      .prepare(`SELECT * FROM thresholds WHERE parameter_type = 'NSD' AND scope_type = 'DEPOT' AND scope_id = ? AND is_active = 1`)
      .get(depotId);
    if (override) return override;
  }
  if (parameterType === 'PRESSURE' && busModelId) {
    const override = db
      .prepare(`SELECT * FROM thresholds WHERE parameter_type = 'PRESSURE' AND scope_type = 'BUS_MODEL' AND scope_id = ? AND is_active = 1`)
      .get(busModelId);
    if (override) return override;
  }
  return db
    .prepare(`SELECT * FROM thresholds WHERE parameter_type = ? AND scope_type = 'GLOBAL' AND is_active = 1`)
    .get(parameterType);
}

// NSD is a single lower bound: the reading must stay ABOVE the configured
// max value to be safe (tread depth falling AT OR BELOW the line is the breach).

/**
 * Checks a Non-Skid Depth (NSD) value against the warning/critical lower limits.
 * 
 * @param {number} value - Measured tread depth value (mm)
 * @param {object|null} threshold - Active NSD threshold settings row
 * @returns {string} Evaluation flag result ('OK', 'WARNING', 'CRITICAL')
 */
function evaluateNsd(value, threshold) {
  if (!threshold) return 'OK';
  if (threshold.critical_max != null && value <= threshold.critical_max) return 'CRITICAL';
  if (threshold.warning_max != null && value <= threshold.warning_max) return 'WARNING';
  return 'OK';
}

// Pressure is a two-sided band: breach if the reading falls outside [min, max]
// at either severity level (SRS 8.1 example: "< 90 or > 120 PSI").

/**
 * Checks a pressure value against the warning/critical two-sided band limits.
 * 
 * @param {number} value - Measured tyre pressure (PSI)
 * @param {object|null} threshold - Active Pressure threshold settings row
 * @returns {string} Evaluation flag result ('OK', 'WARNING', 'CRITICAL')
 */
function evaluatePressure(value, threshold) {
  if (!threshold) return 'OK';
  const breachesCritical =
    (threshold.critical_min != null && value < threshold.critical_min) ||
    (threshold.critical_max != null && value > threshold.critical_max);
  if (breachesCritical) return 'CRITICAL';
  const breachesWarning =
    (threshold.warning_min != null && value < threshold.warning_min) ||
    (threshold.warning_max != null && value > threshold.warning_max);
  if (breachesWarning) return 'WARNING';
  return 'OK';
}

// Inspection compliance uses its own vocabulary (On Time / Due / Overdue) per
// the milestone spec, distinct from the NSD/Pressure OK/WARNING/CRITICAL scale.

/**
 * Checks elapsed days since last inspection against the warning/critical thresholds.
 * Returns inspection-compliance states ('On Time', 'Due', 'Overdue').
 * 
 * @param {number} daysSinceLastReading - Count of days elapsed since the last nsd_reading or pressure_reading
 * @param {object|null} threshold - Active Inspection Interval threshold settings row
 * @returns {string} Compliance classification result ('On Time', 'Due', 'Overdue')
 */
function evaluateInspectionAge(daysSinceLastReading, threshold) {
  if (!threshold || daysSinceLastReading == null) return 'On Time';
  if (threshold.critical_max != null && daysSinceLastReading >= threshold.critical_max) return 'Overdue';
  if (threshold.warning_max != null && daysSinceLastReading >= threshold.warning_max) return 'Due';
  return 'On Time';
}

module.exports = { resolveThreshold, evaluateNsd, evaluatePressure, evaluateInspectionAge };
