/**
 * @file events.js
 * @description Exposes endpoints to log single tyre events (like replacement, rotation, send to stock,
 * and condemnation) or submit batch inspection reports (multiple measurements per bus).
 */

const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { createTyreEvent, ApiError, AMENDABLE_FIELDS } = require('../utils/tyreEvents');
const { validateNsd, validatePressure } = require('../utils/readingValidation');
const { writeAuditLog } = require('../utils/auditLog');
const { ROLES, isDepotScoped } = require('../utils/roles');

const router = express.Router();

// SRS section 6: NFM and Read-Only Auditor never log events (no write role
// exists for them anywhere in the spec) -- they are read-only on this resource.
const WRITE_ROLES = [ROLES.ADMIN, ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR];

// Tyre Card Amendment / Correction workflow: only Depot Managers and System
// Administrators may amend a tyre_events row (via a tyre_event_amendments
// overlay row -- the original event itself is never touched, see FR-TC-02).
const AMEND_ROLES = [ROLES.ADMIN, ROLES.DEPOT_MANAGER];

const SELECT_AMENDMENT = `
  SELECT a.*, u.username AS amended_by_username, u.full_name AS amended_by_name
  FROM tyre_event_amendments a
  LEFT JOIN users u ON u.id = a.amended_by
`;

function handleEventError(err, res) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  throw err;
}

const SELECT_EVENT = `
  SELECT
    e.*,
    t.tyre_number,
    b.registration_no AS bus_registration_no,
    fb.registration_no AS from_bus_registration_no,
    tb.registration_no AS to_bus_registration_no,
    rt.tyre_number AS related_tyre_number,
    d.name AS depot_name,
    u.username AS performed_by_username, u.full_name AS performed_by_name
  FROM tyre_events e
  JOIN tyres t ON t.id = e.tyre_id
  LEFT JOIN buses b ON b.id = e.bus_id
  LEFT JOIN buses fb ON fb.id = e.from_bus_id
  LEFT JOIN buses tb ON tb.id = e.to_bus_id
  LEFT JOIN tyres rt ON rt.id = e.related_tyre_id
  LEFT JOIN depots d ON d.id = e.depot_id
  LEFT JOIN users u ON u.id = e.performed_by
`;

router.use(authenticate);

// FR-TC-03: chronological history, filterable by event type and date range.
router.get('/', (req, res) => {
  const { tyre_id, bus_id, event_type, from, to, page = '1', pageSize = '20' } = req.query;
  const clauses = [];
  const params = {};

  if (tyre_id) {
    clauses.push('e.tyre_id = @tyre_id');
    params.tyre_id = Number(tyre_id);
  }
  if (bus_id) {
    clauses.push('e.bus_id = @bus_id');
    params.bus_id = Number(bus_id);
  }
  if (event_type) {
    clauses.push('e.event_type = @event_type');
    params.event_type = event_type;
  }
  if (from) {
    clauses.push('e.event_date >= @from');
    params.from = from;
  }
  if (to) {
    clauses.push('e.event_date <= @to');
    params.to = to;
  }
  if (isDepotScoped(req.user)) {
    clauses.push('e.depot_id = @depot_id');
    params.depot_id = req.user.depot_id;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM tyre_events e ${where}`).get(params).c;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;

  const rows = db
    .prepare(`${SELECT_EVENT} ${where} ORDER BY e.event_date DESC, e.id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset });

  res.json({ data: rows, total, page: pageNum, pageSize: size });
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`${SELECT_EVENT} WHERE e.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Event not found' });
  if (isDepotScoped(req.user) && row.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }
  res.json(row);
});

// Dynamic single-event creation (Event Logging section). event_type in the
// body selects which fields are required -- see utils/tyreEvents.js.
router.post('/', authorize(...WRITE_ROLES), (req, res) => {
  const { event_type, ...payload } = req.body || {};
  if (!event_type) return res.status(400).json({ error: 'event_type is required' });

  try {
    const events = createTyreEvent(req.user, event_type, payload);
    res.status(201).json(events.length === 1 ? events[0] : events);
  } catch (err) {
    handleEventError(err, res);
  }
});

// FR-RW-01: batch NSD + Pressure entry for every tyre currently mounted on a
// bus, in one inspection session. Delegates to the same createTyreEvent() used
// by the single-event route so validation/mutation logic is not duplicated.
router.post('/batch', authorize(...WRITE_ROLES), (req, res) => {
  const { bus_id, event_date, readings } = req.body || {};
  if (!bus_id || !Array.isArray(readings) || readings.length === 0) {
    return res.status(400).json({ error: 'bus_id and a non-empty readings array are required' });
  }

  const created = [];
  const errors = [];

  try {
    for (const reading of readings) {
      const { tyre_id, nsd_value, pressure_value } = reading;
      if (!tyre_id) {
        errors.push({ tyre_id: null, error: 'tyre_id is required for each reading' });
        continue;
      }
      if (nsd_value === undefined && pressure_value === undefined) continue;

      try {
        if (nsd_value !== undefined && nsd_value !== null && nsd_value !== '') {
          created.push(...createTyreEvent(req.user, 'nsd_reading', { tyre_id, nsd_value, event_date }));
        }
        if (pressure_value !== undefined && pressure_value !== null && pressure_value !== '') {
          created.push(...createTyreEvent(req.user, 'pressure_reading', { tyre_id, pressure_value, event_date }));
        }
      } catch (err) {
        if (err instanceof ApiError) {
          errors.push({ tyre_id, error: err.message });
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    return handleEventError(err, res);
  }

  // Returns 201 if at least one event was successfully logged, otherwise returns 400
  res.status(created.length ? 201 : 400).json({ created, errors });
});

// Validates and coerces the corrected_values submitted to an amendment,
// restricted to the field set that's amendable for the original event's
// event_type (see AMENDABLE_FIELDS) so a correction can't smuggle in changes
// to structural/relational fields the tyre_events table relies on.
function cleanCorrectedValues(eventType, correctedValues) {
  const allowedFields = AMENDABLE_FIELDS[eventType] || [];
  const cleaned = {};
  for (const [key, value] of Object.entries(correctedValues)) {
    if (!allowedFields.includes(key)) {
      throw new ApiError(400, `Field "${key}" is not amendable for ${eventType} events`);
    }
    if (key === 'nsd_value') {
      const result = validateNsd(value);
      if (!result.valid) throw new ApiError(400, result.error);
      cleaned[key] = result.value;
    } else if (key === 'pressure_value') {
      const result = validatePressure(value);
      if (!result.valid) throw new ApiError(400, result.error);
      cleaned[key] = result.value;
    } else if (key === 'repair_type') {
      if (!['plug', 'patch', 'tube'].includes(value)) {
        throw new ApiError(400, 'repair_type must be one of: plug, patch, tube');
      }
      cleaned[key] = value;
    } else {
      if (value === undefined || value === null || String(value).trim() === '') {
        throw new ApiError(400, `${key} cannot be empty`);
      }
      cleaned[key] = value;
    }
  }
  if (Object.keys(cleaned).length === 0) {
    throw new ApiError(400, 'At least one corrected value is required');
  }
  return cleaned;
}

// Tyre Card Amendment / Correction: layers a correction on top of an existing
// tyre_events row without ever updating or deleting it (FR-TC-02/NFR-07).
router.post('/:id/correct', authorize(...AMEND_ROLES), (req, res) => {
  const event = db.prepare('SELECT * FROM tyre_events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (isDepotScoped(req.user) && event.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  const { reason, corrected_values } = req.body || {};
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'An amendment reason is required' });
  }
  if (!corrected_values || typeof corrected_values !== 'object' || Array.isArray(corrected_values)) {
    return res.status(400).json({ error: 'corrected_values is required' });
  }

  let cleaned;
  try {
    cleaned = cleanCorrectedValues(event.event_type, corrected_values);
  } catch (err) {
    return handleEventError(err, res);
  }

  const info = db.prepare(`
    INSERT INTO tyre_event_amendments (original_event_id, corrected_values_json, reason, amended_by)
    VALUES (?, ?, ?, ?)
  `).run(event.id, JSON.stringify(cleaned), reason, req.user.id);

  const amendment = db.prepare(`${SELECT_AMENDMENT} WHERE a.id = ?`).get(info.lastInsertRowid);

  writeAuditLog({
    user: req.user,
    action: 'AMEND_EVENT',
    entityType: 'tyre_event',
    entityId: event.id,
    before: event,
    after: { amendment_id: amendment.id, corrected_values: cleaned, reason },
  });

  res.status(201).json(amendment);
});

// Full amendment history for one tyre_events row, oldest first (newest last)
// so the UI can render Original -> Correction #1 -> Correction #2 -> ...
router.get('/:id/amendments', (req, res) => {
  const event = db.prepare('SELECT * FROM tyre_events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (isDepotScoped(req.user) && event.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  const rows = db
    .prepare(`${SELECT_AMENDMENT} WHERE a.original_event_id = ? ORDER BY a.amended_at ASC, a.id ASC`)
    .all(event.id);
  res.json(rows);
});

module.exports = router;
