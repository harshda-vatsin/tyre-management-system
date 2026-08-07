/**
 * @file seedThresholds.js
 * @description Restores the baseline GLOBAL threshold configuration
 * (src/utils/defaultThresholds.js) without touching any other table --
 * unlike seed.js, this never calls clearAll(). For a database that already
 * has real depot/bus/tyre/tyre_events data (e.g. after an MIS import) but
 * is missing threshold configuration -- with no active thresholds
 * configured, alert generation and inspection/rotation compliance
 * silently evaluate to "no breach" for every reading rather than erroring,
 * so the gap is easy to miss until a report is checked.
 *
 * Idempotent: skips any parameter_type/scope combination that already has
 * an active threshold, mirroring the same existence check
 * routes/thresholds.js's POST / uses, rather than inventing a different
 * upsert mechanism.
 */

const db = require('./db');
const { DEFAULT_GLOBAL_THRESHOLDS } = require('./utils/defaultThresholds');

async function seedThresholds() {
  await db.ready;

  const admin = await db.prepare("SELECT id FROM users WHERE username = 'admin'").get();

  const results = [];
  for (const t of DEFAULT_GLOBAL_THRESHOLDS) {
    const existing = await db
      .prepare(`
        SELECT id FROM thresholds
        WHERE parameter_type = ? AND scope_type = ? AND is_active = 1
          AND ((scope_id IS NULL AND ?::integer IS NULL) OR scope_id = ?)
      `)
      .get(t.parameter_type, t.scope_type, t.scope_id, t.scope_id);

    if (existing) {
      results.push({ parameter_type: t.parameter_type, action: 'skipped (already exists)' });
      continue;
    }

    await db
      .prepare(`
        INSERT INTO thresholds (parameter_type, scope_type, scope_id, warning_min, warning_max, critical_min, critical_max, unit, updated_by)
        VALUES (@parameter_type, @scope_type, @scope_id, @warning_min, @warning_max, @critical_min, @critical_max, @unit, @updated_by)
      `)
      .run({ ...t, updated_by: admin?.id ?? null });
    results.push({ parameter_type: t.parameter_type, action: 'created' });
  }

  return results;
}

if (require.main === module) {
  seedThresholds()
    .then((results) => {
      console.log('Threshold reseed complete:', results);
      return db.close();
    })
    .catch((err) => {
      console.error('Threshold reseed failed:', err);
      process.exitCode = 1;
      return db.close();
    });
}

module.exports = { seedThresholds };
