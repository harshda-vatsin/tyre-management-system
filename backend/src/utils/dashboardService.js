/**
 * @file dashboardService.js
 * @description Aggregates database metrics to generate KPIs, alerts counters, and status breakdowns
 * for both fleet-wide (national) and individual depot-scoped dashboards.
 */

const db = require('../db');
const { resolveThreshold } = require('./thresholdEngine');
const { computeInspectionCompliance, listInServiceTyresWithLastReading } = require('./inspectionService');
const { computeRotationCompliance, listInServiceTyresWithLastRotation } = require('./rotationService');
const { ALL_STATUSES } = require('./tyreLifecycle');

// The 6 simplified operational statuses, so every one gets a guaranteed
// zero-filled entry in tyre_status_counts even if no tyre currently holds it.
const TYRE_STATUSES = ALL_STATUSES;

/**
 * Counts tyres grouped by status ('In Service', 'In Store', etc.).
 * Optionally filters to a single depot.
 *
 * @param {number|null} [depotId] - Optional depot ID to filter counts
 * @returns {Promise<Record<string, number>>} Count map per status label
 */
async function getTyreStatusCounts(depotId) {
  const params = {};
  let where = '';
  if (depotId) {
    where = 'WHERE current_depot_id = @depotId';
    params.depotId = depotId;
  }
  const rows = await db.prepare(`SELECT status, COUNT(*) c FROM tyres ${where} GROUP BY status`).all(params);
  const counts = Object.fromEntries(TYRE_STATUSES.map((s) => [s, 0]));
  for (const r of rows) counts[r.status] = r.c;
  return counts;
}

/**
 * Counts currently active (Open/Acknowledged) alerts.
 * Grouped by severity ('Warning', 'Critical') and optionally filtered by depot.
 *
 * @param {number|null} [depotId] - Optional depot ID to restrict scope
 * @returns {Promise<{Warning: number, Critical: number}>} Summary counts
 */
async function getActiveAlertCounts(depotId) {
  const params = {};
  let where = `WHERE status IN ('Open', 'Acknowledged')`;
  if (depotId) {
    where += ' AND depot_id = @depotId';
    params.depotId = depotId;
  }
  const rows = await db.prepare(`SELECT severity, COUNT(*) c FROM alerts ${where} GROUP BY severity`).all(params);
  const counts = { Warning: 0, Critical: 0 };
  for (const r of rows) counts[r.severity] = r.c;
  return counts;
}

/**
 * Counts tyres that are either "Due" or "Overdue" for inspection.
 * Computes this by inspecting the age of the last reading against the global interval threshold.
 *
 * @param {number|null} [depotId] - Optional depot filter
 * @returns {Promise<{due: number, overdue: number}>} Counts of affected tyres
 */
async function getInspectionCounts(depotId) {
  const threshold = await resolveThreshold('INSPECTION_INTERVAL', {});
  const tyres = await listInServiceTyresWithLastReading(depotId);
  let due = 0;
  let overdue = 0;
  for (const t of tyres) {
    const { status } = computeInspectionCompliance(t, t.last_reading_date, threshold);
    if (status === 'Due') due += 1;
    else if (status === 'Overdue') overdue += 1;
  }
  return { due, overdue };
}

/**
 * Counts tyres that are either "Due" or "Overdue" for rotation, mirroring
 * getInspectionCounts exactly but against the rotation clock.
 *
 * @param {number|null} [depotId]
 * @returns {Promise<{due: number, overdue: number}>}
 */
async function getRotationCounts(depotId) {
  const threshold = await resolveThreshold('ROTATION_INTERVAL', {});
  const kmThreshold = await resolveThreshold('ROTATION_INTERVAL_KM', {});
  const tyres = await listInServiceTyresWithLastRotation(depotId);
  let due = 0;
  let overdue = 0;
  for (const t of tyres) {
    const { status } = computeRotationCompliance(t, t.last_rotation_date, threshold, {
      lastRotationOdometerKm: t.last_rotation_odometer_km,
      currentOdometerKm: t.current_odometer_km,
      kmThreshold,
    });
    if (status === 'Due') due += 1;
    else if (status === 'Overdue') overdue += 1;
  }
  return { due, overdue };
}

/**
 * Active alert counts broken down by parameter type (NSD/PRESSURE/
 * INSPECTION/ROTATION) and severity, for the dashboard's "Pressure
 * Critical"/"NSD Critical" cards -- getActiveAlertCounts only sums across
 * every parameter type, which isn't granular enough for those.
 *
 * @param {number|null} [depotId]
 * @returns {Promise<Record<string, {Warning: number, Critical: number}>>}
 */
async function getAlertCountsByParameter(depotId) {
  const params = {};
  let where = `WHERE status IN ('Open', 'Acknowledged')`;
  if (depotId) {
    where += ' AND depot_id = @depotId';
    params.depotId = depotId;
  }
  const rows = await db.prepare(`SELECT parameter_type, severity, COUNT(*) c FROM alerts ${where} GROUP BY parameter_type, severity`).all(params);
  const counts = {
    NSD: { Warning: 0, Critical: 0 },
    PRESSURE: { Warning: 0, Critical: 0 },
    INSPECTION: { Warning: 0, Critical: 0 },
    ROTATION: { Warning: 0, Critical: 0 },
  };
  for (const r of rows) {
    if (!counts[r.parameter_type]) counts[r.parameter_type] = { Warning: 0, Critical: 0 };
    counts[r.parameter_type][r.severity] = r.c;
  }
  return counts;
}

/**
 * Lifecycle-stage KPI counts. With the simplified 6-status model these are
 * mostly direct single-status counts (repair_queue = 'Under Repair',
 * at_vendor = 'Under Retread', ...) -- "retreaded" is the one exception,
 * kept as a lifetime event count rather than a status count, since a tyre
 * only sits at 'Under Retread' while it's actually there; once it's back
 * In Store that history would otherwise disappear from this KPI.
 *
 * @param {number|null} [depotId]
 * @returns {Promise<object>}
 */
async function getLifecycleGroupCounts(depotId) {
  const params = {};
  let where = '';
  if (depotId) {
    where = 'WHERE current_depot_id = @depotId';
    params.depotId = depotId;
  }
  const rows = await db.prepare(`SELECT status, COUNT(*) c FROM tyres ${where} GROUP BY status`).all(params);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.c]));

  const retreadedParams = {};
  let retreadedWhere = `WHERE e.event_type = 'retread_completed'`;
  if (depotId) {
    retreadedWhere += ' AND e.depot_id = @depotId';
    retreadedParams.depotId = depotId;
  }
  const retreadedTotal = (await db.prepare(`SELECT COUNT(*) c FROM tyre_events e ${retreadedWhere}`).get(retreadedParams)).c;

  return {
    repair_queue: byStatus['Under Repair'] || 0,
    at_vendor: byStatus['Under Retread'] || 0,
    retreaded_total: retreadedTotal,
    warranty_pending: byStatus['Warranty'] || 0,
    scrapped: byStatus['Scrapped'] || 0,
  };
}

/**
 * Resolves the top-flagged buses with the highest count of unique active tyre alert warnings.
 * Used to identify vehicles requiring immediate maintenance attention.
 *
 * @param {number|null} [depotId] - Optional depot ID filter
 * @param {number} [limit=10] - Max list limit size
 * @returns {Promise<Array<object>>} Flagged bus items list
 */
function getTopFlaggedBuses(depotId, limit = 10) {
  const params = { limit };
  let where = `WHERE a.status IN ('Open', 'Acknowledged') AND a.bus_id IS NOT NULL`;
  if (depotId) {
    where += ' AND b.depot_id = @depotId';
    params.depotId = depotId;
  }
  return db
    .prepare(`
      SELECT b.id AS bus_id, b.registration_no, b.depot_id, d.name AS depot_name, COUNT(DISTINCT a.tyre_id) AS flagged_count
      FROM alerts a
      JOIN buses b ON b.id = a.bus_id
      JOIN depots d ON d.id = b.depot_id
      ${where}
      GROUP BY b.id, b.registration_no, b.depot_id, d.name
      ORDER BY flagged_count DESC
      LIMIT @limit
    `)
    .all(params); // returns a Promise -- callers must await
}

/**
 * Maps each bus to an array containing the compliance status of each of its mounted tyres.
 *
 * @param {number|null} [depotId] - Optional depot ID scoping
 * @returns {Promise<Map<number, string[]>>} Map mapping Bus ID to compliance status array
 */
async function computeBusComplianceMap(depotId) {
  const threshold = await resolveThreshold('INSPECTION_INTERVAL', {});
  const tyres = await listInServiceTyresWithLastReading(depotId);
  const byBus = new Map();
  for (const t of tyres) {
    if (!t.current_bus_id) continue;
    const { status } = computeInspectionCompliance(t, t.last_reading_date, threshold);
    if (!byBus.has(t.current_bus_id)) byBus.set(t.current_bus_id, []);
    byBus.get(t.current_bus_id).push(status);
  }
  return byBus;
}

/**
 * Calculates depot-wise compliance scores based on the percentage of active buses
 * that are fully compliant (having all mounted tyres marked "On Time").
 *
 * @returns {Promise<Array<object>>} Array of depot objects with compliance percentage indicators
 */
async function getDepotComplianceScores() {
  const busCompliance = await computeBusComplianceMap();
  const buses = await db.prepare(`SELECT b.id, b.depot_id, d.name AS depot_name FROM buses b JOIN depots d ON d.id = b.depot_id`).all();

  const perDepot = {};
  for (const bus of buses) {
    const statuses = busCompliance.get(bus.id);
    if (!statuses || statuses.length === 0) continue; // exclude buses without mounted tyres from calculations
    if (!perDepot[bus.depot_id]) {
      perDepot[bus.depot_id] = { depot_id: bus.depot_id, depot_name: bus.depot_name, total_buses: 0, compliant_buses: 0 };
    }
    perDepot[bus.depot_id].total_buses += 1;
    if (statuses.every((s) => s === 'On Time')) perDepot[bus.depot_id].compliant_buses += 1;
  }

  return Object.values(perDepot).map((d) => ({
    ...d,
    compliance_pct: d.total_buses ? Math.round((d.compliant_buses / d.total_buses) * 100) : 0,
  }));
}

/**
 * Resolves compliance statistics summary for a single depot ID.
 *
 * @param {number} depotId - Depot ID to query
 * @returns {Promise<object>} Depot compliance summary object
 */
async function getComplianceForDepot(depotId) {
  const scores = await getDepotComplianceScores();
  const found = scores.find((s) => s.depot_id === depotId);
  return found || { depot_id: depotId, depot_name: null, total_buses: 0, compliant_buses: 0, compliance_pct: 0 };
}

/**
 * Resolves list of buses in a depot alongside tyre status rollups and flagged warnings counts.
 *
 * @param {number} depotId - Depot ID reference
 * @returns {Promise<Array<object>>} Bus list items with metrics payload
 */
async function getBusSummaries(depotId) {
  const buses = await db
    .prepare(`
      SELECT b.id, b.registration_no, b.status, m.name AS model_name
      FROM buses b JOIN bus_models m ON m.id = b.bus_model_id
      WHERE b.depot_id = ?
      ORDER BY b.registration_no
    `)
    .all(depotId);

  const tyreCounts = await db
    .prepare(`
      SELECT current_bus_id AS bus_id, status, COUNT(*) c
      FROM tyres WHERE current_depot_id = ? AND current_bus_id IS NOT NULL
      GROUP BY current_bus_id, status
    `)
    .all(depotId);

  const flaggedCounts = await db
    .prepare(`
      SELECT bus_id, COUNT(DISTINCT tyre_id) c FROM alerts
      WHERE status IN ('Open', 'Acknowledged') AND bus_id IS NOT NULL AND depot_id = ?
      GROUP BY bus_id
    `)
    .all(depotId);

  const tyreCountsByBus = {};
  for (const r of tyreCounts) {
    tyreCountsByBus[r.bus_id] = tyreCountsByBus[r.bus_id] || {};
    tyreCountsByBus[r.bus_id][r.status] = r.c;
  }
  const flaggedByBus = Object.fromEntries(flaggedCounts.map((r) => [r.bus_id, r.c]));

  return buses.map((b) => ({
    ...b,
    tyre_counts: tyreCountsByBus[b.id] || {},
    flagged_count: flaggedByBus[b.id] || 0,
  }));
}

/**
 * Resolves the inventory list of tyres in depot storage alongside their remaining NSD
 * and storage age (in days since they were unmounted/stored).
 *
 * @param {number|null} [depotId] - Optional depot ID filtering scope
 * @param {number} [limit=50] - Result cap list size
 * @returns {Promise<Array<object>>} Tyres in store list with storage duration metrics
 */
function getTyresInStoreWithAge(depotId, limit = 50) {
  const params = { limit };
  let where = `WHERE t.status = 'In Store'`;
  if (depotId) {
    where += ' AND t.current_depot_id = @depotId';
    params.depotId = depotId;
  }
  // Postgres equivalent of SQLite's julianday('now') - julianday(x): both
  // columns are TEXT ('YYYY-MM-DD HH:MM:SS' UTC), cast to timestamp and take
  // the day difference via EXTRACT(EPOCH FROM ...); ROUND() needs ::numeric.
  return db
    .prepare(`
      SELECT
        t.id AS tyre_id, t.tyre_number, t.brand, t.current_depot_id, d.name AS depot_name,
        (SELECT nsd_value FROM tyre_events WHERE tyre_id = t.id AND event_type = 'nsd_reading' ORDER BY event_date DESC, id DESC LIMIT 1) AS last_nsd_value,
        ROUND((EXTRACT(EPOCH FROM (
          (now() AT TIME ZONE 'UTC') - COALESCE(
            (SELECT event_date FROM tyre_events WHERE tyre_id = t.id AND event_type = 'send_to_store' ORDER BY event_date DESC, id DESC LIMIT 1),
            t.updated_at
          )::timestamp
        )) / 86400.0)::numeric) AS days_in_storage
      FROM tyres t
      LEFT JOIN depots d ON d.id = t.current_depot_id
      ${where}
      ORDER BY days_in_storage DESC
      LIMIT @limit
    `)
    .all(params); // returns a Promise -- callers must await
}

/**
 * Resolves upcoming scheduled tyre inspections (approaching interval limits, i.e., "Due").
 *
 * @param {number|null} [depotId] - Optional depot scope filter
 * @param {number} [limit=50] - Result display limit
 * @returns {Promise<Array<object>>} List of upcoming inspection items
 */
async function getUpcomingInspections(depotId, limit = 50) {
  const threshold = await resolveThreshold('INSPECTION_INTERVAL', {});
  const tyres = await listInServiceTyresWithLastReading(depotId);
  const buses = await db.prepare('SELECT id, registration_no FROM buses').all();
  const busById = Object.fromEntries(buses.map((b) => [b.id, b.registration_no]));

  return tyres
    .map((t) => ({ tyre: t, compliance: computeInspectionCompliance(t, t.last_reading_date, threshold) }))
    .filter((x) => x.compliance.status === 'Due')
    .sort((a, b) => b.compliance.daysSinceLastReading - a.compliance.daysSinceLastReading)
    .slice(0, limit)
    .map((x) => ({
      tyre_id: x.tyre.id,
      tyre_number: x.tyre.tyre_number,
      current_bus_id: x.tyre.current_bus_id,
      bus_registration_no: x.tyre.current_bus_id ? busById[x.tyre.current_bus_id] : null,
      days_since_last_reading: x.compliance.daysSinceLastReading,
      last_reading_date: x.compliance.lastReadingDate,
    }));
}

/**
 * Builds the National fleet-wide KPI indicators and data dashboard payload.
 *
 * @returns {Promise<object>} High-level national dashboard dataset
 */
async function getNationalDashboard() {
  const [
    tyreStatusCounts, activeAlertCounts, inspectionCounts, rotationCounts,
    alertCountsByParameter, lifecycleGroupCounts, topFlaggedBuses, depotComplianceScores,
    totalBusesRow, totalDepotsRow,
  ] = await Promise.all([
    getTyreStatusCounts(),
    getActiveAlertCounts(),
    getInspectionCounts(),
    getRotationCounts(),
    getAlertCountsByParameter(),
    getLifecycleGroupCounts(),
    getTopFlaggedBuses(undefined, 10),
    getDepotComplianceScores(),
    db.prepare('SELECT COUNT(*) c FROM buses').get(),
    db.prepare('SELECT COUNT(*) c FROM depots').get(),
  ]);

  const totalBuses = totalBusesRow.c;
  const totalDepots = totalDepotsRow.c;
  const totalTyres = Object.values(tyreStatusCounts).reduce((a, b) => a + b, 0);
  const totalCompliantBuses = depotComplianceScores.reduce((a, d) => a + d.compliant_buses, 0);
  const totalScoredBuses = depotComplianceScores.reduce((a, d) => a + d.total_buses, 0);

  return {
    fleet_summary: {
      total_depots: totalDepots,
      total_buses: totalBuses,
      total_tyres: totalTyres,
      active_alerts: activeAlertCounts.Warning + activeAlertCounts.Critical,
      overall_compliance_pct: totalScoredBuses ? Math.round((totalCompliantBuses / totalScoredBuses) * 100) : 0,
    },
    tyre_status_counts: tyreStatusCounts,
    active_alert_counts: activeAlertCounts,
    alert_counts_by_parameter: alertCountsByParameter,
    inspection_counts: inspectionCounts,
    rotation_counts: rotationCounts,
    lifecycle_group_counts: lifecycleGroupCounts,
    top_flagged_buses: topFlaggedBuses,
    depot_compliance_scores: depotComplianceScores,
  };
}

/**
 * Builds depot-specific operational parameters and dashboard metrics payload.
 *
 * @param {number} depotId - Depot ID scope
 * @returns {Promise<object>} High-level depot-specific dashboard dataset
 */
async function getDepotDashboard(depotId) {
  const [
    depot, tyreStatusCounts, activeAlertCounts, inspectionCounts, rotationCounts,
    alertCountsByParameter, lifecycleGroupCounts, busSummaries, tyresInStore,
    upcomingInspections, compliance,
  ] = await Promise.all([
    db.prepare('SELECT * FROM depots WHERE id = ?').get(depotId),
    getTyreStatusCounts(depotId),
    getActiveAlertCounts(depotId),
    getInspectionCounts(depotId),
    getRotationCounts(depotId),
    getAlertCountsByParameter(depotId),
    getLifecycleGroupCounts(depotId),
    getBusSummaries(depotId),
    getTyresInStoreWithAge(depotId),
    getUpcomingInspections(depotId),
    getComplianceForDepot(depotId),
  ]);

  return {
    depot,
    fleet_health: {
      total_buses: busSummaries.length,
      total_tyres: Object.values(tyreStatusCounts).reduce((a, b) => a + b, 0),
      active_alerts: activeAlertCounts.Warning + activeAlertCounts.Critical,
      compliance_pct: compliance.compliance_pct,
    },
    tyre_status_counts: tyreStatusCounts,
    active_alert_counts: activeAlertCounts,
    alert_counts_by_parameter: alertCountsByParameter,
    inspection_counts: inspectionCounts,
    rotation_counts: rotationCounts,
    lifecycle_group_counts: lifecycleGroupCounts,
    bus_summaries: busSummaries,
    tyres_in_store: tyresInStore,
    upcoming_inspections: upcomingInspections,
    compliance,
  };
}

module.exports = {
  getTyreStatusCounts,
  getActiveAlertCounts,
  getInspectionCounts,
  getRotationCounts,
  getAlertCountsByParameter,
  getLifecycleGroupCounts,
  getTopFlaggedBuses,
  getDepotComplianceScores,
  getComplianceForDepot,
  getBusSummaries,
  getTyresInStoreWithAge,
  getUpcomingInspections,
  getNationalDashboard,
  getDepotDashboard,
};
