/**
 * @file bulkImport.js
 * @description CSV Bulk Import: per-row create logic for depots, buses, and
 * tyres. Deliberately reuses the exact same validation/normalization helpers
 * as the single-record POST routes (routes/depots.js, routes/buses.js,
 * routes/tyres.js) so a CSV row and a manually-submitted form are held to
 * identical rules -- no duplicated business logic to drift out of sync.
 */

const db = require('../db');
const { PG_ERRORS } = db;
const { writeAuditLog } = require('./auditLog');
const { isDepotScoped } = require('./roles');
const busesRouter = require('../routes/buses');
const tyresRouter = require('../routes/tyres');
const { createTyreEvent } = require('./tyreEvents');
const { ALL_STATUSES: TYRE_STATUSES } = require('./tyreLifecycle');

const { normalizeCode, validateYearOfManufacture, validateDateOfEntry } = busesRouter;
const { validatePosition } = tyresRouter;

// Mirrors the CHECK constraint on buses.status in db.js -- routes/buses.js
// doesn't export a reusable constant for it the way tyreLifecycle.js does
// for tyre status.
const BUS_STATUSES = ['Active', 'Under Maintenance', 'Decommissioned'];

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

// Resolves a CSV cell that may be either the raw numeric primary key or a
// human-readable name/code -- the manual Add Bus/Add Tyre forms only ever
// expose these relations as name-based dropdowns (bus model, depot, package,
// bus registration number), so a hand-authored CSV shouldn't have to know
// internal IDs the UI never surfaces either. Returns null if neither form
// resolves to an existing row.
async function resolveRef(value, table, lookupColumns) {
  const asNumber = toNumberOrNull(value);
  if (asNumber !== null) return asNumber;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  for (const col of lookupColumns) {
    // LOWER(col) = LOWER(?) is Postgres's equivalent of SQLite's
    // `= ? COLLATE NOCASE` (a built-in SQLite collation Postgres doesn't have).
    const found = await db.prepare(`SELECT id FROM ${table} WHERE LOWER(${col}) = LOWER(?)`).get(trimmed);
    if (found) return found.id;
  }
  return null;
}

// Each importer takes (user, row) where row is a plain object keyed by
// lowercase/underscored CSV header names, and returns either { created } or
// { error }. Errors are returned rather than thrown so one bad row doesn't
// abort the rest of the file -- callers collect them per-row.

async function importDepotRow(user, row) {
  const name = (row.name || '').trim();
  const code = (row.code || '').trim();
  if (!name || !code) return { error: 'name and code are required' };

  try {
    const info = await db
      .prepare('INSERT INTO depots (name, code, region, address) VALUES (?, ?, ?, ?)')
      .run(name, code, row.region?.trim() || null, row.address?.trim() || null);
    const created = await db.prepare('SELECT * FROM depots WHERE id = ?').get(info.lastInsertRowid);
    await writeAuditLog({ user, action: 'CREATE', entityType: 'depot', entityId: created.id, after: created });
    return { created };
  } catch (err) {
    if (err.code === PG_ERRORS.UNIQUE_VIOLATION) return { error: 'Depot code already exists' };
    throw err;
  }
}

async function importBusRow(user, row) {
  const registration_no = normalizeCode(row.registration_no || '');
  const chassis_no = normalizeCode(row.chassis_no || '');
  const year_of_manufacture = row.year_of_manufacture;
  const date_of_entry_into_fleet = row.date_of_entry_into_fleet;
  const status = row.status || 'Active';

  if (!registration_no || !chassis_no || !row.bus_model_id || !row.depot_id) {
    return { error: 'registration_no, chassis_no, bus_model_id and depot_id are required' };
  }

  const yearError = validateYearOfManufacture(year_of_manufacture);
  if (yearError) return { error: yearError };
  const dateError = validateDateOfEntry(date_of_entry_into_fleet);
  if (dateError) return { error: dateError };
  if (!BUS_STATUSES.includes(status)) {
    return { error: `status must be one of: ${BUS_STATUSES.join(', ')}` };
  }

  const bus_model_id = await resolveRef(row.bus_model_id, 'bus_models', ['name']);
  if (!bus_model_id) return { error: 'bus_model_id does not reference a valid bus model (by ID or name)' };

  const depot_id = await resolveRef(row.depot_id, 'depots', ['name', 'code']);
  if (!depot_id) return { error: 'depot_id does not reference a valid depot (by ID, name, or code)' };

  // package_id has no equivalent required-ness in the manual Add Bus form
  // either -- "No package" is a valid selection there -- so an absent/empty
  // CSV cell resolves to NULL rather than an error.
  let package_id = null;
  if (row.package_id) {
    package_id = await resolveRef(row.package_id, 'packages', ['name', 'code']);
    if (!package_id) return { error: 'package_id does not reference a valid package (by ID, name, or code)' };
  }

  if (isDepotScoped(user) && depot_id !== user.depot_id) {
    return { error: 'Not authorized to create a bus in this depot' };
  }

  const depot = await db.prepare('SELECT is_active FROM depots WHERE id = ?').get(depot_id);
  if (!depot.is_active) return { error: 'This depot is deactivated and cannot accept new buses' };

  try {
    const info = await db
      .prepare(`
        INSERT INTO buses (depot_id, package_id, registration_no, chassis_no, bus_model_id, year_of_manufacture, date_of_entry_into_fleet, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(depot_id, package_id, registration_no, chassis_no, bus_model_id, year_of_manufacture, date_of_entry_into_fleet, status);
    const created = await db.prepare('SELECT * FROM buses WHERE id = ?').get(info.lastInsertRowid);
    await writeAuditLog({ user, action: 'CREATE', entityType: 'bus', entityId: created.id, after: created });
    return { created };
  } catch (err) {
    if (err.code === PG_ERRORS.UNIQUE_VIOLATION) {
      return { error: 'A bus with this registration number or chassis number already exists' };
    }
    throw err;
  }
}

async function importTyreRow(user, row) {
  const tyre_number = (row.tyre_number || '').trim();
  const brand = (row.brand || '').trim();
  if (!tyre_number || !brand) return { error: 'tyre_number and brand are required' };

  const status = row.status || 'In Store';
  if (!TYRE_STATUSES.includes(status)) {
    return { error: `status must be one of: ${TYRE_STATUSES.join(', ')}` };
  }

  const purchase_date = (row.purchase_date || '').trim() || null;
  if (purchase_date && isNaN(Date.parse(purchase_date))) {
    return { error: 'purchase_date must be a valid date' };
  }
  const invoice_date = (row.invoice_date || '').trim() || null;
  if (invoice_date && isNaN(Date.parse(invoice_date))) {
    return { error: 'invoice_date must be a valid date' };
  }

  // current_bus_id may be given either as the raw numeric ID or, matching
  // the manual Add Tyre form's registration-number dropdown, the bus's
  // registration number.
  let current_bus_id = null;
  if (row.current_bus_id) {
    current_bus_id = await resolveRef(row.current_bus_id, 'buses', ['registration_no']);
    if (!current_bus_id) return { error: 'current_bus_id does not reference a valid bus (by ID or registration number)' };
  }
  const current_position = row.current_position || null;

  const posResult = await validatePosition({ current_bus_id, current_position });
  if (posResult?.error) return { error: posResult.error };

  let resolvedDepotId = posResult?.depotId ?? null;
  if (!resolvedDepotId && row.current_depot_id) {
    resolvedDepotId = await resolveRef(row.current_depot_id, 'depots', ['name', 'code']);
    if (!resolvedDepotId) return { error: 'current_depot_id does not reference a valid depot (by ID, name, or code)' };
  }

  if (isDepotScoped(user) && resolvedDepotId && resolvedDepotId !== user.depot_id) {
    return { error: 'Not authorized to create a tyre in this depot' };
  }

  try {
    // Wrapped in a transaction so the tyre row and its opening lifecycle
    // event (purchase_intake) are never created independently of each other,
    // mirroring routes/tyres.js's single-record POST -- a bulk-imported tyre
    // must not start with a blank Tyre Card timeline.
    const created = await db.transaction(async () => {
      const info = await db
        .prepare(`
          INSERT INTO tyres (tyre_number, brand, model, size, pattern, ply_rating, purchase_date, initial_nsd, purchase_cost, status, current_bus_id, current_position, current_depot_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          tyre_number,
          brand,
          row.model?.trim() || null,
          row.size?.trim() || null,
          row.pattern?.trim() || null,
          row.ply_rating?.trim() || null,
          purchase_date,
          toNumberOrNull(row.initial_nsd),
          toNumberOrNull(row.purchase_cost),
          status,
          current_bus_id,
          current_position,
          resolvedDepotId
        );
      const tyreRow = await db.prepare('SELECT * FROM tyres WHERE id = ?').get(info.lastInsertRowid);
      await writeAuditLog({ user, action: 'CREATE', entityType: 'tyre', entityId: tyreRow.id, after: tyreRow });
      await createTyreEvent(user, 'purchase_intake', {
        tyre_id: tyreRow.id,
        notes: 'Tyre record created via CSV import',
        vendor_name: row.vendor_name?.trim() || null,
        gate_pass_no: row.gate_pass_no?.trim() || null,
        invoice_no: row.invoice_no?.trim() || null,
        invoice_date,
      });
      return tyreRow;
    })();
    return { created };
  } catch (err) {
    if (err.code === PG_ERRORS.UNIQUE_VIOLATION) return { error: 'A tyre with this tyre number already exists' };
    throw err;
  }
}

module.exports = { importDepotRow, importBusRow, importTyreRow };
