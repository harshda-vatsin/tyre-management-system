/**
 * @file wheelAlignmentService.js
 * @description Wheel Alignment compliance computation. Bus-scoped (axle
 * geometry, not an individual tyre's condition) -- see MIS Depth Expansion
 * notes in db.js. Standard ranges reuse the existing thresholds table
 * (warning_min/warning_max as the single standard range, no warning/
 * critical tiers the way NSD/Pressure have) via the same resolveThreshold
 * used everywhere else.
 */

const db = require('../db');
const { resolveThreshold } = require('./thresholdEngine');

const AXES = ['toe', 'caster', 'camber', 'sai'];
const AXIS_PARAMETER_TYPE = { toe: 'TOE', caster: 'CASTER', camber: 'CAMBER', sai: 'SAI' };

/**
 * Flags each axis of one position's measurement in/out of its standard
 * range, using the "after" value (the state the alignment left the bus in)
 * -- falling back to "before" only if "after" wasn't recorded.
 *
 * @param {object} measurement - one wheel_alignment_measurements row
 * @param {Record<string, object|undefined>} thresholds - resolved threshold row per axis parameter type
 * @returns {{toe: string, caster: string, camber: string, sai: string, overall: string}}
 */
function computeAlignmentCompliance(measurement, thresholds) {
  const result = {};
  for (const axis of AXES) {
    const value = measurement[`${axis}_after`] ?? measurement[`${axis}_before`];
    const threshold = thresholds[AXIS_PARAMETER_TYPE[axis]];
    if (value == null || !threshold) {
      result[axis] = 'Not Measured';
      continue;
    }
    const withinMin = threshold.warning_min == null || value >= threshold.warning_min;
    const withinMax = threshold.warning_max == null || value <= threshold.warning_max;
    result[axis] = withinMin && withinMax ? 'OK' : 'Out of Range';
  }
  result.overall = Object.values(result).includes('Out of Range') ? 'Out of Range' : 'OK';
  return result;
}

function resolveAlignmentThresholds() {
  return {
    TOE: resolveThreshold('TOE', {}),
    CASTER: resolveThreshold('CASTER', {}),
    CAMBER: resolveThreshold('CAMBER', {}),
    SAI: resolveThreshold('SAI', {}),
  };
}

function getMeasurementsForAlignment(alignmentId) {
  return db.prepare('SELECT * FROM wheel_alignment_measurements WHERE alignment_id = ?').all(alignmentId);
}

module.exports = { AXES, computeAlignmentCompliance, resolveAlignmentThresholds, getMeasurementsForAlignment };
