/**
 * @file misRecordRepository.js
 * @description Generic persistence for MIS records (§2: "MIS Record
 * Repositories -- one dedicated table per sheet type, immutable once
 * written"). One INSERT-column spec per sheet type drives a single generic
 * insert function, rather than a bespoke repository module per table --
 * the tables differ in which columns they have, not in how a row gets
 * written to one.
 */

const db = require('../db');
const { getPositionLayout } = require('../utils/busLayout');

// linkage_status is deliberately never in these column lists -- every table
// starts it at its column DEFAULT ('pending') and updateLinkageStatus() sets
// it for real once the row's event intents have actually been attempted
// (see replayEngine.js).
const MIS_TABLE_SPECS = {
  puncture_repair: {
    table: 'mis_puncture_records',
    columns: [
      'import_session_id', 'source_sheet', 'source_row',
      'depot_id', 'declared_date', 'make', 'tyre_id', 'tyre_number_raw', 'nsd',
      'repaired_date', 'patch_size', 'supervisor_name', 'tyre_man_name', 'remarks',
      'raw_row_json', 'fingerprint', 'schema_version', 'event_generator_version',
    ],
  },
  scrap: {
    table: 'mis_scrap_records',
    columns: [
      'import_session_id', 'source_sheet', 'source_row',
      'package_id', 'depot_id', 'scrap_declared_date', 'tyre_id', 'tyre_number_raw',
      'make', 'tyre_kind', 'last_removal_date', 'min_nsd',
      'tyre_life_before_retread_km', 'tyre_life_after_retread_km', 'total_tyre_life_km',
      'scrap_cause', 'remarks', 'gate_pass_no', 'gate_pass_date', 'vendor_name',
      'approved_by', 'store_manager', 'vendor_address',
      'raw_row_json', 'fingerprint', 'schema_version', 'event_generator_version',
    ],
  },
  warranty: {
    table: 'mis_warranty_records',
    columns: [
      'import_session_id', 'source_sheet', 'source_row',
      'package_id', 'depot_id', 'warranty_declared_date', 'tyre_id', 'tyre_number_raw',
      'make', 'tyre_kind', 'last_removal_date', 'min_nsd',
      'tyre_life_before_retread_km', 'tyre_life_after_retread_km', 'total_tyre_life_km',
      'warranty_cause', 'remarks', 'warranty_claim_status', 'claim_status_date',
      'gate_pass_no', 'gate_pass_date', 'vendor_name', 'approved_by', 'store_manager', 'vendor_address',
      'raw_row_json', 'fingerprint', 'schema_version', 'event_generator_version',
    ],
  },
  retread: {
    table: 'mis_retread_records',
    columns: [
      'import_session_id', 'source_sheet', 'source_row',
      'package_id', 'depot_id', 'removal_date', 'tyre_id', 'tyre_number_raw', 'make',
      'nsd_at_removal', 'tyre_life_before_retread_km', 'retread_purpose', 'dispatch_date',
      'gate_pass_no', 'vendor_name', 'vendor_location', 'invoice_no', 'invoice_date',
      'retread_status', 'rejected_reason',
      'raw_row_json', 'fingerprint', 'schema_version', 'event_generator_version',
    ],
  },
  nsd: {
    table: 'mis_nsd_records',
    columns: [
      'import_session_id', 'source_sheet', 'source_row',
      'depot_id', 'tyre_kind', 'bus_id', 'bus_number_raw', 'tyre_dimension', 'pr_li_si',
      'make', 'pattern', 'position', 'tyre_id', 'tyre_number_raw', 'inspection_date',
      'pressure_psi', 'nsd_g1', 'nsd_g2', 'nsd_g3', 'nsd_g4', 'vehicle_status', 'tyre_fitting_condition',
      'raw_row_json', 'fingerprint', 'schema_version', 'event_generator_version',
    ],
  },
  rotation: {
    table: 'mis_rotation_records',
    columns: [
      'import_session_id', 'source_sheet', 'source_row',
      'package_id', 'depot_id', 'bus_id', 'bus_number_raw', 'current_km', 'km_at_rotation',
      'due_date', 'rotation_date', 'from_position', 'tyre_id', 'tyre_number_raw', 'nsd',
      'to_position', 'status', 'remarks',
      'raw_row_json', 'fingerprint', 'schema_version', 'event_generator_version',
    ],
  },
  wheel_alignment: {
    table: 'mis_wheel_alignment_records',
    columns: [
      'import_session_id', 'source_sheet', 'source_row',
      'depot_id', 'bus_id', 'bus_number_raw', 'current_km', 'km_at_alignment', 'due_date', 'alignment_date',
      'toe_fr_before', 'toe_fr_after', 'caster_fr_before', 'caster_fr_after',
      'camber_fr_before', 'camber_fr_after', 'sai_fr_before', 'sai_fr_after',
      'toe_fl_before', 'toe_fl_after', 'caster_fl_before', 'caster_fl_after',
      'camber_fl_before', 'camber_fl_after', 'sai_fl_before', 'sai_fl_after',
      'status', 'remarks',
      'raw_row_json', 'fingerprint', 'schema_version', 'event_generator_version',
    ],
  },
  consumption: {
    table: 'mis_consumption_records',
    columns: [
      'import_session_id', 'source_sheet', 'source_row',
      'depot_id', 'invoice_no', 'invoice_date', 'received_date', 'make', 'tyre_kind', 'nsd',
      'consumption_status', 'tyre_id', 'tyre_number_raw', 'bus_id', 'bus_number_raw', 'position',
      'fitment_date', 'fitment_km', 'removed_tyre_id', 'removed_tyre_number_raw',
      'removed_tyre_min_nsd', 'removal_reason',
      'raw_row_json', 'fingerprint', 'schema_version', 'event_generator_version',
    ],
  },
};

function specFor(sheetType) {
  const spec = MIS_TABLE_SPECS[sheetType];
  if (!spec) throw new Error(`No MIS table spec registered for sheetType "${sheetType}"`);
  return spec;
}

async function insertMisRecord(sheetType, fields) {
  const spec = specFor(sheetType);
  const values = spec.columns.map((col) => {
    if (col === 'raw_row_json') return JSON.stringify(fields.rawRowJson ?? null);
    // The parser's NormalizedRow keeps these two as camelCase (sourceSheet/
    // sourceRow) since every other bookkeeping field it carries is likewise
    // JS-conventional; only these two happen to also be real DB columns.
    if (col === 'source_sheet') return fields.sourceSheet ?? null;
    if (col === 'source_row') return fields.sourceRow ?? null;
    return fields[col] ?? null;
  });
  const placeholders = spec.columns.map(() => '?').join(', ');
  const info = await db
    .prepare(`INSERT INTO ${spec.table} (${spec.columns.join(', ')}) VALUES (${placeholders})`)
    .run(...values);
  return db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(info.lastInsertRowid);
}

async function updateLinkageStatus(sheetType, misRecordId, linkageStatus) {
  const spec = specFor(sheetType);
  await db.prepare(`UPDATE ${spec.table} SET linkage_status = ? WHERE id = ?`).run(linkageStatus, misRecordId);
}

// target is { tyreEventId } for the normal createTyreEvent() path, or
// { wheelAlignmentId } for the wheel-alignment path (§10: a different
// lifecycle-writing service, not tyre_events).
async function recordGeneratedEvent(sheetType, misRecordId, eventType, target) {
  await db
    .prepare('INSERT INTO mis_generated_events (mis_record_type, mis_record_id, event_type, tyre_event_id, wheel_alignment_id) VALUES (?, ?, ?, ?, ?)')
    .run(sheetType, misRecordId, eventType, target.tyreEventId ?? null, target.wheelAlignmentId ?? null);
}

async function insertTyre(fields) {
  const info = await db
    .prepare(`
      INSERT INTO tyres (tyre_number, brand, status, current_depot_id, purchase_date)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(fields.tyre_number, fields.brand, fields.status || 'In Store', fields.current_depot_id ?? null, fields.purchase_date ?? null);
  return db.prepare('SELECT * FROM tyres WHERE id = ?').get(info.lastInsertRowid);
}

// Bus auto-provisioning (§ bus auto-provisioning): every sheet only ever
// carries a registration number for a bus, never a model/chassis -- but
// bus_models.bus_model_id and buses.chassis_no are both NOT NULL. Every
// auto-created bus shares one placeholder model rather than inventing a
// fresh, meaningless one per bus; num_positions=6 matches the fixed
// FL/FR/RLO/RLI/RRI/RRO layout most single-rear-axle buses actually
// have (the same layout createRotation()/createFitmentCreated() validate
// a to_position/position against), reusing utils/busLayout.js's own table
// rather than inventing a parallel one. It's a best-effort default, not a
// guarantee: a rotation/fitment row whose position text doesn't match this
// layout still fails Tier 2 validation and is reported as a linkage
// failure (the existing decoupled-outcome model, §1) -- exactly like any
// other row this importer can't fully resolve, never a crash.
const IMPORT_PLACEHOLDER_BUS_MODEL_NAME = 'Unknown (MIS Import)';
const IMPORT_PLACEHOLDER_BUS_MODEL_POSITIONS = 6;

// A caught error inside a Postgres transaction poisons it for every
// statement that follows until a ROLLBACK (or ROLLBACK TO SAVEPOINT)
// happens -- these two inserts always run nested inside processRowUnit's
// own transaction (replayEngine.js), so the risky INSERT itself has to go
// through db.transaction() (which issues a real SAVEPOINT + ROLLBACK TO
// SAVEPOINT on error when nested, db.js's transaction()) before the
// fallback SELECT below can safely run in the same catch block. Plain
// insertTyre()/insertMisRecord() elsewhere in this file don't need this
// because nothing after them in the same row ever catches their errors --
// the two find-or-create functions here are the exception.
const insertBusModelRow = db.transaction(async (positions) => {
  const info = await db
    .prepare('INSERT INTO bus_models (name, manufacturer, num_positions, position_labels_json) VALUES (?, ?, ?, ?)')
    .run(IMPORT_PLACEHOLDER_BUS_MODEL_NAME, null, positions.length, JSON.stringify(positions));
  return info.lastInsertRowid;
});

const insertBusRow = db.transaction(async (depot_id, package_id, registration_no, chassis_no, bus_model_id) => {
  const info = await db
    .prepare(`
      INSERT INTO buses (depot_id, package_id, registration_no, chassis_no, bus_model_id, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(depot_id, package_id, registration_no, chassis_no, bus_model_id, 'Active');
  return db.prepare('SELECT * FROM buses WHERE id = ?').get(info.lastInsertRowid);
});

// Find-or-create. The UNIQUE constraint on bus_models.name is the real
// guard against two rows racing to create this shared placeholder for the
// first time (replay() itself never runs two chunks concurrently within
// one import, per replayEngine.js -- this only matters across two
// different imports' Confirm jobs landing at the same moment) -- a 23505
// here just means another chunk/job already won, so re-select and reuse it.
async function ensureImportPlaceholderBusModel() {
  const existing = await db.prepare('SELECT id FROM bus_models WHERE name = ?').get(IMPORT_PLACEHOLDER_BUS_MODEL_NAME);
  if (existing) return existing.id;

  try {
    return await insertBusModelRow(getPositionLayout(IMPORT_PLACEHOLDER_BUS_MODEL_POSITIONS));
  } catch (err) {
    if (err.code === db.PG_ERRORS.UNIQUE_VIOLATION) {
      const row = await db.prepare('SELECT id FROM bus_models WHERE name = ?').get(IMPORT_PLACEHOLDER_BUS_MODEL_NAME);
      if (row) return row.id;
    }
    throw err;
  }
}

// A bus a row references that doesn't exist yet. chassis_no is synthesized
// deterministically from registration_no (never random) purely to satisfy
// the NOT NULL UNIQUE column no sheet has any real data for -- it plays no
// other role. registration_no is normalized the same way the Bus Master
// UI does (routes/buses.js's normalizeCode) so an auto-created bus can
// never end up as a case-duplicate of one entered manually later.
async function insertBus({ registration_no, depot_id, package_id }) {
  const busModelId = await ensureImportPlaceholderBusModel();
  const normalizedRegistration = String(registration_no).trim().toUpperCase();
  const chassisNo = `MIS-IMPORT-${normalizedRegistration}`;
  try {
    return await insertBusRow(depot_id, package_id ?? null, normalizedRegistration, chassisNo, busModelId);
  } catch (err) {
    if (err.code === db.PG_ERRORS.UNIQUE_VIOLATION) {
      const existing = await db.prepare('SELECT * FROM buses WHERE registration_no = ?').get(normalizedRegistration);
      if (existing) return existing;
    }
    throw err;
  }
}

// Depot auto-provisioning (§ depot auto-provisioning, mirrors bus
// auto-provisioning above): a row's depot text that doesn't match any
// existing depot gets one created here rather than being left unresolved.
// depots.code is NOT NULL UNIQUE with no source-sheet equivalent to draw
// from (every sheet only ever names a depot, never a code) -- synthesized
// deterministically from the name, with a numeric suffix appended only if
// that collides (e.g. two differently-cased/punctuated depot names that
// both reduce to the same alnum code).
async function insertDepot({ name }) {
  const trimmedName = String(name).trim();
  const baseCode = trimmedName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16) || 'DEPOT';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = attempt === 0 ? baseCode : `${baseCode}${attempt + 1}`;
    try {
      const info = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?)').run(trimmedName, code);
      return db.prepare('SELECT * FROM depots WHERE id = ?').get(info.lastInsertRowid);
    } catch (err) {
      if (err.code === db.PG_ERRORS.UNIQUE_VIOLATION) {
        const existing = await db.prepare('SELECT * FROM depots WHERE name = ?').get(trimmedName);
        if (existing) return existing;
        continue; // code collision (not a name match) -- retry with the next suffix
      }
      throw err;
    }
  }
  throw new Error(`Could not generate a unique depot code for "${name}" after 20 attempts`);
}

module.exports = { MIS_TABLE_SPECS, insertMisRecord, updateLinkageStatus, recordGeneratedEvent, insertTyre, insertBus, insertDepot };
