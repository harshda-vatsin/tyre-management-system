/**
 * @file tyreEvents.js
 * @description Core business rules transaction manager for tyre event logs.
 * Validates, writes, and audits all primary tyre events (NSD/Pressure measurements, rotations,
 * replacements, transfers, repairs, sends to stock, and condemnation).
 */

const db = require('../db');
const { writeAuditLog } = require('./auditLog');
const { validateNsd, validatePressure } = require('./readingValidation');
const { evaluateNsd, evaluatePressure } = require('./thresholdEngine');
const { applyReadingEvaluation } = require('./alertService');
const { ROLES } = require('./roles');

const DEPOT_SCOPED_ROLES = [ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR];
// Condemnation and Send-to-Store are service-removal actions; SRS UC-13 assigns
// Condemn explicitly to Depot Manager (not Tyre Supervisor), and Send-to-Store
// is treated the same way by analogy since it's the same class of action.
const ELEVATED_EVENT_TYPES = ['send_to_store', 'condemnation'];

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// COALESCE(@event_date, datetime('now')): binding an explicit NULL parameter
// overrides a column's DEFAULT clause in SQLite, so the fallback to "now" has
// to happen in the statement itself, not by omitting the column.
const insertEvent = db.prepare(`
  INSERT INTO tyre_events (
    tyre_id, event_type, event_date, bus_id, position, depot_id,
    from_bus_id, from_position, from_depot_id, to_bus_id, to_position, to_depot_id,
    related_tyre_id, nsd_value, pressure_value, repair_type, reason, stored_at,
    odometer_km, notes, performed_by
  ) VALUES (
    @tyre_id, @event_type, COALESCE(@event_date, datetime('now')), @bus_id, @position, @depot_id,
    @from_bus_id, @from_position, @from_depot_id, @to_bus_id, @to_position, @to_depot_id,
    @related_tyre_id, @nsd_value, @pressure_value, @repair_type, @reason, @stored_at,
    @odometer_km, @notes, @performed_by
  )
`);

const EVENT_FIELDS = [
  'tyre_id', 'event_type', 'event_date', 'bus_id', 'position', 'depot_id',
  'from_bus_id', 'from_position', 'from_depot_id', 'to_bus_id', 'to_position', 'to_depot_id',
  'related_tyre_id', 'nsd_value', 'pressure_value', 'repair_type', 'reason', 'stored_at',
  'odometer_km', 'notes', 'performed_by',
];

function insertEventRow(fields) {
  const complete = Object.fromEntries(EVENT_FIELDS.map((f) => [f, fields[f] ?? null]));
  const info = insertEvent.run(complete);
  return db.prepare('SELECT * FROM tyre_events WHERE id = ?').get(info.lastInsertRowid);
}

function setEventFlagStatus(eventId, flagStatus) {
  db.prepare(`UPDATE tyre_events SET flag_status = ? WHERE id = ?`).run(flagStatus, eventId);
  return db.prepare('SELECT * FROM tyre_events WHERE id = ?').get(eventId);
}

function getTyre(id) {
  const tyre = db.prepare('SELECT * FROM tyres WHERE id = ?').get(id);
  if (!tyre) throw new ApiError(404, `Tyre ${id} not found`);
  return tyre;
}

function getBus(id) {
  const bus = db.prepare('SELECT * FROM buses WHERE id = ?').get(id);
  if (!bus) throw new ApiError(400, `Bus ${id} does not exist`);
  return bus;
}

function getBusModelPositions(busModelId) {
  const model = db.prepare('SELECT position_labels_json FROM bus_models WHERE id = ?').get(busModelId);
  return JSON.parse(model.position_labels_json);
}

function assertDepotScope(user, depotId) {
  if (DEPOT_SCOPED_ROLES.includes(user.role) && depotId !== user.depot_id) {
    throw new ApiError(403, 'Not authorized for this depot');
  }
}

function assertPositionFree(busId, position, excludeTyreId) {
  const occupant = db
    .prepare('SELECT id, tyre_number FROM tyres WHERE current_bus_id = ? AND current_position = ? AND id != ?')
    .get(busId, position, excludeTyreId || 0);
  if (occupant) {
    throw new ApiError(409, `Position ${position} is already occupied by tyre ${occupant.tyre_number}`);
  }
}

function updateTyre(id, fields) {
  const before = db.prepare('SELECT * FROM tyres WHERE id = ?').get(id);
  const merged = { ...before, ...fields };
  db.prepare(`
    UPDATE tyres SET status = ?, current_bus_id = ?, current_position = ?, current_depot_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(merged.status, merged.current_bus_id, merged.current_position, merged.current_depot_id, id);
  const after = db.prepare('SELECT * FROM tyres WHERE id = ?').get(id);
  return { before, after };
}

function auditTyreEvent(user, event) {
  writeAuditLog({ user, action: 'CREATE', entityType: 'tyre_event', entityId: event.id, after: event });
}

function auditTyreMutation(user, before, after) {
  writeAuditLog({ user, action: 'UPDATE', entityType: 'tyre', entityId: after.id, before, after });
}

/**
 * Single transactional entry point for all tyre events.
 * Performs user privilege check, wraps DB mutations in a SQLite transaction,
 * writes tyre_events row, updates tyre state, and writes the audit log.
 * 
 * @param {object} user - User triggering the event
 * @param {string} eventType - The action code ('nsd_reading', 'rotation', 'replacement', etc.)
 * @param {object} payload - Input arguments depending on eventType
 * @returns {Array<object>} List of created event database rows
 */
function createTyreEvent(user, eventType, payload) {
  if (ELEVATED_EVENT_TYPES.includes(eventType) && ![ROLES.ADMIN, ROLES.DEPOT_MANAGER].includes(user.role)) {
    throw new ApiError(403, `${eventType} requires Depot Manager or Administrator`);
  }

  const runner = db.transaction(() => {
    switch (eventType) {
      case 'nsd_reading':
        return createReadingEvent(user, 'nsd_reading', payload);
      case 'pressure_reading':
        return createReadingEvent(user, 'pressure_reading', payload);
      case 'rotation':
        return createRotation(user, payload);
      case 'replacement':
        return createReplacement(user, payload);
      case 'puncture_repair':
        return createPunctureRepair(user, payload);
      case 'inter_bus_transfer':
        return createInterBusTransfer(user, payload);
      case 'send_to_store':
        return createSendToStore(user, payload);
      case 'condemnation':
        return createCondemnation(user, payload);
      default:
        throw new ApiError(400, `Unknown event_type: ${eventType}`);
    }
  });

  return runner();
}

function createReadingEvent(user, eventType, { tyre_id, nsd_value, pressure_value, notes, event_date }) {
  const tyre = getTyre(tyre_id);
  if (!tyre.current_bus_id) {
    throw new ApiError(400, 'Tyre must be mounted on a bus to record a reading');
  }
  assertDepotScope(user, tyre.current_depot_id);

  let nsd = null;
  let pressure = null;
  if (eventType === 'nsd_reading') {
    const result = validateNsd(nsd_value);
    if (!result.valid) throw new ApiError(400, result.error);
    nsd = result.value;
  } else {
    const result = validatePressure(pressure_value);
    if (!result.valid) throw new ApiError(400, result.error);
    pressure = result.value;
  }

  let event = insertEventRow({
    tyre_id: tyre.id,
    event_type: eventType,
    event_date: event_date || undefined,
    bus_id: tyre.current_bus_id,
    position: tyre.current_position,
    depot_id: tyre.current_depot_id,
    nsd_value: nsd,
    pressure_value: pressure,
    notes,
    performed_by: user.id,
  });
  auditTyreEvent(user, event);

  // FR-AL-01/§8.1: evaluate the reading against its resolved threshold, store
  // the result on the event (flag_status), and let the alert engine react.
  const bus = getBus(tyre.current_bus_id);
  const flagStatus = applyReadingEvaluation({
    tyre,
    bus,
    parameterType: eventType === 'nsd_reading' ? 'NSD' : 'PRESSURE',
    value: eventType === 'nsd_reading' ? nsd : pressure,
    evaluate: eventType === 'nsd_reading' ? evaluateNsd : evaluatePressure,
    triggeringEventId: event.id,
  });
  event = setEventFlagStatus(event.id, flagStatus);

  return [event];
}

function createRotation(user, { tyre_id, to_position, reason, event_date }) {
  const tyre = getTyre(tyre_id);
  if (!tyre.current_bus_id) throw new ApiError(400, 'Tyre must be mounted on a bus to rotate');
  if (!to_position) throw new ApiError(400, 'to_position is required');
  assertDepotScope(user, tyre.current_depot_id);

  const bus = getBus(tyre.current_bus_id);
  const positions = getBusModelPositions(bus.bus_model_id);
  if (!positions.includes(to_position)) {
    throw new ApiError(400, `to_position must be one of: ${positions.join(', ')}`);
  }
  if (to_position === tyre.current_position) {
    throw new ApiError(400, 'to_position is the same as the current position');
  }
  assertPositionFree(bus.id, to_position, tyre.id);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'rotation',
    event_date: event_date || undefined,
    bus_id: bus.id,
    position: to_position,
    depot_id: tyre.current_depot_id,
    from_position: tyre.current_position,
    to_position,
    reason,
    performed_by: user.id,
  });

  const { before, after } = updateTyre(tyre.id, { current_position: to_position });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  return [event];
}

function createReplacement(user, { tyre_id, new_tyre_id, reason, event_date }) {
  const oldTyre = getTyre(tyre_id);
  if (!oldTyre.current_bus_id) throw new ApiError(400, 'Tyre being replaced must be mounted on a bus');
  if (!new_tyre_id) throw new ApiError(400, 'new_tyre_id is required');

  const newTyre = getTyre(new_tyre_id);
  if (newTyre.status !== 'In Store') {
    throw new ApiError(400, 'Replacement tyre must have status "In Store"');
  }
  assertDepotScope(user, oldTyre.current_depot_id);
  if (DEPOT_SCOPED_ROLES.includes(user.role) && newTyre.current_depot_id !== oldTyre.current_depot_id) {
    throw new ApiError(403, 'Replacement tyre must be in stock at the same depot');
  }

  const busId = oldTyre.current_bus_id;
  const position = oldTyre.current_position;
  const depotId = oldTyre.current_depot_id;

  const oldEvent = insertEventRow({
    tyre_id: oldTyre.id,
    event_type: 'replacement',
    event_date: event_date || undefined,
    bus_id: busId,
    position,
    depot_id: depotId,
    from_position: position,
    related_tyre_id: newTyre.id,
    reason,
    performed_by: user.id,
  });
  const newEvent = insertEventRow({
    tyre_id: newTyre.id,
    event_type: 'replacement',
    event_date: event_date || undefined,
    bus_id: busId,
    position,
    depot_id: depotId,
    to_position: position,
    related_tyre_id: oldTyre.id,
    reason,
    performed_by: user.id,
  });

  const oldResult = updateTyre(oldTyre.id, { status: 'In Store', current_bus_id: null, current_position: null });
  const newResult = updateTyre(newTyre.id, { status: 'In Service', current_bus_id: busId, current_position: position, current_depot_id: depotId });

  auditTyreMutation(user, oldResult.before, oldResult.after);
  auditTyreMutation(user, newResult.before, newResult.after);
  auditTyreEvent(user, oldEvent);
  auditTyreEvent(user, newEvent);
  return [oldEvent, newEvent];
}

function createPunctureRepair(user, { tyre_id, repair_type, notes, event_date }) {
  const tyre = getTyre(tyre_id);
  if (!['plug', 'patch', 'tube'].includes(repair_type)) {
    throw new ApiError(400, 'repair_type must be one of: plug, patch, tube');
  }
  assertDepotScope(user, tyre.current_depot_id);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'puncture_repair',
    event_date: event_date || undefined,
    bus_id: tyre.current_bus_id,
    position: tyre.current_position,
    depot_id: tyre.current_depot_id,
    repair_type,
    notes,
    performed_by: user.id,
  });
  auditTyreEvent(user, event);
  return [event];
}

function createInterBusTransfer(user, { tyre_id, to_bus_id, to_position, reason, event_date }) {
  const tyre = getTyre(tyre_id);
  if (!tyre.current_bus_id) throw new ApiError(400, 'Tyre must be mounted on a bus to transfer');
  if (!to_bus_id || !to_position) throw new ApiError(400, 'to_bus_id and to_position are required');

  const fromBus = getBus(tyre.current_bus_id);
  const toBus = getBus(to_bus_id);
  if (toBus.id === fromBus.id) throw new ApiError(400, 'to_bus_id must be a different bus');

  const isCrossDepot = fromBus.depot_id !== toBus.depot_id;
  if (isCrossDepot && user.role !== ROLES.ADMIN) {
    throw new ApiError(403, 'Cross-depot transfers require Administrator');
  }
  if (!isCrossDepot) assertDepotScope(user, fromBus.depot_id);

  const positions = getBusModelPositions(toBus.bus_model_id);
  if (!positions.includes(to_position)) {
    throw new ApiError(400, `to_position must be one of: ${positions.join(', ')}`);
  }
  assertPositionFree(toBus.id, to_position, tyre.id);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'inter_bus_transfer',
    event_date: event_date || undefined,
    bus_id: toBus.id,
    position: to_position,
    depot_id: toBus.depot_id,
    from_bus_id: fromBus.id,
    from_position: tyre.current_position,
    from_depot_id: fromBus.depot_id,
    to_bus_id: toBus.id,
    to_position,
    to_depot_id: toBus.depot_id,
    reason,
    performed_by: user.id,
  });

  const { before, after } = updateTyre(tyre.id, { current_bus_id: toBus.id, current_position: to_position, current_depot_id: toBus.depot_id });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  return [event];
}

function createSendToStore(user, { tyre_id, reason, nsd_value, stored_at, event_date }) {
  const tyre = getTyre(tyre_id);
  if (!reason) throw new ApiError(400, 'reason is required');
  if (!stored_at) throw new ApiError(400, 'stored_at is required');
  const nsdResult = validateNsd(nsd_value);
  if (!nsdResult.valid) throw new ApiError(400, nsdResult.error);
  assertDepotScope(user, tyre.current_depot_id);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'send_to_store',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    from_bus_id: tyre.current_bus_id,
    from_position: tyre.current_position,
    nsd_value: nsdResult.value,
    reason,
    stored_at,
    performed_by: user.id,
  });

  const { before, after } = updateTyre(tyre.id, { status: 'In Store', current_bus_id: null, current_position: null });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  return [event];
}

function createCondemnation(user, { tyre_id, reason, nsd_value, event_date }) {
  const tyre = getTyre(tyre_id);
  if (!reason) throw new ApiError(400, 'reason is required');
  const nsdResult = validateNsd(nsd_value);
  if (!nsdResult.valid) throw new ApiError(400, nsdResult.error);
  assertDepotScope(user, tyre.current_depot_id);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'condemnation',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    from_bus_id: tyre.current_bus_id,
    from_position: tyre.current_position,
    nsd_value: nsdResult.value,
    reason,
    performed_by: user.id,
  });

  const { before, after } = updateTyre(tyre.id, { status: 'Condemned', current_bus_id: null, current_position: null });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  return [event];
}

module.exports = { createTyreEvent, ApiError };
