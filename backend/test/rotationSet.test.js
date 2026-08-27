'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedTestDb } = require('../test-support/testDb');

// db/app/etc. are populated inside test.before(), after DATABASE_URL has
// been pointed at this file's own isolated database (see helpers/testDb.js).
let db, jwt, JWT_SECRET, ROLES;
let server, baseUrl, dropTestDb;

test.before(async () => {
  ({ dropTestDb } = await createIsolatedTestDb('rotation_set'));

  db = require('../src/db');
  jwt = require('jsonwebtoken');
  ({ JWT_SECRET } = require('../src/middleware/auth'));
  ({ ROLES } = require('../src/utils/roles'));
  const app = require('../src/app');

  await db.ready;
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  await dropTestDb();
});

let counter = 0;

async function seedUser(overrides = {}) {
  counter += 1;
  const role = overrides.role || ROLES.ADMIN;
  const depot_id = overrides.depot_id ?? null;
  const username = `rotation_set_user_${counter}`;
  const info = await db
    .prepare('INSERT INTO users (username, email, password_hash, full_name, role, depot_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, `${username}@example.com`, 'x', 'Test User', role, depot_id);
  return { id: info.lastInsertRowid, username, role, depot_id };
}

function tokenFor(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, depot_id: user.depot_id },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function seedDepot() {
  counter += 1;
  const info = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?)').run(`Depot ${counter}`, `DPT${counter}`);
  return info.lastInsertRowid;
}

async function seedBusModel(positions) {
  counter += 1;
  const info = await db
    .prepare('INSERT INTO bus_models (name, num_positions, position_labels_json) VALUES (?, ?, ?)')
    .run(`Model ${counter}`, positions.length, JSON.stringify(positions));
  return info.lastInsertRowid;
}

async function seedBus(depotId, busModelId) {
  counter += 1;
  const info = await db
    .prepare('INSERT INTO buses (depot_id, registration_no, chassis_no, bus_model_id) VALUES (?, ?, ?, ?)')
    .run(depotId, `BUS-${counter}`, `CHS-${counter}`, busModelId);
  return info.lastInsertRowid;
}

async function seedMountedTyre(busId, depotId, position) {
  counter += 1;
  const tyre_number = `TY-${counter}`;
  const info = await db
    .prepare('INSERT INTO tyres (tyre_number, brand, status, current_bus_id, current_position, current_depot_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tyre_number, 'MRF', 'Active', busId, position, depotId);
  return { id: info.lastInsertRowid, tyre_number };
}

async function positionOf(tyreId) {
  return (await db.prepare('SELECT current_position FROM tyres WHERE id = ?').get(tyreId)).current_position;
}

// This is the exact case the fix targets: on a fully-mounted bus, no
// position is ever free until another leg of the same cycle has already
// landed, so a sequence of independent single-position rotation events can
// never apply a closed cycle. createRotationSet validates the whole final
// layout first and writes every move together, so this must just work.
test('POST /events/rotation-set applies a closed 3-tyre rotation cycle on a fully-mounted bus atomically', async () => {
  const admin = await seedUser();
  const token = tokenFor(admin);
  const depotId = await seedDepot();
  const busModelId = await seedBusModel(['P1', 'P2', 'P3']);
  const busId = await seedBus(depotId, busModelId);

  const t1 = await seedMountedTyre(busId, depotId, 'P1');
  const t2 = await seedMountedTyre(busId, depotId, 'P2');
  const t3 = await seedMountedTyre(busId, depotId, 'P3');

  const res = await fetch(`${baseUrl}/api/events/rotation-set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      bus_id: busId,
      moves: [
        { tyre_id: t1.id, to_position: 'P2' },
        { tyre_id: t2.id, to_position: 'P3' },
        { tyre_id: t3.id, to_position: 'P1' },
      ],
    }),
  });

  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.length, 3);
  assert.ok(body.every((e) => e.event_type === 'rotation'));

  assert.equal(await positionOf(t1.id), 'P2');
  assert.equal(await positionOf(t2.id), 'P3');
  assert.equal(await positionOf(t3.id), 'P1');
});

// The other structural bug: a direct two-tyre swap is a 2-cycle, and is
// exactly as impossible for independent single-position events as the
// 3-cycle above -- neither tyre's destination is free until the other has
// already moved.
test('POST /events/rotation-set performs a direct two-tyre swap in one call', async () => {
  const admin = await seedUser();
  const token = tokenFor(admin);
  const depotId = await seedDepot();
  const busModelId = await seedBusModel(['P1', 'P2']);
  const busId = await seedBus(depotId, busModelId);

  const t1 = await seedMountedTyre(busId, depotId, 'P1');
  const t2 = await seedMountedTyre(busId, depotId, 'P2');

  const res = await fetch(`${baseUrl}/api/events/rotation-set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      bus_id: busId,
      moves: [
        { tyre_id: t1.id, to_position: 'P2' },
        { tyre_id: t2.id, to_position: 'P1' },
      ],
    }),
  });

  assert.equal(res.status, 201);
  assert.equal(await positionOf(t1.id), 'P2');
  assert.equal(await positionOf(t2.id), 'P1');
});

test('POST /events/rotation-set rejects a set that leaves two tyres targeting the same position, and writes nothing', async () => {
  const admin = await seedUser();
  const token = tokenFor(admin);
  const depotId = await seedDepot();
  const busModelId = await seedBusModel(['P1', 'P2', 'P3']);
  const busId = await seedBus(depotId, busModelId);

  const t1 = await seedMountedTyre(busId, depotId, 'P1');
  const t2 = await seedMountedTyre(busId, depotId, 'P2');
  const t3 = await seedMountedTyre(busId, depotId, 'P3');

  // t1 -> P2, but t2 (P2's current occupant) is never given anywhere to go
  // or sent to Spare -- P2 would end up claimed by both t1 and t2.
  const res = await fetch(`${baseUrl}/api/events/rotation-set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      bus_id: busId,
      moves: [
        { tyre_id: t1.id, to_position: 'P2' },
        { tyre_id: t3.id, to_position: 'P1' },
      ],
    }),
  });

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /P2/);
  assert.match(body.error, new RegExp(t2.tyre_number));

  // All-or-nothing: nothing was written, all three tyres are exactly where
  // they started.
  assert.equal(await positionOf(t1.id), 'P1');
  assert.equal(await positionOf(t2.id), 'P2');
  assert.equal(await positionOf(t3.id), 'P3');
  const eventCount = await db
    .prepare('SELECT COUNT(*) c FROM tyre_events WHERE tyre_id IN (?, ?, ?)')
    .get(t1.id, t2.id, t3.id);
  assert.equal(eventCount.c, 0);
});

test('POST /events/rotation-set can dismount a tyre to Spare atomically alongside the rest of the rotation', async () => {
  const admin = await seedUser();
  const token = tokenFor(admin);
  const depotId = await seedDepot();
  const busModelId = await seedBusModel(['P1', 'P2']);
  const busId = await seedBus(depotId, busModelId);

  const t1 = await seedMountedTyre(busId, depotId, 'P1');
  const t2 = await seedMountedTyre(busId, depotId, 'P2');

  const res = await fetch(`${baseUrl}/api/events/rotation-set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      bus_id: busId,
      moves: [
        { tyre_id: t1.id, to_position: 'P2' },
        { tyre_id: t2.id, dismount: true, nsd_value: 5, stored_at: 'Depot Store' },
      ],
    }),
  });

  assert.equal(res.status, 201);
  assert.equal(await positionOf(t1.id), 'P2');

  const t2After = await db.prepare('SELECT current_position, current_bus_id, status FROM tyres WHERE id = ?').get(t2.id);
  assert.equal(t2After.current_bus_id, null);
  assert.equal(t2After.current_position, null);
  assert.equal(t2After.status, 'In Store');
});

test('POST /events/rotation-set rejects a tyre_id that is not currently mounted on the given bus', async () => {
  const admin = await seedUser();
  const token = tokenFor(admin);
  const depotId = await seedDepot();
  const busModelId = await seedBusModel(['P1', 'P2']);
  const busId = await seedBus(depotId, busModelId);
  const otherBusId = await seedBus(depotId, busModelId);

  const t1 = await seedMountedTyre(busId, depotId, 'P1');
  const elsewhere = await seedMountedTyre(otherBusId, depotId, 'P1');

  const res = await fetch(`${baseUrl}/api/events/rotation-set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      bus_id: busId,
      moves: [
        { tyre_id: t1.id, to_position: 'P2' },
        { tyre_id: elsewhere.id, to_position: 'P1' },
      ],
    }),
  });

  assert.equal(res.status, 400);
  assert.equal(await positionOf(t1.id), 'P1');
});
