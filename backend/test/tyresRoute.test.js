'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedTestDb } = require('../test-support/testDb');

// db/app/etc. are populated inside test.before(), after DATABASE_URL has
// been pointed at this file's own isolated database (see helpers/testDb.js)
// -- they can't be required at module top-level the way a shared-database
// setup could, since the database has to exist and DATABASE_URL has to be
// set before ../src/db is ever required.
let db, jwt, JWT_SECRET, ROLES;
let server, baseUrl, dropTestDb;

test.before(async () => {
  ({ dropTestDb } = await createIsolatedTestDb('tyres_route'));

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

let userCounter = 0;
async function seedUser(overrides = {}) {
  userCounter += 1;
  const role = overrides.role || ROLES.ADMIN;
  const depot_id = overrides.depot_id ?? null;
  const username = `route_test_user_${userCounter}`;
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

async function seedTyre(overrides = {}) {
  const info = await db
    .prepare('INSERT INTO tyres (tyre_number, brand, status) VALUES (?, ?, ?)')
    .run(overrides.tyre_number || 'TY-ROUTE-001', overrides.brand || 'MRF', overrides.status || 'In Store');
  return info.lastInsertRowid;
}

test('DELETE /api/tyres/:id returns a friendly 409 (not a raw 500) when the tyre has lifecycle history', async () => {
  const admin = await seedUser({ role: ROLES.ADMIN });
  const token = tokenFor(admin);
  const tyreId = await seedTyre({ tyre_number: 'TY-HIST-001' });
  await db.prepare(`INSERT INTO tyre_events (tyre_id, event_type, notes, performed_by) VALUES (?, 'purchase_intake', 'seeded for test', ?)`)
    .run(tyreId, admin.id);

  const res = await fetch(`${baseUrl}/api/tyres/${tyreId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /lifecycle history/);

  // Confirm the tyre and its history are both still there (the delete never happened).
  assert.ok(await db.prepare('SELECT id FROM tyres WHERE id = ?').get(tyreId));
});

test('DELETE /api/tyres/:id succeeds with 204 when the tyre has no lifecycle history', async () => {
  const admin = await seedUser({ role: ROLES.ADMIN });
  const token = tokenFor(admin);
  const tyreId = await seedTyre({ tyre_number: 'TY-NOHIST-001' });

  const res = await fetch(`${baseUrl}/api/tyres/${tyreId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(res.status, 204);
  assert.equal(await db.prepare('SELECT id FROM tyres WHERE id = ?').get(tyreId), undefined);
});

test('DELETE /api/tyres/:id is Administrator-only', async () => {
  const dm = await seedUser({ role: ROLES.DEPOT_MANAGER });
  const token = tokenFor(dm);
  const tyreId = await seedTyre({ tyre_number: 'TY-FORBID-001' });

  const res = await fetch(`${baseUrl}/api/tyres/${tyreId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(res.status, 403);
});
