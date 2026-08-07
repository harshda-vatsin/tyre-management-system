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
const { ApiError } = require('../utils/apiError');
const {
  AXES, computeAlignmentCompliance, resolveAlignmentThresholds, getMeasurementsForAlignment,
  createWheelAlignment, SELECT_ALIGNMENT,
} = require('../utils/wheelAlignmentService');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
const WRITE_ROLES = [ROLES.ADMIN, ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR];

router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
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
  const total = (await db.prepare(`SELECT COUNT(*) c FROM wheel_alignments wa ${where}`).get(params)).c;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;

  const rows = await db
    .prepare(`${SELECT_ALIGNMENT} ${where} ORDER BY wa.alignment_date DESC, wa.id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset });

  const thresholds = await resolveAlignmentThresholds();
  const data = await Promise.all(rows.map(async (row) => {
    const measurements = await getMeasurementsForAlignment(row.id);
    const perPosition = measurements.map((m) => ({ ...m, compliance: computeAlignmentCompliance(m, thresholds) }));
    const overall = perPosition.some((m) => m.compliance.overall === 'Out of Range') ? 'Out of Range' : 'OK';
    return { ...row, position_count: measurements.length, compliance_overall: overall };
  }));

  res.json({ data, total, page: pageNum, pageSize: size });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const row = await db.prepare(`${SELECT_ALIGNMENT} WHERE wa.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Wheel alignment record not found' });

  if (isDepotScoped(req.user) && row.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  const thresholds = await resolveAlignmentThresholds();
  const rawMeasurements = await getMeasurementsForAlignment(row.id);
  const measurements = rawMeasurements.map((m) => ({ ...m, compliance: computeAlignmentCompliance(m, thresholds) }));

  res.json({ ...row, measurements });
}));

router.post('/', authorize(...WRITE_ROLES), asyncHandler(async (req, res) => {
  const { bus_id, measurements } = req.body || {};
  if (!bus_id) return res.status(400).json({ error: 'bus_id is required' });
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return res.status(400).json({ error: 'At least one position measurement is required' });
  }

  if (isDepotScoped(req.user)) {
    const bus = await db.prepare('SELECT depot_id FROM buses WHERE id = ?').get(bus_id);
    if (!bus) return res.status(400).json({ error: 'bus_id does not reference a valid bus' });
    if (bus.depot_id !== req.user.depot_id) {
      return res.status(403).json({ error: 'Not authorized for this depot' });
    }
  }

  let created;
  try {
    created = await createWheelAlignment(req.user, req.body || {});
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  await writeAuditLog({ user: req.user, action: 'CREATE', entityType: 'wheel_alignment', entityId: created.id, after: created });

  const thresholds = await resolveAlignmentThresholds();
  const rawMeasurements = await getMeasurementsForAlignment(created.id);
  const fullMeasurements = rawMeasurements.map((m) => ({ ...m, compliance: computeAlignmentCompliance(m, thresholds) }));

  res.status(201).json({ ...created, measurements: fullMeasurements });
}));

module.exports = router;
