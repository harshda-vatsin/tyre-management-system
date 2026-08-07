const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { resolveThreshold } = require('../utils/thresholdEngine');
const { computeRotationCompliance, listInServiceTyresWithLastRotation } = require('../utils/rotationService');
const { isDepotScoped } = require('../utils/roles');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.use(authenticate);

// Rotation Due / Rotation Overdue views are the same underlying list
// filtered by computed status, mirroring routes/inspection.js exactly.
router.get('/', asyncHandler(async (req, res) => {
  const { status, depot_id, bus_id, search, page = '1', pageSize = '20' } = req.query;

  const scopeDepotId = isDepotScoped(req.user) ? req.user.depot_id : (depot_id ? Number(depot_id) : undefined);
  const threshold = await resolveThreshold('ROTATION_INTERVAL', {});
  const kmThreshold = await resolveThreshold('ROTATION_INTERVAL_KM', {});

  let tyres = await listInServiceTyresWithLastRotation(scopeDepotId);

  if (bus_id) tyres = tyres.filter((t) => t.current_bus_id === Number(bus_id));
  if (search) {
    const q = search.toLowerCase();
    tyres = tyres.filter((t) => t.tyre_number.toLowerCase().includes(q) || t.brand.toLowerCase().includes(q));
  }

  const busIds = [...new Set(tyres.map((t) => t.current_bus_id).filter(Boolean))];
  const buses = busIds.length
    ? await db.prepare(`SELECT id, registration_no FROM buses WHERE id IN (${busIds.map(() => '?').join(',')})`).all(...busIds)
    : [];
  const busById = Object.fromEntries(buses.map((b) => [b.id, b]));

  const depotIds = [...new Set(tyres.map((t) => t.current_depot_id).filter(Boolean))];
  const depots = depotIds.length
    ? await db.prepare(`SELECT id, name FROM depots WHERE id IN (${depotIds.map(() => '?').join(',')})`).all(...depotIds)
    : [];
  const depotById = Object.fromEntries(depots.map((d) => [d.id, d]));

  let results = tyres.map((tyre) => {
    const compliance = computeRotationCompliance(tyre, tyre.last_rotation_date, threshold, {
      lastRotationOdometerKm: tyre.last_rotation_odometer_km,
      currentOdometerKm: tyre.current_odometer_km,
      kmThreshold,
    });
    return {
      tyre_id: tyre.id,
      tyre_number: tyre.tyre_number,
      brand: tyre.brand,
      current_bus_id: tyre.current_bus_id,
      bus_registration_no: tyre.current_bus_id ? busById[tyre.current_bus_id]?.registration_no : null,
      current_depot_id: tyre.current_depot_id,
      depot_name: tyre.current_depot_id ? depotById[tyre.current_depot_id]?.name : null,
      last_rotation_date: compliance.lastRotationDate,
      days_since_last_rotation: compliance.daysSinceLastRotation,
      km_since_last_rotation: compliance.kmSinceLastRotation,
      rotation_status: compliance.status,
    };
  });

  if (status) results = results.filter((r) => r.rotation_status === status);

  results.sort((a, b) => b.days_since_last_rotation - a.days_since_last_rotation);

  const total = results.length;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;
  const data = results.slice(offset, offset + size);

  res.json({ data, total, page: pageNum, pageSize: size, threshold: threshold ? { warning_max: threshold.warning_max, critical_max: threshold.critical_max, unit: threshold.unit } : null });
}));

module.exports = router;
