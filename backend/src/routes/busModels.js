const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/auditLog');
const { ROLES } = require('../utils/roles');
const { SUPPORTED_TYRE_COUNTS, getPositionLayout } = require('../utils/busLayout');

const router = express.Router();
// FR-BM-02: bus model / tyre-position template management is Administrator-only,
// same tier as depot master (SRS 8.1 treats this class of config as admin-owned).
const WRITE_ROLES = [ROLES.ADMIN];

router.use(authenticate);

function serialize(row) {
  return {
    ...row,
    position_labels: JSON.parse(row.position_labels_json),
  };
}

// FR-BM-XX: the admin only chooses a total tyre count from the predefined
// set; there is no manual axle/position builder.
function resolvePositionLayout(num_positions) {
  const count = Number(num_positions);
  if (!Number.isInteger(count) || !SUPPORTED_TYRE_COUNTS.includes(count)) {
    return { error: `num_positions must be one of: ${SUPPORTED_TYRE_COUNTS.join(', ')}` };
  }
  return { positionLabels: getPositionLayout(count) };
}

router.get('/', (req, res) => {
  const { search = '', is_active } = req.query;
  const clauses = [];
  const params = {};

  if (search) {
    clauses.push('(name LIKE @search OR manufacturer LIKE @search)');
    params.search = `%${search}%`;
  }
  if (is_active !== undefined) {
    clauses.push('is_active = @is_active');
    params.is_active = is_active === 'true' || is_active === '1' ? 1 : 0;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM bus_models ${where} ORDER BY name`).all(params);
  res.json(rows.map(serialize));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM bus_models WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Bus model not found' });
  res.json(serialize(row));
});

router.post('/', authorize(...WRITE_ROLES), (req, res) => {
  const { name, manufacturer, num_positions } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const layoutResult = resolvePositionLayout(num_positions);
  if (layoutResult.error) return res.status(400).json({ error: layoutResult.error });
  const { positionLabels } = layoutResult;

  try {
    const info = db
      .prepare(`
        INSERT INTO bus_models (name, manufacturer, num_positions, position_labels_json)
        VALUES (?, ?, ?, ?)
      `)
      .run(name.trim(), manufacturer || null, positionLabels.length, JSON.stringify(positionLabels));

    const created = db.prepare('SELECT * FROM bus_models WHERE id = ?').get(info.lastInsertRowid);
    writeAuditLog({ user: req.user, action: 'CREATE', entityType: 'bus_model', entityId: created.id, after: created });
    res.status(201).json(serialize(created));
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A bus model with this name already exists' });
    }
    throw err;
  }
});

router.put('/:id', authorize(...WRITE_ROLES), (req, res) => {
  const before = db.prepare('SELECT * FROM bus_models WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Bus model not found' });

  const name = req.body?.name ?? before.name;
  const manufacturer = req.body?.manufacturer ?? before.manufacturer;
  const num_positions_input = req.body?.num_positions ?? before.num_positions;
  const is_active = req.body?.is_active !== undefined ? (req.body.is_active ? 1 : 0) : before.is_active;

  const layoutResult = resolvePositionLayout(num_positions_input);
  if (layoutResult.error) return res.status(400).json({ error: layoutResult.error });
  const { positionLabels } = layoutResult;

  try {
    db.prepare(`
      UPDATE bus_models
      SET name = ?, manufacturer = ?, num_positions = ?, position_labels_json = ?, is_active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, manufacturer, positionLabels.length, JSON.stringify(positionLabels), is_active, req.params.id);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A bus model with this name already exists' });
    }
    throw err;
  }

  const after = db.prepare('SELECT * FROM bus_models WHERE id = ?').get(req.params.id);
  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'bus_model', entityId: after.id, before, after });
  res.json(serialize(after));
});

router.delete('/:id', authorize(...WRITE_ROLES), (req, res) => {
  const before = db.prepare('SELECT * FROM bus_models WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Bus model not found' });

  const inUse = db.prepare('SELECT COUNT(*) c FROM buses WHERE bus_model_id = ?').get(req.params.id);
  if (inUse.c > 0) {
    return res.status(409).json({ error: 'Cannot delete a bus model that is assigned to buses. Deactivate it instead.' });
  }

  db.prepare('DELETE FROM bus_models WHERE id = ?').run(req.params.id);
  writeAuditLog({ user: req.user, action: 'DELETE', entityType: 'bus_model', entityId: before.id, before });
  res.status(204).send();
});

module.exports = router;
