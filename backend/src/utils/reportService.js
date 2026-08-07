/**
 * @file reportService.js
 * @description Generates structured datasets for analytical reports (Tyre Status, Tyre Health,
 * Inspections, Alert history, Event logs) with dynamic query aggregation.
 */

const db = require('../db');
const { resolveThreshold } = require('./thresholdEngine');
const { computeInspectionCompliance, listInServiceTyresWithLastReading } = require('./inspectionService');
const { depotScopeClause, dateRangeClause, lastEventValueSql } = require('./reportQueryHelpers');
const { ALL_STATUSES, EVENT_TYPES } = require('./tyreLifecycle');

// ---------- 1. Tyre Status Report ----------

/**
 * Builds the Tyre Status snapshot report.
 * Resolves current active tyres, physical positions, brands, and latest nsd/pressure readings.
 *
 * @param {object} filters - Report query filters
 * @param {number|null} [filters.depot_id] - Scoping depot ID filter
 * @param {number|null} [filters.bus_id] - Bus ID filter
 * @param {string|null} [filters.status] - Tyre status filter ('In Service', 'In Store', etc.)
 * @returns {Promise<Array<object>>} Flat array of tyre status report rows
 */
async function tyreStatusReport(filters) {
  const { depot_id, package_id, bus_id, status } = filters;
  const clauses = [];
  const params = {};
  depotScopeClause('t.current_depot_id', depot_id, clauses, params);
  depotScopeClause('t.current_package_id', package_id, clauses, params, 'packageId');
  if (bus_id) {
    clauses.push('t.current_bus_id = @bus_id');
    params.bus_id = bus_id;
  }
  if (status) {
    clauses.push('t.status = @status');
    params.status = status;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db
    .prepare(`
      SELECT
        t.tyre_number, t.brand, t.status,
        d.name AS depot_name, p.name AS package_name, b.registration_no AS bus_registration_no, t.current_position,
        ${lastEventValueSql('nsd_reading', 'nsd_value')} AS last_nsd_value,
        ${lastEventValueSql('nsd_reading', 'event_date')} AS last_nsd_date,
        ${lastEventValueSql('pressure_reading', 'pressure_value')} AS last_pressure_value,
        ${lastEventValueSql('pressure_reading', 'event_date')} AS last_pressure_date
      FROM tyres t
      LEFT JOIN depots d ON d.id = t.current_depot_id
      LEFT JOIN packages p ON p.id = t.current_package_id
      LEFT JOIN buses b ON b.id = t.current_bus_id
      ${where}
      ORDER BY t.tyre_number
    `)
    .all(params);

  if (!filters.from && !filters.to) return rows;
  return rows.filter((r) => {
    const latest = [r.last_nsd_date, r.last_pressure_date].filter(Boolean).sort().pop();
    if (!latest) return false;
    if (filters.from && latest < filters.from) return false;
    if (filters.to && latest > filters.to) return false;
    return true;
  });
}

// ---------- 2. Flagged Tyres Report ----------
// SRS 7.3: tyres currently breaching NSD or Pressure thresholds.
async function flaggedTyresReport(filters) {
  const { depot_id, bus_id, alert_level, date } = filters;
  const clauses = [`a.status IN ('Open', 'Acknowledged')`, `a.parameter_type IN ('NSD', 'PRESSURE')`];
  const params = {};
  depotScopeClause('a.depot_id', depot_id, clauses, params);
  if (bus_id) {
    clauses.push('a.bus_id = @bus_id');
    params.bus_id = bus_id;
  }
  if (alert_level) {
    clauses.push('a.severity = @alert_level');
    params.alert_level = alert_level;
  }
  if (date) {
    clauses.push('a.opened_at >= @date');
    params.date = date;
  }

  return db
    .prepare(`
      SELECT
        t.tyre_number, b.registration_no AS bus_registration_no, d.name AS depot_name,
        a.parameter_type, a.severity, a.reading_value, a.threshold_value, a.status, a.opened_at
      FROM alerts a
      JOIN tyres t ON t.id = a.tyre_id
      LEFT JOIN buses b ON b.id = a.bus_id
      LEFT JOIN depots d ON d.id = a.depot_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.opened_at DESC
    `)
    .all(params);
}

// ---------- 3. Tyre History Report ----------
// SRS 7.3: full event history for a specific tyre number. Same event shape
// as GET /api/events (Tyre Card milestone) -- this report is that same query,
// scoped to one resolved tyre_id.
async function tyreHistoryReport(filters) {
  const { tyre_number, event_type, from, to } = filters;
  if (!tyre_number) return [];

  const tyre = await db.prepare('SELECT id FROM tyres WHERE tyre_number = ?').get(tyre_number);
  if (!tyre) return [];

  const clauses = ['e.tyre_id = @tyre_id'];
  const params = { tyre_id: tyre.id };
  if (event_type) {
    clauses.push('e.event_type = @event_type');
    params.event_type = event_type;
  }
  dateRangeClause('e.event_date', from, to, clauses, params);

  return db
    .prepare(`
      SELECT
        e.event_date, e.event_type, t.tyre_number, b.registration_no AS bus_registration_no,
        e.position, e.from_position, e.to_position, e.nsd_value, e.pressure_value,
        e.repair_type, e.reason, e.stored_at, e.notes, u.username AS performed_by_username
      FROM tyre_events e
      JOIN tyres t ON t.id = e.tyre_id
      LEFT JOIN buses b ON b.id = e.bus_id
      LEFT JOIN users u ON u.id = e.performed_by
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.event_date DESC
    `)
    .all(params);
}

// ---------- 4. Bus Tyre Health Report ----------
// SRS 7.3: all tyre positions of a selected bus with current readings, "as
// of" an optional date (bounds the correlated subqueries, not a range).
async function busTyreHealthReport(filters) {
  const { bus_id, depot_id, date } = filters;
  if (!bus_id && !depot_id) return [];

  const asOfClause = date ? " AND event_date <= @asOf" : '';
  const params = {};
  if (date) params.asOf = date;

  let query = `
    SELECT
      b.registration_no AS bus_registration_no,
      b.id AS bus_id,
      t.id, t.tyre_number, t.current_position, t.status,
      (SELECT nsd_value FROM tyre_events WHERE tyre_id = t.id AND event_type = 'nsd_reading'${asOfClause} ORDER BY event_date DESC, id DESC LIMIT 1) AS last_nsd_value,
      (SELECT event_date FROM tyre_events WHERE tyre_id = t.id AND event_type = 'nsd_reading'${asOfClause} ORDER BY event_date DESC, id DESC LIMIT 1) AS last_nsd_date,
      (SELECT pressure_value FROM tyre_events WHERE tyre_id = t.id AND event_type = 'pressure_reading'${asOfClause} ORDER BY event_date DESC, id DESC LIMIT 1) AS last_pressure_value,
      (SELECT event_date FROM tyre_events WHERE tyre_id = t.id AND event_type = 'pressure_reading'${asOfClause} ORDER BY event_date DESC, id DESC LIMIT 1) AS last_pressure_date
    FROM tyres t
    JOIN buses b ON b.id = t.current_bus_id
  `;

  if (bus_id) {
    query += ` WHERE t.current_bus_id = @bus_id`;
    params.bus_id = bus_id;
  } else if (depot_id) {
    query += ` WHERE b.depot_id = @depot_id`;
    params.depot_id = depot_id;
  }

  const tyres = await db.prepare(query).all(params);

  if (bus_id) {
    const bus = await db.prepare('SELECT id, registration_no, bus_model_id FROM buses WHERE id = ?').get(bus_id);
    if (!bus) return [];
    const model = await db.prepare('SELECT position_labels_json FROM bus_models WHERE id = ?').get(bus.bus_model_id);
    const positions = JSON.parse(model.position_labels_json);
    const tyreByPosition = Object.fromEntries(tyres.map((t) => [t.current_position, t]));
    return positions.map((position) => {
      const t = tyreByPosition[position];
      return {
        bus_registration_no: bus.registration_no,
        position,
        tyre_number: t?.tyre_number || null,
        status: t?.status || null,
        last_nsd_value: t?.last_nsd_value ?? null,
        last_nsd_date: t?.last_nsd_date ?? null,
        last_pressure_value: t?.last_pressure_value ?? null,
        last_pressure_date: t?.last_pressure_date ?? null,
      };
    });
  }

  return tyres.map((t) => ({
    bus_registration_no: t.bus_registration_no,
    position: t.current_position,
    tyre_number: t.tyre_number,
    status: t.status,
    last_nsd_value: t.last_nsd_value ?? null,
    last_nsd_date: t.last_nsd_date ?? null,
    last_pressure_value: t.last_pressure_value ?? null,
    last_pressure_date: t.last_pressure_date ?? null,
  }));
}

// ---------- 5. Rotation & Replacement Log ----------
async function rotationReplacementReport(filters) {
  const { depot_id, bus_id, from, to } = filters;
  const clauses = [`e.event_type IN ('rotation', 'replacement')`];
  const params = {};
  depotScopeClause('e.depot_id', depot_id, clauses, params);
  if (bus_id) {
    clauses.push('e.bus_id = @bus_id');
    params.bus_id = bus_id;
  }
  dateRangeClause('e.event_date', from, to, clauses, params);

  return db
    .prepare(`
      SELECT
        e.event_date, e.event_type, t.tyre_number, b.registration_no AS bus_registration_no,
        e.from_position, e.to_position, rt.tyre_number AS related_tyre_number, e.reason,
        u.username AS performed_by_username
      FROM tyre_events e
      JOIN tyres t ON t.id = e.tyre_id
      LEFT JOIN buses b ON b.id = e.bus_id
      LEFT JOIN tyres rt ON rt.id = e.related_tyre_id
      LEFT JOIN users u ON u.id = e.performed_by
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.event_date DESC
    `)
    .all(params);
}

// ---------- 6. Puncture Incident Report ----------
async function punctureIncidentReport(filters) {
  const { depot_id, bus_id, from, to } = filters;
  const clauses = [`e.event_type = 'puncture_repair'`];
  const params = {};
  depotScopeClause('e.depot_id', depot_id, clauses, params);
  if (bus_id) {
    clauses.push('e.bus_id = @bus_id');
    params.bus_id = bus_id;
  }
  dateRangeClause('e.event_date', from, to, clauses, params);

  return db
    .prepare(`
      SELECT
        e.event_date, t.tyre_number, b.registration_no AS bus_registration_no,
        e.repair_type, e.notes, u.username AS performed_by_username
      FROM tyre_events e
      JOIN tyres t ON t.id = e.tyre_id
      LEFT JOIN buses b ON b.id = e.bus_id
      LEFT JOIN users u ON u.id = e.performed_by
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.event_date DESC
    `)
    .all(params);
}

// ---------- 7. Inter-Bus Transfer Log ----------
async function interBusTransferReport(filters) {
  const { from_depot_id, to_depot_id, from, to, scopeDepotId } = filters;
  const clauses = [`e.event_type = 'inter_bus_transfer'`];
  const params = {};
  // scopeDepotId (RBAC only, set by routes/reports.js for depot-scoped roles):
  // a transfer is visible if their depot is either side of the move.
  if (scopeDepotId) {
    clauses.push('(e.from_depot_id = @scopeDepotId OR e.to_depot_id = @scopeDepotId)');
    params.scopeDepotId = scopeDepotId;
  }
  if (from_depot_id) {
    clauses.push('e.from_depot_id = @from_depot_id');
    params.from_depot_id = from_depot_id;
  }
  if (to_depot_id) {
    clauses.push('e.to_depot_id = @to_depot_id');
    params.to_depot_id = to_depot_id;
  }
  dateRangeClause('e.event_date', from, to, clauses, params);

  return db
    .prepare(`
      SELECT
        e.event_date, t.tyre_number,
        fb.registration_no AS from_bus_registration_no, fd.name AS from_depot_name,
        tb.registration_no AS to_bus_registration_no, td.name AS to_depot_name,
        e.reason, u.username AS performed_by_username
      FROM tyre_events e
      JOIN tyres t ON t.id = e.tyre_id
      LEFT JOIN buses fb ON fb.id = e.from_bus_id
      LEFT JOIN depots fd ON fd.id = e.from_depot_id
      LEFT JOIN buses tb ON tb.id = e.to_bus_id
      LEFT JOIN depots td ON td.id = e.to_depot_id
      LEFT JOIN users u ON u.id = e.performed_by
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.event_date DESC
    `)
    .all(params);
}

// ---------- 8. Tyre Life Report ----------
// SRS 7.3: "Age and total distance/days in service ... from entry to
// condemnation". This system tracks bus odometer readings only, never
// tyre-specific mileage (no odometer is captured against individual tyre
// events) -- so total distance is not computable from the data model and is
// intentionally omitted rather than fabricated. Days in service is shown.
async function tyreLifeReport(filters) {
  const { depot_id, brand, from, to } = filters;
  const clauses = [];
  const params = {};
  depotScopeClause('t.current_depot_id', depot_id, clauses, params);
  if (brand) {
    clauses.push('t.brand = @brand');
    params.brand = brand;
  }
  dateRangeClause('t.purchase_date', from, to, clauses, params);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Excel Parity Gap-Closure: km-based "Life Used" per the Tyre Card sheet --
  // the most recent fitment_created's odometer_km, compared against whichever
  // odometer reading later ended that stint: a removal-type event
  // (rotation/send_to_repair/send_to_store/condemnation/scrap/retread_sent)
  // if one was logged with a reading, else the current bus's live odometer
  // if the tyre is still mounted from that same fitment.
  // Filters "after this fitment" by event id rather than event_date: sub-
  // second timestamp resolution means a fitment immediately followed by its
  // removal event in the same session can land in the same second -- id
  // ordering (which always reflects true insertion order) stays correct even then.
  //
  // 'replacement' is included alongside 'fitment_created' throughout this
  // report (as a start-of-stint baseline, and as a removal boundary) because
  // it's the same real-world moment under a different event_type: a tyre
  // going onto a bus for the first time uses fitment_created (nothing to
  // remove), a tyre going on in place of another uses replacement instead
  // (createReplacement in tyreEvents.js), which writes one event row to
  // *each* tyre involved -- to_position set on the incoming tyre's row,
  // from_position set on the outgoing tyre's, so those columns (not
  // event_type, which is the same 'replacement' for both) are what
  // distinguishes "my stint started here" from "my stint ended here." Not a
  // new event type or workflow, just this report (and createReplacement's
  // now-optional odometer_km param) recognizing a distinction the data
  // already draws.
  const lastFitmentIdSql = `(SELECT e2.id FROM tyre_events e2 WHERE e2.tyre_id = t.id AND (e2.event_type = 'fitment_created' OR (e2.event_type = 'replacement' AND e2.to_position IS NOT NULL)) ORDER BY e2.event_date DESC, e2.id DESC LIMIT 1)`;
  const removalOdometerSql = `
    (SELECT e.odometer_km FROM tyre_events e
     WHERE e.tyre_id = t.id AND e.odometer_km IS NOT NULL
       AND (e.event_type IN ('rotation', 'send_to_repair', 'send_to_store', 'condemnation', 'scrap', 'retread_sent')
            OR (e.event_type = 'replacement' AND e.from_position IS NOT NULL))
       AND e.id > (${lastFitmentIdSql})
     ORDER BY e.event_date ASC, e.id ASC LIMIT 1)
  `;
  const lastFitmentOdometerSql = `
    (SELECT e.odometer_km FROM tyre_events e
     WHERE e.tyre_id = t.id
       AND (e.event_type = 'fitment_created' OR (e.event_type = 'replacement' AND e.to_position IS NOT NULL))
     ORDER BY e.event_date DESC, e.id DESC LIMIT 1)
  `;

  const rows = await db
    .prepare(`
      SELECT
        t.tyre_number, t.brand, t.purchase_date, t.status, d.name AS depot_name,
        ${lastEventValueSql('condemnation', 'event_date')} AS condemned_date,
        ${lastFitmentOdometerSql} AS last_fitment_odometer_km,
        ${removalOdometerSql} AS removal_odometer_km,
        cb.odometer_km AS current_bus_odometer_km
      FROM tyres t
      LEFT JOIN depots d ON d.id = t.current_depot_id
      LEFT JOIN buses cb ON cb.id = t.current_bus_id
      ${where}
      ORDER BY t.tyre_number
    `)
    .all(params);

  return rows.map((r) => {
    const start = r.purchase_date ? new Date(r.purchase_date) : null;
    const end = r.condemned_date ? new Date(r.condemned_date.replace(' ', 'T') + 'Z') : new Date();
    const daysInService = start ? Math.max(0, Math.floor((end - start) / (1000 * 60 * 60 * 24))) : null;

    const endOdometerKm = r.removal_odometer_km ?? r.current_bus_odometer_km;
    const lifeUsedKm = r.last_fitment_odometer_km != null && endOdometerKm != null && endOdometerKm >= r.last_fitment_odometer_km
      ? endOdometerKm - r.last_fitment_odometer_km
      : null;

    const { last_fitment_odometer_km, removal_odometer_km, current_bus_odometer_km, ...rest } = r;
    return { ...rest, days_in_service: daysInService, life_used_km: lifeUsedKm };
  });
}

// ---------- 9. Inspection Compliance Report ----------
// SRS 7.3: buses/tyres overdue for inspection. Directly reuses the same
// compliance computation as the Business Rules Engine and Dashboard
// milestones -- one definition of "overdue" in the whole system.
async function inspectionComplianceReport(filters) {
  const { depot_id, days_overdue } = filters;
  const threshold = await resolveThreshold('INSPECTION_INTERVAL', {});
  const effectiveThreshold = days_overdue
    ? { ...threshold, critical_max: Number(days_overdue) }
    : threshold;

  const tyres = await listInServiceTyresWithLastReading(depot_id);
  const buses = await db.prepare('SELECT id, registration_no FROM buses').all();
  const busById = Object.fromEntries(buses.map((b) => [b.id, b.registration_no]));
  const depots = await db.prepare('SELECT id, name FROM depots').all();
  const depotById = Object.fromEntries(depots.map((d) => [d.id, d.name]));

  return tyres
    .map((t) => ({ tyre: t, compliance: computeInspectionCompliance(t, t.last_reading_date, effectiveThreshold) }))
    .filter((x) => x.compliance.status === 'Overdue')
    .sort((a, b) => b.compliance.daysSinceLastReading - a.compliance.daysSinceLastReading)
    .map((x) => ({
      tyre_number: x.tyre.tyre_number,
      bus_registration_no: x.tyre.current_bus_id ? busById[x.tyre.current_bus_id] : null,
      depot_name: x.tyre.current_depot_id ? depotById[x.tyre.current_depot_id] : null,
      last_reading_date: x.compliance.lastReadingDate,
      days_since_last_reading: x.compliance.daysSinceLastReading,
      status: x.compliance.status,
    }));
}

// ---------- 10. Condemned Tyres Report ----------
async function condemnedTyresReport(filters) {
  const { depot_id, from, to } = filters;
  const clauses = [`t.status = 'Scrapped'`];
  const params = {};
  depotScopeClause('t.current_depot_id', depot_id, clauses, params);

  const rows = await db
    .prepare(`
      SELECT
        t.tyre_number, t.brand, d.name AS depot_name,
        ${lastEventValueSql('condemnation', 'event_date')} AS condemned_date,
        ${lastEventValueSql('condemnation', 'nsd_value')} AS nsd_at_condemnation,
        ${lastEventValueSql('condemnation', 'reason')} AS reason,
        (SELECT u.username FROM tyre_events ce JOIN users u ON u.id = ce.performed_by WHERE ce.tyre_id = t.id AND ce.event_type = 'condemnation' ORDER BY ce.event_date DESC, ce.id DESC LIMIT 1) AS authorised_by_username
      FROM tyres t
      LEFT JOIN depots d ON d.id = t.current_depot_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY condemned_date DESC
    `)
    .all(params);

  if (!from && !to) return rows;
  return rows.filter((r) => {
    if (!r.condemned_date) return false;
    if (from && r.condemned_date < from) return false;
    if (to && r.condemned_date > to) return false;
    return true;
  });
}

// ---------- 11. Retread History Report ----------
async function retreadHistoryReport(filters) {
  const { depot_id, from, to } = filters;
  const clauses = [`e.event_type IN ('retread_sent', 'retread_completed')`];
  const params = {};
  depotScopeClause('e.depot_id', depot_id, clauses, params);
  dateRangeClause('e.event_date', from, to, clauses, params);

  return db
    .prepare(`
      SELECT
        e.event_date, t.tyre_number, e.event_type, e.vendor_name, e.vendor_location, e.retread_cost,
        e.gate_pass_no, e.invoice_no, e.invoice_date, e.retread_purpose, e.outcome,
        e.reason, e.notes, d.name AS depot_name, u.username AS performed_by_username
      FROM tyre_events e
      JOIN tyres t ON t.id = e.tyre_id
      LEFT JOIN depots d ON d.id = e.depot_id
      LEFT JOIN users u ON u.id = e.performed_by
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.event_date DESC
    `)
    .all(params);
}

// ---------- 12. Warranty Claims Report ----------
async function warrantyClaimsReport(filters) {
  const { depot_id, from, to } = filters;
  const clauses = [`e.event_type = 'warranty_claim'`];
  const params = {};
  depotScopeClause('e.depot_id', depot_id, clauses, params);
  dateRangeClause('e.event_date', from, to, clauses, params);

  return db
    .prepare(`
      SELECT
        e.event_date, t.tyre_number, t.status AS current_tyre_status, e.reason, e.notes,
        e.vendor_name, e.vendor_location, e.gate_pass_no, e.invoice_no, e.invoice_date, e.approved_by,
        d.name AS depot_name, u.username AS performed_by_username
      FROM tyre_events e
      JOIN tyres t ON t.id = e.tyre_id
      LEFT JOIN depots d ON d.id = e.depot_id
      LEFT JOIN users u ON u.id = e.performed_by
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.event_date DESC
    `)
    .all(params);
}

// ---------- 13. Scrap Analysis Report ----------
async function scrapAnalysisReport(filters) {
  const { depot_id, from, to } = filters;
  const clauses = [`e.event_type = 'scrap'`];
  const params = {};
  depotScopeClause('e.depot_id', depot_id, clauses, params);
  dateRangeClause('e.event_date', from, to, clauses, params);

  return db
    .prepare(`
      SELECT
        e.event_date, t.tyre_number, t.brand, e.scrap_value, e.reason,
        e.vendor_name, e.vendor_location, e.gate_pass_no, e.invoice_no, e.invoice_date, e.approved_by, e.store_manager,
        d.name AS depot_name, u.username AS performed_by_username
      FROM tyre_events e
      JOIN tyres t ON t.id = e.tyre_id
      LEFT JOIN depots d ON d.id = e.depot_id
      LEFT JOIN users u ON u.id = e.performed_by
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.event_date DESC
    `)
    .all(params);
}

// ---------- 14. Wheel Alignment Report ----------
async function wheelAlignmentReport(filters) {
  const { depot_id, bus_id, from, to } = filters;
  const clauses = [];
  const params = {};
  depotScopeClause('wa.depot_id', depot_id, clauses, params);
  if (bus_id) {
    clauses.push('wa.bus_id = @bus_id');
    params.bus_id = bus_id;
  }
  dateRangeClause('wa.alignment_date', from, to, clauses, params);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  return db
    .prepare(`
      SELECT
        wa.alignment_date, b.registration_no AS bus_registration_no, d.name AS depot_name,
        wa.current_km, wa.due_date, wa.status, wa.remarks, u.username AS performed_by_username
      FROM wheel_alignments wa
      JOIN buses b ON b.id = wa.bus_id
      LEFT JOIN depots d ON d.id = wa.depot_id
      LEFT JOIN users u ON u.id = wa.performed_by
      ${where}
      ORDER BY wa.alignment_date DESC
    `)
    .all(params);
}

// ---------- 15. Stock Summary Report ----------
// Excel Parity Gap-Closure: the practical, as-of-today version of the
// sheet's "Tyre Summary" daily closing-stock grid -- current tyre counts by
// status, grouped by depot/package. The full 31-day historical grid is
// deliberately not reconstructed here; the tyre-history report / audit log
// already provide full history if it's ever needed.
async function stockSummaryReport(filters) {
  const { depot_id, package_id } = filters;
  const clauses = [];
  const params = {};
  depotScopeClause('t.current_depot_id', depot_id, clauses, params);
  depotScopeClause('t.current_package_id', package_id, clauses, params, 'packageId');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  return db
    .prepare(`
      SELECT d.name AS depot_name, p.name AS package_name, t.status, COUNT(*) AS tyre_count
      FROM tyres t
      LEFT JOIN depots d ON d.id = t.current_depot_id
      LEFT JOIN packages p ON p.id = t.current_package_id
      ${where}
      GROUP BY t.current_depot_id, t.current_package_id, t.status, d.name, p.name
      ORDER BY d.name, p.name, t.status
    `)
    .all(params);
}

const REPORTS = {
  'tyre-status': {
    name: 'Tyre Status Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'package_id', label: 'Package', type: 'package' },
      { key: 'bus_id', label: 'Bus', type: 'bus' },
      { key: 'status', label: 'Status', type: 'select', options: ALL_STATUSES },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'brand', label: 'Brand' },
      { key: 'status', label: 'Status' },
      { key: 'depot_name', label: 'Depot' },
      { key: 'package_name', label: 'Package' },
      { key: 'bus_registration_no', label: 'Bus' },
      { key: 'current_position', label: 'Position' },
      { key: 'last_nsd_value', label: 'Last NSD (mm)' },
      { key: 'last_nsd_date', label: 'Last NSD Date' },
      { key: 'last_pressure_value', label: 'Last Pressure (psi)' },
      { key: 'last_pressure_date', label: 'Last Pressure Date' },
    ],
    getRows: tyreStatusReport,
  },
  'flagged-tyres': {
    name: 'Flagged Tyres Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'bus_id', label: 'Bus', type: 'bus' },
      { key: 'alert_level', label: 'Alert Level', type: 'select', options: ['Warning', 'Critical'] },
      { key: 'date', label: 'Opened On/After', type: 'date' },
    ],
    columns: [
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'bus_registration_no', label: 'Bus' },
      { key: 'depot_name', label: 'Depot' },
      { key: 'parameter_type', label: 'Parameter' },
      { key: 'severity', label: 'Alert Level' },
      { key: 'reading_value', label: 'Reading' },
      { key: 'threshold_value', label: 'Threshold' },
      { key: 'status', label: 'Status' },
      { key: 'opened_at', label: 'Opened At' },
    ],
    getRows: flaggedTyresReport,
  },
  'tyre-history': {
    name: 'Tyre History Report',
    filters: [
      { key: 'tyre_number', label: 'Tyre Number', type: 'text', required: true },
      { key: 'event_type', label: 'Event Type', type: 'select', options: EVENT_TYPES },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'event_date', label: 'Date' },
      { key: 'event_type', label: 'Event Type' },
      { key: 'bus_registration_no', label: 'Bus' },
      { key: 'position', label: 'Position' },
      { key: 'from_position', label: 'From Position' },
      { key: 'to_position', label: 'To Position' },
      { key: 'nsd_value', label: 'NSD' },
      { key: 'pressure_value', label: 'Pressure' },
      { key: 'repair_type', label: 'Repair Type' },
      { key: 'reason', label: 'Reason' },
      { key: 'notes', label: 'Notes' },
      { key: 'performed_by_username', label: 'Performed By' },
    ],
    getRows: tyreHistoryReport,
  },
  'bus-tyre-health': {
    name: 'Bus Tyre Health Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'bus_id', label: 'Bus', type: 'bus' },
      { key: 'date', label: 'As Of Date', type: 'date' },
    ],
    columns: [
      { key: 'bus_registration_no', label: 'Bus' },
      { key: 'position', label: 'Position' },
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'status', label: 'Status' },
      { key: 'last_nsd_value', label: 'Last NSD (mm)' },
      { key: 'last_nsd_date', label: 'Last NSD Date' },
      { key: 'last_pressure_value', label: 'Last Pressure (psi)' },
      { key: 'last_pressure_date', label: 'Last Pressure Date' },
    ],
    getRows: busTyreHealthReport,
  },
  'rotation-replacement': {
    name: 'Rotation & Replacement Log',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'bus_id', label: 'Bus', type: 'bus' },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'event_date', label: 'Date' },
      { key: 'event_type', label: 'Event Type' },
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'bus_registration_no', label: 'Bus' },
      { key: 'from_position', label: 'From Position' },
      { key: 'to_position', label: 'To Position' },
      { key: 'related_tyre_number', label: 'Related Tyre' },
      { key: 'reason', label: 'Reason' },
      { key: 'performed_by_username', label: 'Performed By' },
    ],
    getRows: rotationReplacementReport,
  },
  'puncture-incident': {
    name: 'Puncture Incident Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'bus_id', label: 'Bus', type: 'bus' },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'event_date', label: 'Date' },
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'bus_registration_no', label: 'Bus' },
      { key: 'repair_type', label: 'Repair Type' },
      { key: 'notes', label: 'Notes' },
      { key: 'performed_by_username', label: 'Repaired By' },
    ],
    getRows: punctureIncidentReport,
  },
  'inter-bus-transfer': {
    name: 'Inter-Bus Transfer Log',
    filters: [
      { key: 'from_depot_id', label: 'From Depot', type: 'depot' },
      { key: 'to_depot_id', label: 'To Depot', type: 'depot' },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'event_date', label: 'Date' },
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'from_bus_registration_no', label: 'From Bus' },
      { key: 'from_depot_name', label: 'From Depot' },
      { key: 'to_bus_registration_no', label: 'To Bus' },
      { key: 'to_depot_name', label: 'To Depot' },
      { key: 'reason', label: 'Reason' },
      { key: 'performed_by_username', label: 'Authorised By' },
    ],
    getRows: interBusTransferReport,
  },
  'tyre-life': {
    name: 'Tyre Life Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'brand', label: 'Brand', type: 'text' },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'brand', label: 'Brand' },
      { key: 'depot_name', label: 'Depot' },
      { key: 'purchase_date', label: 'Purchase Date' },
      { key: 'status', label: 'Status' },
      { key: 'condemned_date', label: 'Condemned Date' },
      { key: 'days_in_service', label: 'Days in Service' },
      { key: 'life_used_km', label: 'Life Used (km)' },
    ],
    getRows: tyreLifeReport,
  },
  'inspection-compliance': {
    name: 'Inspection Compliance Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'days_overdue', label: 'Days Overdue Threshold', type: 'number' },
    ],
    columns: [
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'bus_registration_no', label: 'Bus' },
      { key: 'depot_name', label: 'Depot' },
      { key: 'last_reading_date', label: 'Last Reading Date' },
      { key: 'days_since_last_reading', label: 'Days Since Last Reading' },
      { key: 'status', label: 'Compliance Status' },
    ],
    getRows: inspectionComplianceReport,
  },
  'condemned-tyres': {
    name: 'Condemned Tyres Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'brand', label: 'Brand' },
      { key: 'depot_name', label: 'Depot' },
      { key: 'condemned_date', label: 'Condemned Date' },
      { key: 'nsd_at_condemnation', label: 'NSD at Condemnation' },
      { key: 'reason', label: 'Reason' },
      { key: 'authorised_by_username', label: 'Authorised By' },
    ],
    getRows: condemnedTyresReport,
  },
  'retread-history': {
    name: 'Retread History Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'event_date', label: 'Date' },
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'event_type', label: 'Event' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'vendor_location', label: 'Vendor Location' },
      { key: 'gate_pass_no', label: 'Gate Pass No.' },
      { key: 'invoice_no', label: 'Invoice No.' },
      { key: 'invoice_date', label: 'Invoice Date' },
      { key: 'retread_cost', label: 'Retread Cost' },
      { key: 'retread_purpose', label: 'Purpose' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'depot_name', label: 'Depot' },
      { key: 'reason', label: 'Reason' },
      { key: 'performed_by_username', label: 'Performed By' },
    ],
    getRows: retreadHistoryReport,
  },
  'warranty-claims': {
    name: 'Warranty Claims Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'event_date', label: 'Date' },
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'current_tyre_status', label: 'Current Status' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'vendor_location', label: 'Vendor Location' },
      { key: 'gate_pass_no', label: 'Gate Pass No.' },
      { key: 'invoice_no', label: 'Invoice No.' },
      { key: 'invoice_date', label: 'Invoice Date' },
      { key: 'approved_by', label: 'Approved By' },
      { key: 'depot_name', label: 'Depot' },
      { key: 'reason', label: 'Reason / Outcome' },
      { key: 'performed_by_username', label: 'Performed By' },
    ],
    getRows: warrantyClaimsReport,
  },
  'scrap-analysis': {
    name: 'Scrap Analysis Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'event_date', label: 'Date' },
      { key: 'tyre_number', label: 'Tyre Number' },
      { key: 'brand', label: 'Brand' },
      { key: 'scrap_value', label: 'Scrap Value' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'vendor_location', label: 'Vendor Location' },
      { key: 'gate_pass_no', label: 'Gate Pass No.' },
      { key: 'invoice_no', label: 'Invoice No.' },
      { key: 'invoice_date', label: 'Invoice Date' },
      { key: 'approved_by', label: 'Approved By' },
      { key: 'store_manager', label: 'Store Manager' },
      { key: 'depot_name', label: 'Depot' },
      { key: 'reason', label: 'Reason' },
      { key: 'performed_by_username', label: 'Performed By' },
    ],
    getRows: scrapAnalysisReport,
  },
  'wheel-alignment': {
    name: 'Wheel Alignment Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'bus_id', label: 'Bus', type: 'bus' },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'alignment_date', label: 'Date' },
      { key: 'bus_registration_no', label: 'Bus' },
      { key: 'depot_name', label: 'Depot' },
      { key: 'current_km', label: 'Current KM' },
      { key: 'due_date', label: 'Due Date' },
      { key: 'status', label: 'Status' },
      { key: 'remarks', label: 'Remarks' },
      { key: 'performed_by_username', label: 'Performed By' },
    ],
    getRows: wheelAlignmentReport,
  },
  'stock-summary': {
    name: 'Stock Summary Report',
    filters: [
      { key: 'depot_id', label: 'Depot', type: 'depot' },
      { key: 'package_id', label: 'Package', type: 'package' },
    ],
    columns: [
      { key: 'depot_name', label: 'Depot' },
      { key: 'package_name', label: 'Package' },
      { key: 'status', label: 'Status' },
      { key: 'tyre_count', label: 'Tyre Count' },
    ],
    getRows: stockSummaryReport,
  },
};

module.exports = { REPORTS };
