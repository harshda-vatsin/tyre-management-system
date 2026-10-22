'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedTestDb } = require('../test-support/testDb');

let db, jwt, bcrypt, JWT_SECRET, ROLES, resolveJwtSecret;
let server, baseUrl, dropTestDb;
let depotA, depotB, busA, busB;

test.before(async () => {
  ({ dropTestDb } = await createIsolatedTestDb('auth_sessions'));

  db = require('../src/db');
  jwt = require('jsonwebtoken');
  bcrypt = require('bcrypt');
  ({ JWT_SECRET, resolveJwtSecret } = require('../src/middleware/auth'));
  ({ ROLES } = require('../src/utils/roles'));
  const app = require('../src/app');

  await db.ready;
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  depotA = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?) RETURNING *').get('Depot A', 'DA');
  depotB = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?) RETURNING *').get('Depot B', 'DB');
  const model = await db
    .prepare("INSERT INTO bus_models (name, num_positions, position_labels_json) VALUES (?, 4, '[\"FR\",\"FL\",\"RR\",\"RL\"]') RETURNING *")
    .get('Auth Test Model');
  busA = await db
    .prepare('INSERT INTO buses (depot_id, registration_no, chassis_no, bus_model_id) VALUES (?, ?, ?, ?) RETURNING *')
    .get(depotA.id, 'AUTH-BUS-A', 'AUTH-CH-A', model.id);
  busB = await db
    .prepare('INSERT INTO buses (depot_id, registration_no, chassis_no, bus_model_id) VALUES (?, ?, ?, ?) RETURNING *')
    .get(depotB.id, 'AUTH-BUS-B', 'AUTH-CH-B', model.id);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  await dropTestDb();
});

const PASSWORD = 'Passw0rdTest';
let counter = 0;
async function seedUser({ role = ROLES.ADMIN, depot_id = null } = {}) {
  counter += 1;
  const username = `auth_user_${counter}`;
  const info = await db
    .prepare('INSERT INTO users (username, email, password_hash, full_name, role, depot_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, `${username}@example.com`, bcrypt.hashSync(PASSWORD, 4), 'Auth User', role, depot_id);
  return { id: info.lastInsertRowid, username };
}

const CSRF = { 'X-Requested-With': 'ebtms' };

function refreshCookieFrom(res) {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('ebtms_refresh='));
  return raw ? { raw, value: raw.split(';')[0].slice('ebtms_refresh='.length) } : null;
}

async function login(user) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.username, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return { body, cookie: refreshCookieFrom(res), res };
}

function refresh(cookieValue, headers = CSRF) {
  return fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { ...headers, ...(cookieValue ? { Cookie: `ebtms_refresh=${cookieValue}` } : {}) },
  });
}

function logout(cookieValue, headers = CSRF) {
  return fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { ...headers, ...(cookieValue ? { Cookie: `ebtms_refresh=${cookieValue}` } : {}) },
  });
}

test('login issues a short-lived access token and an HttpOnly SameSite=Strict refresh cookie scoped to /api/auth', async () => {
  const user = await seedUser();
  const { body, cookie } = await login(user);

  const decoded = jwt.verify(body.token, JWT_SECRET);
  assert.equal(decoded.exp - decoded.iat, 15 * 60);

  assert.ok(cookie, 'refresh cookie set');
  assert.match(cookie.raw, /HttpOnly/);
  assert.match(cookie.raw, /SameSite=Strict/);
  assert.match(cookie.raw, /Path=\/api\/auth/);
  assert.ok(cookie.value.length >= 40, 'token is long and random');

  // Only a hash is stored, never the raw token.
  const rows = await db.prepare('SELECT token_hash FROM refresh_sessions WHERE user_id = ?').all(user.id);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, cookie.value);
});

test('session persists across a "browser refresh": the cookie alone yields a new access token', async () => {
  const user = await seedUser();
  const { cookie } = await login(user);

  const res = await refresh(cookie.value);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.username, user.username);
  assert.ok(jwt.verify(body.token, JWT_SECRET));
});

test('refresh rotates the token: new cookie issued, old one retired', async () => {
  const user = await seedUser();
  const { cookie } = await login(user);

  const res = await refresh(cookie.value);
  const next = refreshCookieFrom(res);
  assert.ok(next);
  assert.notEqual(next.value, cookie.value);

  assert.equal((await refresh(next.value)).status, 200, 'new token works');
});

test('replaying a rotated token outside the grace window is rejected and revokes the whole family', async () => {
  const user = await seedUser();
  const { cookie } = await login(user);
  const rotated = refreshCookieFrom(await refresh(cookie.value));

  // Age the rotation beyond the concurrent-tab grace window.
  await db.prepare("UPDATE refresh_sessions SET replaced_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ? AND replaced_at IS NOT NULL").run(user.id);

  const replay = await refresh(cookie.value);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).code, 'REFRESH_INVALID');

  // The legitimate (newest) token is dead too: theft response.
  assert.equal((await refresh(rotated.value)).status, 401);
});

test('simultaneous refreshes with the same cookie (two tabs) both succeed without killing the session', async () => {
  const user = await seedUser();
  const { cookie } = await login(user);

  const [a, b] = await Promise.all([refresh(cookie.value), refresh(cookie.value)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  // Exactly one response rotated the cookie; the browser keeps that one.
  const cookies = [refreshCookieFrom(a), refreshCookieFrom(b)].filter(Boolean);
  assert.equal(cookies.length, 1);
  assert.equal((await refresh(cookies[0].value)).status, 200, 'session still alive');
});

test('logout revokes the session and clears the cookie; further renewal is impossible', async () => {
  const user = await seedUser();
  const { cookie } = await login(user);

  const out = await logout(cookie.value);
  assert.equal(out.status, 200);
  const cleared = refreshCookieFrom(out);
  assert.match(cleared.raw, /Max-Age=0/);

  const after = await refresh(cookie.value);
  assert.equal(after.status, 401);
});

test('logout also kills a rotated descendant of the logged-out token', async () => {
  const user = await seedUser();
  const { cookie } = await login(user);
  const rotated = refreshCookieFrom(await refresh(cookie.value));

  await logout(rotated.value);
  assert.equal((await refresh(rotated.value)).status, 401);
});

test('invalid, missing, expired and revoked refresh tokens are rejected', async () => {
  const user = await seedUser();

  assert.equal((await refresh(null)).status, 401, 'missing');
  assert.equal((await refresh('not-a-real-token')).status, 401, 'garbage');

  const expired = (await login(user)).cookie;
  await db.prepare("UPDATE refresh_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(user.id);
  assert.equal((await refresh(expired.value)).status, 401, 'idle-expired');

  const capped = (await login(user)).cookie;
  await db.prepare("UPDATE refresh_sessions SET family_expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ? AND revoked_at IS NULL").run(user.id);
  assert.equal((await refresh(capped.value)).status, 401, 'absolute-lifetime-expired');

  const revoked = (await login(user)).cookie;
  await db.prepare("UPDATE refresh_sessions SET revoked_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(user.id);
  assert.equal((await refresh(revoked.value)).status, 401, 'revoked');
});

test('refresh and logout require the CSRF header and reject a foreign Origin', async () => {
  const user = await seedUser();
  const { cookie } = await login(user);

  assert.equal((await refresh(cookie.value, {})).status, 403, 'no custom header');
  assert.equal((await logout(cookie.value, {})).status, 403, 'logout without header');
  assert.equal(
    (await refresh(cookie.value, { ...CSRF, Origin: 'https://evil.example' })).status,
    403,
    'cross-origin'
  );
  assert.equal(
    (await refresh(cookie.value, { ...CSRF, Origin: baseUrl })).status,
    200,
    'same-origin is accepted (and the rejected attempts did not consume the token)'
  );
});

test('a deactivated user cannot refresh, and deactivation revokes existing sessions', async () => {
  const admin = await seedUser();
  const victim = await seedUser();
  const { cookie } = await login(victim);
  const adminToken = (await login(admin)).body.token;

  const res = await fetch(`${baseUrl}/api/users/${victim.id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ is_active: false }),
  });
  assert.equal(res.status, 200);

  assert.equal((await refresh(cookie.value)).status, 401);
});

test('refresh re-reads role and depot from the database, so changes apply at the next renewal', async () => {
  const user = await seedUser({ role: ROLES.DEPOT_MANAGER, depot_id: depotA.id });
  const { cookie } = await login(user);

  await db.prepare('UPDATE users SET depot_id = ? WHERE id = ?').run(depotB.id, user.id);
  const body = await (await refresh(cookie.value)).json();
  assert.equal(jwt.verify(body.token, JWT_SECRET).depot_id, depotB.id);
});

test('an expired access token is reported as TOKEN_EXPIRED (so clients refresh) and not accepted', async () => {
  const user = await seedUser();
  const expired = jwt.sign({ id: user.id, username: user.username, role: ROLES.ADMIN, depot_id: null }, JWT_SECRET, { expiresIn: -10 });

  const res = await fetch(`${baseUrl}/api/buses`, { headers: { Authorization: `Bearer ${expired}` } });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'TOKEN_EXPIRED');

  const forged = jwt.sign({ id: user.id, role: ROLES.ADMIN }, 'some-other-secret');
  const res2 = await fetch(`${baseUrl}/api/buses`, { headers: { Authorization: `Bearer ${forged}` } });
  assert.equal(res2.status, 401);
  assert.equal((await res2.json()).code, 'TOKEN_INVALID');
});

test('refreshed access tokens still enforce depot scoping: users cannot read another depot\'s data', async () => {
  const mgrA = await seedUser({ role: ROLES.DEPOT_MANAGER, depot_id: depotA.id });
  const { cookie } = await login(mgrA);
  const { token } = await (await refresh(cookie.value)).json();
  const headers = { Authorization: `Bearer ${token}` };

  const own = await fetch(`${baseUrl}/api/buses/${busA.id}`, { headers });
  assert.equal(own.status, 200);

  const other = await fetch(`${baseUrl}/api/buses/${busB.id}`, { headers });
  assert.equal(other.status, 403);

  const list = await (await fetch(`${baseUrl}/api/buses?depot_id=${depotB.id}`, { headers })).json();
  const regs = (list.data || list.items || list).map((b) => b.registration_no);
  assert.ok(!regs.includes('AUTH-BUS-B'), 'list is forced to the caller\'s own depot');
});

test('sessions survive a backend restart: refresh tokens are server-side state and the signing secret is stable', async () => {
  const user = await seedUser();
  const { cookie, body } = await login(user);

  // Simulate restart: stop the HTTP server and start a new one over the same
  // persistent store. Nothing about the session lives in process memory.
  await new Promise((resolve) => server.close(resolve));
  const app = require('../src/app');
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // The pre-restart access token is still valid (same secret) ...
  const probe = await fetch(`${baseUrl}/api/buses`, { headers: { Authorization: `Bearer ${body.token}` } });
  assert.equal(probe.status, 200);
  // ... and the refresh cookie still renews the session.
  assert.equal((await refresh(cookie.value)).status, 200);
});

test('JWT secret handling: production refuses missing, placeholder or short secrets; dev falls back', () => {
  assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production' }), /JWT_SECRET/);
  assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'change-this-in-production' }), /JWT_SECRET/);
  assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'too-short' }), /JWT_SECRET/);
  const good = 'a'.repeat(40);
  assert.equal(resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: good }), good);
  assert.ok(resolveJwtSecret({ NODE_ENV: 'development' }));
});

test('login still rejects bad credentials without setting a cookie', async () => {
  const user = await seedUser();
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.username, password: 'wrong' }),
  });
  assert.equal(res.status, 401);
  assert.equal(refreshCookieFrom(res), null);
});
