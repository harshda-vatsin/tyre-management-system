'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedTestDb } = require('../test-support/testDb');

// db/importDepotRow/etc. are populated inside test.before(), after
// DATABASE_URL has been pointed at this file's own isolated database (see
// helpers/testDb.js) -- this file no longer shares a database with any
// other test file, so its beforeEach reset (below) only ever has to worry
// about this file's own sibling tests reusing the same fixture names, not
// about another file's tests running at the same time against the same
// tables.
let db, importDepotRow, importBusRow, importTyreRow, ROLES;
let dropTestDb;

async function resetDb() {
  // Deletion order matters under foreign_keys = ON: audit_log/tyre_events
  // reference users, buses/tyres reference depots+bus_models+packages, and
  // users.depot_id itself references depots -- so users must go before
  // depots, not after, or the depots delete fails on a dangling reference.
  await db.exec(`
    DELETE FROM audit_log;
    DELETE FROM tyre_events;
    DELETE FROM tyres;
    DELETE FROM buses;
    DELETE FROM users;
    DELETE FROM bus_models;
    DELETE FROM packages;
    DELETE FROM depots;
  `);
}

// audit_log.user_id and tyre_events.performed_by both have a FK to users(id)
// (foreign_keys = ON, same as production), so every user acting through an
// importer here needs a real row -- a plain in-memory { id, role } object
// would fail those inserts with a foreign-key violation.
let userCounter = 0;
async function seedUser(overrides = {}) {
  userCounter += 1;
  const role = overrides.role || ROLES.ADMIN;
  const depot_id = overrides.depot_id ?? null;
  const info = await db
    .prepare('INSERT INTO users (username, email, password_hash, full_name, role, depot_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`test_user_${userCounter}`, `test_user_${userCounter}@example.com`, 'x', 'Test User', role, depot_id);
  return { id: info.lastInsertRowid, role, depot_id };
}

function adminUser() {
  return seedUser({ role: ROLES.ADMIN });
}

async function seedDepot(overrides = {}) {
  const info = await db
    .prepare('INSERT INTO depots (name, code, region, address) VALUES (?, ?, ?, ?)')
    .run(overrides.name || 'Delhi Central Depot', overrides.code || 'DEL-C', null, null);
  return info.lastInsertRowid;
}

async function seedBusModel(overrides = {}) {
  const labels = overrides.position_labels || ['FL', 'FR'];
  const info = await db
    .prepare('INSERT INTO bus_models (name, manufacturer, num_positions, position_labels_json) VALUES (?, ?, ?, ?)')
    .run(overrides.name || 'Tata Starbus EV', 'Tata', labels.length, JSON.stringify(labels));
  return info.lastInsertRowid;
}

async function seedPackage(overrides = {}) {
  const info = await db
    .prepare('INSERT INTO packages (name, code) VALUES (?, ?)')
    .run(overrides.name || 'Verify Package', overrides.code || 'VP-1');
  return info.lastInsertRowid;
}

async function seedBus({ depotId, modelId, packageId, registration_no = 'DL01AB1234' }) {
  const info = await db
    .prepare(`
      INSERT INTO buses (depot_id, package_id, registration_no, chassis_no, bus_model_id, year_of_manufacture, date_of_entry_into_fleet, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(depotId, packageId || null, registration_no, `VIN-${registration_no}`, modelId, 2023, '2023-01-01', 'Active');
  return info.lastInsertRowid;
}

test.before(async () => {
  ({ dropTestDb } = await createIsolatedTestDb('bulk_import'));

  db = require('../src/db');
  ({ importDepotRow, importBusRow, importTyreRow } = require('../src/utils/bulkImport'));
  ({ ROLES } = require('../src/utils/roles'));

  await db.ready;
});
test.beforeEach(() => resetDb());
test.after(async () => {
  await db.close();
  await dropTestDb();
});

// --- Depot import -----------------------------------------------------

test('importDepotRow: requires name and code', async () => {
  const result = await importDepotRow(await adminUser(), { name: '', code: '' });
  assert.equal(result.error, 'name and code are required');
});

test('importDepotRow: rejects duplicate code', async () => {
  await seedDepot({ code: 'DUPE' });
  const result = await importDepotRow(await adminUser(), { name: 'Another', code: 'DUPE' });
  assert.equal(result.error, 'Depot code already exists');
});

// --- Bus import ---------------------------------------------------------

test('importBusRow: required fields', async () => {
  const result = await importBusRow(await adminUser(), {});
  assert.equal(result.error, 'registration_no, chassis_no, bus_model_id and depot_id are required');
});

test('importBusRow: rejects an invalid status with a friendly message instead of a raw DB error', async () => {
  const depotId = await seedDepot();
  const modelId = await seedBusModel();
  const result = await importBusRow(await adminUser(), {
    registration_no: 'DL01ZZ0001',
    chassis_no: 'VIN0001',
    bus_model_id: String(modelId),
    depot_id: String(depotId),
    year_of_manufacture: '2023',
    date_of_entry_into_fleet: '2023-01-01',
    status: 'Retired',
  });
  assert.match(result.error, /status must be one of/);
});

test('importBusRow: resolves bus_model_id, depot_id, and package_id by name, not just numeric ID', async () => {
  const depotId = await seedDepot({ name: 'Mumbai West Depot', code: 'MUM-W' });
  const modelId = await seedBusModel({ name: 'Olectra K7' });
  const packageId = await seedPackage({ name: 'Route 42', code: 'R42' });

  const result = await importBusRow(await adminUser(), {
    registration_no: 'mh01ab1234',
    chassis_no: 'vin-mh01ab1234',
    bus_model_id: 'Olectra K7',
    depot_id: 'Mumbai West Depot',
    package_id: 'Route 42',
    year_of_manufacture: '2024',
    date_of_entry_into_fleet: '2024-01-01',
  });

  assert.ok(result.created, JSON.stringify(result));
  assert.equal(result.created.bus_model_id, modelId);
  assert.equal(result.created.depot_id, depotId);
  assert.equal(result.created.package_id, packageId);
  // normalizeCode uppercases/trims, matching the manual Add Bus form's behavior.
  assert.equal(result.created.registration_no, 'MH01AB1234');
});

test('importBusRow: package_id is optional and defaults to null (matches "No package" in the manual form)', async () => {
  const depotId = await seedDepot();
  const modelId = await seedBusModel();
  const result = await importBusRow(await adminUser(), {
    registration_no: 'DL01ZZ0002',
    chassis_no: 'VIN0002',
    bus_model_id: String(modelId),
    depot_id: String(depotId),
    year_of_manufacture: '2023',
    date_of_entry_into_fleet: '2023-01-01',
  });
  assert.ok(result.created, JSON.stringify(result));
  assert.equal(result.created.package_id, null);
});

test('importBusRow: an unresolvable bus_model_id name errors clearly instead of failing on the FK', async () => {
  const depotId = await seedDepot();
  const result = await importBusRow(await adminUser(), {
    registration_no: 'DL01ZZ0003',
    chassis_no: 'VIN0003',
    bus_model_id: 'Nonexistent Model',
    depot_id: String(depotId),
    year_of_manufacture: '2023',
    date_of_entry_into_fleet: '2023-01-01',
  });
  assert.match(result.error, /bus_model_id does not reference a valid bus model/);
});

test('importBusRow: rejects a bus for a deactivated depot', async () => {
  const depotId = await seedDepot();
  await db.prepare('UPDATE depots SET is_active = 0 WHERE id = ?').run(depotId);
  const modelId = await seedBusModel();
  const result = await importBusRow(await adminUser(), {
    registration_no: 'DL01ZZ0004',
    chassis_no: 'VIN0004',
    bus_model_id: String(modelId),
    depot_id: String(depotId),
    year_of_manufacture: '2023',
    date_of_entry_into_fleet: '2023-01-01',
  });
  assert.match(result.error, /deactivated/);
});

test('importBusRow: a depot-scoped user cannot import a bus into another depot', async () => {
  const depotId = await seedDepot({ name: 'Depot A', code: 'DA' });
  const otherDepotId = await seedDepot({ name: 'Depot B', code: 'DB' });
  const modelId = await seedBusModel();
  const dm = await seedUser({ role: ROLES.DEPOT_MANAGER, depot_id: otherDepotId });
  const result = await importBusRow(dm, {
    registration_no: 'DL01ZZ0005',
    chassis_no: 'VIN0005',
    bus_model_id: String(modelId),
    depot_id: String(depotId),
    year_of_manufacture: '2023',
    date_of_entry_into_fleet: '2023-01-01',
  });
  assert.match(result.error, /Not authorized/);
});

test('importBusRow: rejects a duplicate registration/chassis number', async () => {
  const depotId = await seedDepot();
  const modelId = await seedBusModel();
  await seedBus({ depotId, modelId, registration_no: 'DL01ZZ0006' });
  const result = await importBusRow(await adminUser(), {
    registration_no: 'DL01ZZ0006',
    chassis_no: 'VIN-OTHER',
    bus_model_id: String(modelId),
    depot_id: String(depotId),
    year_of_manufacture: '2023',
    date_of_entry_into_fleet: '2023-01-01',
  });
  assert.match(result.error, /already exists/);
});

// --- Tyre import ----------------------------------------------------------

test('importTyreRow: required fields', async () => {
  const result = await importTyreRow(await adminUser(), {});
  assert.equal(result.error, 'tyre_number and brand are required');
});

test('importTyreRow: rejects an invalid status with a friendly message instead of a raw DB error', async () => {
  const result = await importTyreRow(await adminUser(), { tyre_number: 'TY-BAD', brand: 'MRF', status: 'Fitted' });
  assert.match(result.error, /status must be one of/);
});

test('importTyreRow: rejects an invalid purchase_date instead of storing garbage', async () => {
  const result = await importTyreRow(await adminUser(), { tyre_number: 'TY-BAD-DATE', brand: 'MRF', purchase_date: 'not-a-date' });
  assert.match(result.error, /purchase_date must be a valid date/);
});

test('importTyreRow: persists pattern, ply_rating, and purchase_cost (previously silently dropped)', async () => {
  const result = await importTyreRow(await adminUser(), {
    tyre_number: 'TY-FULL-001',
    brand: 'MRF',
    pattern: 'JTH-1',
    ply_rating: '16',
    purchase_cost: '15000',
  });
  assert.ok(result.created, JSON.stringify(result));
  assert.equal(result.created.pattern, 'JTH-1');
  assert.equal(result.created.ply_rating, '16');
  assert.equal(result.created.purchase_cost, 15000);
});

test('importTyreRow: creates the opening purchase_intake lifecycle event (previously missing)', async () => {
  const result = await importTyreRow(await adminUser(), {
    tyre_number: 'TY-EVENT-001',
    brand: 'MRF',
    vendor_name: 'Acme Tyres',
    gate_pass_no: 'GP-1',
    invoice_no: 'INV-1',
    invoice_date: '2025-01-01',
  });
  assert.ok(result.created, JSON.stringify(result));

  const events = await db.prepare('SELECT * FROM tyre_events WHERE tyre_id = ?').all(result.created.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'purchase_intake');
  assert.equal(events[0].vendor_name, 'Acme Tyres');
  assert.equal(events[0].gate_pass_no, 'GP-1');
  assert.equal(events[0].invoice_no, 'INV-1');
  assert.equal(events[0].invoice_date, '2025-01-01');
});

test('importTyreRow: resolves current_bus_id by registration number and current_depot_id by name', async () => {
  const depotId = await seedDepot({ name: 'Delhi Central Depot', code: 'DEL-C' });
  const modelId = await seedBusModel({ position_labels: ['FL', 'FR'] });
  const busId = await seedBus({ depotId, modelId, registration_no: 'DL01AB9999' });

  const result = await importTyreRow(await adminUser(), {
    tyre_number: 'TY-MOUNT-001',
    brand: 'MRF',
    current_bus_id: 'DL01AB9999',
    current_position: 'FL',
  });

  assert.ok(result.created, JSON.stringify(result));
  assert.equal(result.created.current_bus_id, busId);
  assert.equal(result.created.current_position, 'FL');
  assert.equal(result.created.current_depot_id, depotId);
});

test('importTyreRow: rejects a current_position not in the bus model layout', async () => {
  const depotId = await seedDepot();
  const modelId = await seedBusModel({ position_labels: ['FL', 'FR'] });
  await seedBus({ depotId, modelId, registration_no: 'DL01AB8888' });

  const result = await importTyreRow(await adminUser(), {
    tyre_number: 'TY-BADPOS-001',
    brand: 'MRF',
    current_bus_id: 'DL01AB8888',
    current_position: 'RL-O',
  });
  assert.match(result.error, /current_position must be one of/);
});

test('importTyreRow: rejects a duplicate tyre_number', async () => {
  await importTyreRow(await adminUser(), { tyre_number: 'TY-DUPE', brand: 'MRF' });
  const result = await importTyreRow(await adminUser(), { tyre_number: 'TY-DUPE', brand: 'CEAT' });
  assert.match(result.error, /already exists/);
});
