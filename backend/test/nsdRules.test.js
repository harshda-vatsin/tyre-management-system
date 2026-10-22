'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedTestDb } = require('../test-support/testDb');

let db, createTyreEvent, ROLES;
let dropTestDb;
let admin;

test.before(async () => {
  ({ dropTestDb } = await createIsolatedTestDb('nsd_rules'));
  db = require('../src/db');
  ({ createTyreEvent } = require('../src/utils/tyreEvents'));
  ({ ROLES } = require('../src/utils/roles'));
  await db.ready;

  // Default GLOBAL NSD thresholds (utils/defaultThresholds.js): warning <= 4 mm, critical <= 2 mm.
  await db.prepare("DELETE FROM thresholds WHERE parameter_type = 'NSD'").run();
  await db
    .prepare("INSERT INTO thresholds (parameter_type, scope_type, warning_max, critical_max, unit) VALUES ('NSD', 'GLOBAL', 4, 2, 'mm')")
    .run();

  const info = await db
    .prepare('INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)')
    .run('nsd_rules_admin', 'nsd_rules_admin@example.com', 'x', 'Admin', ROLES.ADMIN);
  admin = { id: info.lastInsertRowid, role: ROLES.ADMIN, depot_id: null };
});

test.after(async () => {
  await db.close();
  await dropTestDb();
});

let counter = 0;
async function seedMountedTyre() {
  counter += 1;
  const depot = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?) RETURNING *').get(`NSD Depot ${counter}`, `ND${counter}`);
  const model = await db
    .prepare("INSERT INTO bus_models (name, num_positions, position_labels_json) VALUES (?, 4, '[\"FR\",\"FL\",\"RR\",\"RL\"]') RETURNING *")
    .get(`NSD Model ${counter}`);
  const bus = await db
    .prepare('INSERT INTO buses (depot_id, registration_no, chassis_no, bus_model_id) VALUES (?, ?, ?, ?) RETURNING *')
    .get(depot.id, `NSDBUS-${counter}`, `NSDCH-${counter}`, model.id);
  return db
    .prepare("INSERT INTO tyres (tyre_number, brand, status, current_bus_id, current_position, current_depot_id) VALUES (?, 'JK', 'Active', ?, 'FR', ?) RETURNING *")
    .get(`NSDTY-${counter}`, bus.id, depot.id);
}

async function seedStoreTyre(initialNsd) {
  counter += 1;
  return db
    .prepare("INSERT INTO tyres (tyre_number, brand, status, initial_nsd) VALUES (?, 'JK', 'In Store', ?) RETURNING *")
    .get(`NSDST-${counter}`, initialNsd);
}

async function latestAlert(tyreId) {
  return db.prepare("SELECT * FROM alerts WHERE tyre_id = ? AND parameter_type = 'NSD' ORDER BY id DESC LIMIT 1").get(tyreId);
}

// ---------------------------------------------------------------------------
// Fix 1: retreading boundary (<= 2.0 mm is ineligible, matching CRITICAL)
// ---------------------------------------------------------------------------

for (const [nsd, blocked] of [[1.9, true], [2.0, true], [2.1, false]]) {
  test(`createRetreadSent with explicit NSD ${nsd} mm is ${blocked ? 'blocked' : 'allowed'}`, async () => {
    const tyre = await seedStoreTyre(12);
    const attempt = createTyreEvent(admin, 'retread_sent', { tyre_id: tyre.id, vendor_name: 'Vendor', nsd_value: nsd });
    if (blocked) {
      await assert.rejects(attempt, (err) => err.status === 400 && /2\.0 mm limit for retreading/.test(err.message));
      const after = await db.prepare('SELECT status FROM tyres WHERE id = ?').get(tyre.id);
      assert.equal(after.status, 'In Store', 'tyre state unchanged');
    } else {
      const [event] = await attempt;
      assert.equal(event.event_type, 'retread_sent');
      assert.equal((await db.prepare('SELECT status FROM tyres WHERE id = ?').get(tyre.id)).status, 'Going for Retread');
    }
  });

  test(`createRetreadStarted with recorded NSD ${nsd} mm is ${blocked ? 'blocked' : 'allowed'}`, async () => {
    const tyre = await seedStoreTyre(nsd); // effective NSD falls back to initial_nsd when no event has one
    const attempt = createTyreEvent(admin, 'retread_started', { tyre_id: tyre.id, vendor_name: 'Vendor' });
    if (blocked) {
      await assert.rejects(attempt, (err) => err.status === 400 && /2\.0 mm limit for retreading/.test(err.message));
      assert.equal((await db.prepare('SELECT status FROM tyres WHERE id = ?').get(tyre.id)).status, 'In Store');
    } else {
      const [event] = await attempt;
      assert.equal(event.event_type, 'retread_started');
      assert.equal((await db.prepare('SELECT status FROM tyres WHERE id = ?').get(tyre.id)).status, 'Under Retread');
    }
  });
}

test('createRetreadSent at exactly 2.0 mm with auto_scrap still routes to condemnation', async () => {
  const tyre = await seedStoreTyre(12);
  const [event] = await createTyreEvent(admin, 'retread_sent', { tyre_id: tyre.id, vendor_name: 'Vendor', nsd_value: 2.0, auto_scrap: true });
  assert.equal(event.event_type, 'condemnation');
  assert.equal(event.nsd_value, 2);
  assert.equal((await db.prepare('SELECT status FROM tyres WHERE id = ?').get(tyre.id)).status, 'Scrapped');
});

// ---------------------------------------------------------------------------
// Fix 2: the minimum groove is authoritative when all four are supplied
// ---------------------------------------------------------------------------

test('grooves 2,4,6,6 with manual nsd_value 6: effective NSD is 2 -> CRITICAL, alert and current NSD agree', async () => {
  const tyre = await seedMountedTyre();
  const [event] = await createTyreEvent(admin, 'nsd_reading', { tyre_id: tyre.id, nsd_value: 6, nsd_g1: 2, nsd_g2: 4, nsd_g3: 6, nsd_g4: 6 });

  assert.equal(event.nsd_value, 2);
  assert.equal(event.flag_status, 'CRITICAL');
  assert.deepEqual([event.nsd_g1, event.nsd_g2, event.nsd_g3, event.nsd_g4], [2, 4, 6, 6], 'raw grooves preserved');

  const alert = await latestAlert(tyre.id);
  assert.equal(alert.severity, 'Critical');
  assert.equal(alert.reading_value, 2);
  assert.equal(alert.threshold_value, 2);

  // The tyre's "current NSD" is derived from its latest nsd_value (see routes/tyres.js).
  const current = await db
    .prepare('SELECT nsd_value FROM tyre_events WHERE tyre_id = ? AND nsd_value IS NOT NULL ORDER BY event_date DESC, id DESC LIMIT 1')
    .get(tyre.id);
  assert.equal(current.nsd_value, 2);
});

test('grooves 4,5,6,7 with manual nsd_value 10: effective NSD is 4 -> WARNING', async () => {
  const tyre = await seedMountedTyre();
  const [event] = await createTyreEvent(admin, 'nsd_reading', { tyre_id: tyre.id, nsd_value: 10, nsd_g1: 4, nsd_g2: 5, nsd_g3: 6, nsd_g4: 7 });

  assert.equal(event.nsd_value, 4);
  assert.equal(event.flag_status, 'WARNING');
  const alert = await latestAlert(tyre.id);
  assert.equal(alert.severity, 'Warning');
  assert.equal(alert.reading_value, 4);
});

test('a UI-supplied auto-calculated nsd_value equal to the minimum is accepted', async () => {
  const tyre = await seedMountedTyre();
  const [event] = await createTyreEvent(admin, 'nsd_reading', { tyre_id: tyre.id, nsd_value: 5, nsd_g1: 5, nsd_g2: 6, nsd_g3: 7, nsd_g4: 8 });
  assert.equal(event.nsd_value, 5);
  assert.equal(event.flag_status, 'OK');
});

for (const blank of [undefined, null, '']) {
  test(`all four grooves with nsd_value ${JSON.stringify(blank)} still uses the minimum`, async () => {
    const tyre = await seedMountedTyre();
    const [event] = await createTyreEvent(admin, 'nsd_reading', { tyre_id: tyre.id, nsd_value: blank, nsd_g1: 9, nsd_g2: 3.5, nsd_g3: 8, nsd_g4: 7 });
    assert.equal(event.nsd_value, 3.5);
    assert.equal(event.flag_status, 'WARNING');
  });
}

test('incomplete grooves without a usable nsd_value are rejected (existing validation preserved)', async () => {
  const tyre = await seedMountedTyre();
  await assert.rejects(
    createTyreEvent(admin, 'nsd_reading', { tyre_id: tyre.id, nsd_g1: 2, nsd_g2: 4, nsd_g3: 6 }),
    (err) => err.status === 400 && /NSD \(mm\) must be a number/.test(err.message)
  );
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS c FROM tyre_events WHERE tyre_id = ?').get(tyre.id)).c, 0);
});

test('incomplete grooves with an explicit nsd_value keep the existing behaviour (nsd_value used as given)', async () => {
  const tyre = await seedMountedTyre();
  const [event] = await createTyreEvent(admin, 'nsd_reading', { tyre_id: tyre.id, nsd_value: 6, nsd_g1: 2, nsd_g2: 4, nsd_g3: 6 });
  assert.equal(event.nsd_value, 6);
  assert.equal(event.nsd_g4, null, 'missing groove is not invented');
});

test('an invalid groove is rejected even when a valid manual nsd_value is supplied (no fallback)', async () => {
  const tyre = await seedMountedTyre();
  await assert.rejects(
    createTyreEvent(admin, 'nsd_reading', { tyre_id: tyre.id, nsd_value: 6, nsd_g1: 2, nsd_g2: 4, nsd_g3: 6, nsd_g4: 99 }),
    (err) => err.status === 400 && /between 0 and 25/.test(err.message)
  );
  await assert.rejects(
    createTyreEvent(admin, 'nsd_reading', { tyre_id: tyre.id, nsd_value: 6, nsd_g1: 2, nsd_g2: 'abc', nsd_g3: 6, nsd_g4: 6 }),
    (err) => err.status === 400 && /must be a number/.test(err.message)
  );
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS c FROM tyre_events WHERE tyre_id = ?').get(tyre.id)).c, 0);
});
