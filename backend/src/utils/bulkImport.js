/**
 * @file bulkImport.js
 * @description CSV Bulk Import: per-row create logic for depots, buses, and
 * tyres. Deliberately reuses the exact same validation/normalization helpers
 * as the single-record POST routes (routes/depots.js, routes/buses.js,
 * routes/tyres.js) so a CSV row and a manually-submitted form are held to
 * identical rules -- no duplicated business logic to drift out of sync.
 */

const db = require('../db');
const { writeAuditLog } = require('./auditLog');
const { isDepotScoped } = require('./roles');
const busesRouter = require('../routes/buses');
const tyresRouter = require('../routes/tyres');

const { normalizeCode, validateYearOfManufacture, validateDateOfEntry } = busesRouter;
const { validatePosition } = tyresRouter;

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

// Each importer takes (user, row) where row is a plain object keyed by
// lowercase/underscored CSV header names, and returns either { created } or
// { error }. Errors are returned rather than thrown so one bad row doesn't
// abort the rest of the file -- callers collect them per-row.

function importDepotRow(user, row) {
  const name = (row.name || '').trim();
  const code = (row.code || '').trim();
  if (!name || !code) return { error: 'name and code are required' };

  try {
    const info = db
      .prepare('INSERT INTO depots (name, code, region, address) VALUES (?, ?, ?, ?)')
      .run(name, code, row.region?.trim() || null, row.address?.trim() || null);
    const created = db.prepare('SELECT * FROM depots WHERE id = ?').get(info.lastInsertRowid);
    writeAuditLog({ user, action: 'CREATE', entityType: 'depot', entityId: created.id, after: created });
    return { created };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return { error: 'Depot code already exists' };
    throw err;
  }
}

function importBusRow(user, row) {
  const registration_no = normalizeCode(row.registration_no || '');
  const chassis_no = normalizeCode(row.chassis_no || '');
  const bus_model_id = toNumberOrNull(row.bus_model_id);
  const depot_id = toNumberOrNull(row.depot_id);
  const year_of_manufacture = row.year_of_manufacture;
  const date_of_entry_into_fleet = row.date_of_entry_into_fleet;
  const status = row.status || 'Active';

  if (!registration_no || !chassis_no || !bus_model_id || !depot_id) {
    return { error: 'registration_no, chassis_no, bus_model_id and depot_id are required' };
  }

  const yearError = validateYearOfManufacture(year_of_manufacture);
  if (yearError) return { error: yearError };
  const dateError = validateDateOfEntry(date_of_entry_into_fleet);
  if (dateError) return { error: dateError };

  if (isDepotScoped(user) && depot_id !== user.depot_id) {
    return { error: 'Not authorized to create a bus in this depot' };
  }

  const model = db.prepare('SELECT id FROM bus_models WHERE id = ?').get(bus_model_id);
  if (!model) return { error: 'bus_model_id does not reference a valid bus model' };

  const depot = db.prepare('SELECT id, is_active FROM depots WHERE id = ?').get(depot_id);
  if (!depot) return { error: 'depot_id does not reference a valid depot' };
  if (!depot.is_active) return { error: 'This depot is deactivated and cannot accept new buses' };

  try {
    const info = db
      .prepare(`
        INSERT INTO buses (depot_id, registration_no, chassis_no, bus_model_id, year_of_manufacture, date_of_entry_into_fleet, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(depot_id, registration_no, chassis_no, bus_model_id, year_of_manufacture, date_of_entry_into_fleet, status);
    const created = db.prepare('SELECT * FROM buses WHERE id = ?').get(info.lastInsertRowid);
    writeAuditLog({ user, action: 'CREATE', entityType: 'bus', entityId: created.id, after: created });
    return { created };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { error: 'A bus with this registration number or chassis number already exists' };
    }
    throw err;
  }
}

function importTyreRow(user, row) {
  const tyre_number = (row.tyre_number || '').trim();
  const brand = (row.brand || '').trim();
  if (!tyre_number || !brand) return { error: 'tyre_number and brand are required' };

  const current_bus_id = toNumberOrNull(row.current_bus_id);
  const current_position = row.current_position || null;

  const posResult = validatePosition({ current_bus_id, current_position });
  if (posResult?.error) return { error: posResult.error };
  const resolvedDepotId = posResult?.depotId ?? toNumberOrNull(row.current_depot_id);

  if (isDepotScoped(user) && resolvedDepotId && resolvedDepotId !== user.depot_id) {
    return { error: 'Not authorized to create a tyre in this depot' };
  }

  try {
    const info = db
      .prepare(`
        INSERT INTO tyres (tyre_number, brand, model, size, purchase_date, initial_nsd, status, current_bus_id, current_position, current_depot_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        tyre_number,
        brand,
        row.model?.trim() || null,
        row.size?.trim() || null,
        row.purchase_date || null,
        toNumberOrNull(row.initial_nsd),
        row.status || 'In Store',
        current_bus_id,
        current_position,
        resolvedDepotId
      );
    const created = db.prepare('SELECT * FROM tyres WHERE id = ?').get(info.lastInsertRowid);
    writeAuditLog({ user, action: 'CREATE', entityType: 'tyre', entityId: created.id, after: created });
    return { created };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return { error: 'A tyre with this tyre number already exists' };
    throw err;
  }
}

module.exports = { importDepotRow, importBusRow, importTyreRow };
