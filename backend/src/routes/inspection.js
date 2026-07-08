const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { resolveThreshold } = require('../utils/thresholdEngine');
const { computeInspectionCompliance, listInServiceTyresWithLastReading } = require('../utils/inspectionService');
const { isDepotScoped } = require('../utils/roles');

const router = express.Router();

router.use(authenticate);

// Inspection Due / Inspection Overdue views (SRS FR-AL-04 + milestone Frontend
// section) are the same underlying list filtered by computed status, not two
// separate endpoints -- avoids duplicating the tyre-lookup/join logic twice.
router.get('/', (req, res) => {
  const { status, depot_id, bus_id, search, page = '1', pageSize = '20' } = req.query;

  const scopeDepotId = isDepotScoped(req.user) ? req.user.depot_id : (depot_id ? Number(depot_id) : undefined);
  const threshold = resolveThreshold('INSPECTION_INTERVAL', {});

  let tyres = listInServiceTyresWithLastReading(scopeDepotId);

  if (bus_id) tyres = tyres.filter((t) => t.current_bus_id === Number(bus_id));
  if (search) {
    const q = search.toLowerCase();
    tyres = tyres.filter((t) => t.tyre_number.toLowerCase().includes(q) || t.brand.toLowerCase().includes(q));
  }

  const busIds = [...new Set(tyres.map((t) => t.current_bus_id).filter(Boolean))];
  const buses = busIds.length
    ? db.prepare(`SELECT id, registration_no FROM buses WHERE id IN (${busIds.map(() => '?').join(',')})`).all(...busIds)
    : [];
  const busById = Object.fromEntries(buses.map((b) => [b.id, b]));

  const depotIds = [...new Set(tyres.map((t) => t.current_depot_id).filter(Boolean))];
  const depots = depotIds.length
    ? db.prepare(`SELECT id, name FROM depots WHERE id IN (${depotIds.map(() => '?').join(',')})`).all(...depotIds)
    : [];
  const depotById = Object.fromEntries(depots.map((d) => [d.id, d]));

  let results = tyres.map((tyre) => {
    const compliance = computeInspectionCompliance(tyre, tyre.last_reading_date, threshold);
    return {
      tyre_id: tyre.id,
      tyre_number: tyre.tyre_number,
      brand: tyre.brand,
      current_bus_id: tyre.current_bus_id,
      bus_registration_no: tyre.current_bus_id ? busById[tyre.current_bus_id]?.registration_no : null,
      current_depot_id: tyre.current_depot_id,
      depot_name: tyre.current_depot_id ? depotById[tyre.current_depot_id]?.name : null,
      last_reading_date: compliance.lastReadingDate,
      days_since_last_reading: compliance.daysSinceLastReading,
      inspection_status: compliance.status,
    };
  });

  if (status) results = results.filter((r) => r.inspection_status === status);

  results.sort((a, b) => b.days_since_last_reading - a.days_since_last_reading);

  const total = results.length;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;
  const data = results.slice(offset, offset + size);

  res.json({ data, total, page: pageNum, pageSize: size, threshold: threshold ? { warning_max: threshold.warning_max, critical_max: threshold.critical_max, unit: threshold.unit } : null });
});

module.exports = router;
