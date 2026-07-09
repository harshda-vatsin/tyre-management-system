const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/auditLog');
const { ROLES } = require('../utils/roles');

const router = express.Router();
// SRS FR-DM-01/02: depot master create/edit/deactivate is Administrator-only.
const WRITE_ROLES = [ROLES.ADMIN];

router.use(authenticate);

// Depot master list with search/status filtering and per-depot summary
// counts (active buses, total tyres under management). Stays a flat array
// (not the {data,total} paginated shape used elsewhere) because every other
// page's depot-picker dropdown calls this same endpoint expecting a plain
// list -- only the two new summary fields are additive.
router.get('/', (req, res) => {
  const { search = '', is_active } = req.query;
  const clauses = [];
  const params = {};

  if (search) {
    clauses.push('(d.name LIKE @search OR d.code LIKE @search OR d.region LIKE @search)');
    params.search = `%${search}%`;
  }
  if (is_active !== undefined) {
    clauses.push('d.is_active = @is_active');
    params.is_active = is_active === 'true' || is_active === '1' ? 1 : 0;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const depots = db.prepare(`
    SELECT
      d.*,
      COALESCE(bus_counts.active_bus_count, 0) AS active_bus_count,
      COALESCE(tyre_counts.total_tyre_count, 0) AS total_tyre_count
    FROM depots d
    LEFT JOIN (
      SELECT depot_id, COUNT(*) AS active_bus_count FROM buses WHERE status = 'Active' GROUP BY depot_id
    ) bus_counts ON bus_counts.depot_id = d.id
    LEFT JOIN (
      SELECT current_depot_id, COUNT(*) AS total_tyre_count FROM tyres GROUP BY current_depot_id
    ) tyre_counts ON tyre_counts.current_depot_id = d.id
    ${where}
    ORDER BY d.is_active DESC, d.name
  `).all(params);

  res.json(depots);
});

router.get('/:id', (req, res) => {
  const depot = db.prepare('SELECT * FROM depots WHERE id = ?').get(req.params.id);
  if (!depot) return res.status(404).json({ error: 'Depot not found' });
  res.json(depot);
});

router.post('/', authorize(...WRITE_ROLES), (req, res) => {
  const { name, code, region, address } = req.body || {};
  if (!name || !code) {
    return res.status(400).json({ error: 'name and code are required' });
  }

  try {
    const info = db
      .prepare('INSERT INTO depots (name, code, region, address) VALUES (?, ?, ?, ?)')
      .run(name, code, region || null, address || null);
    const created = db.prepare('SELECT * FROM depots WHERE id = ?').get(info.lastInsertRowid);

    writeAuditLog({ user: req.user, action: 'CREATE', entityType: 'depot', entityId: created.id, after: created });

    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Depot code already exists' });
    }
    throw err;
  }
});

router.put('/:id', authorize(...WRITE_ROLES), (req, res) => {
  const before = db.prepare('SELECT * FROM depots WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Depot not found' });

  const name = req.body?.name ?? before.name;
  const code = req.body?.code ?? before.code;
  const region = req.body?.region ?? before.region;
  const address = req.body?.address ?? before.address;

  try {
    db.prepare(`
      UPDATE depots SET name = ?, code = ?, region = ?, address = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, code, region, address, req.params.id);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Depot code already exists' });
    }
    throw err;
  }

  const after = db.prepare('SELECT * FROM depots WHERE id = ?').get(req.params.id);
  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'depot', entityId: after.id, before, after });

  res.json(after);
});

router.patch('/:id/status', authorize(...WRITE_ROLES), (req, res) => {
  const { is_active } = req.body || {};
  if (is_active === undefined) return res.status(400).json({ error: 'is_active is required' });

  const before = db.prepare('SELECT * FROM depots WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Depot not found' });

  db.prepare(`UPDATE depots SET is_active = ?, updated_at = datetime('now') WHERE id = ?`).run(is_active ? 1 : 0, req.params.id);

  const after = db.prepare('SELECT * FROM depots WHERE id = ?').get(req.params.id);
  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'depot', entityId: after.id, before, after });

  res.json(after);
});

// FR-DM-02: depots are never hard-deleted, only deactivated -- "shall not
// delete historical records but shall prevent new entries against it." There
// is deliberately no DELETE route for this entity; use PATCH /:id/status.

module.exports = router;
