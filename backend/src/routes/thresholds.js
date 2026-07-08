const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/auditLog');
const { ROLES } = require('../utils/roles');
const { resolveThreshold } = require('../utils/thresholdEngine');

const router = express.Router();

// SRS 8.1 + section 6: threshold configuration is Administrator-only to write.
// This module is configuration storage ONLY — no breach evaluation is implemented here.
const WRITE_ROLES = [ROLES.ADMIN];

// SRS 8.1 table: which scopes are legal per parameter.
const ALLOWED_SCOPES = {
  NSD: ['GLOBAL', 'DEPOT'],
  PRESSURE: ['GLOBAL', 'BUS_MODEL'],
  INSPECTION_INTERVAL: ['GLOBAL'],
  ESCALATION_DAYS: ['GLOBAL'],
};
// Which of the four numeric fields are meaningful per parameter. NSD/INSPECTION/
// ESCALATION are single-bound (upper limit only); PRESSURE is a two-sided band.
const REQUIRED_FIELDS = {
  NSD: { warning: ['warning_max'], critical: ['critical_max'] },
  PRESSURE: { warning: ['warning_min', 'warning_max'], critical: ['critical_min', 'critical_max'] },
  INSPECTION_INTERVAL: { warning: ['warning_max'], critical: ['critical_max'] },
  ESCALATION_DAYS: { warning: ['warning_max'], critical: [] },
};

const SELECT_THRESHOLD = `
  SELECT
    th.*,
    d.name AS depot_name,
    bm.name AS bus_model_name,
    u.username AS updated_by_username
  FROM thresholds th
  LEFT JOIN depots d ON th.scope_type = 'DEPOT' AND d.id = th.scope_id
  LEFT JOIN bus_models bm ON th.scope_type = 'BUS_MODEL' AND bm.id = th.scope_id
  LEFT JOIN users u ON u.id = th.updated_by
`;

function validate(body) {
  const { parameter_type, scope_type = 'GLOBAL', scope_id, warning_min, warning_max, critical_min, critical_max } = body;

  if (!ALLOWED_SCOPES[parameter_type]) {
    return { error: `parameter_type must be one of: ${Object.keys(ALLOWED_SCOPES).join(', ')}` };
  }
  if (!ALLOWED_SCOPES[parameter_type].includes(scope_type)) {
    return { error: `${parameter_type} only supports scope_type: ${ALLOWED_SCOPES[parameter_type].join(', ')}` };
  }
  if (scope_type !== 'GLOBAL' && !scope_id) {
    return { error: `scope_id is required when scope_type is ${scope_type}` };
  }
  if (scope_type === 'GLOBAL' && scope_id) {
    return { error: 'scope_id must be omitted when scope_type is GLOBAL' };
  }

  if (scope_type === 'DEPOT') {
    const depot = db.prepare('SELECT id FROM depots WHERE id = ?').get(scope_id);
    if (!depot) return { error: 'scope_id does not reference a valid depot' };
  }
  if (scope_type === 'BUS_MODEL') {
    const model = db.prepare('SELECT id FROM bus_models WHERE id = ?').get(scope_id);
    if (!model) return { error: 'scope_id does not reference a valid bus model' };
  }

  const required = REQUIRED_FIELDS[parameter_type];
  const provided = { warning_min, warning_max, critical_min, critical_max };
  for (const field of [...required.warning, ...required.critical]) {
    if (provided[field] === undefined || provided[field] === null || provided[field] === '') {
      return { error: `${field} is required for parameter_type ${parameter_type}` };
    }
  }
  // Null out fields the parameter type doesn't use, so stale values can't linger.
  const allFields = ['warning_min', 'warning_max', 'critical_min', 'critical_max'];
  const usedFields = new Set([...required.warning, ...required.critical]);
  const normalized = {};
  for (const f of allFields) {
    normalized[f] = usedFields.has(f) ? Number(provided[f]) : null;
  }

  return { normalized, scope_id: scope_type === 'GLOBAL' ? null : Number(scope_id) };
}

router.use(authenticate);

// FR-RW-02: lets a data-entry client (Batch Inspection) show an immediate
// inline warning as a value is typed, instead of only after submit -- returns
// the same warning/critical bounds the server itself will evaluate against,
// resolved through the same DEPOT/BUS_MODEL-override-then-GLOBAL precedence.
// Open to every authenticated role; it's a read of already-visible limits,
// not a scoped resource.
router.get('/resolve', (req, res) => {
  const { parameter_type, depot_id, bus_model_id } = req.query;
  if (!parameter_type) return res.status(400).json({ error: 'parameter_type is required' });

  const threshold = resolveThreshold(parameter_type, {
    depotId: depot_id ? Number(depot_id) : undefined,
    busModelId: bus_model_id ? Number(bus_model_id) : undefined,
  });

  if (!threshold) return res.json(null);
  const { warning_min, warning_max, critical_min, critical_max, unit, scope_type } = threshold;
  res.json({ warning_min, warning_max, critical_min, critical_max, unit, scope_type });
});

router.get('/', (req, res) => {
  const { parameter_type, scope_type, is_active } = req.query;
  const clauses = [];
  const params = {};

  if (parameter_type) {
    clauses.push('th.parameter_type = @parameter_type');
    params.parameter_type = parameter_type;
  }
  if (scope_type) {
    clauses.push('th.scope_type = @scope_type');
    params.scope_type = scope_type;
  }
  if (is_active !== undefined) {
    clauses.push('th.is_active = @is_active');
    params.is_active = is_active === 'true' || is_active === '1' ? 1 : 0;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`${SELECT_THRESHOLD} ${where} ORDER BY th.parameter_type, th.scope_type`).all(params);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`${SELECT_THRESHOLD} WHERE th.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Threshold not found' });
  res.json(row);
});

router.post('/', authorize(...WRITE_ROLES), (req, res) => {
  const result = validate(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });

  const { parameter_type, scope_type = 'GLOBAL', unit } = req.body;

  const existing = db
    .prepare(`
      SELECT id FROM thresholds
      WHERE parameter_type = ? AND scope_type = ? AND is_active = 1
        AND ((scope_id IS NULL AND ? IS NULL) OR scope_id = ?)
    `)
    .get(parameter_type, scope_type, result.scope_id, result.scope_id);
  if (existing) {
    return res.status(409).json({ error: 'An active threshold already exists for this parameter and scope. Edit it instead.' });
  }

  const info = db
    .prepare(`
      INSERT INTO thresholds (parameter_type, scope_type, scope_id, warning_min, warning_max, critical_min, critical_max, unit, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      parameter_type,
      scope_type,
      result.scope_id,
      result.normalized.warning_min,
      result.normalized.warning_max,
      result.normalized.critical_min,
      result.normalized.critical_max,
      unit || null,
      req.user.id
    );

  const created = db.prepare(`${SELECT_THRESHOLD} WHERE th.id = ?`).get(info.lastInsertRowid);
  writeAuditLog({ user: req.user, action: 'CREATE', entityType: 'threshold', entityId: created.id, after: created });
  res.status(201).json(created);
});

router.put('/:id', authorize(...WRITE_ROLES), (req, res) => {
  const before = db.prepare('SELECT * FROM thresholds WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Threshold not found' });

  const merged = {
    parameter_type: before.parameter_type,
    scope_type: before.scope_type,
    scope_id: before.scope_id,
    warning_min: before.warning_min,
    warning_max: before.warning_max,
    critical_min: before.critical_min,
    critical_max: before.critical_max,
    ...req.body,
  };

  const result = validate(merged);
  if (result.error) return res.status(400).json({ error: result.error });

  const unit = req.body?.unit ?? before.unit;

  db.prepare(`
    UPDATE thresholds
    SET warning_min = ?, warning_max = ?, critical_min = ?, critical_max = ?, unit = ?, updated_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    result.normalized.warning_min,
    result.normalized.warning_max,
    result.normalized.critical_min,
    result.normalized.critical_max,
    unit,
    req.user.id,
    req.params.id
  );

  const after = db.prepare(`${SELECT_THRESHOLD} WHERE th.id = ?`).get(req.params.id);
  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'threshold', entityId: after.id, before, after });
  res.json(after);
});

router.patch('/:id/deactivate', authorize(...WRITE_ROLES), (req, res) => {
  const before = db.prepare('SELECT * FROM thresholds WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Threshold not found' });

  if (before.scope_type === 'GLOBAL') {
    return res.status(409).json({ error: 'Global thresholds cannot be deactivated, only overridden values changed' });
  }

  db.prepare(`UPDATE thresholds SET is_active = 0, updated_by = ?, updated_at = datetime('now') WHERE id = ?`).run(req.user.id, req.params.id);

  const after = db.prepare(`${SELECT_THRESHOLD} WHERE th.id = ?`).get(req.params.id);
  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'threshold', entityId: after.id, before, after });
  res.json(after);
});

module.exports = router;
