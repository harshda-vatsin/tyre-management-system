const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const dashboardService = require('../utils/dashboardService');
const { ROLES, isDepotScoped } = require('../utils/roles');

const router = express.Router();

// SRS 7.1: "visible to National Fleet Managers and Administrators". Read-Only
// Auditor is included too -- their whole role is fleet-wide oversight, and this
// endpoint is read-only, so it doesn't extend any write capability to them.
// A depot-scoped Auditor (depot_id assigned) is excluded below, since a
// fleet-wide aggregate is exactly what their assigned scope should not see.
const NATIONAL_ROLES = [ROLES.ADMIN, ROLES.NATIONAL_FLEET_MANAGER, ROLES.AUDITOR];

router.use(authenticate);

router.get('/national', authorize(...NATIONAL_ROLES), (req, res) => {
  if (isDepotScoped(req.user)) {
    return res.status(403).json({ error: 'Scoped to a single depot -- use /dashboard/depot instead' });
  }
  res.json(dashboardService.getNationalDashboard());
});

// Depot Manager/Tyre Supervisor are always scoped to their own depot;
// fleet-wide roles must specify depot_id (this is the "drillable by depot"
// path from the national dashboard's alert/compliance widgets).
router.get('/depot', (req, res) => {
  let depotId;
  if (isDepotScoped(req.user)) {
    depotId = req.user.depot_id;
  } else {
    if (!req.query.depot_id) return res.status(400).json({ error: 'depot_id is required' });
    depotId = Number(req.query.depot_id);
  }

  const depot = db.prepare('SELECT id FROM depots WHERE id = ?').get(depotId);
  if (!depot) return res.status(404).json({ error: 'Depot not found' });

  res.json(dashboardService.getDepotDashboard(depotId));
});

module.exports = router;
