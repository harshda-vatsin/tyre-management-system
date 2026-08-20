/**
 * @file db.js
 * @description PostgreSQL connection layer (migrated from better-sqlite3).
 * Exposes a better-sqlite3-shaped API -- db.prepare(sql).get/all/run(params),
 * db.transaction(fn), db.exec(sql) -- backed by a real `pg` Pool, so the vast
 * majority of call sites across routes/ and utils/ only need `await` added,
 * not their SQL rewritten. See the "Call-shape compatibility" notes below
 * for exactly what is and isn't transparent.
 *
 * Schema: the CREATE TABLE/INDEX statements below are a straight port of the
 * final SQLite schema (see git history for the original db.js) -- the many
 * ALTER TABLE/rebuild migrations that used to follow them existed only to
 * upgrade a pre-existing SQLite file across schema versions and don't apply
 * to a fresh database, so they aren't ported.
 */

const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');
const { EVENT_OUTCOMES } = require('./utils/tyreLifecycle');

// Generates the tyre_events.outcome CHECK constraint directly from
// EVENT_OUTCOMES (utils/tyreLifecycle.js) instead of hand-copying its
// values into SQL -- this is the fix for the warranty/retread outcome
// mismatch: two event types write to the same `outcome` column but mean
// different things by it (a binary vendor result vs. a three-state claim
// workflow), and a hardcoded `outcome IN (...)` list can only ever
// validate one of those vocabularies, silently rejecting the other. The
// generated constraint is event-type-aware, and there is exactly one place
// in the codebase that spells out what "approved" or "Done" mean --
// tyreEvents.js's handlers validate against the same EVENT_OUTCOMES map,
// so the DB and the application can never drift apart on this again.
function buildOutcomeCheckSql() {
  const perEventType = Object.entries(EVENT_OUTCOMES).map(
    ([eventType, values]) => `(event_type = '${eventType}' AND outcome IN (${values.map((v) => `'${v}'`).join(', ')}))`
  );
  return `outcome IS NULL OR ${perEventType.join(' OR ')}`;
}

// Postgres's COUNT(*)/SUM() etc. return the wire type `bigint` (OID 20),
// which `pg` parses as a JS string by default (to avoid silent precision
// loss above Number.MAX_SAFE_INTEGER). Nothing in this app's counts
// (buses/tyres/events per query) will ever approach that, and every one of
// the ~15 route/service files doing `.get(params).c` or similar expects a
// plain JS number the way better-sqlite3 always returned it -- so this is
// registered once, globally, instead of adding a ::int cast at every one of
// those call sites (and every future one).
types.setTypeParser(20, (value) => parseInt(value, 10));

// DATABASE_URL follows the standard postgres:// connection-string convention
// (set automatically by most hosts -- Heroku, Railway, Render, RDS, etc).
// Falls back to the local dev Docker container (see README/CLAUDE.md) when
// unset.
const connectionString = process.env.DATABASE_URL || 'postgres://postgres:devpassword@localhost:5432/ebtms';
const pool = new Pool({ connectionString });

// Holds the pg client currently checked out for an in-flight transaction, so
// nested db.prepare(...).run()/.get()/.all() calls made *inside* a
// db.transaction() callback run on that same client/connection instead of
// each grabbing a fresh one from the pool -- which would silently execute
// outside the transaction and defeat atomicity.
const txContext = new AsyncLocalStorage();
function currentClient() {
  return txContext.getStore() || pool;
}

// --- Call-shape compatibility with the previous better-sqlite3 API --------
//
// 1. Placeholders: SQL strings across the codebase use either positional
//    '?' or named '@name' placeholders (better-sqlite3 supports both).
//    Postgres only understands positional '$1, $2, ...'. translate() walks
//    the SQL text left-to-right and assigns $-indexes in the order
//    placeholders actually appear, pulling '@name' values out of the params
//    object and '?' values out of the params array by position -- this
//    matters for the several routes that build a WHERE clause dynamically
//    (clauses.push(...); params.foo = ...) since those params objects are
//    *not* guaranteed to be in placeholder order otherwise.
//
// 2. lastInsertRowid: better-sqlite3's .run() on an INSERT returns the new
//    row's rowid for free. Postgres has no equivalent -- every table's
//    primary key in this schema is literally named `id`, so run()
//    transparently appends `RETURNING id` to any INSERT that doesn't
//    already declare a RETURNING clause, and surfaces it the same way.
//
// 3. db.transaction(fn) returns a wrapped function (matching
//    better-sqlite3's shape exactly: `db.transaction(() => {...})()`), so
//    existing call sites only need `await` added in front of the second
//    `()`, not restructuring. Nested transactions (utils/tyreEvents.js's
//    createTyreEvent is itself wrapped in db.transaction() and is called
//    from inside routes/tyres.js's and utils/bulkImport.js's own
//    transactions) use a SAVEPOINT instead of a fresh BEGIN.
function translate(sql, params) {
  const values = [];
  let i = 0;
  const text = sql.replace(/\?|@(\w+)/g, (match, name) => {
    i += 1;
    values.push(name ? params[name] : params[i - 1]);
    return `$${i}`;
  });
  return { text, values };
}

// better-sqlite3's .get()/.all()/.run() accept bind parameters three ways:
// a single array, a single named-params object, or multiple positional
// arguments spread directly (`.get(a, b, c)` -- the most common shape in
// this codebase, e.g. routes/tyres.js's
// `.get(current_bus_id, current_position, excludeTyreId || 0)`). args here
// is already the full arguments array from a rest-param call site.
function normalizeParams(args) {
  if (args.length === 0) return [];
  if (args.length === 1) {
    const only = args[0];
    if (Array.isArray(only)) return only;
    if (only !== null && typeof only === 'object') return only; // named-params object
    return [only]; // single positional value, e.g. .get(id)
  }
  return args; // multiple positional values, e.g. .run(a, b, c)
}

function withReturningId(sql) {
  const isInsert = /^\s*insert\s+into/i.test(sql);
  const hasReturning = /\breturning\b/i.test(sql);
  // Every INSERT target in this schema has an `id` primary key except
  // system_settings (key TEXT PRIMARY KEY) -- both places that insert into
  // it (this file's seed insert, routes/settings.js's upsert) use
  // ON CONFLICT, so gating on that keeps the RETURNING-id assumption safe
  // without needing a table-name allowlist.
  const isUpsert = /\bon\s+conflict\b/i.test(sql);
  return isInsert && !hasReturning && !isUpsert ? `${sql.replace(/;\s*$/, '')} RETURNING id` : sql;
}

function prepare(sql) {
  return {
    async get(...args) {
      const { text, values } = translate(sql, normalizeParams(args));
      const res = await currentClient().query(text, values);
      return res.rows[0];
    },
    async all(...args) {
      const { text, values } = translate(sql, normalizeParams(args));
      const res = await currentClient().query(text, values);
      return res.rows;
    },
    async run(...args) {
      const { text, values } = translate(withReturningId(sql), normalizeParams(args));
      const res = await currentClient().query(text, values);
      return { lastInsertRowid: res.rows[0]?.id, changes: res.rowCount };
    },
  };
}

let savepointCounter = 0;
function transaction(fn) {
  return async (...args) => {
    const existingClient = txContext.getStore();

    if (existingClient) {
      savepointCounter += 1;
      const name = `sp_${savepointCounter}`;
      await existingClient.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn(...args);
        await existingClient.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        await existingClient.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw err;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txContext.run(client, () => fn(...args));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
}

// Multi-statement DDL/cleanup strings (schema creation below, and the
// test suite's multi-table DELETE resets) go through the simple query
// protocol -- pg only allows multiple ';'-separated statements in one call
// when no parameters are bound, which is exactly this file's usage.
async function exec(sql) {
  await currentClient().query(sql);
}

async function close() {
  await pool.end();
}

// now() AT TIME ZONE 'UTC' formatted to match better-sqlite3's
// datetime('now') string shape exactly ('YYYY-MM-DD HH:MM:SS' in UTC), so
// every date column stays a plain TEXT column and every existing
// Date.parse()/string-comparison/ORDER BY in the app keeps working
// unchanged -- upgrading these to native TIMESTAMPTZ columns is a valid
// future improvement but isn't required for this migration.
//
// NOW_SQL is exported so every route/util file that inlined SQLite's
// datetime('now') directly in an UPDATE (e.g. `updated_at = datetime('now')`)
// can swap in the identical Postgres-safe fragment via template-literal
// interpolation (`updated_at = ${NOW_SQL}`) instead of a bind parameter --
// this is raw SQL text, never pass it through prepare()'s params.
const NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

// Postgres error codes (SQLSTATE) replacing the SQLITE_CONSTRAINT_* strings
// the codebase used to check on caught errors from a failed INSERT/UPDATE.
const PG_ERRORS = { UNIQUE_VIOLATION: '23505', FOREIGN_KEY_VIOLATION: '23503' };

const ready = (async () => {
  await exec(`
    CREATE TABLE IF NOT EXISTS depots (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      region TEXT,
      address TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('System Administrator', 'National Fleet Manager', 'Depot Manager', 'Tyre Supervisor', 'Read-Only Auditor')),
      depot_id INTEGER REFERENCES depots(id),
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS bus_models (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      manufacturer TEXT,
      num_positions INTEGER NOT NULL CHECK (num_positions > 0),
      position_labels_json TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS buses (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      depot_id INTEGER NOT NULL REFERENCES depots(id),
      package_id INTEGER REFERENCES packages(id),
      registration_no TEXT NOT NULL UNIQUE,
      chassis_no TEXT NOT NULL UNIQUE,
      bus_model_id INTEGER NOT NULL REFERENCES bus_models(id),
      year_of_manufacture INTEGER,
      date_of_entry_into_fleet TEXT,
      status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Under Maintenance', 'Decommissioned')),
      odometer_km INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS tyres (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tyre_number TEXT NOT NULL UNIQUE,
      brand TEXT NOT NULL,
      model TEXT,
      size TEXT,
      pattern TEXT,
      ply_rating TEXT,
      purchase_date TEXT,
      initial_nsd REAL,
      purchase_cost REAL,
      status TEXT NOT NULL DEFAULT 'In Store' CHECK (status IN (
        'In Store', 'Active', 'Under Repair', 'Under Retread', 'Warranty', 'Scrapped'
      )),
      current_bus_id INTEGER REFERENCES buses(id),
      current_position TEXT,
      current_depot_id INTEGER REFERENCES depots(id),
      current_package_id INTEGER REFERENCES packages(id),
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS tyre_events (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tyre_id INTEGER NOT NULL REFERENCES tyres(id),
      event_type TEXT NOT NULL CHECK (event_type IN (
        'nsd_reading', 'pressure_reading', 'rotation', 'replacement',
        'puncture_repair', 'inter_bus_transfer', 'send_to_store', 'condemnation',
        'purchase_intake', 'fitment_created', 'reservation', 'inspection_completed',
        'send_to_repair', 'retread_sent', 'retread_completed', 'warranty_claim', 'scrap', 'scrap_disposal'
      )),
      event_date TEXT NOT NULL DEFAULT ${NOW},
      bus_id INTEGER REFERENCES buses(id),
      position TEXT,
      depot_id INTEGER REFERENCES depots(id),
      from_bus_id INTEGER REFERENCES buses(id),
      from_position TEXT,
      from_depot_id INTEGER REFERENCES depots(id),
      to_bus_id INTEGER REFERENCES buses(id),
      to_position TEXT,
      to_depot_id INTEGER REFERENCES depots(id),
      related_tyre_id INTEGER REFERENCES tyres(id),
      nsd_value REAL,
      nsd_g1 REAL,
      nsd_g2 REAL,
      nsd_g3 REAL,
      nsd_g4 REAL,
      pressure_value REAL,
      repair_type TEXT CHECK (repair_type IN ('plug', 'patch', 'tube')),
      reason TEXT,
      stored_at TEXT,
      odometer_km INTEGER,
      notes TEXT,
      flag_status TEXT,
      repair_cost REAL,
      retread_cost REAL,
      scrap_value REAL,
      vendor_name TEXT,
      gate_pass_no TEXT,
      invoice_no TEXT,
      invoice_date TEXT,
      vendor_location TEXT,
      approved_by TEXT,
      supervisor_name TEXT,
      tyre_man_name TEXT,
      patch_size TEXT,
      retread_purpose TEXT CHECK (retread_purpose IS NULL OR retread_purpose IN ('Retread', 'Cut Repair')),
      outcome TEXT CHECK (${buildOutcomeCheckSql()}),
      store_manager TEXT,
      system_backfilled INTEGER NOT NULL DEFAULT 0,
      performed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS tyre_event_amendments (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      original_event_id INTEGER NOT NULL REFERENCES tyre_events(id),
      corrected_values_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      amended_by INTEGER REFERENCES users(id),
      amended_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS thresholds (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      parameter_type TEXT NOT NULL CHECK (parameter_type IN (
        'NSD', 'PRESSURE', 'NSD_INSPECTION_INTERVAL', 'PRESSURE_INSPECTION_INTERVAL', 'ESCALATION_DAYS', 'ROTATION_INTERVAL',
        'ROTATION_INTERVAL_KM', 'TOE', 'CASTER', 'CAMBER', 'SAI'
      )),
      scope_type TEXT NOT NULL DEFAULT 'GLOBAL' CHECK (scope_type IN ('GLOBAL', 'DEPOT', 'BUS_MODEL')),
      scope_id INTEGER,
      warning_min REAL,
      warning_max REAL,
      critical_min REAL,
      critical_max REAL,
      unit TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS wheel_alignments (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      bus_id INTEGER NOT NULL REFERENCES buses(id),
      depot_id INTEGER REFERENCES depots(id),
      package_id INTEGER REFERENCES packages(id),
      alignment_date TEXT NOT NULL DEFAULT ${NOW},
      current_km INTEGER,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'Done' CHECK (status IN ('Done', 'Pending')),
      remarks TEXT,
      performed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS wheel_alignment_measurements (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      alignment_id INTEGER NOT NULL REFERENCES wheel_alignments(id),
      position TEXT NOT NULL,
      toe_before REAL,
      toe_after REAL,
      caster_before REAL,
      caster_after REAL,
      camber_before REAL,
      camber_after REAL,
      sai_before REAL,
      sai_after REAL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tyre_id INTEGER NOT NULL REFERENCES tyres(id),
      bus_id INTEGER REFERENCES buses(id),
      depot_id INTEGER REFERENCES depots(id),
      parameter_type TEXT NOT NULL CHECK (parameter_type IN ('NSD', 'PRESSURE', 'NSD_INSPECTION', 'PRESSURE_INSPECTION', 'ROTATION')),
      severity TEXT NOT NULL CHECK (severity IN ('Warning', 'Critical')),
      status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Acknowledged', 'Resolved')),
      triggering_event_id INTEGER REFERENCES tyre_events(id),
      reading_value REAL,
      threshold_value REAL,
      opened_at TEXT NOT NULL DEFAULT ${NOW},
      acknowledged_at TEXT,
      acknowledged_by INTEGER REFERENCES users(id),
      resolved_at TEXT,
      resolved_by INTEGER REFERENCES users(id),
      resolution_note TEXT,
      escalation_level INTEGER NOT NULL DEFAULT 0,
      escalated_at TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      username TEXT,
      action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'TRANSFER', 'AMEND_EVENT')),
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      username TEXT,
      role TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      status_code INTEGER,
      response_time_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE INDEX IF NOT EXISTS idx_buses_depot ON buses(depot_id);
    CREATE INDEX IF NOT EXISTS idx_access_logs_created ON access_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_buses_model ON buses(bus_model_id);
    CREATE INDEX IF NOT EXISTS idx_buses_package ON buses(package_id);
    CREATE INDEX IF NOT EXISTS idx_tyres_bus ON tyres(current_bus_id);
    CREATE INDEX IF NOT EXISTS idx_tyres_depot ON tyres(current_depot_id);
    CREATE INDEX IF NOT EXISTS idx_tyres_status ON tyres(status);
    CREATE INDEX IF NOT EXISTS idx_tyres_package ON tyres(current_package_id);
    CREATE INDEX IF NOT EXISTS idx_wheel_alignments_bus ON wheel_alignments(bus_id, alignment_date);
    CREATE INDEX IF NOT EXISTS idx_wheel_alignment_measurements_alignment ON wheel_alignment_measurements(alignment_id);
    CREATE INDEX IF NOT EXISTS idx_tyre_events_tyre ON tyre_events(tyre_id, event_date);
    CREATE INDEX IF NOT EXISTS idx_tyre_events_type ON tyre_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_tyre_events_bus ON tyre_events(bus_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_tyre ON alerts(tyre_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_unique ON alerts(tyre_id, parameter_type) WHERE status IN ('Open', 'Acknowledged');
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_tyre_event_amendments_event ON tyre_event_amendments(original_event_id, amended_at);
    CREATE INDEX IF NOT EXISTS idx_users_depot ON users(depot_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_thresholds_scope ON thresholds(parameter_type, scope_type, scope_id) WHERE is_active = 1;
  `);

  // MIS Excel Import — schema per the frozen v4 architecture. Every
  // mis_<sheet_type>_records table is an immutable ingestion record: written
  // once by the Replay Engine, never updated by lifecycle amendments. Shared
  // shape across all of them:
  //   import_session_id     -- which upload produced this row
  //   source_sheet/source_row -- traceability back to the exact workbook cell
  //   raw_row_json           -- the entire original row, exactly as read,
  //                             before any parsing/interpretation (subsumes
  //                             the earlier extra_fields idea outright)
  //   fingerprint            -- hashed over resolved IDs, UNIQUE per table;
  //                             backs the new/exact-duplicate/conflicting
  //                             3-way classification
  //   schema_version         -- which set of named columns this table
  //                             recognized when the row was written
  //   event_generator_version -- which Event Generator rule version derived
  //                             (or attempted to derive) this row's event
  //   linkage_status         -- pending -> linked | partially_linked |
  //                             unlinked | awaiting_review | manually_linked
  //
  // A single MIS record can legitimately generate more than one lifecycle
  // event (the Consumption sheet's one row is both an incoming tyre and its
  // fitment; the Puncture sheet's one row is both send_to_repair and
  // puncture_repair, each needing its own event_date). A singular
  // linked-record pointer on the MIS row itself can't represent that, so
  // generated events are recorded in the mis_generated_events join table
  // below instead -- one row per event actually created, however many that
  // turns out to be for a given MIS record. linkage_status is the
  // record-level rollup: linked (every intended event landed), unlinked
  // (none did), partially_linked (some did, some didn't -- a row that still
  // needs a look, not a clean success).
  await exec(`
    CREATE TABLE IF NOT EXISTS import_sessions (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uploaded_by INTEGER REFERENCES users(id),
      original_filename TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN (
        'previewed', 'queued', 'running', 'committed', 'failed', 'cancelled'
      )),
      rows_total INTEGER NOT NULL DEFAULT 0,
      rows_stored INTEGER NOT NULL DEFAULT 0,
      events_linked INTEGER NOT NULL DEFAULT 0,
      events_unlinked INTEGER NOT NULL DEFAULT 0,
      rows_skipped_duplicate INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT,
      started_at TEXT NOT NULL DEFAULT ${NOW},
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS import_session_rows (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      import_session_id INTEGER NOT NULL REFERENCES import_sessions(id),
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      sheet_type TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN (
        'stored', 'skipped_exact_duplicate', 'flagged_conflicting_duplicate',
        'rejected_shape', 'rejected_lifecycle'
      )),
      mis_record_type TEXT,
      mis_record_id INTEGER,
      tyre_event_id INTEGER REFERENCES tyre_events(id),
      failure_reason TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    -- Tyre Cons. New-Retread-Old Ok sheet: a tyre entering inventory
    -- (new/retread/old-ok-spare) and, on the same row, its fitment onto a
    -- bus in place of a removed tyre. Two lifecycle intents per row:
    -- purchase_intake (incoming tyre) + fitment_created/replacement.
    CREATE TABLE IF NOT EXISTS mis_consumption_records (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      import_session_id INTEGER NOT NULL REFERENCES import_sessions(id),
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      depot_id INTEGER REFERENCES depots(id),
      invoice_no TEXT,
      invoice_date TEXT,
      received_date TEXT,
      make TEXT,
      tyre_kind TEXT,
      nsd REAL,
      consumption_status TEXT,
      tyre_id INTEGER REFERENCES tyres(id),
      tyre_number_raw TEXT,
      bus_id INTEGER REFERENCES buses(id),
      bus_number_raw TEXT,
      position TEXT,
      fitment_date TEXT,
      fitment_km INTEGER,
      removed_tyre_id INTEGER REFERENCES tyres(id),
      removed_tyre_number_raw TEXT,
      removed_tyre_min_nsd REAL,
      removal_reason TEXT,
      raw_row_json JSONB NOT NULL,
      fingerprint TEXT NOT NULL,
      schema_version SMALLINT NOT NULL DEFAULT 1,
      event_generator_version SMALLINT,
      linkage_status TEXT NOT NULL DEFAULT 'pending' CHECK (linkage_status IN (
        'pending', 'linked', 'partially_linked', 'unlinked', 'awaiting_review', 'manually_linked'
      )),
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    -- Puncture Repaire Details sheet: send_to_repair + puncture_repair.
    CREATE TABLE IF NOT EXISTS mis_puncture_records (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      import_session_id INTEGER NOT NULL REFERENCES import_sessions(id),
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      depot_id INTEGER REFERENCES depots(id),
      declared_date TEXT,
      make TEXT,
      tyre_id INTEGER REFERENCES tyres(id),
      tyre_number_raw TEXT,
      nsd REAL,
      repaired_date TEXT,
      patch_size TEXT,
      supervisor_name TEXT,
      tyre_man_name TEXT,
      remarks TEXT,
      raw_row_json JSONB NOT NULL,
      fingerprint TEXT NOT NULL,
      schema_version SMALLINT NOT NULL DEFAULT 1,
      event_generator_version SMALLINT,
      linkage_status TEXT NOT NULL DEFAULT 'pending' CHECK (linkage_status IN (
        'pending', 'linked', 'partially_linked', 'unlinked', 'awaiting_review', 'manually_linked'
      )),
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    -- Retread Tyre History sheet: retread_sent (dispatch to retreader) +
    -- retread_completed (received back, Done/Reject outcome).
    CREATE TABLE IF NOT EXISTS mis_retread_records (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      import_session_id INTEGER NOT NULL REFERENCES import_sessions(id),
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      package_id INTEGER REFERENCES packages(id),
      depot_id INTEGER REFERENCES depots(id),
      removal_date TEXT,
      tyre_id INTEGER REFERENCES tyres(id),
      tyre_number_raw TEXT,
      make TEXT,
      nsd_at_removal REAL,
      tyre_life_before_retread_km INTEGER,
      retread_purpose TEXT,
      dispatch_date TEXT,
      gate_pass_no TEXT,
      vendor_name TEXT,
      vendor_location TEXT,
      invoice_no TEXT,
      invoice_date TEXT,
      retread_status TEXT,
      rejected_reason TEXT,
      raw_row_json JSONB NOT NULL,
      fingerprint TEXT NOT NULL,
      schema_version SMALLINT NOT NULL DEFAULT 1,
      event_generator_version SMALLINT,
      linkage_status TEXT NOT NULL DEFAULT 'pending' CHECK (linkage_status IN (
        'pending', 'linked', 'partially_linked', 'unlinked', 'awaiting_review', 'manually_linked'
      )),
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    -- Scraped Tyre Details sheet: scrap + scrap_disposal (vendor sale).
    CREATE TABLE IF NOT EXISTS mis_scrap_records (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      import_session_id INTEGER NOT NULL REFERENCES import_sessions(id),
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      package_id INTEGER REFERENCES packages(id),
      depot_id INTEGER REFERENCES depots(id),
      scrap_declared_date TEXT,
      tyre_id INTEGER REFERENCES tyres(id),
      tyre_number_raw TEXT,
      make TEXT,
      tyre_kind TEXT,
      last_removal_date TEXT,
      min_nsd REAL,
      tyre_life_before_retread_km INTEGER,
      tyre_life_after_retread_km INTEGER,
      total_tyre_life_km INTEGER,
      scrap_cause TEXT,
      remarks TEXT,
      gate_pass_no TEXT,
      gate_pass_date TEXT,
      vendor_name TEXT,
      approved_by TEXT,
      store_manager TEXT,
      vendor_address TEXT,
      raw_row_json JSONB NOT NULL,
      fingerprint TEXT NOT NULL,
      schema_version SMALLINT NOT NULL DEFAULT 1,
      event_generator_version SMALLINT,
      linkage_status TEXT NOT NULL DEFAULT 'pending' CHECK (linkage_status IN (
        'pending', 'linked', 'partially_linked', 'unlinked', 'awaiting_review', 'manually_linked'
      )),
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    -- Warranty Tyre History sheet: warranty_claim.
    CREATE TABLE IF NOT EXISTS mis_warranty_records (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      import_session_id INTEGER NOT NULL REFERENCES import_sessions(id),
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      package_id INTEGER REFERENCES packages(id),
      depot_id INTEGER REFERENCES depots(id),
      warranty_declared_date TEXT,
      tyre_id INTEGER REFERENCES tyres(id),
      tyre_number_raw TEXT,
      make TEXT,
      tyre_kind TEXT,
      last_removal_date TEXT,
      min_nsd REAL,
      tyre_life_before_retread_km INTEGER,
      tyre_life_after_retread_km INTEGER,
      total_tyre_life_km INTEGER,
      warranty_cause TEXT,
      remarks TEXT,
      warranty_claim_status TEXT,
      claim_status_date TEXT,
      gate_pass_no TEXT,
      gate_pass_date TEXT,
      vendor_name TEXT,
      approved_by TEXT,
      store_manager TEXT,
      vendor_address TEXT,
      raw_row_json JSONB NOT NULL,
      fingerprint TEXT NOT NULL,
      schema_version SMALLINT NOT NULL DEFAULT 1,
      event_generator_version SMALLINT,
      linkage_status TEXT NOT NULL DEFAULT 'pending' CHECK (linkage_status IN (
        'pending', 'linked', 'partially_linked', 'unlinked', 'awaiting_review', 'manually_linked'
      )),
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    -- Tyre NSD Report sheet: nsd_reading (+ pressure_reading from the same
    -- row). Deliberately excludes every formula-derived report column
    -- (% wear, projected/remaining mileage, km/mm wear, days remaining,
    -- retreading date, standard OTD lookup) per the "ignore computed
    -- report cells" rule -- these are recomputable from stored facts, never
    -- themselves facts to preserve.
    CREATE TABLE IF NOT EXISTS mis_nsd_records (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      import_session_id INTEGER NOT NULL REFERENCES import_sessions(id),
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      depot_id INTEGER REFERENCES depots(id),
      tyre_kind TEXT,
      bus_id INTEGER REFERENCES buses(id),
      bus_number_raw TEXT,
      tyre_dimension TEXT,
      pr_li_si TEXT,
      make TEXT,
      pattern TEXT,
      position TEXT,
      tyre_id INTEGER REFERENCES tyres(id),
      tyre_number_raw TEXT,
      inspection_date TEXT,
      pressure_psi REAL,
      nsd_g1 REAL,
      nsd_g2 REAL,
      nsd_g3 REAL,
      nsd_g4 REAL,
      vehicle_status TEXT,
      tyre_fitting_condition TEXT,
      raw_row_json JSONB NOT NULL,
      fingerprint TEXT NOT NULL,
      schema_version SMALLINT NOT NULL DEFAULT 1,
      event_generator_version SMALLINT,
      linkage_status TEXT NOT NULL DEFAULT 'pending' CHECK (linkage_status IN (
        'pending', 'linked', 'partially_linked', 'unlinked', 'awaiting_review', 'manually_linked'
      )),
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    -- Tyre Rotation sheet: one Excel row covers up to 6 tyre-position slots
    -- (FR/FL/RRO/RRI/RLO/RLI) moved in the same rotation visit. Normalized
    -- to one MIS record per occupied slot (matching tyre_events' one-tyre-
    -- per-rotation-event shape); all slots from the same source row share
    -- import_session_id + source_sheet + source_row as their natural group
    -- key, plus an identical raw_row_json.
    CREATE TABLE IF NOT EXISTS mis_rotation_records (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      import_session_id INTEGER NOT NULL REFERENCES import_sessions(id),
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      package_id INTEGER REFERENCES packages(id),
      depot_id INTEGER REFERENCES depots(id),
      bus_id INTEGER REFERENCES buses(id),
      bus_number_raw TEXT,
      current_km INTEGER,
      km_at_rotation INTEGER,
      due_date TEXT,
      rotation_date TEXT,
      from_position TEXT NOT NULL,
      tyre_id INTEGER REFERENCES tyres(id),
      tyre_number_raw TEXT,
      nsd REAL,
      to_position TEXT,
      status TEXT,
      remarks TEXT,
      raw_row_json JSONB NOT NULL,
      fingerprint TEXT NOT NULL,
      schema_version SMALLINT NOT NULL DEFAULT 1,
      event_generator_version SMALLINT,
      linkage_status TEXT NOT NULL DEFAULT 'pending' CHECK (linkage_status IN (
        'pending', 'linked', 'partially_linked', 'unlinked', 'awaiting_review', 'manually_linked'
      )),
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    -- Wheel Alignment sheet: feeds the existing wheel_alignments /
    -- wheel_alignment_measurements tables as its lifecycle-equivalent
    -- output (linked_record_type = 'wheel_alignment'), same as every other
    -- sheet feeds tyre_events -- kept as its own dedicated MIS table rather
    -- than reusing the operational tables as import staging, since only the
    -- MIS table carries raw_row_json fidelity, import traceability, and
    -- fingernprint-based dedup on re-import.
    CREATE TABLE IF NOT EXISTS mis_wheel_alignment_records (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      import_session_id INTEGER NOT NULL REFERENCES import_sessions(id),
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      depot_id INTEGER REFERENCES depots(id),
      bus_id INTEGER REFERENCES buses(id),
      bus_number_raw TEXT,
      current_km INTEGER,
      km_at_alignment INTEGER,
      due_date TEXT,
      alignment_date TEXT,
      toe_fr_before REAL, toe_fr_after REAL,
      caster_fr_before REAL, caster_fr_after REAL,
      camber_fr_before REAL, camber_fr_after REAL,
      sai_fr_before REAL, sai_fr_after REAL,
      toe_fl_before REAL, toe_fl_after REAL,
      caster_fl_before REAL, caster_fl_after REAL,
      camber_fl_before REAL, camber_fl_after REAL,
      sai_fl_before REAL, sai_fl_after REAL,
      status TEXT,
      remarks TEXT,
      raw_row_json JSONB NOT NULL,
      fingerprint TEXT NOT NULL,
      schema_version SMALLINT NOT NULL DEFAULT 1,
      event_generator_version SMALLINT,
      linkage_status TEXT NOT NULL DEFAULT 'pending' CHECK (linkage_status IN (
        'pending', 'linked', 'partially_linked', 'unlinked', 'awaiting_review', 'manually_linked'
      )),
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE INDEX IF NOT EXISTS idx_import_session_rows_session ON import_session_rows(import_session_id);
    CREATE INDEX IF NOT EXISTS idx_mis_consumption_session ON mis_consumption_records(import_session_id);
    CREATE INDEX IF NOT EXISTS idx_mis_consumption_tyre ON mis_consumption_records(tyre_id);
    CREATE INDEX IF NOT EXISTS idx_mis_consumption_linkage ON mis_consumption_records(linkage_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mis_consumption_fingerprint ON mis_consumption_records(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_mis_puncture_session ON mis_puncture_records(import_session_id);
    CREATE INDEX IF NOT EXISTS idx_mis_puncture_tyre ON mis_puncture_records(tyre_id);
    CREATE INDEX IF NOT EXISTS idx_mis_puncture_linkage ON mis_puncture_records(linkage_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mis_puncture_fingerprint ON mis_puncture_records(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_mis_retread_session ON mis_retread_records(import_session_id);
    CREATE INDEX IF NOT EXISTS idx_mis_retread_tyre ON mis_retread_records(tyre_id);
    CREATE INDEX IF NOT EXISTS idx_mis_retread_linkage ON mis_retread_records(linkage_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mis_retread_fingerprint ON mis_retread_records(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_mis_scrap_session ON mis_scrap_records(import_session_id);
    CREATE INDEX IF NOT EXISTS idx_mis_scrap_tyre ON mis_scrap_records(tyre_id);
    CREATE INDEX IF NOT EXISTS idx_mis_scrap_linkage ON mis_scrap_records(linkage_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mis_scrap_fingerprint ON mis_scrap_records(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_mis_warranty_session ON mis_warranty_records(import_session_id);
    CREATE INDEX IF NOT EXISTS idx_mis_warranty_tyre ON mis_warranty_records(tyre_id);
    CREATE INDEX IF NOT EXISTS idx_mis_warranty_linkage ON mis_warranty_records(linkage_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mis_warranty_fingerprint ON mis_warranty_records(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_mis_nsd_session ON mis_nsd_records(import_session_id);
    CREATE INDEX IF NOT EXISTS idx_mis_nsd_tyre ON mis_nsd_records(tyre_id);
    CREATE INDEX IF NOT EXISTS idx_mis_nsd_linkage ON mis_nsd_records(linkage_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mis_nsd_fingerprint ON mis_nsd_records(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_mis_rotation_session ON mis_rotation_records(import_session_id);
    CREATE INDEX IF NOT EXISTS idx_mis_rotation_tyre ON mis_rotation_records(tyre_id);
    CREATE INDEX IF NOT EXISTS idx_mis_rotation_linkage ON mis_rotation_records(linkage_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mis_rotation_fingerprint ON mis_rotation_records(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_mis_wheel_alignment_session ON mis_wheel_alignment_records(import_session_id);
    CREATE INDEX IF NOT EXISTS idx_mis_wheel_alignment_bus ON mis_wheel_alignment_records(bus_id);
    CREATE INDEX IF NOT EXISTS idx_mis_wheel_alignment_linkage ON mis_wheel_alignment_records(linkage_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mis_wheel_alignment_fingerprint ON mis_wheel_alignment_records(fingerprint);

    -- One row per lifecycle event actually created from an MIS record --
    -- see the note above the import_sessions table for why this is a join
    -- table rather than a singular pointer column on each mis_* row.
    CREATE TABLE IF NOT EXISTS mis_generated_events (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      mis_record_type TEXT NOT NULL,
      mis_record_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      tyre_event_id INTEGER REFERENCES tyre_events(id),
      wheel_alignment_id INTEGER REFERENCES wheel_alignments(id),
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );
    CREATE INDEX IF NOT EXISTS idx_mis_generated_events_record ON mis_generated_events(mis_record_type, mis_record_id);
  `);

  // Traceability chain per architecture §10: a nullable, polymorphic pointer
  // from a lifecycle-writing table back to the MIS record that generated it.
  // No DB-level FK (the two possible source_mis_record_type values point at
  // different tables) -- resolved in application code, same reasoning as
  // linked_record_type/linked_record_id above.
  await exec(`
    ALTER TABLE tyre_events ADD COLUMN IF NOT EXISTS source_mis_record_type TEXT;
    ALTER TABLE tyre_events ADD COLUMN IF NOT EXISTS source_mis_record_id INTEGER;
    ALTER TABLE wheel_alignments ADD COLUMN IF NOT EXISTS source_mis_record_type TEXT;
    ALTER TABLE wheel_alignments ADD COLUMN IF NOT EXISTS source_mis_record_id INTEGER;
    CREATE INDEX IF NOT EXISTS idx_tyre_events_source_mis ON tyre_events(source_mis_record_type, source_mis_record_id);
    CREATE INDEX IF NOT EXISTS idx_wheel_alignments_source_mis ON wheel_alignments(source_mis_record_type, source_mis_record_id);
  `);

  // The outcome CHECK constraint's definition lives in EVENT_OUTCOMES, not
  // in this file (see buildOutcomeCheckSql above) -- but CREATE TABLE IF
  // NOT EXISTS only applies to a table that doesn't exist yet, so an
  // already-created tyre_events table needs its constraint re-applied
  // explicitly whenever EVENT_OUTCOMES changes. Re-running this with an
  // unchanged EVENT_OUTCOMES is a harmless no-op (drop-then-recreate the
  // identical constraint), so it's safe to run unconditionally on every
  // boot rather than trying to detect whether it actually changed.
  await exec(`
    ALTER TABLE tyre_events DROP CONSTRAINT IF EXISTS tyre_events_outcome_check;
    ALTER TABLE tyre_events ADD CONSTRAINT tyre_events_outcome_check CHECK (${buildOutcomeCheckSql()});
  `);

  // SRS §8.3: pressure unit defaults to PSI until an Admin changes it.
  // ON CONFLICT DO NOTHING is Postgres's equivalent of SQLite's INSERT OR IGNORE.
  await prepare('INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run(['pressure_unit', 'PSI']);
  // MIS Excel importer kill switch (§10) defaults to enabled.
  await prepare('INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run(['mis_import_enabled', 'true']);
})();

module.exports = { prepare, transaction, exec, close, ready, pool, NOW_SQL: NOW, PG_ERRORS };
