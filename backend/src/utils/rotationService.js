/**
 * @file rotationService.js
 * @description Computes rotation-due/overdue compliance, mirroring
 * inspectionService.js's read-computed pattern exactly (no cron, no stored
 * "Rotation Due" status column value -- see tyreLifecycle.js's header note
 * on why "due" states are never written to tyres.status).
 *
 * MIS Depth Expansion: rotation scheduling is also KM-based in the real
 * MIS ("KMs @ Rotation"), not just day-based -- a tyre is flagged Overdue if
 * EITHER the day-based or the km-based interval is breached, whichever
 * trips first, matching how real maintenance scheduling actually works.
 */

const db = require('../db');
const { resolveThreshold, evaluateInspectionAge } = require('./thresholdEngine');
const { upsertBreachAlert, autoResolveAlert } = require('./alertService');

// Correlated subqueries fetching the date and odometer reading of the
// latest rotation event for a tyre, plus the tyre's current bus's live
// odometer reading (for the km-elapsed-since-last-rotation calculation).
const LAST_ROTATION_SUBQUERY = `
  (SELECT event_date FROM tyre_events
   WHERE tyre_id = t.id AND event_type = 'rotation'
   ORDER BY event_date DESC, id DESC LIMIT 1)
`;
const LAST_ROTATION_ODOMETER_SUBQUERY = `
  (SELECT odometer_km FROM tyre_events
   WHERE tyre_id = t.id AND event_type = 'rotation' AND odometer_km IS NOT NULL
   ORDER BY event_date DESC, id DESC LIMIT 1)
`;

const STATUS_RANK = { 'On Time': 0, Due: 1, Overdue: 2 };

/**
 * Computes the rotation compliance state of a tyre. Reuses
 * evaluateInspectionAge's generic days-vs-threshold logic (On Time/Due/
 * Overdue) -- it isn't actually inspection-specific, just named for its
 * first caller.
 *
 * @param {object} tyre - Tyre master row
 * @param {string|null} lastRotationDate - Timestamp string of last rotation event
 * @param {object} dayThreshold - ROTATION_INTERVAL threshold settings row
 * @param {{lastRotationOdometerKm?: number|null, currentOdometerKm?: number|null, kmThreshold?: object}} [kmContext] -
 *   optional km-based inputs; omitted entirely by callers that don't have odometer data on hand
 * @returns {{status: string, daysSinceLastRotation: number, lastRotationDate: string|null, kmSinceLastRotation: number|null}}
 */
function computeRotationCompliance(tyre, lastRotationDate, dayThreshold, kmContext) {
  const baseline = lastRotationDate || tyre.created_at;
  const daysSince = (Date.now() - new Date(baseline.replace(' ', 'T') + 'Z').getTime()) / (1000 * 60 * 60 * 24);
  const dayStatus = evaluateInspectionAge(daysSince, dayThreshold);

  let kmSinceLastRotation = null;
  let kmStatus = 'On Time';
  if (kmContext && kmContext.currentOdometerKm != null) {
    const baselineKm = kmContext.lastRotationOdometerKm ?? 0;
    kmSinceLastRotation = Math.max(0, kmContext.currentOdometerKm - baselineKm);
    kmStatus = evaluateInspectionAge(kmSinceLastRotation, kmContext.kmThreshold);
  }

  const status = STATUS_RANK[kmStatus] > STATUS_RANK[dayStatus] ? kmStatus : dayStatus;

  return {
    status,
    daysSinceLastRotation: Math.floor(daysSince),
    lastRotationDate: lastRotationDate || null,
    kmSinceLastRotation: kmSinceLastRotation != null ? Math.floor(kmSinceLastRotation) : null,
  };
}

/**
 * Resolves list of in-service tyres along with the date/odometer of their
 * last rotation event and their current bus's live odometer reading.
 *
 * @param {number|null} [depotId]
 * @returns {Array<object>}
 */
function listInServiceTyresWithLastRotation(depotId) {
  const clauses = [`t.status = 'Active'`];
  const params = {};
  if (depotId) {
    clauses.push('t.current_depot_id = @depotId');
    params.depotId = depotId;
  }
  return db
    .prepare(`
      SELECT
        t.*,
        ${LAST_ROTATION_SUBQUERY} AS last_rotation_date,
        ${LAST_ROTATION_ODOMETER_SUBQUERY} AS last_rotation_odometer_km,
        b.odometer_km AS current_odometer_km
      FROM tyres t
      LEFT JOIN buses b ON b.id = t.current_bus_id
      WHERE ${clauses.join(' AND ')}
    `)
    .all(params); // returns a Promise -- callers must await
}

/**
 * Sweeps all in-service tyres to sync/raise "Rotation Overdue" alerts or auto-resolve them.
 *
 * @param {number|null} [depotId]
 * @returns {Array<object>}
 */
async function syncRotationAlerts(depotId) {
  const dayThreshold = await resolveThreshold('ROTATION_INTERVAL', {});
  const kmThreshold = await resolveThreshold('ROTATION_INTERVAL_KM', {});
  const tyres = await listInServiceTyresWithLastRotation(depotId);
  const results = [];

  for (const tyre of tyres) {
    const { status, daysSinceLastRotation, kmSinceLastRotation } = computeRotationCompliance(tyre, tyre.last_rotation_date, dayThreshold, {
      lastRotationOdometerKm: tyre.last_rotation_odometer_km,
      currentOdometerKm: tyre.current_odometer_km,
      kmThreshold,
    });

    if (status === 'Overdue') {
      await upsertBreachAlert({
        tyreId: tyre.id,
        busId: tyre.current_bus_id,
        depotId: tyre.current_depot_id,
        parameterType: 'ROTATION',
        severity: 'Critical',
        readingValue: daysSinceLastRotation,
        thresholdValue: dayThreshold?.critical_max ?? null,
        triggeringEventId: null,
      });
    } else {
      await autoResolveAlert({ tyreId: tyre.id, parameterType: 'ROTATION', resolvedByUserId: null });
    }
    results.push({ tyreId: tyre.id, status, daysSinceLastRotation, kmSinceLastRotation });
  }

  return results;
}

module.exports = { computeRotationCompliance, listInServiceTyresWithLastRotation, syncRotationAlerts };
