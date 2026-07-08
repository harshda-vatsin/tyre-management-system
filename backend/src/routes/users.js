const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/auditLog');
const { ROLES } = require('../utils/roles');

const router = express.Router();

// SRS 8.2 + milestone module 4: user management is Administrator-only, full stop.
const ADMIN_ONLY = [ROLES.ADMIN];
const DEPOT_SCOPED_ROLES = [ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR];
const NO_DEPOT_ROLES = [ROLES.ADMIN, ROLES.NATIONAL_FLEET_MANAGER];

const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

function serialize(row) {
  if (!row) return row;
  const { password_hash, ...rest } = row;
  return rest;
}

function resolveDepotId(role, depot_id) {
  if (DEPOT_SCOPED_ROLES.includes(role)) {
    if (!depot_id) return { error: `depot_id is required for role ${role}` };
    return { depot_id: Number(depot_id) };
  }
  if (NO_DEPOT_ROLES.includes(role)) {
    return { depot_id: null };
  }
  // Read-Only Auditor: depot scope is optional (SRS 6 — "Configurable: Depot or All").
  return { depot_id: depot_id ? Number(depot_id) : null };
}

router.use(authenticate, authorize(...ADMIN_ONLY));

router.get('/', (req, res) => {
  const { search = '', role, depot_id, is_active, page = '1', pageSize = '20' } = req.query;
  const clauses = [];
  const params = {};

  if (search) {
    clauses.push('(username LIKE @search OR email LIKE @search OR full_name LIKE @search)');
    params.search = `%${search}%`;
  }
  if (role) {
    clauses.push('role = @role');
    params.role = role;
  }
  if (depot_id) {
    clauses.push('depot_id = @depot_id');
    params.depot_id = Number(depot_id);
  }
  if (is_active !== undefined) {
    clauses.push('is_active = @is_active');
    params.is_active = is_active === 'true' || is_active === '1' ? 1 : 0;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM users ${where}`).get(params).c;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;

  const rows = db
    .prepare(`SELECT * FROM users ${where} ORDER BY full_name LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset });

  res.json({ data: rows.map(serialize), total, page: pageNum, pageSize: size });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json(serialize(row));
});

router.post('/', (req, res) => {
  const { username, email, full_name, role, depot_id, password } = req.body || {};

  if (!username || !email || !full_name || !role || !password) {
    return res.status(400).json({ error: 'username, email, full_name, role and password are required' });
  }
  if (!Object.values(ROLES).includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${Object.values(ROLES).join(', ')}` });
  }
  if (!PASSWORD_RULE.test(password)) {
    return res.status(400).json({ error: 'password must be at least 8 characters and include a letter and a number' });
  }

  const depotResult = resolveDepotId(role, depot_id);
  if (depotResult.error) return res.status(400).json({ error: depotResult.error });

  const passwordHash = bcrypt.hashSync(password, 10);

  try {
    const info = db
      .prepare(`
        INSERT INTO users (username, email, password_hash, full_name, role, depot_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(username, email, passwordHash, full_name, role, depotResult.depot_id);

    const created = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    writeAuditLog({ user: req.user, action: 'CREATE', entityType: 'user', entityId: created.id, after: serialize(created) });
    res.status(201).json(serialize(created));
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A user with this username or email already exists' });
    }
    throw err;
  }
});

router.put('/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'User not found' });

  const username = req.body?.username ?? before.username;
  const email = req.body?.email ?? before.email;
  const full_name = req.body?.full_name ?? before.full_name;
  const role = req.body?.role ?? before.role;

  if (!Object.values(ROLES).includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${Object.values(ROLES).join(', ')}` });
  }

  const depot_id = req.body?.depot_id !== undefined ? req.body.depot_id : before.depot_id;
  const depotResult = resolveDepotId(role, depot_id);
  if (depotResult.error) return res.status(400).json({ error: depotResult.error });

  try {
    db.prepare(`
      UPDATE users SET username = ?, email = ?, full_name = ?, role = ?, depot_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(username, email, full_name, role, depotResult.depot_id, req.params.id);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A user with this username or email already exists' });
    }
    throw err;
  }

  const after = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'user', entityId: after.id, before: serialize(before), after: serialize(after) });
  res.json(serialize(after));
});

router.patch('/:id/status', (req, res) => {
  const { is_active } = req.body || {};
  if (is_active === undefined) return res.status(400).json({ error: 'is_active is required' });

  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'User not found' });

  if (before.id === req.user.id && !is_active) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }

  db.prepare(`UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ?`).run(is_active ? 1 : 0, req.params.id);

  const after = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'user', entityId: after.id, before: serialize(before), after: serialize(after) });
  res.json(serialize(after));
});

router.post('/:id/reset-password', (req, res) => {
  const { new_password } = req.body || {};
  if (!new_password || !PASSWORD_RULE.test(new_password)) {
    return res.status(400).json({ error: 'new_password must be at least 8 characters and include a letter and a number' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const passwordHash = bcrypt.hashSync(new_password, 10);
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(passwordHash, req.params.id);

  writeAuditLog({ user: req.user, action: 'UPDATE', entityType: 'user', entityId: user.id, before: { password: '(hidden)' }, after: { password: '(reset by admin)' } });
  res.json({ message: 'Password reset successfully' });
});

module.exports = router;
