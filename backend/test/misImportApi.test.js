'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { createIsolatedTestDb } = require('../test-support/testDb');

let db, app, jwt, JWT_SECRET, startImportJobQueue, stopImportJobQueue;
let dropTestDb, server, baseUrl;
let adminToken, dmToken;
let fixtures;

test.before(async () => {
  ({ dropTestDb } = await createIsolatedTestDb('mis_import_api'));

  db = require('../src/db');
  jwt = require('jsonwebtoken');
  ({ JWT_SECRET } = require('../src/middleware/auth'));
  ({ startImportJobQueue, stopImportJobQueue } = require('../src/misImport/importJobQueue'));
  app = require('../src/app');

  await db.ready;
  await startImportJobQueue();

  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const admin = await db
    .prepare('INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?) RETURNING *')
    .get('api_test_admin', 'api_test_admin@example.com', 'x', 'Admin', 'System Administrator');
  adminToken = jwt.sign({ id: admin.id, username: admin.username, role: admin.role, depot_id: null }, JWT_SECRET, { expiresIn: '1h' });

  const dm = await db
    .prepare('INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?) RETURNING *')
    .get('api_test_dm', 'api_test_dm@example.com', 'x', 'Depot Manager', 'Depot Manager');
  dmToken = jwt.sign({ id: dm.id, username: dm.username, role: dm.role, depot_id: null }, JWT_SECRET, { expiresIn: '1h' });

  // Master data the sample workbook's rows can actually resolve against.
  const depot = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?) RETURNING *').get('API Test Depot', 'ATD');
  const busModel = await db
    .prepare("INSERT INTO bus_models (name, num_positions, position_labels_json) VALUES (?, 4, '[\"FR\",\"FL\",\"RR\",\"RL\"]') RETURNING *")
    .get('API Test Model');
  const bus = await db
    .prepare('INSERT INTO buses (depot_id, registration_no, chassis_no, bus_model_id, status) VALUES (?, ?, ?, ?, ?) RETURNING *')
    .get(depot.id, 'API-BUS-1', 'API-CH-1', busModel.id, 'Active');
  await db
    .prepare("INSERT INTO tyres (tyre_number, brand, status, current_bus_id, current_position, current_depot_id) VALUES (?, 'JK', 'Active', ?, 'FR', ?)")
    .run('API-TYRE-1', bus.id, depot.id);

  fixtures = { depotName: depot.name, tyreNumber: 'API-TYRE-1' };
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopImportJobQueue();
  await db.close();
  await dropTestDb();
});

function buildWorkbookBuffer({ depotName, tyreNumber }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Puncture Repaire Details');
  sheet.addRow(['Sr. No.', 'Depot', 'Month', 'Declared for Pun. Repair Date', 'Make (JK/Ceat)', 'Tyre No', 'NSD', 'Month', 'Repaired Date', 'Repair Patch Size', 'Supervisor', 'Tyre Man', 'Remarks']);
  sheet.addRow([1, depotName, null, '2026-05-01', 'JK', tyreNumber, 9, null, '2026-05-02', 6, 'S', 'T', 'api test']);
  return workbook.xlsx.writeBuffer();
}

async function upload(token, filename = 'test.xlsx') {
  const buffer = await buildWorkbookBuffer(fixtures);
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  return fetch(`${baseUrl}/api/mis-imports`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}

test('POST /api/mis-imports is Administrator-only', async () => {
  const res = await upload(dmToken);
  assert.equal(res.status, 403);
});

test('POST /api/mis-imports requires authentication', async () => {
  const res = await fetch(`${baseUrl}/api/mis-imports`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('POST /api/mis-imports rejects non-Excel content even with a plausible filename', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('not a real xlsx file')]), 'fake.xlsx');
  const res = await fetch(`${baseUrl}/api/mis-imports`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: form });
  assert.equal(res.status, 400);
});

test('full lifecycle: upload -> preview -> confirm -> committed, with correct counts throughout', async () => {
  const uploadRes = await upload(adminToken);
  assert.equal(uploadRes.status, 201);
  const uploadBody = await uploadRes.json();
  assert.equal(uploadBody.status, 'previewed');
  assert.equal(uploadBody.totalParsed, 1);
  assert.equal(uploadBody.totalStored, 1);

  const sessionId = uploadBody.importSessionId;

  const detailRes = await fetch(`${baseUrl}/api/mis-imports/${sessionId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const detail = await detailRes.json();
  assert.equal(detail.status, 'previewed');
  assert.equal(detail.rows_stored, 0, 'preview must not have persisted anything yet');
  assert.ok(detail.sheets.some((s) => s.name === 'Puncture Repaire Details' && s.stored === 1));

  const rowsRes = await fetch(`${baseUrl}/api/mis-imports/${sessionId}/rows`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const rowsBody = await rowsRes.json();
  assert.equal(rowsBody.total, 1);

  // Confirming as a non-Admin must fail before we even try the real confirm.
  const dmConfirmRes = await fetch(`${baseUrl}/api/mis-imports/${sessionId}/confirm`, { method: 'POST', headers: { Authorization: `Bearer ${dmToken}` } });
  assert.equal(dmConfirmRes.status, 403);

  const confirmRes = await fetch(`${baseUrl}/api/mis-imports/${sessionId}/confirm`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(confirmRes.status, 202);
  const confirmBody = await confirmRes.json();
  assert.equal(confirmBody.status, 'queued');
  assert.ok(confirmBody.jobId);

  let finalStatus;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const pollRes = await fetch(`${baseUrl}/api/mis-imports/${sessionId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
    finalStatus = await pollRes.json();
    if (['committed', 'failed'].includes(finalStatus.status)) break;
  }
  assert.equal(finalStatus.status, 'committed', JSON.stringify(finalStatus));
  assert.equal(finalStatus.rows_stored, 1);
  assert.equal(finalStatus.events_linked, 1);

  // Confirming an already-committed session must be rejected.
  const doubleConfirmRes = await fetch(`${baseUrl}/api/mis-imports/${sessionId}/confirm`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(doubleConfirmRes.status, 409);

  // Cancelling an already-committed session must also be rejected.
  const cancelRes = await fetch(`${baseUrl}/api/mis-imports/${sessionId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(cancelRes.status, 409);
});

test('cancel: a previewed session can be discarded and can never be confirmed afterward', async () => {
  const uploadRes = await upload(adminToken);
  const { importSessionId } = await uploadRes.json();

  const cancelRes = await fetch(`${baseUrl}/api/mis-imports/${importSessionId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(cancelRes.status, 200);
  const cancelBody = await cancelRes.json();
  assert.equal(cancelBody.status, 'cancelled');

  const confirmRes = await fetch(`${baseUrl}/api/mis-imports/${importSessionId}/confirm`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(confirmRes.status, 409);
});

test('kill switch: disabling mis_import_enabled blocks the whole router, re-enabling restores it', async () => {
  const disableRes = await fetch(`${baseUrl}/api/settings/mis_import_enabled`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'false' }),
  });
  assert.equal(disableRes.status, 200);

  const listRes = await fetch(`${baseUrl}/api/mis-imports`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(listRes.status, 503);

  const enableRes = await fetch(`${baseUrl}/api/settings/mis_import_enabled`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'true' }),
  });
  assert.equal(enableRes.status, 200);

  const listAfterRes = await fetch(`${baseUrl}/api/mis-imports`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(listAfterRes.status, 200);
});
