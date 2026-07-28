/**
 * @file wheelAlignments.js
 * @description Wheel Alignment record CRUD (create + list + detail). Write
 * access mirrors routes/events.js -- Tyre Supervisors log these day-to-day,
 * not just Admin/Depot Manager.
 */

const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/auditLog');
const { ROLES, isDepotScoped } = require('../utils/roles');
const {
  AXES, computeAlignmentCompliance, resolveAlignmentThresholds, getMeasurementsForAlignment,
} = require('../utils/wheelAlignmentService');

const router = express.Router();
const WRITE_ROLES = [ROLES.ADMIN, ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR];

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

router.use(authenticate);

router.get('/', (req, res) => {
  const { bus_id, depot_id, status, page = '1', pageSize = '20' } = req.query;
  const clauses = [];
  const params = {};

  if (bus_id) {
    clauses.push('wa.bus_id = @bus_id');
    params.bus_id = Number(bus_id);
  }
  if (status) {
    clauses.push('wa.status = @status');
    params.status = status;
  }
  if (isDepotScoped(req.user)) {
    clauses.push('wa.depot_id = @depot_id');
    params.depot_id = req.user.depot_id;
  } else if (depot_id) {
    clauses.push('wa.depot_id = @depot_id');
    params.depot_id = Number(depot_id);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM wheel_alignments wa ${where}`).get(params).c;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;

  const rows = db
    .prepare(`${SELECT_ALIGNMENT} ${where} ORDER BY wa.alignment_date DESC, wa.id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset });

  const thresholds = resolveAlignmentThresholds();
  const data = rows.map((row) => {
    const measurements = getMeasurementsForAlignment(row.id);
    const perPosition = measurements.map((m) => ({ ...m, compliance: computeAlignmentCompliance(m, thresholds) }));
    const overall = perPosition.some((m) => m.compliance.overall === 'Out of Range') ? 'Out of Range' : 'OK';
    return { ...row, position_count: measurements.length, compliance_overall: overall };
  });

  res.json({ data, total, page: pageNum, pageSize: size });
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`${SELECT_ALIGNMENT} WHERE wa.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Wheel alignment record not found' });

  if (isDepotScoped(req.user) && row.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  const thresholds = resolveAlignmentThresholds();
  const measurements = getMeasurementsForAlignment(row.id).map((m) => ({ ...m, compliance: computeAlignmentCompliance(m, thresholds) }));

  res.json({ ...row, measurements });
});

router.post('/', authorize(...WRITE_ROLES), (req, res) => {
  const { bus_id, alignment_date, current_km, due_date, status, remarks, measurements } = req.body || {};
  if (!bus_id) return res.status(400).json({ error: 'bus_id is required' });
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return res.status(400).json({ error: 'At least one position measurement is required' });
  }

  const bus = db.prepare('SELECT * FROM buses WHERE id = ?').get(bus_id);
  if (!bus) return res.status(400).json({ error: 'bus_id does not reference a valid bus' });
  if (isDepotScoped(req.user) && bus.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  const insertAlignment = db.prepare(`
    INSERT INTO wheel_alignments (bus_id, depot_id, package_id, alignment_date, current_km, due_date, status, remarks, performed_by)
    VALUES (@bus_id, @depot_id, @package_id, COALESCE(@alignment_date, datetime('now')), @current_km, @due_date, @status, @remarks, @performed_by)
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

  const created = db.transaction(() => {
    const info = insertAlignment.run({
      bus_id,
      depot_id: bus.depot_id,
      package_id: bus.package_id,
      alignment_date: alignment_date || null,
      current_km: current_km ?? null,
      due_date: due_date || null,
      status: status || 'Done',
      remarks: remarks || null,
      performed_by: req.user.id,
    });
    const alignmentId = info.lastInsertRowid;

    for (const m of measurements) {
      const complete = Object.fromEntries(
        ['position', ...AXES.flatMap((a) => [`${a}_before`, `${a}_after`])].map((f) => [f, m[f] ?? null])
      );
      insertMeasurement.run({ alignment_id: alignmentId, ...complete });
    }

    if (current_km != null && current_km > bus.odometer_km) {
      db.prepare(`UPDATE buses SET odometer_km = ?, updated_at = datetime('now') WHERE id = ?`).run(current_km, bus_id);
    }

    return db.prepare(`${SELECT_ALIGNMENT} WHERE wa.id = ?`).get(alignmentId);
  })();

  writeAuditLog({ user: req.user, action: 'CREATE', entityType: 'wheel_alignment', entityId: created.id, after: created });

  const thresholds = resolveAlignmentThresholds();
  const fullMeasurements = getMeasurementsForAlignment(created.id).map((m) => ({ ...m, compliance: computeAlignmentCompliance(m, thresholds) }));

  res.status(201).json({ ...created, measurements: fullMeasurements });
});

module.exports = router;
