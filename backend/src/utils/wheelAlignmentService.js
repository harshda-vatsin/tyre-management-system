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
const { NOW_SQL } = db;
const { resolveThreshold } = require('./thresholdEngine');
const { ApiError } = require('./apiError');

const AXES = ['toe', 'caster', 'camber', 'sai'];
const AXIS_PARAMETER_TYPE = { toe: 'TOE', caster: 'CASTER', camber: 'CAMBER', sai: 'SAI' };

const SELECT_ALIGNMENT = `
  SELECT
    wa.*,
    b.registration_no AS bus_registration_no,
    d.name AS depot_name,
    p.name AS package_name,
    u.username AS performed_by_username
  FROM wheel_alignments wa
  JOIN buses b ON b.id = wa.bus_id
  LEFT JOIN depots d ON d.id = wa.depot_id
  LEFT JOIN packages p ON p.id = wa.package_id
  LEFT JOIN users u ON u.id = wa.performed_by
`;

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

async function resolveAlignmentThresholds() {
  const [TOE, CASTER, CAMBER, SAI] = await Promise.all([
    resolveThreshold('TOE', {}),
    resolveThreshold('CASTER', {}),
    resolveThreshold('CAMBER', {}),
    resolveThreshold('SAI', {}),
  ]);
  return { TOE, CASTER, CAMBER, SAI };
}

function getMeasurementsForAlignment(alignmentId) {
  return db.prepare('SELECT * FROM wheel_alignment_measurements WHERE alignment_id = ?').all(alignmentId); // returns a Promise -- callers must await
}

const insertAlignment = db.prepare(`
  INSERT INTO wheel_alignments (bus_id, depot_id, package_id, alignment_date, current_km, due_date, status, remarks, performed_by, source_mis_record_type, source_mis_record_id)
  VALUES (@bus_id, @depot_id, @package_id, COALESCE(@alignment_date, ${NOW_SQL}), @current_km, @due_date, @status, @remarks, @performed_by, @source_mis_record_type, @source_mis_record_id)
`);
const insertMeasurement = db.prepare(`
  INSERT INTO wheel_alignment_measurements (
    alignment_id, position, toe_before, toe_after, caster_before, caster_after,
    camber_before, camber_after, sai_before, sai_after
  ) VALUES (
    @alignment_id, @position, @toe_before, @toe_after, @caster_before, @caster_after,
    @camber_before, @camber_after, @sai_before, @sai_after
  )
`);

// Single creation path for a wheel alignment record + its per-position
// measurements -- both routes/wheelAlignments.js (manual entry) and the MIS
// importer's Event Generator (misImport/eventGenerator.js) call this, the
// same "one path, never bypassed" discipline createTyreEvent() already
// enforces for tyre_events.
const createWheelAlignment = db.transaction(async function createWheelAlignmentInner(user, payload) {
  const { bus_id, alignment_date, current_km, due_date, status, remarks, measurements, source_mis_record_type, source_mis_record_id } = payload;
  if (!bus_id) throw new ApiError(400, 'bus_id is required');
  if (!Array.isArray(measurements) || measurements.length === 0) {
    throw new ApiError(400, 'At least one position measurement is required');
  }

  const bus = await db.prepare('SELECT * FROM buses WHERE id = ?').get(bus_id);
  if (!bus) throw new ApiError(400, 'bus_id does not reference a valid bus');

  const info = await insertAlignment.run({
    bus_id,
    depot_id: bus.depot_id,
    package_id: bus.package_id,
    alignment_date: alignment_date || null,
    current_km: current_km ?? null,
    due_date: due_date || null,
    status: status || 'Done',
    remarks: remarks || null,
    performed_by: user.id,
    source_mis_record_type: source_mis_record_type ?? null,
    source_mis_record_id: source_mis_record_id ?? null,
  });
  const alignmentId = info.lastInsertRowid;

  for (const m of measurements) {
    const complete = Object.fromEntries(
      ['position', ...AXES.flatMap((a) => [`${a}_before`, `${a}_after`])].map((f) => [f, m[f] ?? null])
    );
    await insertMeasurement.run({ alignment_id: alignmentId, ...complete });
  }

  if (current_km != null && current_km > bus.odometer_km) {
    await db.prepare(`UPDATE buses SET odometer_km = ?, updated_at = ${NOW_SQL} WHERE id = ?`).run(current_km, bus_id);
  }

  return db.prepare(`${SELECT_ALIGNMENT} WHERE wa.id = ?`).get(alignmentId);
});

module.exports = {
  AXES,
  computeAlignmentCompliance,
  resolveAlignmentThresholds,
  getMeasurementsForAlignment,
  createWheelAlignment,
  SELECT_ALIGNMENT,
};
