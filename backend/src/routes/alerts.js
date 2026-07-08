/**
 * @file alerts.js
 * @description Exposes endpoints to search alerts, acknowledge open alerts,
 * and manually resolve active alerts.
 */

const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { acknowledgeAlert, resolveAlertManually, escalateStaleOpenAlerts, ApiError } = require('../utils/alertService');
const { syncInspectionAlerts } = require('../utils/inspectionService');
const { ROLES, isDepotScoped } = require('../utils/roles');

const router = express.Router();

// SRS §6: acknowledge/resolve is Admin, National Fleet Manager ("acknowledge
// and close national-level alerts" -- NFM's one write action anywhere in the
// spec), and Depot Manager (own depot). Tyre Supervisor and Read-Only Auditor
// are read-only here.
const WRITE_ROLES = [ROLES.ADMIN, ROLES.NATIONAL_FLEET_MANAGER, ROLES.DEPOT_MANAGER];

function handleError(err, res) {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
  throw err;
}

const SELECT_ALERT = `
  SELECT
    a.*,
    (a.escalation_level > 0) AS is_escalated,
    ROUND(julianday(COALESCE(a.resolved_at, datetime('now'))) - julianday(a.opened_at), 1) AS age_days,
    t.tyre_number,
    b.registration_no AS bus_registration_no,
    d.name AS depot_name,
    e.event_date AS triggering_event_date,
    ack.username AS acknowledged_by_username,
    res.username AS resolved_by_username
  FROM alerts a
  JOIN tyres t ON t.id = a.tyre_id
  LEFT JOIN buses b ON b.id = a.bus_id
  LEFT JOIN depots d ON d.id = a.depot_id
  LEFT JOIN tyre_events e ON e.id = a.triggering_event_id
  LEFT JOIN users ack ON ack.id = a.acknowledged_by
  LEFT JOIN users res ON res.id = a.resolved_by
`;

router.use(authenticate);

// Reconciliation is synchronous and read-triggered (no cron dependency in this
// skeleton): every list/detail read first escalates stale Open alerts and
// syncs inspection-overdue alerts, so results are always current.
function reconcile(req) {
  escalateStaleOpenAlerts();
  syncInspectionAlerts(isDepotScoped(req.user) ? req.user.depot_id : undefined);
}

router.get('/', (req, res) => {
  reconcile(req);

  const { search, status, severity, parameter_type, depot_id, tyre_id, bus_id, escalated, page = '1', pageSize = '20' } = req.query;
  const clauses = [];
  const params = {};

  if (search) {
    clauses.push('(t.tyre_number LIKE @search OR b.registration_no LIKE @search)');
    params.search = `%${search}%`;
  }
  if (status) {
    clauses.push('a.status = @status');
    params.status = status;
  }
  if (severity) {
    clauses.push('a.severity = @severity');
    params.severity = severity;
  }
  if (parameter_type) {
    clauses.push('a.parameter_type = @parameter_type');
    params.parameter_type = parameter_type;
  }
  if (tyre_id) {
    clauses.push('a.tyre_id = @tyre_id');
    params.tyre_id = Number(tyre_id);
  }
  if (bus_id) {
    clauses.push('a.bus_id = @bus_id');
    params.bus_id = Number(bus_id);
  }
  if (escalated !== undefined) {
    clauses.push('(a.escalation_level > 0) = @escalated');
    params.escalated = escalated === 'true' || escalated === '1' ? 1 : 0;
  }

  if (isDepotScoped(req.user)) {
    clauses.push('a.depot_id = @depot_id');
    params.depot_id = req.user.depot_id;
  } else if (depot_id) {
    clauses.push('a.depot_id = @depot_id');
    params.depot_id = Number(depot_id);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`
    SELECT COUNT(*) c 
    FROM alerts a
    JOIN tyres t ON t.id = a.tyre_id
    LEFT JOIN buses b ON b.id = a.bus_id
    ${where}
  `).get(params).c;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;

  const rows = db
    .prepare(`${SELECT_ALERT} ${where} ORDER BY a.status = 'Open' DESC, a.opened_at DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset });

  res.json({ data: rows, total, page: pageNum, pageSize: size });
});

router.get('/:id', (req, res) => {
  reconcile(req);

  const row = db.prepare(`${SELECT_ALERT} WHERE a.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Alert not found' });
  if (isDepotScoped(req.user) && row.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }
  res.json(row);
});

router.patch('/:id/acknowledge', authorize(...WRITE_ROLES), (req, res) => {
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (req.user.role === ROLES.DEPOT_MANAGER && alert.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  try {
    acknowledgeAlert(req.params.id, req.user);
    const after = db.prepare(`${SELECT_ALERT} WHERE a.id = ?`).get(req.params.id);
    res.json(after);
  } catch (err) {
    handleError(err, res);
  }
});

router.patch('/:id/resolve', authorize(...WRITE_ROLES), (req, res) => {
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (req.user.role === ROLES.DEPOT_MANAGER && alert.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  try {
    resolveAlertManually(req.params.id, req.user, req.body?.resolution_note);
    const after = db.prepare(`${SELECT_ALERT} WHERE a.id = ?`).get(req.params.id);
    res.json(after);
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
