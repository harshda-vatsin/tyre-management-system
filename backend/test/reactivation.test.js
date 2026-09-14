'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedTestDb } = require('../test-support/testDb');

let db, jwt, JWT_SECRET, ROLES;
let server, baseUrl, dropTestDb;

test.before(async () => {
  ({ dropTestDb } = await createIsolatedTestDb('reactivation'));

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
  const username = `reactivation_test_user_${userCounter}`;
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
    .prepare('INSERT INTO tyres (tyre_number, brand, status, current_bus_id, current_position) VALUES (?, ?, ?, ?, ?)')
    .run(
      overrides.tyre_number || 'TY-REACT-001',
      overrides.brand || 'MRF',
      overrides.status || 'Scrapped',
      overrides.current_bus_id ?? null,
      overrides.current_position ?? null
    );
  return info.lastInsertRowid;
}

test('POST /events reactivation brings a Scrapped tyre back to In Store and logs an event', async () => {
  const admin = await seedUser({ role: ROLES.ADMIN });
  const token = tokenFor(admin);
  const tyreId = await seedTyre({ tyre_number: 'TY-REACT-001', status: 'Scrapped' });

  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'reactivation', tyre_id: tyreId, reason: 'Scrapped in error' }),
  });

  assert.equal(res.status, 201);
  const event = await res.json();
  assert.equal(event.event_type, 'reactivation');
  assert.equal(event.reason, 'Scrapped in error');

  const tyre = await db.prepare('SELECT * FROM tyres WHERE id = ?').get(tyreId);
  assert.equal(tyre.status, 'In Store');
  assert.equal(tyre.current_bus_id, null);
});

test('POST /events reactivation is rejected for a tyre that is not currently Scrapped', async () => {
  const admin = await seedUser({ role: ROLES.ADMIN });
  const token = tokenFor(admin);
  const tyreId = await seedTyre({ tyre_number: 'TY-REACT-002', status: 'In Store' });

  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'reactivation', tyre_id: tyreId, reason: 'Should not work' }),
  });

  assert.equal(res.status, 409);
  const tyre = await db.prepare('SELECT * FROM tyres WHERE id = ?').get(tyreId);
  assert.equal(tyre.status, 'In Store');
});

test('POST /events reactivation requires Admin or Depot Manager (Tyre Supervisor forbidden)', async () => {
  const supervisor = await seedUser({ role: ROLES.TYRE_SUPERVISOR });
  const token = tokenFor(supervisor);
  const tyreId = await seedTyre({ tyre_number: 'TY-REACT-003', status: 'Scrapped' });

  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'reactivation', tyre_id: tyreId, reason: 'Attempted by supervisor' }),
  });

  assert.equal(res.status, 403);
  const tyre = await db.prepare('SELECT * FROM tyres WHERE id = ?').get(tyreId);
  assert.equal(tyre.status, 'Scrapped');
});

test('PUT /api/tyres/:id (master-data route) still refuses to move a Scrapped tyre to any other status directly', async () => {
  const admin = await seedUser({ role: ROLES.ADMIN });
  const token = tokenFor(admin);
  const tyreId = await seedTyre({ tyre_number: 'TY-REACT-004', status: 'Scrapped' });

  const res = await fetch(`${baseUrl}/api/tyres/${tyreId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'In Store' }),
  });

  assert.equal(res.status, 409);
  const tyre = await db.prepare('SELECT * FROM tyres WHERE id = ?').get(tyreId);
  assert.equal(tyre.status, 'Scrapped');
});
