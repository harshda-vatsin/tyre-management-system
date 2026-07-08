/**
 * @file dashboardService.js
 * @description Aggregates database metrics to generate KPIs, alerts counters, and status breakdowns
 * for both fleet-wide (national) and individual depot-scoped dashboards.
 */

const db = require('../db');
const { resolveThreshold } = require('./thresholdEngine');
const { computeInspectionCompliance, listInServiceTyresWithLastReading } = require('./inspectionService');

// Standard tyre inventory status labels
const TYRE_STATUSES = ['In Service', 'In Store', 'Under Repair', 'Condemned'];

/**
 * Counts tyres grouped by status ('In Service', 'In Store', etc.).
 * Optionally filters to a single depot.
 * 
 * @param {number|null} [depotId] - Optional depot ID to filter counts
 * @returns {Record<string, number>} Count map per status label
 */
function getTyreStatusCounts(depotId) {
  const params = {};
  let where = '';
  if (depotId) {
    where = 'WHERE current_depot_id = @depotId';
    params.depotId = depotId;
  }
  const rows = db.prepare(`SELECT status, COUNT(*) c FROM tyres ${where} GROUP BY status`).all(params);
  const counts = Object.fromEntries(TYRE_STATUSES.map((s) => [s, 0]));
  for (const r of rows) counts[r.status] = r.c;
  return counts;
}

/**
 * Counts currently active (Open/Acknowledged) alerts.
 * Grouped by severity ('Warning', 'Critical') and optionally filtered by depot.
 * 
 * @param {number|null} [depotId] - Optional depot ID to restrict scope
 * @returns {{Warning: number, Critical: number}} Summary counts
 */
function getActiveAlertCounts(depotId) {
  const params = {};
  let where = `WHERE status IN ('Open', 'Acknowledged')`;
  if (depotId) {
    where += ' AND depot_id = @depotId';
    params.depotId = depotId;
  }
  const rows = db.prepare(`SELECT severity, COUNT(*) c FROM alerts ${where} GROUP BY severity`).all(params);
  const counts = { Warning: 0, Critical: 0 };
  for (const r of rows) counts[r.severity] = r.c;
  return counts;
}

/**
 * Counts tyres that are either "Due" or "Overdue" for inspection.
 * Computes this by inspecting the age of the last reading against the global interval threshold.
 * 
 * @param {number|null} [depotId] - Optional depot filter
 * @returns {{due: number, overdue: number}} Counts of affected tyres
 */
function getInspectionCounts(depotId) {
  const threshold = resolveThreshold('INSPECTION_INTERVAL', {});
  const tyres = listInServiceTyresWithLastReading(depotId);
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
 * Resolves the top-flagged buses with the highest count of unique active tyre alert warnings.
 * Used to identify vehicles requiring immediate maintenance attention.
 * 
 * @param {number|null} [depotId] - Optional depot ID filter
 * @param {number} [limit=10] - Max list limit size
 * @returns {Array<object>} Flagged bus items list
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
      GROUP BY b.id
      ORDER BY flagged_count DESC
      LIMIT @limit
    `)
    .all(params);
}

/**
 * Maps each bus to an array containing the compliance status of each of its mounted tyres.
 * 
 * @param {number|null} [depotId] - Optional depot ID scoping
 * @returns {Map<number, string[]>} Map mapping Bus ID to compliance status array
 */
function computeBusComplianceMap(depotId) {
  const threshold = resolveThreshold('INSPECTION_INTERVAL', {});
  const tyres = listInServiceTyresWithLastReading(depotId);
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
 * @returns {Array<object>} Array of depot objects with compliance percentage indicators
 */
function getDepotComplianceScores() {
  const busCompliance = computeBusComplianceMap();
  const buses = db.prepare(`SELECT b.id, b.depot_id, d.name AS depot_name FROM buses b JOIN depots d ON d.id = b.depot_id`).all();

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
 * @returns {object} Depot compliance summary object
 */
function getComplianceForDepot(depotId) {
  const found = getDepotComplianceScores().find((s) => s.depot_id === depotId);
  return found || { depot_id: depotId, depot_name: null, total_buses: 0, compliant_buses: 0, compliance_pct: 0 };
}

/**
 * Resolves list of buses in a depot alongside tyre status rollups and flagged warnings counts.
 * 
 * @param {number} depotId - Depot ID reference
 * @returns {Array<object>} Bus list items with metrics payload
 */
function getBusSummaries(depotId) {
  const buses = db
    .prepare(`
      SELECT b.id, b.registration_no, b.status, m.name AS model_name
      FROM buses b JOIN bus_models m ON m.id = b.bus_model_id
      WHERE b.depot_id = ?
      ORDER BY b.registration_no
    `)
    .all(depotId);

  const tyreCounts = db
    .prepare(`
      SELECT current_bus_id AS bus_id, status, COUNT(*) c
      FROM tyres WHERE current_depot_id = ? AND current_bus_id IS NOT NULL
      GROUP BY current_bus_id, status
    `)
    .all(depotId);

  const flaggedCounts = db
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
 * @returns {Array<object>} Tyres in store list with storage duration metrics
 */
function getTyresInStoreWithAge(depotId, limit = 50) {
  const params = { limit };
  let where = `WHERE t.status = 'In Store'`;
  if (depotId) {
    where += ' AND t.current_depot_id = @depotId';
    params.depotId = depotId;
  }
  return db
    .prepare(`
      SELECT
        t.id AS tyre_id, t.tyre_number, t.brand, t.current_depot_id, d.name AS depot_name,
        (SELECT nsd_value FROM tyre_events WHERE tyre_id = t.id AND event_type = 'nsd_reading' ORDER BY event_date DESC, id DESC LIMIT 1) AS last_nsd_value,
        ROUND(julianday('now') - julianday(COALESCE(
          (SELECT event_date FROM tyre_events WHERE tyre_id = t.id AND event_type = 'send_to_store' ORDER BY event_date DESC, id DESC LIMIT 1),
          t.updated_at
        ))) AS days_in_storage
      FROM tyres t
      LEFT JOIN depots d ON d.id = t.current_depot_id
      ${where}
      ORDER BY days_in_storage DESC
      LIMIT @limit
    `)
    .all(params);
}

/**
 * Resolves upcoming scheduled tyre inspections (approaching interval limits, i.e., "Due").
 * 
 * @param {number|null} [depotId] - Optional depot scope filter
 * @param {number} [limit=50] - Result display limit
 * @returns {Array<object>} List of upcoming inspection items
 */
function getUpcomingInspections(depotId, limit = 50) {
  const threshold = resolveThreshold('INSPECTION_INTERVAL', {});
  const tyres = listInServiceTyresWithLastReading(depotId);
  const buses = db.prepare('SELECT id, registration_no FROM buses').all();
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
 * @returns {object} High-level national dashboard dataset
 */
function getNationalDashboard() {
  const tyreStatusCounts = getTyreStatusCounts();
  const activeAlertCounts = getActiveAlertCounts();
  const inspectionCounts = getInspectionCounts();
  const topFlaggedBuses = getTopFlaggedBuses(undefined, 10);
  const depotComplianceScores = getDepotComplianceScores();

  const totalBuses = db.prepare('SELECT COUNT(*) c FROM buses').get().c;
  const totalDepots = db.prepare('SELECT COUNT(*) c FROM depots').get().c;
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
    inspection_counts: inspectionCounts,
    top_flagged_buses: topFlaggedBuses,
    depot_compliance_scores: depotComplianceScores,
  };
}

/**
 * Builds depot-specific operational parameters and dashboard metrics payload.
 * 
 * @param {number} depotId - Depot ID scope
 * @returns {object} High-level depot-specific dashboard dataset
 */
function getDepotDashboard(depotId) {
  const depot = db.prepare('SELECT * FROM depots WHERE id = ?').get(depotId);
  const tyreStatusCounts = getTyreStatusCounts(depotId);
  const activeAlertCounts = getActiveAlertCounts(depotId);
  const inspectionCounts = getInspectionCounts(depotId);
  const busSummaries = getBusSummaries(depotId);
  const tyresInStore = getTyresInStoreWithAge(depotId);
  const upcomingInspections = getUpcomingInspections(depotId);
  const compliance = getComplianceForDepot(depotId);

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
    inspection_counts: inspectionCounts,
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
  getTopFlaggedBuses,
  getDepotComplianceScores,
  getComplianceForDepot,
  getBusSummaries,
  getTyresInStoreWithAge,
  getUpcomingInspections,
  getNationalDashboard,
  getDepotDashboard,
};
