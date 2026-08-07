'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedTestDb } = require('../test-support/testDb');

let db, createTyreEvent, tyreLifeReport, ROLES;
let dropTestDb;

test.before(async () => {
  ({ dropTestDb } = await createIsolatedTestDb('tyre_life_report'));
  db = require('../src/db');
  ({ createTyreEvent } = require('../src/utils/tyreEvents'));
  ({ REPORTS: { 'tyre-life': { getRows: tyreLifeReport } } } = require('../src/utils/reportService'));
  ({ ROLES } = require('../src/utils/roles'));
  await db.ready;
});

test.after(async () => {
  await db.close();
  await dropTestDb();
});

let counter = 0;
async function seedDepotBusModelBus() {
  counter += 1;
  const depot = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?) RETURNING *').get(`Life Depot ${counter}`, `LD${counter}`);
  const model = await db.prepare(
    "INSERT INTO bus_models (name, num_positions, position_labels_json) VALUES (?, 4, '[\"FR\",\"FL\",\"RR\",\"RL\"]') RETURNING *"
  ).get(`Life Model ${counter}`);
  const bus = await db.prepare(
    'INSERT INTO buses (depot_id, registration_no, chassis_no, bus_model_id, status, odometer_km) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
  ).get(depot.id, `LIFEBUS-${counter}`, `CH-LIFE-${counter}`, model.id, 'Active', 500000);
  return { depot, model, bus };
}

async function seedTyre({ depotId, busId, position, status = 'Active', purchaseDate = null }) {
  counter += 1;
  return db.prepare(`
    INSERT INTO tyres (tyre_number, brand, status, current_bus_id, current_position, current_depot_id, purchase_date)
    VALUES (?, 'JK', ?, ?, ?, ?, ?) RETURNING *
  `).get(`LIFETY-${counter}`, status, busId, position, depotId, purchaseDate);
}

async function adminUser() {
  counter += 1;
  const info = await db
    .prepare('INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)')
    .run(`life_admin_${counter}`, `life_admin_${counter}@example.com`, 'x', 'Test Admin', ROLES.ADMIN);
  return { id: info.lastInsertRowid, role: ROLES.ADMIN, depot_id: null };
}

test('tyreLifeReport: a replaced-in tyre gets last_fitment_odometer_km from its replacement event, not null', async () => {
  const { depot, bus } = await seedDepotBusModelBus();
  const oldTyre = await seedTyre({ depotId: depot.id, busId: bus.id, position: 'FR', purchaseDate: '2025-01-01' });
  const newTyre = await seedTyre({ depotId: depot.id, busId: null, position: null, status: 'In Store', purchaseDate: '2026-01-01' });
  const user = await adminUser();

  await createTyreEvent(user, 'replacement', {
    tyre_id: oldTyre.id,
    new_tyre_id: newTyre.id,
    reason: 'worn',
    odometer_km: 510000,
    event_date: '2026-06-01 00:00:00',
  });

  const rows = await tyreLifeReport({});
  const newRow = rows.find((r) => r.tyre_number === newTyre.tyre_number);
  const oldRow = rows.find((r) => r.tyre_number === oldTyre.tyre_number);

  assert.equal(newRow.status, 'Active');
  assert.equal(oldRow.status, 'In Store');
  // newRow is still mounted with no further event after its replacement-in
  // -- its life_used_km compares that 510000 baseline against the bus's
  // live odometer, which createReplacement's maybeUpdateBusOdometer call
  // just advanced to the same 510000 reading, so the stint is 0km old so far.
  assert.equal(newRow.life_used_km, 0);
});

test('tyreLifeReport: life_used_km computes correctly across a replacement chain (fitment -> replaced out)', async () => {
  const { depot, bus } = await seedDepotBusModelBus();
  const user = await adminUser();

  // tyreA fitted fresh at 500000km, later replaced by tyreB at 510000km --
  // tyreA's own life_used_km should be 10000 (500000 -> 510000), and
  // tyreB's last_fitment_odometer_km should be 510000 (its own stint start).
  const tyreA = await seedTyre({ depotId: depot.id, busId: null, position: null, status: 'In Store' });
  const tyreB = await seedTyre({ depotId: depot.id, busId: null, position: null, status: 'In Store' });

  await createTyreEvent(user, 'fitment_created', {
    tyre_id: tyreA.id, bus_id: bus.id, position: 'FR', odometer_km: 500000, event_date: '2026-01-01 00:00:00',
  });
  await createTyreEvent(user, 'replacement', {
    tyre_id: tyreA.id, new_tyre_id: tyreB.id, reason: 'worn', odometer_km: 510000, event_date: '2026-06-01 00:00:00',
  });

  const rows = await tyreLifeReport({});
  const rowA = rows.find((r) => r.tyre_number === tyreA.tyre_number);
  const rowB = rows.find((r) => r.tyre_number === tyreB.tyre_number);

  assert.equal(rowA.life_used_km, 10000, 'tyreA: 500000 (fitment_created) -> 510000 (replaced out)');
  assert.equal(rowA.status, 'In Store');
  assert.equal(rowB.status, 'Active');
  // tyreB is still mounted with no further event after its replacement-in
  // -- its life_used_km compares that 510000 baseline against the bus's
  // live odometer, which the replacement itself just advanced to 510000
  // (maybeUpdateBusOdometer), so the stint is 0km old so far.
  const liveBus = await db.prepare('SELECT odometer_km FROM buses WHERE id = ?').get(bus.id);
  assert.equal(liveBus.odometer_km, 510000);
  assert.equal(rowB.life_used_km, 0);
});

test('createReplacement: odometer_km is optional -- manual entry (no odometer_km passed) behaves exactly as before', async () => {
  const { depot, bus } = await seedDepotBusModelBus();
  const oldTyre = await seedTyre({ depotId: depot.id, busId: bus.id, position: 'FL' });
  const newTyre = await seedTyre({ depotId: depot.id, busId: null, position: null, status: 'In Store' });
  const user = await adminUser();

  const events = await createTyreEvent(user, 'replacement', {
    tyre_id: oldTyre.id, new_tyre_id: newTyre.id, reason: 'worn', event_date: '2026-06-01 00:00:00',
  });

  for (const e of events) assert.equal(e.odometer_km, null, 'omitting odometer_km must still work and store null, matching pre-existing manual-entry behavior');
});
