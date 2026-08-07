'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedTestDb } = require('../test-support/testDb');

let db, seedThresholds;
let dropTestDb;

test.before(async () => {
  ({ dropTestDb } = await createIsolatedTestDb('seed_thresholds'));
  db = require('../src/db');
  ({ seedThresholds } = require('../src/seedThresholds'));
  await db.ready;
});

test.after(async () => {
  await db.close();
  await dropTestDb();
});

test('seedThresholds: creates the 4 default GLOBAL thresholds on an empty table', async () => {
  const results = await seedThresholds();
  assert.deepEqual(results.map((r) => r.action), ['created', 'created', 'created', 'created']);

  const rows = await db.prepare("SELECT parameter_type FROM thresholds WHERE scope_type = 'GLOBAL' AND is_active = 1 ORDER BY parameter_type").all();
  assert.deepEqual(rows.map((r) => r.parameter_type).sort(), ['ESCALATION_DAYS', 'INSPECTION_INTERVAL', 'NSD', 'PRESSURE']);

  const nsd = await db.prepare("SELECT * FROM thresholds WHERE parameter_type = 'NSD' AND scope_type = 'GLOBAL' AND is_active = 1").get();
  assert.equal(nsd.warning_max, 4);
  assert.equal(nsd.critical_max, 2);
});

test('seedThresholds: running it again is a no-op, never creates duplicates', async () => {
  const results = await seedThresholds();
  assert.deepEqual(results.map((r) => r.action), [
    'skipped (already exists)', 'skipped (already exists)', 'skipped (already exists)', 'skipped (already exists)',
  ]);

  const count = (await db.prepare("SELECT COUNT(*) c FROM thresholds WHERE scope_type = 'GLOBAL' AND is_active = 1").get()).c;
  assert.equal(count, 4);
});

test('seedThresholds: does not touch unrelated tables', async () => {
  const depot = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?) RETURNING *').get('Untouched Depot', 'UNT1');
  await seedThresholds();
  const stillThere = await db.prepare('SELECT * FROM depots WHERE id = ?').get(depot.id);
  assert.ok(stillThere, 'seedThresholds must never wipe or touch other tables (unlike seed.js\'s clearAll)');
});
