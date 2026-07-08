/**
 * @file inspectionService.js
 * @description Manages physical tyre inspection checklists and schedules, computing overdue ages
 * and generating inspection alarms when scheduled limits are exceeded.
 */

const db = require('../db');
const { resolveThreshold, evaluateInspectionAge } = require('./thresholdEngine');
const { upsertBreachAlert, autoResolveAlert } = require('./alertService');

// Correlated subquery fetching the date of the latest reading event for a tyre
const LAST_READING_SUBQUERY = `
  (SELECT event_date FROM tyre_events
   WHERE tyre_id = t.id AND event_type IN ('nsd_reading', 'pressure_reading')
   ORDER BY event_date DESC, id DESC LIMIT 1)
`;

/**
 * Computes the inspection compliance state of a tyre.
 * 
 * @param {object} tyre - Tyre master row
 * @param {string|null} lastReadingDate - Timestamp string of last reading event
 * @param {object} threshold - Inspection interval threshold settings row
 * @returns {{status: string, daysSinceLastReading: number, lastReadingDate: string|null}} Compliance indicators
 */
function computeInspectionCompliance(tyre, lastReadingDate, threshold) {
  const baseline = lastReadingDate || tyre.created_at;
  // Calculate elapsed days since the baseline date
  const daysSince = (Date.now() - new Date(baseline.replace(' ', 'T') + 'Z').getTime()) / (1000 * 60 * 60 * 24);
  const status = evaluateInspectionAge(daysSince, threshold);
  return { status, daysSinceLastReading: Math.floor(daysSince), lastReadingDate: lastReadingDate || null };
}

/**
 * Resolves list of in-service tyres along with the date of their last reading event.
 * 
 * @param {number|null} [depotId] - Optional depot ID scoping
 * @returns {Array<object>} Tyres with reading dates
 */
function listInServiceTyresWithLastReading(depotId) {
  const clauses = [`t.status = 'In Service'`];
  const params = {};
  if (depotId) {
    clauses.push('t.current_depot_id = @depotId');
    params.depotId = depotId;
  }
  return db
    .prepare(`
      SELECT t.*, ${LAST_READING_SUBQUERY} AS last_reading_date
      FROM tyres t
      WHERE ${clauses.join(' AND ')}
    `)
    .all(params);
}

/**
 * Sweeps all in-service tyres to sync/raise "Inspection Overdue" alerts or auto-resolve them.
 * 
 * @param {number|null} [depotId] - Optional depot ID scoping to restrict the sweep
 * @returns {Array<object>} Sweep results mapping tyres to their updated compliance status
 */
function syncInspectionAlerts(depotId) {
  const threshold = resolveThreshold('INSPECTION_INTERVAL', {});
  const tyres = listInServiceTyresWithLastReading(depotId);
  const results = [];

  for (const tyre of tyres) {
    const { status, daysSinceLastReading } = computeInspectionCompliance(tyre, tyre.last_reading_date, threshold);

    if (status === 'Overdue') {
      upsertBreachAlert({
        tyreId: tyre.id,
        busId: tyre.current_bus_id,
        depotId: tyre.current_depot_id,
        parameterType: 'INSPECTION',
        severity: 'Critical',
        readingValue: daysSinceLastReading,
        thresholdValue: threshold?.critical_max ?? null,
        triggeringEventId: null,
      });
    } else {
      autoResolveAlert({ tyreId: tyre.id, parameterType: 'INSPECTION', resolvedByUserId: null });
    }
    results.push({ tyreId: tyre.id, status, daysSinceLastReading });
  }

  return results;
}

module.exports = { computeInspectionCompliance, listInServiceTyresWithLastReading, syncInspectionAlerts };
