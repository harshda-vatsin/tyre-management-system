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
const { transitionTyreStatus } = require('./lifecycleStateMachine');
const { ApiError } = require('./apiError');

const DEPOT_SCOPED_ROLES = [ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR];
// Condemnation and Send-to-Store are service-removal actions; SRS UC-13 assigns
// Condemn explicitly to Depot Manager (not Tyre Supervisor), and Send-to-Store
// is treated the same way by analogy since it's the same class of action.
// Scrap is the same class of destructive terminal action as condemnation.
const ELEVATED_EVENT_TYPES = ['send_to_store', 'condemnation', 'scrap'];

// Tyre Card Amendment workflow: which tyre_events columns may be corrected
// per event_type. Deliberately excludes structural/relational fields (bus_id,
// tyre_id, related_tyre_id, depot_id, position) -- amending those would
// rewrite tyre state history rather than correct a clerical error, which is
// exactly what this workflow must never do to tyre_events.
const AMENDABLE_FIELDS = {
  nsd_reading: ['nsd_value', 'notes', 'nsd_g1', 'nsd_g2', 'nsd_g3', 'nsd_g4'],
  pressure_reading: ['pressure_value', 'notes'],
  rotation: ['to_position', 'reason'],
  replacement: ['reason'],
  puncture_repair: ['repair_type', 'notes', 'repair_cost', 'supervisor_name', 'tyre_man_name', 'patch_size'],
  send_to_repair: ['reason', 'nsd_value'],
  inter_bus_transfer: ['to_bus_id', 'to_position', 'reason'],
  send_to_store: ['nsd_value', 'stored_at', 'reason'],
  condemnation: ['nsd_value', 'reason'],
  purchase_intake: ['notes', 'vendor_name', 'gate_pass_no', 'invoice_no', 'invoice_date'],
  fitment_created: ['reason'],
  reservation: ['reason'],
  inspection_completed: ['notes'],
  retread_sent: ['vendor_name', 'vendor_location', 'gate_pass_no', 'reason', 'retread_purpose'],
  retread_completed: ['vendor_name', 'vendor_location', 'retread_cost', 'invoice_no', 'invoice_date', 'notes', 'outcome', 'reason'],
  warranty_claim: ['reason', 'notes', 'vendor_name', 'gate_pass_no', 'invoice_no', 'invoice_date', 'approved_by', 'vendor_location'],
  scrap: ['scrap_value', 'reason', 'vendor_name', 'vendor_location', 'gate_pass_no', 'invoice_no', 'invoice_date', 'approved_by', 'store_manager', 'nsd_value'],
  scrap_disposal: ['reason'],
};

// COALESCE(@event_date, datetime('now')): binding an explicit NULL parameter
// overrides a column's DEFAULT clause in SQLite, so the fallback to "now" has
// to happen in the statement itself, not by omitting the column.
const insertEvent = db.prepare(`
  INSERT INTO tyre_events (
    tyre_id, event_type, event_date, bus_id, position, depot_id,
    from_bus_id, from_position, from_depot_id, to_bus_id, to_position, to_depot_id,
    related_tyre_id, nsd_value, nsd_g1, nsd_g2, nsd_g3, nsd_g4, pressure_value, repair_type, reason, stored_at,
    odometer_km, notes, repair_cost, retread_cost, scrap_value, vendor_name,
    gate_pass_no, invoice_no, invoice_date, vendor_location, approved_by,
    supervisor_name, tyre_man_name, patch_size, retread_purpose, outcome, store_manager, performed_by
  ) VALUES (
    @tyre_id, @event_type, COALESCE(@event_date, datetime('now')), @bus_id, @position, @depot_id,
    @from_bus_id, @from_position, @from_depot_id, @to_bus_id, @to_position, @to_depot_id,
    @related_tyre_id, @nsd_value, @nsd_g1, @nsd_g2, @nsd_g3, @nsd_g4, @pressure_value, @repair_type, @reason, @stored_at,
    @odometer_km, @notes, @repair_cost, @retread_cost, @scrap_value, @vendor_name,
    @gate_pass_no, @invoice_no, @invoice_date, @vendor_location, @approved_by,
    @supervisor_name, @tyre_man_name, @patch_size, @retread_purpose, @outcome, @store_manager, @performed_by
  )
`);

const EVENT_FIELDS = [
  'tyre_id', 'event_type', 'event_date', 'bus_id', 'position', 'depot_id',
  'from_bus_id', 'from_position', 'from_depot_id', 'to_bus_id', 'to_position', 'to_depot_id',
  'related_tyre_id', 'nsd_value', 'nsd_g1', 'nsd_g2', 'nsd_g3', 'nsd_g4', 'pressure_value', 'repair_type', 'reason', 'stored_at',
  'odometer_km', 'notes', 'repair_cost', 'retread_cost', 'scrap_value', 'vendor_name',
  'gate_pass_no', 'invoice_no', 'invoice_date', 'vendor_location', 'approved_by',
  'supervisor_name', 'tyre_man_name', 'patch_size', 'retread_purpose', 'outcome', 'store_manager', 'performed_by',
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

// Keeps buses.odometer_km as one live reading rather than a second source of
// truth: an event's own odometer_km is always recorded on the tyre_events
// row regardless, but the bus's stored figure only advances, never regresses
// (a lower reading is silently ignored rather than treated as an error, since
// events aren't always logged in strict chronological order).
function maybeUpdateBusOdometer(busId, odometerKm) {
  if (!busId || odometerKm == null) return;
  const bus = db.prepare('SELECT odometer_km FROM buses WHERE id = ?').get(busId);
  if (bus && odometerKm > bus.odometer_km) {
    db.prepare(`UPDATE buses SET odometer_km = ?, updated_at = datetime('now') WHERE id = ?`).run(odometerKm, busId);
  }
}

// NSD capture at transaction time (rotation, send-to-repair, scrap, warranty
// claim) is supplementary, not the primary inspection reading nsd_reading
// represents -- so it's validated with the same physical bounds but is
// optional and never runs threshold/alert evaluation.
function normalizeOptionalNsd(value) {
  if (value === undefined || value === null || value === '') return null;
  const result = validateNsd(value);
  if (!result.valid) throw new ApiError(400, result.error);
  return result.value;
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
      case 'send_to_repair':
        return createSendToRepair(user, payload);
      case 'inter_bus_transfer':
        return createInterBusTransfer(user, payload);
      case 'send_to_store':
        return createSendToStore(user, payload);
      case 'condemnation':
        return createCondemnation(user, payload);
      case 'purchase_intake':
        return createPurchaseIntake(user, payload);
      case 'fitment_created':
        return createFitmentCreated(user, payload);
      case 'reservation':
        return createReservation(user, payload);
      case 'inspection_completed':
        return createInspectionCompleted(user, payload);
      case 'retread_sent':
        return createRetreadSent(user, payload);
      case 'retread_completed':
        return createRetreadCompleted(user, payload);
      case 'warranty_claim':
        return createWarrantyClaim(user, payload);
      case 'scrap':
        return createScrap(user, payload);
      case 'scrap_disposal':
        return createScrapDisposal(user, payload);
      default:
        throw new ApiError(400, `Unknown event_type: ${eventType}`);
    }
  });

  return runner();
}

function createReadingEvent(user, eventType, { tyre_id, nsd_value, nsd_g1, nsd_g2, nsd_g3, nsd_g4, pressure_value, notes, event_date }) {
  const tyre = getTyre(tyre_id);
  if (!tyre.current_bus_id) {
    throw new ApiError(400, 'Tyre must be mounted on a bus to record a reading');
  }
  assertDepotScope(user, tyre.current_depot_id);

  let nsd = null;
  let pressure = null;
  let grooves = { nsd_g1: null, nsd_g2: null, nsd_g3: null, nsd_g4: null };
  if (eventType === 'nsd_reading') {
    grooves = {
      nsd_g1: normalizeOptionalNsd(nsd_g1),
      nsd_g2: normalizeOptionalNsd(nsd_g2),
      nsd_g3: normalizeOptionalNsd(nsd_g3),
      nsd_g4: normalizeOptionalNsd(nsd_g4),
    };
    const grooveValues = Object.values(grooves);
    const allGroovesGiven = grooveValues.every((v) => v !== null);
    // Matches the Excel's own "Min" column: nsd_value is authoritative and
    // stays a manual entry when supplied, only auto-derived as the minimum
    // of the 4 tread-groove points when the caller gave all 4 and skipped it.
    const effectiveNsdValue = (nsd_value === undefined || nsd_value === null || nsd_value === '') && allGroovesGiven
      ? Math.min(...grooveValues)
      : nsd_value;
    const result = validateNsd(effectiveNsdValue);
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
    ...grooves,
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

function createRotation(user, { tyre_id, to_position, reason, event_date, odometer_km, nsd_value }) {
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
  const nsd = normalizeOptionalNsd(nsd_value);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'rotation',
    event_date: event_date || undefined,
    bus_id: bus.id,
    position: to_position,
    depot_id: tyre.current_depot_id,
    from_position: tyre.current_position,
    to_position,
    odometer_km: odometer_km ?? null,
    nsd_value: nsd,
    reason,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, tyre.status, { current_position: to_position });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  maybeUpdateBusOdometer(bus.id, odometer_km);
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
  const bus = getBus(busId);

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

  const oldResult = transitionTyreStatus(oldTyre.id, 'In Store', { current_bus_id: null, current_position: null });
  const newResult = transitionTyreStatus(newTyre.id, 'Active', { current_bus_id: busId, current_position: position, current_depot_id: depotId, current_package_id: bus.package_id });

  auditTyreMutation(user, oldResult.before, oldResult.after);
  auditTyreMutation(user, newResult.before, newResult.after);
  auditTyreEvent(user, oldEvent);
  auditTyreEvent(user, newEvent);
  return [oldEvent, newEvent];
}

// "Repair Completed" -- the second half of the repair workflow. Records
// what was actually done (repair_type/cost/notes) and returns the tyre to
// In Store (a status only ever answers "where is the tyre now"; the record
// of what happened lives here, in the timeline, not in the status value).
// From In Store it can be re-fitted via fitment_created same as any other
// stored tyre.
function createPunctureRepair(user, { tyre_id, repair_type, notes, repair_cost, supervisor_name, tyre_man_name, patch_size, odometer_km, event_date }) {
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
    repair_cost: repair_cost ?? null,
    supervisor_name,
    tyre_man_name,
    patch_size,
    odometer_km: odometer_km ?? null,
    notes,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, 'In Store', { current_bus_id: null, current_position: null });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  maybeUpdateBusOdometer(before.current_bus_id, odometer_km);
  return [event];
}

// "Send to Repair" -- the first half of the repair workflow. Pulls the tyre
// out of wherever it currently is (off the bus, if mounted) and marks it
// Under Repair; createPunctureRepair (fired later, once the mechanic is
// done) is what returns it to In Store.
function createSendToRepair(user, { tyre_id, reason, odometer_km, nsd_value, event_date }) {
  const tyre = getTyre(tyre_id);
  assertDepotScope(user, tyre.current_depot_id);
  const nsd = normalizeOptionalNsd(nsd_value);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'send_to_repair',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    from_bus_id: tyre.current_bus_id,
    from_position: tyre.current_position,
    odometer_km: odometer_km ?? null,
    nsd_value: nsd,
    reason,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, 'Under Repair', { current_bus_id: null, current_position: null });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  maybeUpdateBusOdometer(before.current_bus_id, odometer_km);
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

  const { before, after } = transitionTyreStatus(tyre.id, tyre.status, {
    current_bus_id: toBus.id, current_position: to_position, current_depot_id: toBus.depot_id, current_package_id: toBus.package_id,
  });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  return [event];
}

function createSendToStore(user, { tyre_id, reason, nsd_value, stored_at, odometer_km, event_date }) {
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
    odometer_km: odometer_km ?? null,
    reason,
    stored_at,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, 'In Store', { current_bus_id: null, current_position: null });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  maybeUpdateBusOdometer(before.current_bus_id, odometer_km);
  return [event];
}

function createCondemnation(user, { tyre_id, reason, nsd_value, odometer_km, event_date }) {
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
    odometer_km: odometer_km ?? null,
    reason,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, 'Scrapped', { current_bus_id: null, current_position: null });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  maybeUpdateBusOdometer(before.current_bus_id, odometer_km);
  return [event];
}

// Fired by routes/tyres.js right after a new tyre row is inserted, so tyre
// creation is never silent -- the tyre's own current_bus_id/position/depot
// (whatever the create request set) are copied onto this event as-is; it
// does not itself change status, since the tyre row's initial status was
// already decided by the create request.
function createPurchaseIntake(user, { tyre_id, notes, vendor_name, gate_pass_no, invoice_no, invoice_date, event_date }) {
  const tyre = getTyre(tyre_id);
  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'purchase_intake',
    event_date: event_date || undefined,
    bus_id: tyre.current_bus_id,
    position: tyre.current_position,
    depot_id: tyre.current_depot_id,
    notes,
    vendor_name,
    gate_pass_no,
    invoice_no,
    invoice_date,
    performed_by: user.id,
  });
  auditTyreEvent(user, event);
  return [event];
}

// Mounts a tyre from In Store onto a bus position, taking it straight to
// Active (mounted and running) -- there's no separate transitional "just
// mounted, not yet running" status in the simplified model.
function createFitmentCreated(user, { tyre_id, bus_id, position, reason, odometer_km, event_date }) {
  const tyre = getTyre(tyre_id);
  if (tyre.current_bus_id) throw new ApiError(400, 'Tyre is already mounted on a bus');
  if (!bus_id || !position) throw new ApiError(400, 'bus_id and position are required');

  const bus = getBus(bus_id);
  assertDepotScope(user, bus.depot_id);
  const positions = getBusModelPositions(bus.bus_model_id);
  if (!positions.includes(position)) {
    throw new ApiError(400, `position must be one of: ${positions.join(', ')}`);
  }
  assertPositionFree(bus.id, position, tyre.id);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'fitment_created',
    event_date: event_date || undefined,
    bus_id: bus.id,
    position,
    depot_id: bus.depot_id,
    odometer_km: odometer_km ?? null,
    reason,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, 'Active', {
    current_bus_id: bus.id,
    current_position: position,
    current_depot_id: bus.depot_id,
    current_package_id: bus.package_id,
  });
  maybeUpdateBusOdometer(bus.id, odometer_km);
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  return [event];
}

// Retained for historical rows and API compatibility, but no longer moves
// the tyre anywhere meaningful -- the simplified model has only one
// "not yet fitted" status (In Store), so there's nothing left to reserve
// between. Always resolves to In Store.
function createReservation(user, { tyre_id, reason, event_date }) {
  const tyre = getTyre(tyre_id);
  assertDepotScope(user, tyre.current_depot_id);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'reservation',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    reason,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, 'In Store', {});
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  return [event];
}

// Explicit inspection sign-off, distinct from a raw NSD/pressure reading.
// Counts as a "reading-equivalent" for inspectionService's due/overdue
// clock (see the LAST_READING_SUBQUERY update there). Doesn't change the
// tyre's status -- an inspection is just a timeline entry, not a move.
function createInspectionCompleted(user, { tyre_id, notes, event_date }) {
  const tyre = getTyre(tyre_id);
  if (!tyre.current_bus_id) throw new ApiError(400, 'Tyre must be mounted on a bus to complete an inspection');
  assertDepotScope(user, tyre.current_depot_id);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'inspection_completed',
    event_date: event_date || undefined,
    bus_id: tyre.current_bus_id,
    position: tyre.current_position,
    depot_id: tyre.current_depot_id,
    notes,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, 'Active', {});
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  return [event];
}

// Dispatches a removed/stored tyre to a retread vendor. vendor_name is a
// free-text field (no Vendor master-data entity in this phase).
function createRetreadSent(user, { tyre_id, vendor_name, vendor_location, gate_pass_no, reason, odometer_km, retread_purpose, event_date }) {
  const tyre = getTyre(tyre_id);
  if (!vendor_name) throw new ApiError(400, 'vendor_name is required');
  if (retread_purpose && !['Retread', 'Cut Repair'].includes(retread_purpose)) {
    throw new ApiError(400, 'retread_purpose must be one of: Retread, Cut Repair');
  }
  // The state machine alone would allow this as a same-status no-op
  // transition (needed elsewhere for location-only moves); retread dispatch
  // needs the stronger rule from the spec: "cannot be sent for retread again
  // while already at vendor".
  if (tyre.status === 'Under Retread') {
    throw new ApiError(409, 'Tyre is already under retread');
  }
  assertDepotScope(user, tyre.current_depot_id);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'retread_sent',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    from_bus_id: tyre.current_bus_id,
    from_position: tyre.current_position,
    vendor_name,
    vendor_location,
    gate_pass_no,
    odometer_km: odometer_km ?? null,
    retread_purpose,
    reason,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, 'Under Retread', { current_bus_id: null, current_position: null });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  maybeUpdateBusOdometer(before.current_bus_id, odometer_km);
  return [event];
}

// Records the retread vendor's invoice/return and puts the tyre back In
// Store (ready to be re-fitted via fitment_created, same as any other
// stored tyre).
function createRetreadCompleted(user, { tyre_id, vendor_name, vendor_location, invoice_no, invoice_date, retread_cost, notes, outcome, reason, event_date }) {
  const tyre = getTyre(tyre_id);
  assertDepotScope(user, tyre.current_depot_id);
  if (outcome && !['Done', 'Rejected'].includes(outcome)) {
    throw new ApiError(400, 'outcome must be one of: Done, Rejected');
  }

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'retread_completed',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    vendor_name: vendor_name ?? null,
    vendor_location,
    invoice_no,
    invoice_date,
    retread_cost: retread_cost ?? null,
    notes,
    outcome,
    reason,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, 'In Store', {});
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  return [event];
}

// Fired up to three times per claim, each its own timeline entry, with the
// tyre staying at status 'Warranty' throughout submission and decision --
// only the final "closed" call moves it back In Store, since a warranty
// review doesn't change where the tyre physically is until it's resolved:
//   1. Submit   (no outcome)          -> Warranty
//   2. Decide   (outcome: approved/rejected) -> stays Warranty
//   3. Close    (outcome: closed)     -> In Store
function createWarrantyClaim(user, { tyre_id, outcome, reason, notes, vendor_name, gate_pass_no, invoice_no, invoice_date, approved_by, vendor_location, nsd_value, event_date }) {
  const tyre = getTyre(tyre_id);
  assertDepotScope(user, tyre.current_depot_id);

  if (outcome && !['approved', 'rejected', 'closed'].includes(outcome)) {
    throw new ApiError(400, 'outcome must be one of: approved, rejected, closed');
  }
  if (!outcome && !reason) throw new ApiError(400, 'reason is required to submit a warranty claim');
  const nsd = normalizeOptionalNsd(nsd_value);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'warranty_claim',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    reason: outcome ? `Warranty ${outcome}${reason ? `: ${reason}` : ''}` : reason,
    notes,
    vendor_name,
    gate_pass_no,
    invoice_no,
    invoice_date,
    approved_by,
    vendor_location,
    nsd_value: nsd,
    performed_by: user.id,
  });

  const targetStatus = outcome === 'closed' ? 'In Store' : 'Warranty';
  const { before, after } = transitionTyreStatus(tyre.id, targetStatus, {});
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  return [event];
}

// Terminal write-off. Elevated (Depot Manager/Administrator), same class of
// action as condemnation.
function createScrap(user, { tyre_id, reason, scrap_value, vendor_name, vendor_location, gate_pass_no, invoice_no, invoice_date, approved_by, store_manager, odometer_km, nsd_value, event_date }) {
  const tyre = getTyre(tyre_id);
  if (!reason) throw new ApiError(400, 'reason is required');
  assertDepotScope(user, tyre.current_depot_id);
  const nsd = normalizeOptionalNsd(nsd_value);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'scrap',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    from_bus_id: tyre.current_bus_id,
    from_position: tyre.current_position,
    scrap_value: scrap_value ?? null,
    vendor_name,
    vendor_location,
    gate_pass_no,
    invoice_no,
    invoice_date,
    approved_by,
    store_manager,
    odometer_km: odometer_km ?? null,
    nsd_value: nsd,
    reason,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, 'Scrapped', { current_bus_id: null, current_position: null });
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  maybeUpdateBusOdometer(before.current_bus_id, odometer_km);
  return [event];
}

// Records a post-scrap administrative milestone (physically disposed of /
// archived out of active records). Scrapped is terminal and stays terminal
// -- these are timeline entries describing what happened to a scrapped
// tyre, not further "where is it" moves, so status never leaves Scrapped.
function createScrapDisposal(user, { tyre_id, milestone, reason, event_date }) {
  const tyre = getTyre(tyre_id);
  if (!['Disposed', 'Archived'].includes(milestone)) {
    throw new ApiError(400, 'milestone must be one of: Disposed, Archived');
  }
  assertDepotScope(user, tyre.current_depot_id);

  const event = insertEventRow({
    tyre_id: tyre.id,
    event_type: 'scrap_disposal',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    reason: `${milestone}${reason ? `: ${reason}` : ''}`,
    performed_by: user.id,
  });

  const { before, after } = transitionTyreStatus(tyre.id, 'Scrapped', {});
  auditTyreMutation(user, before, after);
  auditTyreEvent(user, event);
  return [event];
}

module.exports = { createTyreEvent, ApiError, AMENDABLE_FIELDS };
