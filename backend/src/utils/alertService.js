/**
 * @file alertService.js
 * @description Services managing alert states (upserting active alerts, auto-resolving alerts
 * when readings are within boundaries, manual acknowledgment, manual resolution, and escalating stale open alerts).
 */

const db = require('../db');
const { writeAuditLog } = require('./auditLog');
const { resolveThreshold } = require('./thresholdEngine');
const { sendEmailNotification } = require('./emailService');

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Finds an active alert (Open or Acknowledged status) for a given tyre and parameter type.
 * 
 * @param {number} tyreId - ID of the tyre
 * @param {string} parameterType - Parameter check code ('NSD', 'PRESSURE', 'INSPECTION')
 * @returns {object|undefined} The active alert row
 */
function findActiveAlert(tyreId, parameterType) {
  return db
    .prepare(`SELECT * FROM alerts WHERE tyre_id = ? AND parameter_type = ? AND status IN ('Open', 'Acknowledged')`)
    .get(tyreId, parameterType);
}

/**
 * Creates a new Open alert or updates an existing active alert for a parameter breach,
 * adhering to the NFR rule of having only one active alert per tyre-parameter combination.
 * 
 * @param {object} params
 * @param {number} params.tyreId - Tyre ID reference
 * @param {number|null} params.busId - Bus ID reference
 * @param {number|null} params.depotId - Depot ID reference
 * @param {string} params.parameterType - Parameter classification ('NSD', 'PRESSURE')
 * @param {string} params.severity - Alert severity level ('Warning', 'Critical')
 * @param {number} params.readingValue - The value that triggered the alert
 * @param {number} params.thresholdValue - The configured threshold boundary value
 * @param {number|null} params.triggeringEventId - Triggering tyre_events ID reference
 * @returns {object} The created/updated alert row
 */
function upsertBreachAlert({ tyreId, busId, depotId, parameterType, severity, readingValue, thresholdValue, triggeringEventId }) {
  const existing = findActiveAlert(tyreId, parameterType);

  if (existing) {
    const isEscalation = existing.severity !== severity && severity === 'Critical';

    db.prepare(`
      UPDATE alerts
      SET severity = ?, reading_value = ?, threshold_value = ?, triggering_event_id = ?, bus_id = ?, depot_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(severity, readingValue, thresholdValue, triggeringEventId, busId, depotId, existing.id);

    const after = db.prepare('SELECT * FROM alerts WHERE id = ?').get(existing.id);
    writeAuditLog({ user: null, action: 'UPDATE', entityType: 'alert', entityId: after.id, before: existing, after });

    if (isEscalation) {
      sendEmailNotification(after);
    }

    return after;
  }

  const info = db.prepare(`
    INSERT INTO alerts (tyre_id, bus_id, depot_id, parameter_type, severity, status, triggering_event_id, reading_value, threshold_value)
    VALUES (?, ?, ?, ?, ?, 'Open', ?, ?, ?)
  `).run(tyreId, busId, depotId, parameterType, severity, triggeringEventId, readingValue, thresholdValue);

  const created = db.prepare('SELECT * FROM alerts WHERE id = ?').get(info.lastInsertRowid);
  writeAuditLog({ user: null, action: 'CREATE', entityType: 'alert', entityId: created.id, after: created });

  sendEmailNotification(created);

  return created;
}

/**
 * Automatically resolves an active alert when a new reading falls back within normal parameters.
 * 
 * @param {object} params
 * @param {number} params.tyreId - Tyre ID
 * @param {string} params.parameterType - Parameter classification ('NSD', 'PRESSURE', 'INSPECTION')
 * @param {number|null} params.resolvedByUserId - ID of user resolving it (null if system auto-resolved)
 * @returns {object|null} Resolved alert row, or null if no active alert existed
 */
function autoResolveAlert({ tyreId, parameterType, resolvedByUserId }) {
  const existing = findActiveAlert(tyreId, parameterType);
  if (!existing) return null;

  db.prepare(`
    UPDATE alerts
    SET status = 'Resolved', resolved_at = datetime('now'), resolved_by = ?, resolution_note = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(resolvedByUserId || null, 'Auto-resolved: reading within threshold', existing.id);

  const after = db.prepare('SELECT * FROM alerts WHERE id = ?').get(existing.id);
  writeAuditLog({ user: null, action: 'UPDATE', entityType: 'alert', entityId: after.id, before: existing, after });
  return after;
}

/**
 * Checks a newly logged metric reading against active thresholds, raising alerts or resolving
 * existing ones depending on whether a parameter breach is detected.
 * Called immediately inside tyreEvents event creation pipelines.
 * 
 * @param {object} params
 * @param {object} params.tyre - Tyre database row object
 * @param {object|null} params.bus - Bus database row object
 * @param {string} params.parameterType - Parameter type ('NSD', 'PRESSURE')
 * @param {number} params.value - Numeric reading value
 * @param {function} params.evaluate - Evaluate threshold logic function reference
 * @param {number} params.triggeringEventId - ID of logged event
 * @returns {string} Evaluated severity flag status ('OK', 'WARNING', 'CRITICAL')
 */
function applyReadingEvaluation({ tyre, bus, parameterType, value, evaluate, triggeringEventId }) {
  const threshold = resolveThreshold(parameterType, { depotId: tyre.current_depot_id, busModelId: bus?.bus_model_id });
  const flagStatus = evaluate(value, threshold);

  if (flagStatus === 'OK') {
    autoResolveAlert({ tyreId: tyre.id, parameterType, resolvedByUserId: null });
  } else {
    const thresholdValue = flagStatus === 'CRITICAL' ? (threshold?.critical_max ?? threshold?.critical_min) : (threshold?.warning_max ?? threshold?.warning_min);
    upsertBreachAlert({
      tyreId: tyre.id,
      busId: tyre.current_bus_id,
      depotId: tyre.current_depot_id,
      parameterType,
      severity: flagStatus === 'CRITICAL' ? 'Critical' : 'Warning',
      readingValue: value,
      thresholdValue,
      triggeringEventId,
    });
  }

  return flagStatus;
}

/**
 * Transition alert status from 'Open' to 'Acknowledged'.
 * 
 * @param {number} alertId - ID of alert
 * @param {object} user - User performing the acknowledgment
 * @returns {object} Acknowledged alert row
 */
function acknowledgeAlert(alertId, user) {
  const before = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
  if (!before) throw new ApiError(404, 'Alert not found');
  if (before.status !== 'Open') throw new ApiError(409, `Cannot acknowledge an alert with status ${before.status}`);

  db.prepare(`
    UPDATE alerts SET status = 'Acknowledged', acknowledged_at = datetime('now'), acknowledged_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(user.id, alertId);

  const after = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
  writeAuditLog({ user, action: 'UPDATE', entityType: 'alert', entityId: after.id, before, after });
  return after;
}

/**
 * Transitions alert status to 'Resolved'. Requires a mandatory custom resolution note.
 * 
 * @param {number} alertId - ID of alert to resolve
 * @param {object} user - User performing the resolution
 * @param {string} resolutionNote - Note explaining the action taken
 * @returns {object} Resolved alert row
 */
function resolveAlertManually(alertId, user, resolutionNote) {
  if (!resolutionNote || !resolutionNote.trim()) {
    throw new ApiError(400, 'resolution_note is required to manually resolve an alert');
  }

  const before = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
  if (!before) throw new ApiError(404, 'Alert not found');
  if (before.status === 'Resolved') throw new ApiError(409, 'Alert is already resolved');

  db.prepare(`
    UPDATE alerts SET status = 'Resolved', resolved_at = datetime('now'), resolved_by = ?, resolution_note = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(user.id, resolutionNote.trim(), alertId);

  const after = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
  writeAuditLog({ user, action: 'UPDATE', entityType: 'alert', entityId: after.id, before, after });
  return after;
}

/**
 * Evaluates active alerts and auto-escalates stale ones that have remained in the
 * 'Open' state longer than the ESCALATION_DAYS parameter.
 * 
 * @returns {Array<object>} List of escalated alert row entries
 */
function escalateStaleOpenAlerts() {
  const threshold = resolveThreshold('ESCALATION_DAYS', {});
  if (!threshold || threshold.warning_max == null) return [];

  const stale = db
    .prepare(`
      SELECT * FROM alerts
      WHERE status = 'Open' AND escalation_level = 0
        AND julianday('now') - julianday(opened_at) >= ?
    `)
    .all(threshold.warning_max);

  const escalated = [];
  for (const alert of stale) {
    db.prepare(`UPDATE alerts SET escalation_level = 1, escalated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(alert.id);
    const after = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert.id);
    writeAuditLog({ user: null, action: 'UPDATE', entityType: 'alert', entityId: after.id, before: alert, after });
    escalated.push(after);
  }
  return escalated;
}

module.exports = {
  ApiError,
  findActiveAlert,
  upsertBreachAlert,
  autoResolveAlert,
  applyReadingEvaluation,
  acknowledgeAlert,
  resolveAlertManually,
  escalateStaleOpenAlerts,
};
