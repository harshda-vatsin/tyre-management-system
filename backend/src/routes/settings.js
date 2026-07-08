/**
 * @file settings.js
 * @description SRS §8.3 System Parameter Configuration -- currently just the
 * pressure-unit preference (PSI/kPa). Values are stored in the
 * system_settings key/value table; storage of readings themselves stays in
 * PSI always (matching every existing threshold and event row) -- this
 * setting only controls what unit the UI displays and accepts input in.
 */

const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/auditLog');
const { ROLES } = require('../utils/roles');

const router = express.Router();

const WRITE_ROLES = [ROLES.ADMIN];
const ALLOWED = {
  pressure_unit: ['PSI', 'kPa'],
};

router.use(authenticate);

// Every authenticated role can read settings -- it's a display preference
// the whole UI needs, not a scoped or sensitive resource.
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM system_settings').all();
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

router.put('/:key', authorize(...WRITE_ROLES), (req, res) => {
  const { key } = req.params;
  const { value } = req.body || {};

  if (!ALLOWED[key]) {
    return res.status(400).json({ error: `Unknown setting key: ${key}` });
  }
  if (!ALLOWED[key].includes(value)) {
    return res.status(400).json({ error: `${key} must be one of: ${ALLOWED[key].join(', ')}` });
  }

  const before = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);

  db.prepare(`
    INSERT INTO system_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(key, value, req.user.id);

  writeAuditLog({
    user: req.user,
    action: 'UPDATE',
    entityType: 'system_setting',
    entityId: key,
    before: before || null,
    after: { key, value },
  });

  res.json({ key, value });
});

module.exports = router;
