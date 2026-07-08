const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { FLEET_WIDE_ROLES } = require('../utils/roles');

const router = express.Router();

// Enforce RBAC: audit logs should only be accessible by fleet-wide roles (Admin, NFM, Auditor)
router.use(authenticate, authorize(...FLEET_WIDE_ROLES));

router.get('/', (req, res) => {
  const { action, entity_type, username, from, to, search, page = '1', pageSize = '20' } = req.query;
  const clauses = [];
  const params = {};

  if (action) {
    clauses.push('action = @action');
    params.action = action;
  }
  if (entity_type) {
    clauses.push('entity_type = @entity_type');
    params.entity_type = entity_type;
  }
  if (username) {
    clauses.push('username = @username');
    params.username = username;
  }
  if (from) {
    clauses.push('created_at >= @from');
    params.from = from;
  }
  if (to) {
    clauses.push('created_at <= @to');
    params.to = to;
  }
  if (search) {
    clauses.push('(username LIKE @search OR entity_type LIKE @search OR entity_id LIKE @search OR action LIKE @search)');
    params.search = `%${search}%`;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_log ${where}`).get(params).c;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;

  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset });

  res.json({ data: rows, total, page: pageNum, pageSize: size });
});

module.exports = router;
