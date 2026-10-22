'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createIsolatedTestDb } = require('../test-support/testDb');

let db, jwt, JWT_SECRET, ROLES;
let server, baseUrl, dropTestDb, photoDir;

test.before(async () => {
  photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebtms-photos-'));
  process.env.EVENT_PHOTO_DIR = photoDir;
  ({ dropTestDb } = await createIsolatedTestDb('event_photos'));

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
  fs.rmSync(photoDir, { recursive: true, force: true });
});

let userCounter = 0;
async function seedUser(overrides = {}) {
  userCounter += 1;
  const role = overrides.role || ROLES.ADMIN;
  const depot_id = overrides.depot_id ?? null;
  const username = `event_photos_test_user_${userCounter}`;
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

let depotCounter = 0;
async function seedDepot() {
  depotCounter += 1;
  const info = await db.prepare('INSERT INTO depots (name) VALUES (?)').run(`Photo Test Depot ${depotCounter}`);
  return info.lastInsertRowid;
}

let tyreCounter = 0;
async function seedReadingEvent(depotId) {
  tyreCounter += 1;
  const tyre = await db
    .prepare('INSERT INTO tyres (tyre_number, brand, status) VALUES (?, ?, ?)')
    .run(`TY-PHOTO-${tyreCounter}`, 'MRF', 'In Store');
  const event = await db
    .prepare('INSERT INTO tyre_events (tyre_id, event_type, depot_id, nsd_value) VALUES (?, ?, ?, ?)')
    .run(tyre.lastInsertRowid, 'nsd_reading', depotId, 8.5);
  return event.lastInsertRowid;
}

// Minimal valid-looking headers; the server only checks magic bytes.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

function photoForm(buffers, type = 'image/jpeg') {
  const form = new FormData();
  buffers.forEach((buf, i) => form.append('photos', new Blob([buf], { type }), `p${i}.jpg`));
  return form;
}

async function upload(eventId, token, form) {
  return fetch(`${baseUrl}/api/event-photos/events/${eventId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
}

test('uploads a photo to a reading, lists it and serves the file', async () => {
  const admin = await seedUser();
  const token = tokenFor(admin);
  const eventId = await seedReadingEvent(await seedDepot());

  const res = await upload(eventId, token, photoForm([JPEG]));
  assert.equal(res.status, 201);
  const [photo] = await res.json();
  assert.equal(photo.mime_type, 'image/jpeg');

  const list = await (await fetch(`${baseUrl}/api/event-photos?event_id=${eventId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(list.length, 1);

  const file = await fetch(`${baseUrl}/api/event-photos/${photo.id}/file`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await file.arrayBuffer()).length, JPEG.length);
});

test('rejects a non-image even when the client claims image/jpeg', async () => {
  const admin = await seedUser();
  const eventId = await seedReadingEvent(await seedDepot());
  const res = await upload(eventId, tokenFor(admin), photoForm([Buffer.from('not an image at all')]));
  assert.equal(res.status, 400);
});

test('caps photos per event at 5', async () => {
  const admin = await seedUser();
  const token = tokenFor(admin);
  const eventId = await seedReadingEvent(await seedDepot());

  assert.equal((await upload(eventId, token, photoForm([JPEG, JPEG, JPEG, JPEG, JPEG]))).status, 201);
  assert.equal((await upload(eventId, token, photoForm([JPEG]))).status, 400);
});

test('requires authentication and a write role', async () => {
  const eventId = await seedReadingEvent(await seedDepot());
  assert.equal((await upload(eventId, 'bad-token', photoForm([JPEG]))).status, 401);

  const auditor = await seedUser({ role: ROLES.AUDITOR });
  assert.equal((await upload(eventId, tokenFor(auditor), photoForm([JPEG]))).status, 403);
});

test('a depot-scoped user cannot upload to, view or delete another depot\'s photos', async () => {
  const depotA = await seedDepot();
  const depotB = await seedDepot();
  const admin = await seedUser();
  const eventId = await seedReadingEvent(depotA);
  const [photo] = await (await upload(eventId, tokenFor(admin), photoForm([JPEG]))).json();

  const outsider = tokenFor(await seedUser({ role: ROLES.TYRE_SUPERVISOR, depot_id: depotB }));
  assert.equal((await upload(eventId, outsider, photoForm([JPEG]))).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/event-photos/${photo.id}/file`, { headers: { Authorization: `Bearer ${outsider}` } })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/event-photos/${photo.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${outsider}` } })).status, 403);

  const insider = tokenFor(await seedUser({ role: ROLES.TYRE_SUPERVISOR, depot_id: depotA }));
  assert.equal((await fetch(`${baseUrl}/api/event-photos/${photo.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${insider}` } })).status, 204);
});
