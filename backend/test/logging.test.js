'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');

const { createIsolatedTestDb } = require('../test-support/testDb');

let db, app;
let server, baseUrl, dropTestDb, testDbUrl;

test.before(async () => {
  const testDbInfo = await createIsolatedTestDb('logging_test');
  dropTestDb = testDbInfo.dropTestDb;
  testDbUrl = process.env.DATABASE_URL;

  db = require('../src/db');
  app = require('../src/app');

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

test('logging: /api/health should NOT be logged', async () => {
  // Clear any existing logs
  await db.exec('TRUNCATE TABLE access_logs');

  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);

  // Wait briefly for asynchronous res.on('finish') write
  await new Promise(resolve => setTimeout(resolve, 100));

  const logs = await db.prepare('SELECT * FROM access_logs').all();
  assert.equal(logs.length, 0, 'Health check requests must not be logged');
});

test('logging: normal API requests should be logged asynchronously', async () => {
  await db.exec('TRUNCATE TABLE access_logs');

  // Request `/api/auth/login` without credentials -> returns 400
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 400);

  // Wait briefly for asynchronous res.on('finish') write
  await new Promise(resolve => setTimeout(resolve, 100));

  const logs = await db.prepare('SELECT * FROM access_logs').all();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].path, '/api/auth/login');
  assert.equal(logs[0].method, 'POST');
  assert.equal(logs[0].status_code, 400);
  assert.ok(typeof logs[0].response_time_ms === 'number');
  assert.ok(logs[0].response_time_ms >= 0);
  assert.equal(logs[0].username, null);
  assert.equal(logs[0].role, null);
});

test('CLI: check-activity script executes without errors and outputs a summary', async () => {
  // Insert a mock log to ensure we have traffic data to print
  await db.prepare(`
    INSERT INTO access_logs (username, role, method, path, ip_address, status_code, response_time_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('test_admin', 'System Administrator', 'GET', '/api/buses', '127.0.0.1', 200, 15);

  // Run check-activity CLI script using process execution
  const output = execSync('node src/scripts/check-activity.js', {
    env: {
      ...process.env,
      DATABASE_URL: testDbUrl
    },
    encoding: 'utf8'
  });

  assert.ok(output.includes('EBTMS CLIENT ACTIVITY REPORT'), 'Output must contain the header');
  assert.ok(output.toLowerCase().includes('verdict'), 'Output must contain the activity verdict');
  assert.ok(output.includes('/api/buses'), 'Output must contain the logged path');
  assert.ok(output.includes('test_admin'), 'Output must contain the username');
});
