/**
 * @file tyreEvents.js
 * @description Core business rules transaction manager for tyre event logs.
 * Validates, writes, and audits all primary tyre events (NSD/Pressure measurements, rotations,
 * replacements, transfers, repairs, sends to stock, and condemnation).
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const db = require('../db');
const { NOW_SQL } = db;
const { writeAuditLog } = require('./auditLog');
const { validateNsd, validatePressure } = require('./readingValidation');
const { evaluateNsd, evaluatePressure } = require('./thresholdEngine');
const { applyReadingEvaluation } = require('./alertService');
const { ROLES } = require('./roles');
const { transitionTyreStatus } = require('./lifecycleStateMachine');
const { ApiError } = require('./apiError');
const { EVENT_OUTCOMES } = require('./tyreLifecycle');

const DEPOT_SCOPED_ROLES = [ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR];
// Condemnation ("Scrap" in the UI) and Send-to-Store are service-removal
// actions; SRS UC-13 assigns Condemn explicitly to Depot Manager (not Tyre
// Supervisor), and Send-to-Store is treated the same way by analogy since
// it's the same class of action.
const ELEVATED_EVENT_TYPES = ['send_to_store', 'condemnation'];

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
  // "Scrap" in the UI -- absorbed the old separate 'scrap' event type's
  // paperwork fields (see createCondemnation below).
  condemnation: ['nsd_value', 'reason', 'scrap_value', 'vendor_name', 'vendor_location', 'gate_pass_no', 'invoice_no', 'invoice_date', 'approved_by', 'store_manager'],
  purchase_intake: ['notes', 'vendor_name', 'gate_pass_no', 'invoice_no', 'invoice_date'],
  fitment_created: ['reason'],
  reservation: ['reason'],
  inspection_completed: ['notes'],
  retread_sent: ['vendor_name', 'vendor_location', 'gate_pass_no', 'reason', 'retread_purpose'],
  retread_completed: ['vendor_name', 'vendor_location', 'retread_cost', 'invoice_no', 'invoice_date', 'notes', 'outcome', 'reason'],
  warranty_claim: ['reason', 'notes', 'vendor_name', 'gate_pass_no', 'invoice_no', 'invoice_date', 'approved_by', 'vendor_location'],
};

// COALESCE(@event_date, NOW_SQL): binding an explicit NULL parameter
// overrides a column's DEFAULT clause, so the fallback to "now" has to
// happen in the statement itself, not by omitting the column.
const insertEvent = db.prepare(`
  INSERT INTO tyre_events (
    tyre_id, event_type, event_date, bus_id, position, depot_id,
    from_bus_id, from_position, from_depot_id, to_bus_id, to_position, to_depot_id,
    related_tyre_id, nsd_value, nsd_g1, nsd_g2, nsd_g3, nsd_g4, pressure_value, repair_type, reason, stored_at,
    odometer_km, notes, repair_cost, retread_cost, scrap_value, vendor_name,
    gate_pass_no, invoice_no, invoice_date, vendor_location, approved_by,
    supervisor_name, tyre_man_name, patch_size, retread_purpose, outcome, store_manager, performed_by,
    source_mis_record_type, source_mis_record_id
  ) VALUES (
    @tyre_id, @event_type, COALESCE(@event_date, ${NOW_SQL}), @bus_id, @position, @depot_id,
    @from_bus_id, @from_position, @from_depot_id, @to_bus_id, @to_position, @to_depot_id,
    @related_tyre_id, @nsd_value, @nsd_g1, @nsd_g2, @nsd_g3, @nsd_g4, @pressure_value, @repair_type, @reason, @stored_at,
    @odometer_km, @notes, @repair_cost, @retread_cost, @scrap_value, @vendor_name,
    @gate_pass_no, @invoice_no, @invoice_date, @vendor_location, @approved_by,
    @supervisor_name, @tyre_man_name, @patch_size, @retread_purpose, @outcome, @store_manager, @performed_by,
    @source_mis_record_type, @source_mis_record_id
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

// Which MIS record (if any) this call to createTyreEvent() traces back to
// (§10). Set once, in createTyreEvent() itself, for the duration of that
// call -- every one of the 17 createXxx() handlers below funnels through
// insertEventRow(), so this reaches all of them (including handlers that
// insert more than one row per call, e.g. createReplacement's two events)
// without any of them needing to know this context exists. AsyncLocalStorage
// rather than a plain module variable because createTyreEvent() calls are
// not otherwise serialized -- a concurrent, unrelated call must never see
// this one's values.
const sourceMisRecordContext = new AsyncLocalStorage();

async function insertEventRow(fields) {
  const source = sourceMisRecordContext.getStore();
  const complete = Object.fromEntries(EVENT_FIELDS.map((f) => [f, fields[f] ?? null]));
  complete.source_mis_record_type = source?.source_mis_record_type ?? null;
  complete.source_mis_record_id = source?.source_mis_record_id ?? null;
  const info = await insertEvent.run(complete);
  return db.prepare('SELECT * FROM tyre_events WHERE id = ?').get(info.lastInsertRowid);
}

async function setEventFlagStatus(eventId, flagStatus) {
  await db.prepare(`UPDATE tyre_events SET flag_status = ? WHERE id = ?`).run(flagStatus, eventId);
  return db.prepare('SELECT * FROM tyre_events WHERE id = ?').get(eventId);
}

async function getTyre(id) {
  const tyre = await db.prepare('SELECT * FROM tyres WHERE id = ?').get(id);
  if (!tyre) throw new ApiError(404, `Tyre ${id} not found`);
  return tyre;
}

async function getBus(id) {
  const bus = await db.prepare('SELECT * FROM buses WHERE id = ?').get(id);
  if (!bus) throw new ApiError(400, `Bus ${id} does not exist`);
  return bus;
}

// Keeps buses.odometer_km as one live reading rather than a second source of
// truth: an event's own odometer_km is always recorded on the tyre_events
// row regardless, but the bus's stored figure only advances, never regresses
// (a lower reading is silently ignored rather than treated as an error, since
// events aren't always logged in strict chronological order).
async function maybeUpdateBusOdometer(busId, odometerKm) {
  if (!busId || odometerKm == null) return;
  const bus = await db.prepare('SELECT odometer_km FROM buses WHERE id = ?').get(busId);
  if (bus && odometerKm > bus.odometer_km) {
    await db.prepare(`UPDATE buses SET odometer_km = ?, updated_at = ${NOW_SQL} WHERE id = ?`).run(odometerKm, busId);
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

async function getBusModelPositions(busModelId) {
  const model = await db.prepare('SELECT position_labels_json FROM bus_models WHERE id = ?').get(busModelId);
  return JSON.parse(model.position_labels_json);
}

function assertDepotScope(user, depotId) {
  if (DEPOT_SCOPED_ROLES.includes(user.role) && depotId !== user.depot_id) {
    throw new ApiError(403, 'Not authorized for this depot');
  }
}

async function assertPositionFree(busId, position, excludeTyreId) {
  const occupant = await db
    .prepare('SELECT id, tyre_number FROM tyres WHERE current_bus_id = ? AND current_position = ? AND id != ?')
    .get(busId, position, excludeTyreId || 0);
  if (occupant) {
    throw new ApiError(409, `Position ${position} is already occupied by tyre ${occupant.tyre_number}`);
  }
}

function auditTyreEvent(user, event) {
  return writeAuditLog({ user, action: 'CREATE', entityType: 'tyre_event', entityId: event.id, after: event });
}

function auditTyreMutation(user, before, after) {
  return writeAuditLog({ user, action: 'UPDATE', entityType: 'tyre', entityId: after.id, before, after });
}

/**
 * Single transactional entry point for all tyre events.
 * Performs user privilege check, wraps DB mutations in a transaction,
 * writes tyre_events row, updates tyre state, and writes the audit log.
 *
 * @param {object} user - User triggering the event
 * @param {string} eventType - The action code ('nsd_reading', 'rotation', 'replacement', etc.)
 * @param {object} payload - Input arguments depending on eventType
 * @returns {Promise<Array<object>>} List of created event database rows
 */
function createTyreEvent(user, eventType, payload) {
  if (ELEVATED_EVENT_TYPES.includes(eventType) && ![ROLES.ADMIN, ROLES.DEPOT_MANAGER].includes(user.role)) {
    throw new ApiError(403, `${eventType} requires Depot Manager or Administrator`);
  }

  // Optional, MIS-importer-only fields (§10) -- present on payload only
  // when the Replay Engine is the caller; absent (undefined) for every
  // manual form submission, which is exactly what should end up in
  // tyre_events.source_mis_record_type/id for those.
  const { source_mis_record_type, source_mis_record_id } = payload;

  const runner = db.transaction(() =>
    sourceMisRecordContext.run(
      { source_mis_record_type: source_mis_record_type ?? null, source_mis_record_id: source_mis_record_id ?? null },
      async () => {
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
          default:
            throw new ApiError(400, `Unknown event_type: ${eventType}`);
        }
      }
    )
  );

  return runner();
}

async function createReadingEvent(user, eventType, { tyre_id, nsd_value, nsd_g1, nsd_g2, nsd_g3, nsd_g4, pressure_value, notes, event_date }) {
  const tyre = await getTyre(tyre_id);
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

  let event = await insertEventRow({
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
  await auditTyreEvent(user, event);

  // FR-AL-01/§8.1: evaluate the reading against its resolved threshold, store
  // the result on the event (flag_status), and let the alert engine react.
  const bus = await getBus(tyre.current_bus_id);
  const flagStatus = await applyReadingEvaluation({
    tyre,
    bus,
    parameterType: eventType === 'nsd_reading' ? 'NSD' : 'PRESSURE',
    value: eventType === 'nsd_reading' ? nsd : pressure,
    evaluate: eventType === 'nsd_reading' ? evaluateNsd : evaluatePressure,
    triggeringEventId: event.id,
  });
  event = await setEventFlagStatus(event.id, flagStatus);

  return [event];
}

async function createRotation(user, { tyre_id, to_position, reason, event_date, odometer_km, nsd_value }) {
  const tyre = await getTyre(tyre_id);
  if (!tyre.current_bus_id) throw new ApiError(400, 'Tyre must be mounted on a bus to rotate');
  if (!to_position) throw new ApiError(400, 'to_position is required');
  assertDepotScope(user, tyre.current_depot_id);

  const bus = await getBus(tyre.current_bus_id);
  const positions = await getBusModelPositions(bus.bus_model_id);
  if (!positions.includes(to_position)) {
    throw new ApiError(400, `to_position must be one of: ${positions.join(', ')}`);
  }
  if (to_position === tyre.current_position) {
    throw new ApiError(400, 'to_position is the same as the current position');
  }
  await assertPositionFree(bus.id, to_position, tyre.id);
  const nsd = normalizeOptionalNsd(nsd_value);

  const event = await insertEventRow({
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

  const { before, after } = await transitionTyreStatus(tyre.id, tyre.status, { current_position: to_position });
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  await maybeUpdateBusOdometer(bus.id, odometer_km);
  return [event];
}

// odometer_km is optional and currently only ever supplied by the MIS
// importer (Consumption sheet's "Fitment Kms" column, § replacement
// detection) -- the manual Log Event form has no field for it, so every
// existing caller keeps behaving exactly as before (undefined -> null,
// same as omitting it always did). Recorded on both event rows (mirroring
// every other create*() function's odometer_km handling) so
// reportService.js's Tyre Life Report can read it as a fitment-moment
// baseline the same way it already does for fitment_created.
async function createReplacement(user, { tyre_id, new_tyre_id, reason, odometer_km, event_date }) {
  const oldTyre = await getTyre(tyre_id);
  if (!oldTyre.current_bus_id) throw new ApiError(400, 'Tyre being replaced must be mounted on a bus');
  if (!new_tyre_id) throw new ApiError(400, 'new_tyre_id is required');

  const newTyre = await getTyre(new_tyre_id);
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
  const bus = await getBus(busId);

  const oldEvent = await insertEventRow({
    tyre_id: oldTyre.id,
    event_type: 'replacement',
    event_date: event_date || undefined,
    bus_id: busId,
    position,
    depot_id: depotId,
    from_position: position,
    related_tyre_id: newTyre.id,
    reason,
    odometer_km: odometer_km ?? null,
    performed_by: user.id,
  });
  const newEvent = await insertEventRow({
    tyre_id: newTyre.id,
    event_type: 'replacement',
    event_date: event_date || undefined,
    bus_id: busId,
    position,
    depot_id: depotId,
    to_position: position,
    related_tyre_id: oldTyre.id,
    reason,
    odometer_km: odometer_km ?? null,
    performed_by: user.id,
  });

  const oldResult = await transitionTyreStatus(oldTyre.id, 'In Store', { current_bus_id: null, current_position: null });
  const newResult = await transitionTyreStatus(newTyre.id, 'Active', { current_bus_id: busId, current_position: position, current_depot_id: depotId, current_package_id: bus.package_id });

  await auditTyreMutation(user, oldResult.before, oldResult.after);
  await auditTyreMutation(user, newResult.before, newResult.after);
  await auditTyreEvent(user, oldEvent);
  await auditTyreEvent(user, newEvent);
  await maybeUpdateBusOdometer(busId, odometer_km);
  return [oldEvent, newEvent];
}

// "Repair Completed" -- the second half of the repair workflow. Records
// what was actually done (repair_type/cost/notes) and returns the tyre to
// In Store (a status only ever answers "where is the tyre now"; the record
// of what happened lives here, in the timeline, not in the status value).
// A repaired tyre is very often remounted on a *different* bus than the one
// it came off, not necessarily the one from the matching send_to_repair --
// so bus_id/position here are an optional immediate remount, not an echo of
// from_bus_id. Left blank, the tyre lands In Store exactly as before, free
// to be fitted later via fitment_created same as any other stored tyre.
async function createPunctureRepair(user, { tyre_id, repair_type, notes, repair_cost, supervisor_name, tyre_man_name, patch_size, odometer_km, event_date, bus_id, position }) {
  const tyre = await getTyre(tyre_id);
  if (!['plug', 'patch', 'tube'].includes(repair_type)) {
    throw new ApiError(400, 'repair_type must be one of: plug, patch, tube');
  }
  assertDepotScope(user, tyre.current_depot_id);

  let remountBus = null;
  if (bus_id) {
    if (!position) throw new ApiError(400, 'position is required to remount onto a bus');
    remountBus = await getBus(bus_id);
    assertDepotScope(user, remountBus.depot_id);
    const positions = await getBusModelPositions(remountBus.bus_model_id);
    if (!positions.includes(position)) {
      throw new ApiError(400, `position must be one of: ${positions.join(', ')}`);
    }
    await assertPositionFree(remountBus.id, position, tyre.id);
  } else if (position) {
    throw new ApiError(400, 'bus_id is required to remount onto a bus');
  }

  const event = await insertEventRow({
    tyre_id: tyre.id,
    event_type: 'puncture_repair',
    event_date: event_date || undefined,
    bus_id: remountBus ? remountBus.id : tyre.current_bus_id,
    position: remountBus ? position : tyre.current_position,
    depot_id: remountBus ? remountBus.depot_id : tyre.current_depot_id,
    repair_type,
    repair_cost: repair_cost ?? null,
    supervisor_name,
    tyre_man_name,
    patch_size,
    odometer_km: odometer_km ?? null,
    notes,
    performed_by: user.id,
  });

  const { before, after } = remountBus
    ? await transitionTyreStatus(tyre.id, 'Active', {
        current_bus_id: remountBus.id,
        current_position: position,
        current_depot_id: remountBus.depot_id,
        current_package_id: remountBus.package_id,
      })
    : await transitionTyreStatus(tyre.id, 'In Store', { current_bus_id: null, current_position: null });
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  await maybeUpdateBusOdometer(remountBus ? remountBus.id : before.current_bus_id, odometer_km);
  return [event];
}

// "Send to Repair" -- the first half of the repair workflow. Pulls the tyre
// out of wherever it currently is (off the bus, if mounted) and marks it
// Under Repair; createPunctureRepair (fired later, once the mechanic is
// done) is what returns it to In Store.
async function createSendToRepair(user, { tyre_id, reason, odometer_km, nsd_value, event_date }) {
  const tyre = await getTyre(tyre_id);
  assertDepotScope(user, tyre.current_depot_id);
  const nsd = normalizeOptionalNsd(nsd_value);

  const event = await insertEventRow({
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

  const { before, after } = await transitionTyreStatus(tyre.id, 'Under Repair', { current_bus_id: null, current_position: null });
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  await maybeUpdateBusOdometer(before.current_bus_id, odometer_km);
  return [event];
}

async function createInterBusTransfer(user, { tyre_id, to_bus_id, to_position, reason, event_date }) {
  const tyre = await getTyre(tyre_id);
  if (!tyre.current_bus_id) throw new ApiError(400, 'Tyre must be mounted on a bus to transfer');
  if (!to_bus_id || !to_position) throw new ApiError(400, 'to_bus_id and to_position are required');

  const fromBus = await getBus(tyre.current_bus_id);
  const toBus = await getBus(to_bus_id);
  if (toBus.id === fromBus.id) throw new ApiError(400, 'to_bus_id must be a different bus');

  const isCrossDepot = fromBus.depot_id !== toBus.depot_id;
  if (isCrossDepot && user.role !== ROLES.ADMIN) {
    throw new ApiError(403, 'Cross-depot transfers require Administrator');
  }
  if (!isCrossDepot) assertDepotScope(user, fromBus.depot_id);

  const positions = await getBusModelPositions(toBus.bus_model_id);
  if (!positions.includes(to_position)) {
    throw new ApiError(400, `to_position must be one of: ${positions.join(', ')}`);
  }
  await assertPositionFree(toBus.id, to_position, tyre.id);

  const event = await insertEventRow({
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

  const { before, after } = await transitionTyreStatus(tyre.id, tyre.status, {
    current_bus_id: toBus.id, current_position: to_position, current_depot_id: toBus.depot_id, current_package_id: toBus.package_id,
  });
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  return [event];
}

async function createSendToStore(user, { tyre_id, reason, nsd_value, stored_at, odometer_km, event_date }) {
  const tyre = await getTyre(tyre_id);
  if (!reason) throw new ApiError(400, 'reason is required');
  if (!stored_at) throw new ApiError(400, 'stored_at is required');
  const nsdResult = validateNsd(nsd_value);
  if (!nsdResult.valid) throw new ApiError(400, nsdResult.error);
  assertDepotScope(user, tyre.current_depot_id);

  const event = await insertEventRow({
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

  const { before, after } = await transitionTyreStatus(tyre.id, 'In Store', { current_bus_id: null, current_position: null });
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  await maybeUpdateBusOdometer(before.current_bus_id, odometer_km);
  return [event];
}

// "Scrap" in the UI (event_type stays 'condemnation' -- see AMENDABLE_FIELDS
// above). Absorbed the old separate 'scrap' event type's paperwork fields
// (scrap_value, vendor_name, gate_pass_no, ...): the two were the same class
// of terminal write-off with no meaningful distinction once condemnation
// carries the same optional fields, so there's no reason to keep them apart.
// nsd_value is optional (not every write-off has a fresh reading on hand --
// the MIS "Scraped Tyre Details" sheet's Minimum NSD column is often blank).
async function createCondemnation(user, { tyre_id, reason, nsd_value, odometer_km, scrap_value, vendor_name, vendor_location, gate_pass_no, invoice_no, invoice_date, approved_by, store_manager, event_date }) {
  const tyre = await getTyre(tyre_id);
  if (!reason) throw new ApiError(400, 'reason is required');
  const nsd = normalizeOptionalNsd(nsd_value);
  assertDepotScope(user, tyre.current_depot_id);

  const event = await insertEventRow({
    tyre_id: tyre.id,
    event_type: 'condemnation',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    from_bus_id: tyre.current_bus_id,
    from_position: tyre.current_position,
    nsd_value: nsd,
    odometer_km: odometer_km ?? null,
    scrap_value: scrap_value ?? null,
    vendor_name,
    vendor_location,
    gate_pass_no,
    invoice_no,
    invoice_date,
    approved_by,
    store_manager,
    reason,
    performed_by: user.id,
  });

  const { before, after } = await transitionTyreStatus(tyre.id, 'Scrapped', { current_bus_id: null, current_position: null });
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  await maybeUpdateBusOdometer(before.current_bus_id, odometer_km);
  return [event];
}

// Fired by routes/tyres.js right after a new tyre row is inserted, so tyre
// creation is never silent -- the tyre's own current_bus_id/position/depot
// (whatever the create request set) are copied onto this event as-is; it
// does not itself change status, since the tyre row's initial status was
// already decided by the create request.
async function createPurchaseIntake(user, { tyre_id, notes, vendor_name, gate_pass_no, invoice_no, invoice_date, event_date }) {
  const tyre = await getTyre(tyre_id);
  const event = await insertEventRow({
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
  await auditTyreEvent(user, event);
  return [event];
}

// Mounts a tyre from In Store onto a bus position, taking it straight to
// Active (mounted and running) -- there's no separate transitional "just
// mounted, not yet running" status in the simplified model.
async function createFitmentCreated(user, { tyre_id, bus_id, position, reason, odometer_km, event_date }) {
  const tyre = await getTyre(tyre_id);
  if (tyre.current_bus_id) throw new ApiError(400, 'Tyre is already mounted on a bus');
  if (!bus_id || !position) throw new ApiError(400, 'bus_id and position are required');

  const bus = await getBus(bus_id);
  assertDepotScope(user, bus.depot_id);
  const positions = await getBusModelPositions(bus.bus_model_id);
  if (!positions.includes(position)) {
    throw new ApiError(400, `position must be one of: ${positions.join(', ')}`);
  }
  await assertPositionFree(bus.id, position, tyre.id);

  const event = await insertEventRow({
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

  const { before, after } = await transitionTyreStatus(tyre.id, 'Active', {
    current_bus_id: bus.id,
    current_position: position,
    current_depot_id: bus.depot_id,
    current_package_id: bus.package_id,
  });
  await maybeUpdateBusOdometer(bus.id, odometer_km);
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  return [event];
}

// Retained for historical rows and API compatibility, but no longer moves
// the tyre anywhere meaningful -- the simplified model has only one
// "not yet fitted" status (In Store), so there's nothing left to reserve
// between. Always resolves to In Store.
async function createReservation(user, { tyre_id, reason, event_date }) {
  const tyre = await getTyre(tyre_id);
  assertDepotScope(user, tyre.current_depot_id);

  const event = await insertEventRow({
    tyre_id: tyre.id,
    event_type: 'reservation',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    reason,
    performed_by: user.id,
  });

  const { before, after } = await transitionTyreStatus(tyre.id, 'In Store', {});
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  return [event];
}

// Explicit inspection sign-off, distinct from a raw NSD/pressure reading.
// Counts as a "reading-equivalent" for inspectionService's due/overdue
// clock (see the LAST_READING_SUBQUERY update there). Doesn't change the
// tyre's status -- an inspection is just a timeline entry, not a move.
async function createInspectionCompleted(user, { tyre_id, notes, event_date }) {
  const tyre = await getTyre(tyre_id);
  if (!tyre.current_bus_id) throw new ApiError(400, 'Tyre must be mounted on a bus to complete an inspection');
  assertDepotScope(user, tyre.current_depot_id);

  const event = await insertEventRow({
    tyre_id: tyre.id,
    event_type: 'inspection_completed',
    event_date: event_date || undefined,
    bus_id: tyre.current_bus_id,
    position: tyre.current_position,
    depot_id: tyre.current_depot_id,
    notes,
    performed_by: user.id,
  });

  const { before, after } = await transitionTyreStatus(tyre.id, 'Active', {});
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  return [event];
}

// Dispatches a removed/stored tyre to a retread vendor. vendor_name is a
// free-text field (no Vendor master-data entity in this phase).
async function createRetreadSent(user, { tyre_id, vendor_name, vendor_location, gate_pass_no, reason, odometer_km, retread_purpose, event_date }) {
  const tyre = await getTyre(tyre_id);
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

  const event = await insertEventRow({
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

  const { before, after } = await transitionTyreStatus(tyre.id, 'Under Retread', { current_bus_id: null, current_position: null });
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  await maybeUpdateBusOdometer(before.current_bus_id, odometer_km);
  return [event];
}

// Records the retread vendor's invoice/return and puts the tyre back In
// Store (ready to be re-fitted via fitment_created, same as any other
// stored tyre).
async function createRetreadCompleted(user, { tyre_id, vendor_name, vendor_location, invoice_no, invoice_date, retread_cost, notes, outcome, reason, event_date }) {
  const tyre = await getTyre(tyre_id);
  assertDepotScope(user, tyre.current_depot_id);
  if (outcome && !EVENT_OUTCOMES.retread_completed.includes(outcome)) {
    throw new ApiError(400, `outcome must be one of: ${EVENT_OUTCOMES.retread_completed.join(', ')}`);
  }

  const event = await insertEventRow({
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

  const { before, after } = await transitionTyreStatus(tyre.id, 'In Store', {});
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  return [event];
}

// Fired up to three times per claim, each its own timeline entry, with the
// tyre staying at status 'Warranty' throughout submission and decision --
// only the final "closed" call moves it back In Store, since a warranty
// review doesn't change where the tyre physically is until it's resolved:
//   1. Submit   (no outcome)          -> Warranty
//   2. Decide   (outcome: approved/rejected) -> stays Warranty
//   3. Close    (outcome: closed)     -> In Store
async function createWarrantyClaim(user, { tyre_id, outcome, reason, notes, vendor_name, gate_pass_no, invoice_no, invoice_date, approved_by, vendor_location, nsd_value, event_date }) {
  const tyre = await getTyre(tyre_id);
  assertDepotScope(user, tyre.current_depot_id);

  if (outcome && !EVENT_OUTCOMES.warranty_claim.includes(outcome)) {
    throw new ApiError(400, `outcome must be one of: ${EVENT_OUTCOMES.warranty_claim.join(', ')}`);
  }
  if (!outcome && !reason) throw new ApiError(400, 'reason is required to submit a warranty claim');
  const nsd = normalizeOptionalNsd(nsd_value);

  const event = await insertEventRow({
    tyre_id: tyre.id,
    event_type: 'warranty_claim',
    event_date: event_date || undefined,
    depot_id: tyre.current_depot_id,
    outcome: outcome || null,
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
  const { before, after } = await transitionTyreStatus(tyre.id, targetStatus, {});
  await auditTyreMutation(user, before, after);
  await auditTyreEvent(user, event);
  return [event];
}

module.exports = { createTyreEvent, ApiError, AMENDABLE_FIELDS };
