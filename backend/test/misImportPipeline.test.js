'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { createIsolatedTestDb } = require('../test-support/testDb');

let db, buildMasterDataCache, runWorkbookImport, findParserForSheet;
let dropTestDb;
let IMPORT_SESSION_ID;
let ADMIN_USER;

test.before(async () => {
  ({ dropTestDb } = await createIsolatedTestDb('mis_import_pipeline'));

  db = require('../src/db');
  ({ buildMasterDataCache } = require('../src/utils/misMasterDataCache'));
  ({ runWorkbookImport } = require('../src/misImport/importOrchestrator'));
  ({ findParserForSheet } = require('../src/misImport/parserRegistry'));
  require('../src/misImport/parsers/index');

  await db.ready;

  // mis_*_records.import_session_id is a real FK -- every test that
  // actually persists a row needs one genuine import_sessions row to
  // point at, not just an arbitrary number.
  const session = await db
    .prepare("INSERT INTO import_sessions (original_filename, stored_path, status) VALUES ('test.xlsx', '/tmp/test.xlsx', 'previewed') RETURNING *")
    .get();
  IMPORT_SESSION_ID = session.id;

  // tyre_events.performed_by is also a real FK -- createTyreEvent()'s
  // audit trail needs a genuine users row, not just a plausible-looking id.
  // Bound placeholders, not inlined literals: db.js's `?`/`@name` translator
  // doesn't know about quote context, so an inlined "...@example.com" would
  // itself get misparsed as a named placeholder.
  const admin = await db
    .prepare('INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?) RETURNING *')
    .get('test_admin', 'test_admin@example.com', 'x', 'Test Admin', 'System Administrator');
  ADMIN_USER = { id: admin.id, role: admin.role, depot_id: admin.depot_id };
});

test.after(async () => {
  await db.close();
  await dropTestDb();
});

// Mirrors the real "Puncture Repaire Details" sheet's column layout exactly
// (see misImport/parsers/punctureRepairParser.js) -- a synthetic in-memory
// workbook rather than a fixture file, so this test has no dependency on
// any file outside the repo.
function buildPunctureRepairWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Puncture Repaire Details');
  const header = ['Sr. No.', 'Depot', 'Month', 'Declared for Pun. Repair Date', 'Make (JK/Ceat)', 'Tyre No', 'NSD', 'Month', 'Repaired Date', 'Repair Patch Size', 'Supervisor', 'Tyre Man', 'Remarks'];
  sheet.addRow(header);
  rows.forEach((r, i) => {
    sheet.addRow([i + 1, r.depot, null, r.declaredDate, r.make, r.tyreNo, r.nsd, null, r.repairedDate, r.patchSize, r.supervisor, r.tyreMan, r.remarks]);
  });
  return { workbook, sheet };
}

function buildWorkbook(sheetBuilders) {
  const workbook = new ExcelJS.Workbook();
  for (const build of sheetBuilders) build(workbook);
  return workbook;
}

// Mirrors "Tyre Cons. New-Retread-Old Ok" (misImport/parsers/consumptionParser.js)
// exactly -- the one sheet whose rows can introduce both a brand-new tyre
// and (per the bus auto-provisioning change) a brand-new bus.
function buildConsumptionWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Tyre Cons. New-Retread-Old Ok');
  const header = new Array(19).fill(null);
  header[1] = 'Depot';
  header[2] = 'Invoice / Challan No.';
  header[4] = 'Invoice/Challan Date';
  header[5] = 'Date of Material Received/Ok-Spare';
  header[6] = 'Make (JK/Ceat)';
  header[7] = 'Non RTD/ RTD';
  header[8] = 'NSD';
  header[9] = 'Tyre Status(Cons.)';
  header[10] = 'New/Retread-Tyre Number';
  header[11] = 'Bus Number';
  header[12] = 'Tyre Position';
  header[14] = 'Fitment Date';
  header[15] = 'Fitment Kms';
  header[16] = 'Removed Tyre No.';
  header[17] = 'Remove Tyre NSD(Minimum)';
  header[18] = 'Reason for Removed';
  sheet.addRow(header);
  for (const r of rows) {
    const row = new Array(19).fill(null);
    row[1] = r.depot;
    row[2] = r.invoiceNo;
    row[4] = r.invoiceDate;
    row[5] = r.receivedDate;
    row[6] = r.make || 'JK';
    row[7] = r.tyreKind || 'New';
    row[8] = r.nsd ?? null;
    row[9] = r.consumptionStatus || 'New';
    row[10] = r.tyreNo;
    row[11] = r.busNo;
    row[12] = r.position;
    row[14] = r.fitmentDate;
    row[15] = r.fitmentKm ?? null;
    row[16] = r.removedTyreNo || null;
    sheet.addRow(row);
  }
  return { workbook, sheet };
}

let seedCounter = 0;
async function seedDepotBusTyre(overrides = {}) {
  seedCounter += 1;
  const unique = `${Date.now()}-${seedCounter}`;
  const depot = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?) RETURNING *').get(overrides.depotName || `Test Depot ${unique}`, overrides.depotCode || `TD${unique}`);
  const busModel = await db.prepare(
    "INSERT INTO bus_models (name, num_positions, position_labels_json) VALUES (?, 4, '[\"FR\",\"FL\",\"RR\",\"RL\"]') RETURNING *"
  ).get(`Model-${unique}`);
  const bus = await db.prepare(
    'INSERT INTO buses (depot_id, registration_no, chassis_no, bus_model_id, status) VALUES (?, ?, ?, ?, ?) RETURNING *'
  ).get(depot.id, overrides.busReg || `BUS-${unique}`, `CH-${unique}`, busModel.id, 'Active');
  const tyre = await db.prepare(
    "INSERT INTO tyres (tyre_number, brand, status, current_bus_id, current_position, current_depot_id) VALUES (?, 'JK', 'Active', ?, 'FR', ?) RETURNING *"
  ).get(overrides.tyreNumber || `TY-${unique}`, bus.id, depot.id);
  return { depot, bus, tyre };
}

// --- Parser correctness ---------------------------------------------------

test('punctureRepairParser: correctly extracts every mapped field', () => {
  const { workbook, sheet } = buildPunctureRepairWorkbook([
    { depot: 'Varanasi', declaredDate: new Date('2026-01-02'), make: 'JK', tyreNo: 'T-001', nsd: 11.5, repairedDate: new Date('2026-01-03'), patchSize: 6, supervisor: 'Anurag', tyreMan: 'Sanjay', remarks: '6mm patch' },
  ]);
  const found = findParserForSheet(sheet);
  assert.ok(found.parser, `expected a parser match, got ${JSON.stringify(found)}`);
  const rows = found.parser.parse(sheet);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].depot_raw, 'Varanasi');
  assert.equal(rows[0].tyre_number_raw, 'T-001');
  assert.equal(rows[0].nsd, 11.5);
  assert.equal(rows[0].supervisor_name, 'Anurag');
  assert.equal(rows[0].remarks, '6mm patch');
  assert.equal(rows[0].declared_date, '2026-01-02');
  assert.equal(rows[0].repaired_date, '2026-01-03');
});

test('punctureRepairParser: a row missing the tyre number is still parsed but flagged as rejected downstream', async () => {
  const { depot } = await seedDepotBusTyre();
  const { workbook, sheet } = buildPunctureRepairWorkbook([
    { depot: depot.name, declaredDate: new Date('2026-01-02'), make: 'JK', tyreNo: null, nsd: 11.5, repairedDate: new Date('2026-01-03') },
  ]);
  const cache = await buildMasterDataCache();
  const result = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: true, user: ADMIN_USER, masterDataCache: cache });
  const sheetResult = result.sheets.find((s) => s.name === 'Puncture Repaire Details');
  assert.equal(sheetResult.status, 'ok');
  assert.equal(sheetResult.perRow[0].outcome, 'rejected_shape');
  assert.match(sheetResult.perRow[0].reason, /tyre_number_raw/);
});

// --- Dry-run / live parity + decoupled outcomes ---------------------------

test('runWorkbookImport: dry-run persists nothing, live persists the MIS record and real lifecycle events', async () => {
  const { depot, tyre } = await seedDepotBusTyre({ tyreNumber: `PARITY-${Date.now()}` });
  const { workbook } = buildPunctureRepairWorkbook([
    { depot: depot.name, declaredDate: '2026-02-01', make: 'JK', tyreNo: tyre.tyre_number, nsd: 10, repairedDate: '2026-02-02', patchSize: 6, supervisor: 'S', tyreMan: 'T', remarks: 'ok' },
  ]);

  const cache = await buildMasterDataCache();

  const dry = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: true, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(dry.totalStored, 1);
  const misCountAfterDry = (await db.prepare('SELECT COUNT(*) c FROM mis_puncture_records WHERE tyre_id = ?').get(tyre.id)).c;
  const eventCountAfterDry = (await db.prepare('SELECT COUNT(*) c FROM tyre_events WHERE tyre_id = ?').get(tyre.id)).c;
  assert.equal(misCountAfterDry, 0, 'dry run must not persist MIS records');
  assert.equal(eventCountAfterDry, 0, 'dry run must not persist tyre_events');

  const live = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(live.totalStored, 1);
  const misRow = await db.prepare('SELECT * FROM mis_puncture_records WHERE tyre_id = ?').get(tyre.id);
  assert.ok(misRow, 'live run must persist the MIS record');
  assert.equal(misRow.linkage_status, 'linked');
  const events = await db.prepare('SELECT event_type FROM tyre_events WHERE tyre_id = ? ORDER BY id').all(tyre.id);
  assert.deepEqual(events.map((e) => e.event_type), ['send_to_repair', 'puncture_repair']);
});

test('runWorkbookImport: a tyre number with no prior history is auto-provisioned so the row still links', async () => {
  const { depot } = await seedDepotBusTyre();
  // No tyre seeded for this number -- unlike Consumption, Puncture Repair
  // never expects to introduce a brand-new tyre, but on a cold database (or
  // simply a tyre whose own Consumption row predates this workbook) that's
  // exactly what a real MIS export looks like. Tyre auto-provisioning
  // (mirrors bus auto-provisioning) creates a placeholder tyre instead of
  // leaving the row stranded.
  const unresolvableTyreNumber = `NOEXIST-${Date.now()}`;
  const { workbook } = buildPunctureRepairWorkbook([
    { depot: depot.name, declaredDate: '2026-02-01', make: 'JK', tyreNo: unresolvableTyreNumber, nsd: 10, repairedDate: '2026-02-02' },
  ]);
  const cache = await buildMasterDataCache();
  const live = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(live.totalStored, 1);
  const misRow = await db.prepare('SELECT * FROM mis_puncture_records WHERE tyre_number_raw = ?').get(unresolvableTyreNumber);
  assert.ok(misRow, 'MIS record must persist');
  assert.ok(misRow.tyre_id, 'a placeholder tyre must be auto-created so the event can attach to a real tyre_id');
  assert.equal(misRow.linkage_status, 'linked');

  const tyreRow = await db.prepare('SELECT * FROM tyres WHERE id = ?').get(misRow.tyre_id);
  assert.equal(tyreRow.tyre_number, unresolvableTyreNumber);
  assert.equal(tyreRow.brand, 'JK');
  assert.equal(tyreRow.current_depot_id, depot.id);

  const events = await db.prepare('SELECT event_type FROM tyre_events WHERE tyre_id = ? ORDER BY id').all(misRow.tyre_id);
  assert.deepEqual(events.map((e) => e.event_type), ['send_to_repair', 'puncture_repair']);
});

test('runWorkbookImport: an MIS record persists even when its lifecycle event cannot be created (decoupled outcome)', async () => {
  const { depot, bus } = await seedDepotBusTyre();
  // seedDepotBusTyre already fitted a tyre onto this bus's FR position -- a
  // second, brand-new tyre whose row claims the same position is a real,
  // legitimate failure (not a resolution gap): purchase_intake still
  // succeeds and the MIS record still persists, only the fitment fails,
  // exactly the "decoupled outcome" this test is named for (§1).
  const conflictingTyreNumber = `CONFLICT-${Date.now()}`;
  const { workbook } = buildConsumptionWorkbook([
    { depot: depot.name, invoiceNo: 'INV-X', invoiceDate: '2026-02-01', receivedDate: '2026-02-01', tyreNo: conflictingTyreNumber, busNo: bus.registration_no, position: 'FR', fitmentDate: '2026-02-02', fitmentKm: 50 },
  ]);
  const cache = await buildMasterDataCache();
  const live = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(live.totalStored, 1);
  const misRow = await db.prepare('SELECT * FROM mis_consumption_records WHERE tyre_number_raw = ?').get(conflictingTyreNumber);
  assert.ok(misRow, 'MIS record must persist even though the fitment failed');
  assert.equal(misRow.linkage_status, 'partially_linked');

  const tyreRow = await db.prepare('SELECT * FROM tyres WHERE tyre_number = ?').get(conflictingTyreNumber);
  assert.ok(tyreRow, 'purchase_intake must still have created the tyre');
  assert.equal(tyreRow.current_bus_id, null, 'the failed fitment must never have mounted it');
});

// --- Fingerprint 3-way classification -------------------------------------

test('fingerprint classification: new -> exact duplicate -> conflicting duplicate', async () => {
  const { depot, tyre } = await seedDepotBusTyre({ tyreNumber: `FP-${Date.now()}` });
  const seededTyre = await db.prepare('SELECT tyre_number FROM tyres WHERE id = ?').get(tyre.id);

  const makeWorkbook = (remarks) => {
    const { workbook } = buildPunctureRepairWorkbook([
      { depot: depot.name, declaredDate: '2026-03-01', make: 'JK', tyreNo: seededTyre.tyre_number, nsd: 9, repairedDate: '2026-03-02', remarks },
    ]);
    return workbook;
  };

  const cache = await buildMasterDataCache();

  const first = await runWorkbookImport(makeWorkbook('first pass'), { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  const firstOutcome = first.sheets[0].perRow.find((r) => r.outcome === 'stored');
  assert.ok(firstOutcome, 'first import should classify as new and store');

  const exactRepeat = await runWorkbookImport(makeWorkbook('first pass'), { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(exactRepeat.sheets[0].perRow[0].outcome, 'skipped_exact_duplicate');

  const conflicting = await runWorkbookImport(makeWorkbook('CORRECTED remarks'), { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(conflicting.sheets[0].perRow[0].outcome, 'flagged_conflicting_duplicate');

  const misCount = (await db.prepare('SELECT COUNT(*) c FROM mis_puncture_records WHERE tyre_id = ?').get(tyre.id)).c;
  assert.equal(misCount, 1, 'only the first, "new" row should ever have been persisted');
});

test('fingerprint classification: two different unresolved tyres on the same date must not collide onto one fingerprint', async () => {
  const { depot } = await seedDepotBusTyre();
  const ts = Date.now();
  // Neither tyre has been seen before -- both tyre_id resolve to null at
  // Tier 1 time. Sharing declared_date/repaired_date (the rest of
  // puncture_repair's fingerprint key) used to be enough to make the
  // second row misclassify as a "conflicting duplicate" of the first, since
  // the key hashed bare tyre_id (null for both) instead of falling back to
  // the raw tyre number the way Consumption's own key always has.
  const { workbook } = buildPunctureRepairWorkbook([
    { depot: depot.name, declaredDate: '2026-04-01', make: 'JK', tyreNo: `COLLIDE-A-${ts}`, nsd: 9, repairedDate: '2026-04-02' },
    { depot: depot.name, declaredDate: '2026-04-01', make: 'JK', tyreNo: `COLLIDE-B-${ts}`, nsd: 9, repairedDate: '2026-04-02' },
  ]);
  const cache = await buildMasterDataCache();
  const result = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  const outcomes = result.sheets[0].perRow.map((r) => r.outcome);
  assert.deepEqual(outcomes, ['stored', 'stored'], `both distinct tyres should classify as new, got: ${JSON.stringify(outcomes)}`);
});

// --- Cross-sheet chronological merge ---------------------------------------

test('runWorkbookImport: rows from different sheets for the same tyre land in one chunk, chronologically ordered', async () => {
  const { depot, bus, tyre } = await seedDepotBusTyre({ tyreNumber: `XSHEET-${Date.now()}` });
  const seededTyre = await db.prepare('SELECT tyre_number FROM tyres WHERE id = ?').get(tyre.id);
  const seededBus = await db.prepare('SELECT registration_no FROM buses WHERE id = ?').get(bus.id);

  const workbook = buildWorkbook([
    (wb) => {
      const sheet = wb.addWorksheet('Puncture Repaire Details');
      sheet.addRow(['Sr. No.', 'Depot', 'Month', 'Declared for Pun. Repair Date', 'Make (JK/Ceat)', 'Tyre No', 'NSD', 'Month', 'Repaired Date', 'Repair Patch Size', 'Supervisor', 'Tyre Man', 'Remarks']);
      sheet.addRow([1, depot.name, null, '2026-04-10', 'JK', seededTyre.tyre_number, 8, null, '2026-04-11', 6, 'S', 'T', 'later repair']);
    },
    (wb) => {
      const sheet = wb.addWorksheet('Tyre Rotation');
      sheet.addRow(['Sr. No. ', 'Packages', 'Location', 'Month', 'Bus No. ', 'Current Kms', 'KMs @ Rotation', 'Due Date of Rotation', 'Date of Rotation',
        'NSD', 'Stencil No.', 'New Location', 'NSD', 'Stencil No.', 'New Location', 'NSD', 'Stencil No.', 'New Location',
        'NSD', 'Stencil No.', 'New Location', 'NSD', 'Stencil No.', 'New Location', 'NSD', 'Stencil No.', 'New Location', 'Status', 'Remark']);
      sheet.addRow([1, null, depot.name, null, seededBus.registration_no, 10000, 9500, '2026-04-01', '2026-04-05',
        9, seededTyre.tyre_number, 'FL', null, null, null, null, null, null,
        null, null, null, null, null, null, null, null, null, 'Done', 'earlier rotation']);
    },
  ]);

  const cache = await buildMasterDataCache();
  const live = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(live.totalStored, 2, JSON.stringify(live.sheets.map((s) => ({ name: s.name, perRow: s.perRow }))));

  const events = await db.prepare('SELECT event_type, event_date FROM tyre_events WHERE tyre_id = ? ORDER BY id').all(tyre.id);
  // Rotation (2026-04-05) happened before the puncture repair sequence
  // (2026-04-10/11) -- correct only if both sheets were merged into one
  // chronologically-sorted replay, not replayed independently per sheet.
  assert.equal(events[0].event_type, 'rotation');
  const dates = events.map((e) => e.event_date);
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted, `events should already be in chronological order: ${JSON.stringify(dates)}`);
});

// --- Bus auto-provisioning ---------------------------------------------------

test('bus auto-provisioning: a dry run never creates the missing bus', async () => {
  const depot = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?) RETURNING *').get(`Dry Depot ${Date.now()}`, `DRY${Date.now()}`);
  const busReg = `AUTOBUS-DRY-${Date.now()}`;
  const { workbook } = buildConsumptionWorkbook([
    { depot: depot.name, invoiceNo: 'INV-DRY', invoiceDate: '2026-05-01', receivedDate: '2026-05-01', tyreNo: `DRYTY-${Date.now()}`, busNo: busReg, position: 'FL', fitmentDate: '2026-05-02', fitmentKm: 100 },
  ]);
  const cache = await buildMasterDataCache();
  const dry = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: true, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(dry.totalStored, 1);
  const bus = await db.prepare('SELECT * FROM buses WHERE registration_no = ?').get(busReg.toUpperCase());
  assert.equal(bus, undefined, 'preview must not create a bus');
});

test('bus auto-provisioning: an unknown bus is created from the row, fitment links correctly, and re-referencing it never creates a duplicate', async () => {
  const ts = Date.now();
  const depot = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?) RETURNING *').get(`Auto Depot ${ts}`, `AUTO${ts}`);
  const busReg = `AUTOBUS-${ts}`;
  const tyreA = `AUTOTY-A-${ts}`;
  const tyreB = `AUTOTY-B-${ts}`;

  // Two different tyres, in the same workbook, both fitting onto the same
  // not-yet-existing bus -- exercises the in-run overlay (the second row's
  // chunk must reuse the first row's creation, never attempt a second
  // INSERT) as well as the creation itself.
  const { workbook } = buildConsumptionWorkbook([
    { depot: depot.name, invoiceNo: 'INV-A', invoiceDate: '2026-05-01', receivedDate: '2026-05-01', tyreNo: tyreA, busNo: busReg, position: 'FL', fitmentDate: '2026-05-02', fitmentKm: 100 },
    { depot: depot.name, invoiceNo: 'INV-B', invoiceDate: '2026-05-01', receivedDate: '2026-05-01', tyreNo: tyreB, busNo: busReg, position: 'FR', fitmentDate: '2026-05-02', fitmentKm: 100 },
  ]);

  const cache = await buildMasterDataCache();
  const live = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(live.totalStored, 2, JSON.stringify(live.sheets.map((s) => ({ name: s.name, perRow: s.perRow }))));

  const busRows = await db.prepare('SELECT * FROM buses WHERE registration_no = ?').all(busReg.toUpperCase());
  assert.equal(busRows.length, 1, 'exactly one bus should have been created for two rows referencing it in the same import');
  const bus = busRows[0];
  assert.equal(bus.depot_id, depot.id);
  assert.equal(bus.status, 'Active');
  assert.ok(bus.chassis_no, 'chassis_no must be set (NOT NULL) even with no source data for it');

  const tyreARow = await db.prepare('SELECT * FROM tyres WHERE tyre_number = ?').get(tyreA);
  const tyreBRow = await db.prepare('SELECT * FROM tyres WHERE tyre_number = ?').get(tyreB);
  assert.equal(tyreARow.current_bus_id, bus.id);
  assert.equal(tyreARow.current_position, 'FL');
  assert.equal(tyreBRow.current_bus_id, bus.id);
  assert.equal(tyreBRow.current_position, 'FR');

  const fitmentEvents = await db.prepare("SELECT * FROM tyre_events WHERE event_type = 'fitment_created' AND bus_id = ?").all(bus.id);
  assert.equal(fitmentEvents.length, 2, 'both fitments must be linked to the real, auto-created bus id');

  // A later import (a fresh Master Data Cache, as a genuinely separate
  // import run would build) referencing the same registration number must
  // resolve the already-created bus rather than creating a second one.
  const tyreC = `AUTOTY-C-${ts}`;
  const { workbook: laterWorkbook } = buildConsumptionWorkbook([
    { depot: depot.name, invoiceNo: 'INV-C', invoiceDate: '2026-06-01', receivedDate: '2026-06-01', tyreNo: tyreC, busNo: busReg, position: 'RL-O', fitmentDate: '2026-06-02', fitmentKm: 200 },
  ]);
  const laterCache = await buildMasterDataCache();
  const laterLive = await runWorkbookImport(laterWorkbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: laterCache });
  assert.equal(laterLive.totalStored, 1);

  const busRowsAfter = await db.prepare('SELECT * FROM buses WHERE registration_no = ?').all(busReg.toUpperCase());
  assert.equal(busRowsAfter.length, 1, 'a later import referencing the same bus must never create a duplicate');

  const tyreCRow = await db.prepare('SELECT * FROM tyres WHERE tyre_number = ?').get(tyreC);
  assert.equal(tyreCRow.current_bus_id, bus.id, 'the later import must link onto the same, already-created bus');
});

test('depot auto-provisioning: a dry run never creates the missing depot', async () => {
  const depotName = `Dry Depot Auto ${Date.now()}`;
  const { workbook } = buildConsumptionWorkbook([
    { depot: depotName, invoiceNo: 'INV-DRYD', invoiceDate: '2026-05-01', receivedDate: '2026-05-01', tyreNo: `DRYDEPTY-${Date.now()}`, busNo: null, position: null, fitmentDate: null },
  ]);
  const cache = await buildMasterDataCache();
  const dry = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: true, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(dry.totalStored, 1);
  const depot = await db.prepare('SELECT * FROM depots WHERE name = ?').get(depotName);
  assert.equal(depot, undefined, 'preview must not create a depot');
});

test('depot auto-provisioning: an unknown depot name creates the depot, and also unblocks bus auto-provisioning under it', async () => {
  const ts = Date.now();
  const depotName = `Auto Depot ${ts}`;
  const busReg = `AUTOBUS-DEP-${ts}`;
  const tyreNumber = `AUTODEPTY-${ts}`;

  // A depot and a bus neither one exists yet, both referenced by the same
  // row -- exercises the ordering requirement (replayEngine.js): the depot
  // has to be created, and misRecord.depot_id updated, before bus
  // auto-provisioning runs, since buses.depot_id is NOT NULL.
  const { workbook } = buildConsumptionWorkbook([
    { depot: depotName, invoiceNo: 'INV-DEP', invoiceDate: '2026-05-01', receivedDate: '2026-05-01', tyreNo: tyreNumber, busNo: busReg, position: 'FL', fitmentDate: '2026-05-02', fitmentKm: 100 },
  ]);
  const cache = await buildMasterDataCache();
  const live = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(live.totalStored, 1, JSON.stringify(live.sheets.map((s) => ({ name: s.name, perRow: s.perRow }))));

  const depotRows = await db.prepare('SELECT * FROM depots WHERE name = ?').all(depotName);
  assert.equal(depotRows.length, 1, 'exactly one depot should have been created');
  const depot = depotRows[0];
  assert.ok(depot.code, 'code must be set (NOT NULL) even with no source data for it');

  const misRow = await db.prepare('SELECT * FROM mis_consumption_records WHERE tyre_number_raw = ?').get(tyreNumber);
  assert.equal(misRow.depot_id, depot.id, 'the persisted MIS record must carry the real depot_id, not null');

  const bus = await db.prepare('SELECT * FROM buses WHERE registration_no = ?').get(busReg.toUpperCase());
  assert.equal(bus.depot_id, depot.id, 'the auto-created bus must belong to the auto-created depot');

  const tyreRow = await db.prepare('SELECT * FROM tyres WHERE tyre_number = ?').get(tyreNumber);
  assert.equal(tyreRow.current_depot_id, depot.id);

  // A later row referencing the same depot name must resolve it, not
  // create a second one.
  const tyreNumber2 = `AUTODEPTY2-${ts}`;
  const { workbook: laterWorkbook } = buildConsumptionWorkbook([
    { depot: depotName, invoiceNo: 'INV-DEP2', invoiceDate: '2026-06-01', receivedDate: '2026-06-01', tyreNo: tyreNumber2, busNo: null, position: null, fitmentDate: null },
  ]);
  const laterCache = await buildMasterDataCache();
  const laterLive = await runWorkbookImport(laterWorkbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: laterCache });
  assert.equal(laterLive.totalStored, 1);
  const depotRowsAfter = await db.prepare('SELECT * FROM depots WHERE name = ?').all(depotName);
  assert.equal(depotRowsAfter.length, 1, 'a later import referencing the same depot name must never create a duplicate');
});

// --- Replacement detection --------------------------------------------------

test('replacement detection: a Consumption row naming an unresolved removed tyre generates a real replacement, not a bare fitment', async () => {
  const ts = Date.now();
  const depot = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?) RETURNING *').get(`Repl Depot ${ts}`, `REPL${ts}`);
  const busReg = `REPLBUS-${ts}`;
  const incomingTyre = `REPL-IN-${ts}`;
  const outgoingTyre = `REPL-OUT-${ts}`;

  const { workbook } = buildConsumptionWorkbook([
    {
      depot: depot.name, invoiceNo: 'INV-REPL', invoiceDate: '2026-05-01', receivedDate: '2026-05-01',
      tyreNo: incomingTyre, busNo: busReg, position: 'FL', fitmentDate: '2026-05-02', fitmentKm: 500,
      removedTyreNo: outgoingTyre,
    },
  ]);
  const cache = await buildMasterDataCache();
  const live = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(live.totalStored, 1, JSON.stringify(live.sheets.map((s) => ({ name: s.name, perRow: s.perRow }))));

  const misRow = await db.prepare('SELECT * FROM mis_consumption_records WHERE tyre_number_raw = ?').get(incomingTyre);
  assert.equal(misRow.linkage_status, 'linked');

  const incomingRow = await db.prepare('SELECT * FROM tyres WHERE tyre_number = ?').get(incomingTyre);
  const outgoingRow = await db.prepare('SELECT * FROM tyres WHERE tyre_number = ?').get(outgoingTyre);
  assert.ok(outgoingRow, 'the removed tyre must be auto-provisioned, not left unresolved');
  assert.equal(misRow.removed_tyre_id, outgoingRow.id, 'the persisted MIS record must point at the real removed tyre, not null');

  // The incoming tyre ends up mounted where the outgoing one was; the
  // outgoing one ends up back In Store, unmounted -- exactly what a manual
  // replacement does (createReplacement in utils/tyreEvents.js).
  const bus = await db.prepare('SELECT id FROM buses WHERE registration_no = ?').get(busReg.toUpperCase());
  assert.equal(incomingRow.status, 'Active');
  assert.equal(incomingRow.current_bus_id, bus.id);
  assert.equal(incomingRow.current_position, 'FL');
  assert.equal(outgoingRow.status, 'In Store');
  assert.equal(outgoingRow.current_bus_id, null);

  const events = await db.prepare(`
    SELECT tyre_id, event_type, related_tyre_id FROM tyre_events
    WHERE tyre_id IN (?, ?) ORDER BY id
  `).all(incomingRow.id, outgoingRow.id);
  const eventTypes = events.map((e) => e.event_type);
  assert.deepEqual(eventTypes, ['purchase_intake', 'fitment_created', 'replacement', 'replacement']);
  const replacementEvents = events.filter((e) => e.event_type === 'replacement');
  assert.deepEqual(replacementEvents.map((e) => e.tyre_id).sort(), [incomingRow.id, outgoingRow.id].sort());
});

test('replacement detection: an already-known removed tyre is reused, never re-created', async () => {
  const { depot, bus, tyre: outgoingTyre } = await seedDepotBusTyre();
  const ts = Date.now();
  const incomingTyre = `REPL-KNOWN-${ts}`;

  const { workbook } = buildConsumptionWorkbook([
    {
      depot: depot.name, invoiceNo: 'INV-KNOWN', invoiceDate: '2026-05-01', receivedDate: '2026-05-01',
      tyreNo: incomingTyre, busNo: bus.registration_no, position: outgoingTyre.current_position || 'FR', fitmentDate: '2026-05-02',
      removedTyreNo: outgoingTyre.tyre_number,
    },
  ]);
  const cache = await buildMasterDataCache();
  const live = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(live.totalStored, 1, JSON.stringify(live.sheets.map((s) => ({ name: s.name, perRow: s.perRow }))));

  const misRow = await db.prepare('SELECT * FROM mis_consumption_records WHERE tyre_number_raw = ?').get(incomingTyre);
  assert.equal(misRow.removed_tyre_id, outgoingTyre.id, 'must resolve the already-known tyre, not create a new one');
  assert.equal(misRow.linkage_status, 'linked');

  const outgoingAfter = await db.prepare('SELECT * FROM tyres WHERE id = ?').get(outgoingTyre.id);
  assert.equal(outgoingAfter.status, 'In Store');
});

// --- Tyre Life Report field population --------------------------------------

test('Tyre Life fields: purchase_date and fitment odometer_km are captured from the Consumption sheet', async () => {
  const ts = Date.now();
  const depot = await db.prepare('INSERT INTO depots (name, code) VALUES (?, ?) RETURNING *').get(`Life Depot ${ts}`, `LIFE${ts}`);
  const busReg = `LIFEBUS-${ts}`;
  const tyreNo = `LIFE-TY-${ts}`;

  const { workbook } = buildConsumptionWorkbook([
    {
      depot: depot.name, invoiceNo: 'INV-LIFE', invoiceDate: '2026-05-10', receivedDate: '2026-05-11',
      tyreNo, busNo: busReg, position: 'FR', fitmentDate: '2026-05-12', fitmentKm: 12345,
    },
  ]);
  const cache = await buildMasterDataCache();
  const live = await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });
  assert.equal(live.totalStored, 1);

  const tyreRow = await db.prepare('SELECT * FROM tyres WHERE tyre_number = ?').get(tyreNo);
  assert.equal(tyreRow.purchase_date, '2026-05-10', 'purchase_date should backfill from the sheet\'s invoice date');

  const fitmentEvent = await db.prepare("SELECT * FROM tyre_events WHERE tyre_id = ? AND event_type = 'fitment_created'").get(tyreRow.id);
  assert.equal(fitmentEvent.odometer_km, 12345, 'fitment odometer_km should come from the sheet\'s Fitment Kms column');
});

test('Tyre Life fields: an auto-provisioned historical tyre (not from Consumption) gets no fabricated purchase_date', async () => {
  const { depot } = await seedDepotBusTyre();
  const ts = Date.now();
  const tyreNo = `HIST-TY-${ts}`;
  const { workbook } = buildPunctureRepairWorkbook([
    { depot: depot.name, declaredDate: '2026-02-01', make: 'JK', tyreNo, nsd: 10, repairedDate: '2026-02-02' },
  ]);
  const cache = await buildMasterDataCache();
  await runWorkbookImport(workbook, { importSessionId: IMPORT_SESSION_ID, dryRun: false, user: ADMIN_USER, masterDataCache: cache });

  const tyreRow = await db.prepare('SELECT * FROM tyres WHERE tyre_number = ?').get(tyreNo);
  assert.ok(tyreRow, 'the tyre should still be auto-provisioned');
  assert.equal(tyreRow.purchase_date, null, 'a tyre this sheet never states an acquisition date for must not get a fabricated one');
});
