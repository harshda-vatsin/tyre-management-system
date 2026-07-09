/**
 * @file tyres.js
 * @description Exposes CRUD endpoints to register, update, delete, and search tyres.
 * Includes scoping checks to restrict Depot Managers and Tyre Supervisors to their respective depots.
 */

const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/auditLog');
const { ROLES, isDepotScoped } = require('../utils/roles');
const { buildTyreCardPdf } = require('../utils/exportService');

const router = express.Router();

// Authorized roles allowed to modify tyre master/procurement records.
// Tyre Supervisors cannot alter master data, only event logging records.
const WRITE_ROLES = [ROLES.ADMIN, ROLES.DEPOT_MANAGER];

const SELECT_TYRE = `
  SELECT
    t.*,
    d.name AS depot_name, d.code AS depot_code,
    b.registration_no AS bus_registration_no
  FROM tyres t
  LEFT JOIN depots d ON d.id = t.current_depot_id
  LEFT JOIN buses b ON b.id = t.current_bus_id
`;

router.use(authenticate);

router.get('/', (req, res) => {
  const { search = '', depot_id, status, brand, bus_id, page = '1', pageSize = '20' } = req.query;
  const clauses = [];
  const params = {};

  if (search) {
    clauses.push('(t.tyre_number LIKE @search OR t.brand LIKE @search OR t.model LIKE @search OR b.registration_no LIKE @search)');
    params.search = `%${search}%`;
  }
  if (status) {
    clauses.push('t.status = @status');
    params.status = status;
  }
  if (brand) {
    clauses.push('t.brand = @brand');
    params.brand = brand;
  }
  if (bus_id) {
    clauses.push('t.current_bus_id = @bus_id');
    params.bus_id = Number(bus_id);
  }

  if (isDepotScoped(req.user)) {
    clauses.push('t.current_depot_id = @depot_id');
    params.depot_id = req.user.depot_id;
  } else if (depot_id) {
    clauses.push('t.current_depot_id = @depot_id');
    params.depot_id = Number(depot_id);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM tyres t LEFT JOIN buses b ON b.id = t.current_bus_id ${where}`).get(params).c;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;

  const rows = db
    .prepare(`${SELECT_TYRE} ${where} ORDER BY t.tyre_number LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset });

  res.json({ data: rows, total, page: pageNum, pageSize: size });
});

router.get('/lookup/:tyreNumber', (req, res) => {
  const row = db.prepare(`${SELECT_TYRE} WHERE t.tyre_number = ?`).get(req.params.tyreNumber);
  if (!row) return res.status(404).json({ error: 'Tyre not found' });

  if (isDepotScoped(req.user) && row.current_depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  res.json({ id: row.id, tyre_number: row.tyre_number, current_depot_id: row.current_depot_id });
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`${SELECT_TYRE} WHERE t.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Tyre not found' });

  if (isDepotScoped(req.user) && row.current_depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  res.json(row);
});

function validatePosition({ current_bus_id, current_position, excludeTyreId }) {
  if (!current_bus_id) return null;

  const bus = db.prepare('SELECT id, depot_id, bus_model_id FROM buses WHERE id = ?').get(current_bus_id);
  if (!bus) return { error: 'current_bus_id does not reference a valid bus' };

  if (current_position) {
    const model = db.prepare('SELECT position_labels_json FROM bus_models WHERE id = ?').get(bus.bus_model_id);
    const labels = JSON.parse(model.position_labels_json);
    if (!labels.includes(current_position)) {
      return { error: `current_position must be one of: ${labels.join(', ')}` };
    }

    const occupant = db
      .prepare('SELECT id FROM tyres WHERE current_bus_id = ? AND current_position = ? AND id != ?')
      .get(current_bus_id, current_position, excludeTyreId || 0);
    if (occupant) {
      return { error: `Position ${current_position} on this bus is already occupied by another tyre` };
    }
  }

  return { depotId: bus.depot_id };
}

router.post('/', authorize(...WRITE_ROLES), (req, res) => {
  const { tyre_number, brand, model, size, purchase_date, initial_nsd, status, current_bus_id, current_position, current_depot_id } = req.body || {};

  if (!tyre_number || !brand) {
    return res.status(400).json({ error: 'tyre_number and brand are required' });
  }

  const posResult = validatePosition({ current_bus_id, current_position });
  if (posResult?.error) return res.status(400).json({ error: posResult.error });
  const resolvedDepotId = posResult?.depotId ?? current_depot_id ?? null;

  if (isDepotScoped(req.user) && resolvedDepotId && resolvedDepotId !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized to create a tyre in this depot' });
  }

  try {
    const info = db
      .prepare(`
        INSERT INTO tyres (tyre_number, brand, model, size, purchase_date, initial_nsd, status, current_bus_id, current_position, current_depot_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        tyre_number,
        brand,
        model || null,
        size || null,
        purchase_date || null,
        initial_nsd ?? null,
        status || 'In Store',
        current_bus_id || null,
        current_position || null,
        resolvedDepotId
      );

    const created = db.prepare(`${SELECT_TYRE} WHERE t.id = ?`).get(info.lastInsertRowid);
    writeAuditLog({ user: req.user, action: 'CREATE', entityType: 'tyre', entityId: created.id, after: created });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A tyre with this tyre number already exists' });
    }
    throw err;
  }
});

router.put('/:id', authorize(...WRITE_ROLES), (req, res) => {
  const before = db.prepare('SELECT * FROM tyres WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Tyre not found' });

  if (isDepotScoped(req.user) && before.current_depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  const tyre_number = req.body?.tyre_number ?? before.tyre_number;
  const brand = req.body?.brand ?? before.brand;
  const model = req.body?.model ?? before.model;
  const size = req.body?.size ?? before.size;
  const purchase_date = req.body?.purchase_date ?? before.purchase_date;
  const initial_nsd = req.body?.initial_nsd ?? before.initial_nsd;
  const status = req.body?.status ?? before.status;
  const current_bus_id = req.body?.current_bus_id !== undefined ? req.body.current_bus_id : before.current_bus_id;
  const current_position = req.body?.current_position !== undefined ? req.body.current_position : before.current_position;

  const posResult = validatePosition({ current_bus_id, current_position, excludeTyreId: before.id });
  if (posResult?.error) return res.status(400).json({ error: posResult.error });
  const resolvedDepotId = current_bus_id
    ? posResult.depotId
    : (req.body?.current_depot_id !== undefined ? req.body.current_depot_id : before.current_depot_id);

  if (isDepotScoped(req.user) && resolvedDepotId && resolvedDepotId !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized to move this tyre to that depot/bus' });
  }

  try {
    db.prepare(`
      UPDATE tyres
      SET tyre_number = ?, brand = ?, model = ?, size = ?, purchase_date = ?, initial_nsd = ?, status = ?,
          current_bus_id = ?, current_position = ?, current_depot_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(tyre_number, brand, model, size, purchase_date, initial_nsd, status, current_bus_id || null, current_position || null, resolvedDepotId || null, req.params.id);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A tyre with this tyre number already exists' });
    }
    throw err;
  }

  const after = db.prepare(`${SELECT_TYRE} WHERE t.id = ?`).get(req.params.id);
  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'tyre', entityId: after.id, before, after });
  res.json(after);
});

// DELETE /api/tyres/:id - Permanently removes a tyre master record from the database.
// Restricted exclusively to System Administrators.
router.delete('/:id', authorize(ROLES.ADMIN), (req, res) => {
  const before = db.prepare('SELECT * FROM tyres WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Tyre not found' });

  db.prepare('DELETE FROM tyres WHERE id = ?').run(req.params.id);
  writeAuditLog({ user: req.user, action: 'DELETE', entityType: 'tyre', entityId: before.id, before });
  res.status(204).send();
});

router.get('/:id/export-pdf', async (req, res) => {
  const tyre = db.prepare(`${SELECT_TYRE} WHERE t.id = ?`).get(req.params.id);
  if (!tyre) return res.status(404).json({ error: 'Tyre not found' });

  if (isDepotScoped(req.user) && tyre.current_depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  const events = db.prepare(`
    SELECT
      e.*,
      b.registration_no AS bus_registration_no,
      fb.registration_no AS from_bus_registration_no,
      tb.registration_no AS to_bus_registration_no,
      rt.tyre_number AS related_tyre_number,
      u.full_name AS performed_by_name
    FROM tyre_events e
    LEFT JOIN buses b ON b.id = e.bus_id
    LEFT JOIN buses fb ON fb.id = e.from_bus_id
    LEFT JOIN buses tb ON tb.id = e.to_bus_id
    LEFT JOIN tyres rt ON rt.id = e.related_tyre_id
    LEFT JOIN users u ON u.id = e.performed_by
    WHERE e.tyre_id = ?
    ORDER BY e.event_date DESC, e.id DESC
  `).all(tyre.id);

  // Fetch latest readings
  const latestNsd = db.prepare(`
    SELECT nsd_value, event_date FROM tyre_events
    WHERE tyre_id = ? AND event_type = 'nsd_reading'
    ORDER BY event_date DESC, id DESC LIMIT 1
  `).get(tyre.id);

  const latestPressure = db.prepare(`
    SELECT pressure_value, event_date FROM tyre_events
    WHERE tyre_id = ? AND event_type = 'pressure_reading'
    ORDER BY event_date DESC, id DESC LIMIT 1
  `).get(tyre.id);

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Tyre_Card_${tyre.tyre_number}.pdf"`);

  try {
    await buildTyreCardPdf({
      tyre,
      events,
      latestNsd,
      latestPressure,
      generatedAt,
      generatedByUsername: req.user.username,
    }, res);
  } catch (err) {
    console.error('Failed to build PDF:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to build PDF' });
    }
  }
});

// Exported for reuse by the CSV Bulk Import workflow (utils/bulkImport.js),
// which needs the identical position/depot validation for each imported row.
router.validatePosition = validatePosition;

module.exports = router;
