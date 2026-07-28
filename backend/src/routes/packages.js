/**
 * @file packages.js
 * @description Package master CRUD -- a contractual/route grouping tracked
 * independently of Depot (see MIS Depth Expansion notes in db.js/
 * tyreLifecycle.js). Mirrors routes/depots.js exactly, including the
 * never-hard-delete/deactivate-only pattern.
 */

const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/auditLog');
const { ROLES } = require('../utils/roles');

const router = express.Router();
const WRITE_ROLES = [ROLES.ADMIN];

router.use(authenticate);

router.get('/', (req, res) => {
  const { search = '', is_active } = req.query;
  const clauses = [];
  const params = {};

  if (search) {
    clauses.push('(p.name LIKE @search OR p.code LIKE @search)');
    params.search = `%${search}%`;
  }
  if (is_active !== undefined) {
    clauses.push('p.is_active = @is_active');
    params.is_active = is_active === 'true' || is_active === '1' ? 1 : 0;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const packages = db.prepare(`
    SELECT
      p.*,
      COALESCE(bus_counts.active_bus_count, 0) AS active_bus_count,
      COALESCE(tyre_counts.total_tyre_count, 0) AS total_tyre_count
    FROM packages p
    LEFT JOIN (
      SELECT package_id, COUNT(*) AS active_bus_count FROM buses WHERE status = 'Active' GROUP BY package_id
    ) bus_counts ON bus_counts.package_id = p.id
    LEFT JOIN (
      SELECT current_package_id, COUNT(*) AS total_tyre_count FROM tyres GROUP BY current_package_id
    ) tyre_counts ON tyre_counts.current_package_id = p.id
    ${where}
    ORDER BY p.is_active DESC, p.name
  `).all(params);

  res.json(packages);
});

router.get('/:id', (req, res) => {
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  res.json(pkg);
});

router.post('/', authorize(...WRITE_ROLES), (req, res) => {
  const { name, code } = req.body || {};
  if (!name || !code) {
    return res.status(400).json({ error: 'name and code are required' });
  }

  try {
    const info = db.prepare('INSERT INTO packages (name, code) VALUES (?, ?)').run(name, code);
    const created = db.prepare('SELECT * FROM packages WHERE id = ?').get(info.lastInsertRowid);

    writeAuditLog({ user: req.user, action: 'CREATE', entityType: 'package', entityId: created.id, after: created });

    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Package code already exists' });
    }
    throw err;
  }
});

router.put('/:id', authorize(...WRITE_ROLES), (req, res) => {
  const before = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Package not found' });

  const name = req.body?.name ?? before.name;
  const code = req.body?.code ?? before.code;

  try {
    db.prepare(`UPDATE packages SET name = ?, code = ?, updated_at = datetime('now') WHERE id = ?`).run(name, code, req.params.id);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Package code already exists' });
    }
    throw err;
  }

  const after = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'package', entityId: after.id, before, after });

  res.json(after);
});

router.patch('/:id/status', authorize(...WRITE_ROLES), (req, res) => {
  const { is_active } = req.body || {};
  if (is_active === undefined) return res.status(400).json({ error: 'is_active is required' });

  const before = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Package not found' });

  db.prepare(`UPDATE packages SET is_active = ?, updated_at = datetime('now') WHERE id = ?`).run(is_active ? 1 : 0, req.params.id);

  const after = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'package', entityId: after.id, before, after });

  res.json(after);
});

// Packages are never hard-deleted, only deactivated, same as Depot.

module.exports = router;
