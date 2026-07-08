const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/auditLog');
const { ROLES, isDepotScoped } = require('../utils/roles');

const router = express.Router();

// FR-BM-01/02: Administrator (all depots) and Depot Manager (own depot only) may
// create/edit bus master records. National Fleet Manager, Tyre Supervisor and
// Read-Only Auditor are read-only per SRS section 6 ("cannot modify master data").
const WRITE_ROLES = [ROLES.ADMIN, ROLES.DEPOT_MANAGER];
// Cross-depot transfer requires fleet-wide authority, not single-depot scope.
const TRANSFER_ROLES = [ROLES.ADMIN, ROLES.NATIONAL_FLEET_MANAGER];

const SELECT_BUS = `
  SELECT
    b.*,
    d.name AS depot_name, d.code AS depot_code,
    m.name AS bus_model_name, m.manufacturer AS bus_model_manufacturer,
    m.num_positions AS num_tyre_positions, m.position_labels_json AS position_labels_json
  FROM buses b
  JOIN depots d ON d.id = b.depot_id
  JOIN bus_models m ON m.id = b.bus_model_id
`;

function serialize(row) {
  if (!row) return row;
  const { position_labels_json, ...rest } = row;
  return { ...rest, position_labels: position_labels_json ? JSON.parse(position_labels_json) : [] };
}

// FR-BM-01: Bus Registration Number and Chassis Number (VIN) are standardized
// to trimmed, uppercase form before uniqueness checks and storage, so the
// same physical bus can't be entered twice under differently-cased/spaced
// values (e.g. "dl01ev1001 " vs "DL01EV1001").
function normalizeCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

const CURRENT_YEAR = new Date().getFullYear();

// FR-BM-01: Year of Manufacture must be a whole year not later than the
// current year. No lower bound exists in the current spec, so none is
// invented here.
function validateYearOfManufacture(value) {
  const yearNum = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isInteger(yearNum) || yearNum > CURRENT_YEAR) {
    return `year_of_manufacture is required and must be a whole year not later than ${CURRENT_YEAR}`;
  }
  return null;
}

// FR-BM-01: Date of Entry into Fleet is required and must be a valid date,
// stored in the same TEXT date format already used across the schema.
function validateDateOfEntry(value) {
  if (!value || isNaN(Date.parse(value))) {
    return 'date_of_entry_into_fleet is required and must be a valid date';
  }
  return null;
}

router.use(authenticate);

router.get('/', (req, res) => {
  const { search = '', depot_id, status, bus_model_id, page = '1', pageSize = '20' } = req.query;
  const clauses = [];
  const params = {};

  if (search) {
    clauses.push('(b.registration_no LIKE @search OR b.chassis_no LIKE @search)');
    params.search = `%${search}%`;
  }
  if (status) {
    clauses.push('b.status = @status');
    params.status = status;
  }
  if (bus_model_id) {
    clauses.push('b.bus_model_id = @bus_model_id');
    params.bus_model_id = Number(bus_model_id);
  }

  if (isDepotScoped(req.user)) {
    clauses.push('b.depot_id = @depot_id');
    params.depot_id = req.user.depot_id;
  } else if (depot_id) {
    clauses.push('b.depot_id = @depot_id');
    params.depot_id = Number(depot_id);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM buses b ${where}`).get(params).c;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;

  const rows = db
    .prepare(`${SELECT_BUS} ${where} ORDER BY b.registration_no LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset });

  res.json({ data: rows.map(serialize), total, page: pageNum, pageSize: size });
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`${SELECT_BUS} WHERE b.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Bus not found' });

  if (isDepotScoped(req.user) && row.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  const bus = serialize(row);
  // FR-TC-04: position map needs last NSD, last pressure, and last event date
  // per mounted tyre, sourced live from the tyre card (tyre_events) -- not
  // denormalized onto the tyre row, so there is one source of truth.
  const mountedTyres = db
    .prepare(`
      SELECT
        t.id, t.tyre_number, t.current_position, t.status,
        (SELECT nsd_value FROM tyre_events WHERE tyre_id = t.id AND event_type = 'nsd_reading' ORDER BY event_date DESC, id DESC LIMIT 1) AS last_nsd_value,
        (SELECT event_date FROM tyre_events WHERE tyre_id = t.id AND event_type = 'nsd_reading' ORDER BY event_date DESC, id DESC LIMIT 1) AS last_nsd_date,
        (SELECT pressure_value FROM tyre_events WHERE tyre_id = t.id AND event_type = 'pressure_reading' ORDER BY event_date DESC, id DESC LIMIT 1) AS last_pressure_value,
        (SELECT event_date FROM tyre_events WHERE tyre_id = t.id AND event_type = 'pressure_reading' ORDER BY event_date DESC, id DESC LIMIT 1) AS last_pressure_date,
        (SELECT event_date FROM tyre_events WHERE tyre_id = t.id ORDER BY event_date DESC, id DESC LIMIT 1) AS last_event_date,
        (SELECT flag_status FROM tyre_events WHERE tyre_id = t.id AND event_type IN ('nsd_reading', 'pressure_reading') ORDER BY event_date DESC, id DESC LIMIT 1) AS flag_status
      FROM tyres t WHERE t.current_bus_id = ?
    `)
    .all(req.params.id);
  const tyreByPosition = Object.fromEntries(mountedTyres.map((t) => [t.current_position, t]));
  bus.tyre_position_map = bus.position_labels.map((label) => ({
    position: label,
    tyre: tyreByPosition[label] || null,
  }));

  res.json(bus);
});

router.post('/', authorize(...WRITE_ROLES), (req, res) => {
  const {
    bus_model_id,
    depot_id,
    status,
  } = req.body || {};
  const registration_no = normalizeCode(req.body?.registration_no);
  const chassis_no = normalizeCode(req.body?.chassis_no);
  const year_of_manufacture = req.body?.year_of_manufacture;
  const date_of_entry_into_fleet = req.body?.date_of_entry_into_fleet;

  if (!registration_no || !chassis_no || !bus_model_id || !depot_id) {
    return res.status(400).json({ error: 'registration_no, chassis_no, bus_model_id and depot_id are required' });
  }

  const yearError = validateYearOfManufacture(year_of_manufacture);
  if (yearError) return res.status(400).json({ error: yearError });

  const dateError = validateDateOfEntry(date_of_entry_into_fleet);
  if (dateError) return res.status(400).json({ error: dateError });

  if (isDepotScoped(req.user) && Number(depot_id) !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized to create a bus in this depot' });
  }

  const model = db.prepare('SELECT id FROM bus_models WHERE id = ?').get(bus_model_id);
  if (!model) return res.status(400).json({ error: 'bus_model_id does not reference a valid bus model' });

  const depot = db.prepare('SELECT id, is_active FROM depots WHERE id = ?').get(depot_id);
  if (!depot) return res.status(400).json({ error: 'depot_id does not reference a valid depot' });
  // FR-DM-02: a deactivated depot shall not accept new entries against it.
  if (!depot.is_active) return res.status(400).json({ error: 'This depot is deactivated and cannot accept new buses' });

  try {
    const info = db
      .prepare(`
        INSERT INTO buses (depot_id, registration_no, chassis_no, bus_model_id, year_of_manufacture, date_of_entry_into_fleet, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        depot_id,
        registration_no,
        chassis_no,
        bus_model_id,
        year_of_manufacture,
        date_of_entry_into_fleet,
        status || 'Active'
      );

    const created = db.prepare(`${SELECT_BUS} WHERE b.id = ?`).get(info.lastInsertRowid);
    writeAuditLog({ user: req.user, action: 'CREATE', entityType: 'bus', entityId: created.id, after: created });
    res.status(201).json(serialize(created));
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A bus with this registration number or chassis number already exists' });
    }
    throw err;
  }
});

router.put('/:id', authorize(...WRITE_ROLES), (req, res) => {
  const before = db.prepare('SELECT * FROM buses WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Bus not found' });

  if (isDepotScoped(req.user) && before.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  const registration_no = normalizeCode(req.body?.registration_no ?? before.registration_no);
  const chassis_no = normalizeCode(req.body?.chassis_no ?? before.chassis_no);
  const bus_model_id = req.body?.bus_model_id ?? before.bus_model_id;
  const year_of_manufacture = req.body?.year_of_manufacture ?? before.year_of_manufacture;
  const date_of_entry_into_fleet = req.body?.date_of_entry_into_fleet ?? before.date_of_entry_into_fleet;
  const status = req.body?.status ?? before.status;
  const odometer_km = req.body?.odometer_km ?? before.odometer_km;
  // Depot reassignment goes through the dedicated transfer endpoint, not a plain edit.
  const depot_id = before.depot_id;

  if (!registration_no || !chassis_no) {
    return res.status(400).json({ error: 'registration_no and chassis_no are required' });
  }

  const yearError = validateYearOfManufacture(year_of_manufacture);
  if (yearError) return res.status(400).json({ error: yearError });

  const dateError = validateDateOfEntry(date_of_entry_into_fleet);
  if (dateError) return res.status(400).json({ error: dateError });

  try {
    db.prepare(`
      UPDATE buses
      SET registration_no = ?, chassis_no = ?, bus_model_id = ?, year_of_manufacture = ?,
          date_of_entry_into_fleet = ?, status = ?, odometer_km = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(registration_no, chassis_no, bus_model_id, year_of_manufacture, date_of_entry_into_fleet, status, odometer_km, req.params.id);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A bus with this registration number or chassis number already exists' });
    }
    throw err;
  }

  const after = db.prepare(`${SELECT_BUS} WHERE b.id = ?`).get(req.params.id);
  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'bus', entityId: after.id, before, after: { ...after, depot_id } });
  res.json(serialize(after));
});

// FR-BM-03: transfer a bus between depots. Cascades to every tyre currently
// mounted on the bus so their current_depot_id stays consistent.
router.post('/:id/transfer', authorize(...TRANSFER_ROLES), (req, res) => {
  const { to_depot_id, notes } = req.body || {};
  if (!to_depot_id) return res.status(400).json({ error: 'to_depot_id is required' });

  const bus = db.prepare('SELECT * FROM buses WHERE id = ?').get(req.params.id);
  if (!bus) return res.status(404).json({ error: 'Bus not found' });

  const destDepot = db.prepare('SELECT id, is_active FROM depots WHERE id = ?').get(to_depot_id);
  if (!destDepot) return res.status(400).json({ error: 'to_depot_id does not reference a valid depot' });
  // FR-DM-02: a deactivated depot shall not accept new entries against it.
  if (!destDepot.is_active) return res.status(400).json({ error: 'Destination depot is deactivated and cannot accept transfers' });

  if (Number(to_depot_id) === bus.depot_id) {
    return res.status(400).json({ error: 'Bus is already assigned to this depot' });
  }

  const fromDepotId = bus.depot_id;

  const runTransfer = db.transaction(() => {
    db.prepare(`UPDATE buses SET depot_id = ?, updated_at = datetime('now') WHERE id = ?`).run(to_depot_id, req.params.id);
    db.prepare(`UPDATE tyres SET current_depot_id = ?, updated_at = datetime('now') WHERE current_bus_id = ?`).run(to_depot_id, req.params.id);
  });
  runTransfer();

  const after = db.prepare(`${SELECT_BUS} WHERE b.id = ?`).get(req.params.id);

  writeAuditLog({
    user: req.user,
    action: 'TRANSFER',
    entityType: 'bus',
    entityId: bus.id,
    before: { depot_id: fromDepotId },
    after: { depot_id: Number(to_depot_id), notes: notes || null },
  });

  res.json(serialize(after));
});

router.delete('/:id', authorize(ROLES.ADMIN), (req, res) => {
  const before = db.prepare('SELECT * FROM buses WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Bus not found' });

  const inUse = db.prepare('SELECT COUNT(*) c FROM tyres WHERE current_bus_id = ?').get(req.params.id);
  if (inUse.c > 0) {
    return res.status(409).json({ error: 'Cannot delete a bus that still has tyres mounted on it' });
  }

  db.prepare('DELETE FROM buses WHERE id = ?').run(req.params.id);
  writeAuditLog({ user: req.user, action: 'DELETE', entityType: 'bus', entityId: before.id, before });
  res.status(204).send();
});

module.exports = router;
