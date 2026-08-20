/**
 * @file inspectionService.js
 * @description Manages physical tyre inspection checklists and schedules, computing overdue ages
 * and generating inspection alarms when scheduled limits are exceeded.
 */

const db = require('../db');
const { resolveThreshold, evaluateInspectionAge } = require('./thresholdEngine');
const { upsertBreachAlert, autoResolveAlert } = require('./alertService');

// Also counts inspection_completed as a "reading" for baseline purposes --
// an inspection sign-off legitimately resets the inspection-due clock even
// without a fresh NSD/pressure value attached to it.
const LAST_NSD_READING_SUBQUERY = `
  (SELECT event_date FROM tyre_events
   WHERE tyre_id = t.id AND event_type IN ('nsd_reading', 'inspection_completed')
   ORDER BY event_date DESC, id DESC LIMIT 1)
`;

const LAST_PRESSURE_READING_SUBQUERY = `
  (SELECT event_date FROM tyre_events
   WHERE tyre_id = t.id AND event_type IN ('pressure_reading', 'inspection_completed')
   ORDER BY event_date DESC, id DESC LIMIT 1)
`;

const STATUS_RANK = { 'On Time': 0, Due: 1, Overdue: 2 };

/**
 * Computes the inspection compliance state of a tyre combining both NSD and Pressure.
 * 
 * @param {object} tyre - Tyre master row
 * @param {string|null} lastNsdDate - Timestamp string of last NSD event
 * @param {string|null} lastPressureDate - Timestamp string of last Pressure event
 * @param {object} nsdThreshold - NSD Inspection interval threshold
 * @param {object} pressureThreshold - Pressure Inspection interval threshold
 * @returns {object} Compliance indicators for both and overall status
 */
function computeInspectionCompliance(tyre, lastNsdDate, lastPressureDate, nsdThreshold, pressureThreshold) {
  const nsdBaseline = lastNsdDate || tyre.created_at;
  const nsdDaysSince = (Date.now() - new Date(nsdBaseline.replace(' ', 'T') + 'Z').getTime()) / (1000 * 60 * 60 * 24);
  const nsdStatus = evaluateInspectionAge(nsdDaysSince, nsdThreshold);

  const pressureBaseline = lastPressureDate || tyre.created_at;
  const pressureDaysSince = (Date.now() - new Date(pressureBaseline.replace(' ', 'T') + 'Z').getTime()) / (1000 * 60 * 60 * 24);
  const pressureStatus = evaluateInspectionAge(pressureDaysSince, pressureThreshold);

  const overallStatus = STATUS_RANK[nsdStatus] > STATUS_RANK[pressureStatus] ? nsdStatus : pressureStatus;

  return { 
    status: overallStatus, 
    nsdStatus,
    pressureStatus,
    daysSinceLastNsd: Math.floor(nsdDaysSince), 
    daysSinceLastPressure: Math.floor(pressureDaysSince), 
    lastNsdDate: lastNsdDate || null,
    lastPressureDate: lastPressureDate || null 
  };
}

/**
 * Resolves list of in-service tyres along with the date of their last reading events.
 * 
 * @param {number|null} [depotId] - Optional depot ID scoping
 * @returns {Array<object>} Tyres with reading dates
 */
function listInServiceTyresWithLastReading(depotId) {
  const clauses = [`t.status = 'Active'`];
  const params = {};
  if (depotId) {
    clauses.push('t.current_depot_id = @depotId');
    params.depotId = depotId;
  }
  return db
    .prepare(`
      SELECT t.*, 
        ${LAST_NSD_READING_SUBQUERY} AS last_nsd_date,
        ${LAST_PRESSURE_READING_SUBQUERY} AS last_pressure_date
      FROM tyres t
      WHERE ${clauses.join(' AND ')}
    `)
    .all(params); // returns a Promise -- callers must await
}

/**
 * Sweeps all in-service tyres to sync/raise "Inspection Overdue" alerts or auto-resolve them.
 * 
 * @param {number|null} [depotId] - Optional depot ID scoping to restrict the sweep
 * @returns {Array<object>} Sweep results mapping tyres to their updated compliance status
 */
async function syncInspectionAlerts(depotId) {
  const nsdThreshold = await resolveThreshold('NSD_INSPECTION_INTERVAL', {});
  const pressureThreshold = await resolveThreshold('PRESSURE_INSPECTION_INTERVAL', {});
  const tyres = await listInServiceTyresWithLastReading(depotId);
  const results = [];

  for (const tyre of tyres) {
    const comp = computeInspectionCompliance(tyre, tyre.last_nsd_date, tyre.last_pressure_date, nsdThreshold, pressureThreshold);

    if (comp.nsdStatus === 'Overdue') {
      await upsertBreachAlert({
        tyreId: tyre.id,
        busId: tyre.current_bus_id,
        depotId: tyre.current_depot_id,
        parameterType: 'NSD_INSPECTION',
        severity: 'Critical',
        readingValue: comp.daysSinceLastNsd,
        thresholdValue: nsdThreshold?.critical_max ?? null,
        triggeringEventId: null,
      });
    } else {
      await autoResolveAlert({ tyreId: tyre.id, parameterType: 'NSD_INSPECTION', resolvedByUserId: null });
    }

    if (comp.pressureStatus === 'Overdue') {
      await upsertBreachAlert({
        tyreId: tyre.id,
        busId: tyre.current_bus_id,
        depotId: tyre.current_depot_id,
        parameterType: 'PRESSURE_INSPECTION',
        severity: 'Critical',
        readingValue: comp.daysSinceLastPressure,
        thresholdValue: pressureThreshold?.critical_max ?? null,
        triggeringEventId: null,
      });
    } else {
      await autoResolveAlert({ tyreId: tyre.id, parameterType: 'PRESSURE_INSPECTION', resolvedByUserId: null });
    }

    results.push({ tyreId: tyre.id, status: comp.status });
  }

  return results;
}

module.exports = { computeInspectionCompliance, listInServiceTyresWithLastReading, syncInspectionAlerts };
