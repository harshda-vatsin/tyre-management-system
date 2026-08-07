/**
 * @file backfillLifecycleEvents.js
 * @description One-off, idempotent backfill for tyres whose current status
 * has no corresponding tyre_events row -- fixes the exact data inconsistency
 * that motivated this refactor (e.g. status='Under Repair' with zero
 * puncture_repair events, or status='In Store'/'Condemned' the same way).
 * Every inserted row is marked system_backfilled=1 so the UI can flag it
 * distinctly from a real user-entered event, and each insert gets its own
 * audit_log row (attributed to 'system', same as any other automated
 * action) so the audit trail covers backfilled history too.
 *
 * Safe to re-run: each rule only inserts for tyres that still lack the
 * event it's responsible for, so a second run is a no-op.
 *
 * Run with: npm run backfill
 */

const db = require('../db');
const { writeAuditLog } = require('../utils/auditLog');

const BACKFILL_REASON = 'System Backfilled - historical data reconstruction';

const insertSendToStore = db.prepare(`
  INSERT INTO tyre_events (tyre_id, event_type, event_date, depot_id, reason, stored_at, nsd_value, system_backfilled, performed_by)
  VALUES (?, 'send_to_store', ?, ?, ?, ?, ?, 1, NULL)
`);
const insertSendToRepair = db.prepare(`
  INSERT INTO tyre_events (tyre_id, event_type, event_date, depot_id, reason, system_backfilled, performed_by)
  VALUES (?, 'send_to_repair', ?, ?, ?, 1, NULL)
`);
const insertCondemnation = db.prepare(`
  INSERT INTO tyre_events (tyre_id, event_type, event_date, depot_id, nsd_value, reason, system_backfilled, performed_by)
  VALUES (?, 'condemnation', ?, ?, ?, ?, 1, NULL)
`);
const insertPurchaseIntake = db.prepare(`
  INSERT INTO tyre_events (tyre_id, event_type, event_date, bus_id, position, depot_id, notes, system_backfilled, performed_by)
  VALUES (?, 'purchase_intake', ?, ?, ?, ?, ?, 1, NULL)
`);
const getEvent = db.prepare('SELECT * FROM tyre_events WHERE id = ?');

async function auditBackfilledEvent(event) {
  await writeAuditLog({ user: null, action: 'CREATE', entityType: 'tyre_event', entityId: event.id, after: event });
}

async function run() {
  const summary = { sendToStore: 0, punctureRepair: 0, condemnation: 0, purchaseIntake: 0 };

  const txn = db.transaction(async () => {
    // 1. 'In Store' tyres with no send_to_store event.
    const inStoreMissing = await db.prepare(`
      SELECT t.* FROM tyres t
      WHERE t.status = 'In Store'
      AND NOT EXISTS (SELECT 1 FROM tyre_events e WHERE e.tyre_id = t.id AND e.event_type = 'send_to_store')
    `).all();
    for (const tyre of inStoreMissing) {
      const info = await insertSendToStore.run(
        tyre.id, tyre.updated_at || tyre.created_at, tyre.current_depot_id,
        BACKFILL_REASON, 'Unknown (system backfilled)', tyre.initial_nsd ?? null
      );
      await auditBackfilledEvent(await getEvent.get(info.lastInsertRowid));
      summary.sendToStore++;
    }

    // 2. 'Under Repair' tyres with no send_to_repair event -- Under Repair
    // is now entered via send_to_repair (puncture_repair is the completion
    // event that resolves a tyre OUT of Under Repair back to In Store).
    const underRepairMissing = await db.prepare(`
      SELECT t.* FROM tyres t
      WHERE t.status = 'Under Repair'
      AND NOT EXISTS (SELECT 1 FROM tyre_events e WHERE e.tyre_id = t.id AND e.event_type = 'send_to_repair')
    `).all();
    for (const tyre of underRepairMissing) {
      const info = await insertSendToRepair.run(tyre.id, tyre.updated_at || tyre.created_at, tyre.current_depot_id, BACKFILL_REASON);
      await auditBackfilledEvent(await getEvent.get(info.lastInsertRowid));
      summary.punctureRepair++;
    }

    // 3. 'Scrapped' tyres (formerly 'Condemned' before the status-model
    // simplification) with no condemnation OR scrap event backing the
    // write-off.
    const condemnedMissing = await db.prepare(`
      SELECT t.* FROM tyres t
      WHERE t.status = 'Scrapped'
      AND NOT EXISTS (SELECT 1 FROM tyre_events e WHERE e.tyre_id = t.id AND e.event_type IN ('condemnation', 'scrap'))
    `).all();
    for (const tyre of condemnedMissing) {
      const info = await insertCondemnation.run(
        tyre.id, tyre.updated_at || tyre.created_at, tyre.current_depot_id, tyre.initial_nsd ?? 0, BACKFILL_REASON
      );
      await auditBackfilledEvent(await getEvent.get(info.lastInsertRowid));
      summary.condemnation++;
    }

    // 4. Any tyre left with literally zero tyre_events rows (true for every
    // seeded tyre pre-refactor) gets a backfilled opening event, so no tyre's
    // timeline is ever empty. Runs after 1-3 so tyres already backfilled
    // above are correctly excluded (they now have exactly one event).
    const noEventsAtAll = await db.prepare(`
      SELECT t.* FROM tyres t
      WHERE NOT EXISTS (SELECT 1 FROM tyre_events e WHERE e.tyre_id = t.id)
    `).all();
    for (const tyre of noEventsAtAll) {
      const info = await insertPurchaseIntake.run(
        tyre.id, tyre.created_at, tyre.current_bus_id, tyre.current_position, tyre.current_depot_id,
        `${BACKFILL_REASON} (opening event for a record with no prior history)`
      );
      await auditBackfilledEvent(await getEvent.get(info.lastInsertRowid));
      summary.purchaseIntake++;
    }
  });

  await txn();
  return summary;
}

if (require.main === module) {
  (async () => {
    await db.ready;
    const summary = await run();
    console.log('Lifecycle event backfill complete:');
    console.log(`  send_to_store inserted:   ${summary.sendToStore}`);
    console.log(`  puncture_repair inserted: ${summary.punctureRepair}`);
    console.log(`  condemnation inserted:    ${summary.condemnation}`);
    console.log(`  purchase_intake inserted: ${summary.purchaseIntake} (opening event for tyres with no prior history)`);
    await db.close();
  })().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
