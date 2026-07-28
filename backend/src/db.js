/**
 * @file db.js
 * @description SQLite database initialization and schema creation module.
 * Establishes a database connection using better-sqlite3, sets performance-enhancing
 * SQLite pragmas, and declares the schemas (with relational constraints and indexes)
 * for all primary system entities (depots, users, bus_models, buses, tyres, tyre_events,
 * thresholds, alerts, and audit_log).
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Resolve the absolute file path to the SQLite storage file
const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'ebtms.sqlite');

// backend/data/ holds only gitignored *.sqlite* files, so a fresh clone has
// no such directory on disk -- better-sqlite3 cannot create the DB file
// inside a missing directory, so ensure it exists first.
fs.mkdirSync(DB_DIR, { recursive: true });

// Open the connection to the SQLite database
const db = new Database(DB_PATH);

// Set performance pragmas:
// WAL (Write-Ahead Logging) mode allows simultaneous read operations while writing.
db.pragma('journal_mode = WAL');
// Force SQLite to enforce foreign key relational reference rules and deletion constraints.
db.pragma('foreign_keys = ON');

// Execute DDL statements to ensure all tables exist with correct schemas
db.exec(`
  CREATE TABLE IF NOT EXISTS depots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    region TEXT,
    address TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Contractual/route grouping, independent of Depot (a real operator's MIS
  -- tracks both as separate per-bus/per-tyre attributes, not a hierarchy --
  -- see utils/tyreLifecycle.js-adjacent MIS Depth Expansion notes).
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- SRS section 6 role names: System Administrator, National Fleet Manager,
  -- Depot Manager, Tyre Supervisor, Read-Only Auditor.
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('System Administrator', 'National Fleet Manager', 'Depot Manager', 'Tyre Supervisor', 'Read-Only Auditor')),
    depot_id INTEGER REFERENCES depots(id),
    is_active INTEGER NOT NULL DEFAULT 1,
    last_login TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- FR-BM-XX: tyre position template per bus model archetype. Buses inherit
  -- their position layout by reference (bus_model_id), not by copying it.
  -- num_positions is the only admin-entered value; position_labels_json is
  -- derived from it server-side against a fixed predefined table
  -- (utils/busLayout.js) -- there is no manual axle/position builder.
  CREATE TABLE IF NOT EXISTS bus_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    manufacturer TEXT,
    num_positions INTEGER NOT NULL CHECK (num_positions > 0),
    position_labels_json TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- FR-BM-01: bus master record. bus_model_id fulfils both the "Model / Make"
  -- field and FR-BM-02 tyre-position inheritance in one relation.
  CREATE TABLE IF NOT EXISTS buses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    depot_id INTEGER NOT NULL REFERENCES depots(id),
    package_id INTEGER REFERENCES packages(id),
    registration_no TEXT NOT NULL UNIQUE,
    chassis_no TEXT NOT NULL UNIQUE,
    bus_model_id INTEGER NOT NULL REFERENCES bus_models(id),
    year_of_manufacture INTEGER,
    date_of_entry_into_fleet TEXT,
    status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Under Maintenance', 'Decommissioned')),
    odometer_km INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- FR-TC-01: tyre master ("tyre card" event history is a later milestone).
  -- Simplified operational status model (see utils/tyreLifecycle.js): a
  -- status only ever answers "where is the tyre right now" -- never "what
  -- action was just taken", which is what tyre_events/the timeline is for.
  -- 'Inspection Due'/'Rotation Due' are deliberately NOT in this list --
  -- those are read-computed (see inspectionService.js / rotationService.js),
  -- never written to this column, so a "due" state can never appear here as
  -- a silent status flip.
  CREATE TABLE IF NOT EXISTS tyres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- FR-TC-02: permanent, append-only tyre card event log. One row per event;
  -- rows are never updated or deleted (NFR-07). "position"/"bus_id"/"depot_id"
  -- hold the tyre's context AT the event (destination side for moves); the
  -- from_* columns hold the origin side for rotation/replacement/transfer.
  -- flag_status is reserved for the threshold-evaluation milestone -- it is
  -- written by nothing in this milestone and always stored NULL.
  -- Enterprise Lifecycle expansion: 9 new event types added alongside the
  -- original 8 (unchanged) to cover procurement intake, fitment, inspection
  -- sign-off, retread, warranty, and scrap. repair_cost/retread_cost/
  -- scrap_value/vendor_name are nullable financial/vendor fields -- start
  -- capturing this data from now on without forcing a backfill on old rows.
  -- system_backfilled marks historically-reconstructed events (see
  -- migrations/backfillLifecycleEvents.js) so the UI can flag them distinctly.
  CREATE TABLE IF NOT EXISTS tyre_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tyre_id INTEGER NOT NULL REFERENCES tyres(id),
    event_type TEXT NOT NULL CHECK (event_type IN (
      'nsd_reading', 'pressure_reading', 'rotation', 'replacement',
      'puncture_repair', 'inter_bus_transfer', 'send_to_store', 'condemnation',
      'purchase_intake', 'fitment_created', 'reservation', 'inspection_completed',
      'send_to_repair', 'retread_sent', 'retread_completed', 'warranty_claim', 'scrap', 'scrap_disposal'
    )),
    event_date TEXT NOT NULL DEFAULT (datetime('now')),
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
    -- Excel Parity Gap-Closure: optional 4-groove tread depth capture for
    -- nsd_reading -- nsd_value stays the authoritative single figure
    -- (auto-computed as min(g1..g4) when all 4 are supplied), so every
    -- other event type and every existing report keeps reading nsd_value
    -- exactly as before.
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
    -- MIS Depth Expansion: vendor-transaction and repair-detail fields,
    -- nullable so nothing forces a backfill on rows already written.
    gate_pass_no TEXT,
    invoice_no TEXT,
    invoice_date TEXT,
    vendor_location TEXT,
    approved_by TEXT,
    supervisor_name TEXT,
    tyre_man_name TEXT,
    patch_size TEXT,
    -- Excel Parity Gap-Closure: retread_purpose (retread_sent) and outcome
    -- (retread_completed) are self-referencing CHECKs only, so existing
    -- NULL rows remain valid -- no rebuild needed for these two.
    retread_purpose TEXT CHECK (retread_purpose IS NULL OR retread_purpose IN ('Retread', 'Cut Repair')),
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('Done', 'Rejected')),
    store_manager TEXT,
    system_backfilled INTEGER NOT NULL DEFAULT 0,
    performed_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- SRS 8.1: one row per (parameter_type, scope). warning_min/max and
  -- critical_min/max cover both single-bound parameters (NSD, inspection
  -- interval, escalation days use only *_max) and banded ones (pressure uses
  -- both min and max at each severity level).
  -- Allowed scope per parameter (enforced in routes/thresholds.js):
  --   NSD                 -> GLOBAL | DEPOT
  --   PRESSURE            -> GLOBAL | BUS_MODEL
  --   INSPECTION_INTERVAL -> GLOBAL only
  --   ESCALATION_DAYS     -> GLOBAL only
  -- Tyre Card Amendment / Correction workflow. tyre_events rows are never
  -- updated or deleted (NFR-07) -- a correction is instead layered on top as
  -- its own append-only row here, so the original event and every past
  -- correction remain in the audit trail. corrected_values_json only holds
  -- the fields the user actually changed (a sparse patch), not a full copy
  -- of the event.
  CREATE TABLE IF NOT EXISTS tyre_event_amendments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_event_id INTEGER NOT NULL REFERENCES tyre_events(id),
    corrected_values_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    amended_by INTEGER REFERENCES users(id),
    amended_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS thresholds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parameter_type TEXT NOT NULL CHECK (parameter_type IN (
      'NSD', 'PRESSURE', 'INSPECTION_INTERVAL', 'ESCALATION_DAYS', 'ROTATION_INTERVAL',
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- MIS Depth Expansion: Wheel Alignment is bus-scoped (axle geometry), not
  -- tyre-scoped, so it's its own table pair rather than tyre_events rows.
  -- due_date is plain user-entered (the workshop schedules the next service
  -- directly) -- never derived from an average-km/day projection.
  CREATE TABLE IF NOT EXISTS wheel_alignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bus_id INTEGER NOT NULL REFERENCES buses(id),
    depot_id INTEGER REFERENCES depots(id),
    package_id INTEGER REFERENCES packages(id),
    alignment_date TEXT NOT NULL DEFAULT (datetime('now')),
    current_km INTEGER,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'Done' CHECK (status IN ('Done', 'Pending')),
    remarks TEXT,
    performed_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per axle position per alignment record; before/after pairs
  -- mirror the source MIS sheet's layout exactly. Values are decimal
  -- degrees (e.g. 0º12' stored as 0.2), not degree-minute strings.
  CREATE TABLE IF NOT EXISTS wheel_alignment_measurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tyre_id INTEGER NOT NULL REFERENCES tyres(id),
    bus_id INTEGER REFERENCES buses(id),
    depot_id INTEGER REFERENCES depots(id),
    parameter_type TEXT NOT NULL CHECK (parameter_type IN ('NSD', 'PRESSURE', 'INSPECTION', 'ROTATION')),
    severity TEXT NOT NULL CHECK (severity IN ('Warning', 'Critical')),
    status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Acknowledged', 'Resolved')),
    triggering_event_id INTEGER REFERENCES tyre_events(id),
    reading_value REAL,
    threshold_value REAL,
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    acknowledged_at TEXT,
    acknowledged_by INTEGER REFERENCES users(id),
    resolved_at TEXT,
    resolved_by INTEGER REFERENCES users(id),
    resolution_note TEXT,
    escalation_level INTEGER NOT NULL DEFAULT 0,
    escalated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- SRS §8.3: system-wide display/config parameters (pressure unit today;
  -- a plain key/value store rather than dedicated columns so future
  -- parameters -- SMTP config, inspection reminder cadence, etc. -- don't
  -- each need their own migration).
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    username TEXT,
    action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'TRANSFER', 'AMEND_EVENT')),
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Database indexes to optimize performance of frequent lookups and joins
  CREATE INDEX IF NOT EXISTS idx_buses_depot ON buses(depot_id);
  CREATE INDEX IF NOT EXISTS idx_buses_model ON buses(bus_model_id);
  CREATE INDEX IF NOT EXISTS idx_tyres_bus ON tyres(current_bus_id);
  CREATE INDEX IF NOT EXISTS idx_tyres_depot ON tyres(current_depot_id);
  CREATE INDEX IF NOT EXISTS idx_tyres_status ON tyres(status);
  CREATE INDEX IF NOT EXISTS idx_wheel_alignments_bus ON wheel_alignments(bus_id, alignment_date);
  CREATE INDEX IF NOT EXISTS idx_wheel_alignment_measurements_alignment ON wheel_alignment_measurements(alignment_id);
  CREATE INDEX IF NOT EXISTS idx_tyre_events_tyre ON tyre_events(tyre_id, event_date);
  CREATE INDEX IF NOT EXISTS idx_tyre_events_type ON tyre_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_tyre_events_bus ON tyre_events(bus_id);
  CREATE INDEX IF NOT EXISTS idx_alerts_tyre ON alerts(tyre_id);
  CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
  -- FR-AL-02: only one active (Open/Acknowledged) alert per tyre+parameter.
  -- The app layer already upserts instead of duplicating; this is a data-
  -- integrity backstop, not the primary enforcement mechanism.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_unique ON alerts(tyre_id, parameter_type) WHERE status IN ('Open', 'Acknowledged');
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_tyre_event_amendments_event ON tyre_event_amendments(original_event_id, amended_at);
  CREATE INDEX IF NOT EXISTS idx_users_depot ON users(depot_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_thresholds_scope ON thresholds(parameter_type, scope_type, scope_id) WHERE is_active = 1;
`);

// Lightweight migration: CREATE TABLE IF NOT EXISTS above only applies to a
// fresh database, so an existing ebtms.sqlite predating the depots.is_active
// column needs it added explicitly.
const depotColumns = db.prepare('PRAGMA table_info(depots)').all().map((c) => c.name);
if (!depotColumns.includes('is_active')) {
  db.exec('ALTER TABLE depots ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
}

// SRS §8.3: pressure unit defaults to PSI (matches every existing threshold
// and reading already stored in PSI) until an Admin changes it.
db.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)').run('pressure_unit', 'PSI');

// FR-BM-XX superseded the axle/left-right builder with a predefined
// tyre-count layout table, so the columns backing the old model are dropped
// from any pre-existing database file.
const busModelColumns = db.prepare('PRAGMA table_info(bus_models)').all().map((c) => c.name);
if (busModelColumns.includes('axle_layout_json')) {
  db.exec('ALTER TABLE bus_models DROP COLUMN axle_layout_json');
}
if (busModelColumns.includes('axle_configuration')) {
  db.exec('ALTER TABLE bus_models DROP COLUMN axle_configuration');
}

// Tyre Card Amendment workflow needs a new AMEND_EVENT audit action. SQLite
// has no ALTER TABLE support for changing a CHECK constraint in place, so an
// audit_log table predating this migration is rebuilt column-for-column
// under its existing name, preserving every row already written to it.
const auditLogTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get();
if (auditLogTable && !auditLogTable.sql.includes('AMEND_EVENT')) {
  db.exec(`
    ALTER TABLE audit_log RENAME TO audit_log_old;
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      username TEXT,
      action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'TRANSFER', 'AMEND_EVENT')),
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO audit_log SELECT * FROM audit_log_old;
    DROP TABLE audit_log_old;
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
  `);
}

// ---------------------------------------------------------------------------
// Enterprise Lifecycle expansion migrations. Simple column additions use
// ALTER TABLE ADD COLUMN (safe, no rebuild). CHECK-constraint changes need a
// full table rebuild since SQLite cannot alter a CHECK in place; tyres and
// tyre_events are referenced by other tables' foreign keys, so the rebuild
// runs with foreign_keys temporarily OFF and verifies integrity with
// PRAGMA foreign_key_check before turning it back on, per SQLite's
// documented procedure for restructuring a referenced table.
// ---------------------------------------------------------------------------

const tyreColumns = db.prepare('PRAGMA table_info(tyres)').all().map((c) => c.name);
if (!tyreColumns.includes('purchase_cost')) {
  db.exec('ALTER TABLE tyres ADD COLUMN purchase_cost REAL');
}
if (!tyreColumns.includes('current_package_id')) {
  db.exec('ALTER TABLE tyres ADD COLUMN current_package_id INTEGER REFERENCES packages(id)');
}
if (!tyreColumns.includes('pattern')) {
  db.exec('ALTER TABLE tyres ADD COLUMN pattern TEXT');
}
if (!tyreColumns.includes('ply_rating')) {
  db.exec('ALTER TABLE tyres ADD COLUMN ply_rating TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_tyres_package ON tyres(current_package_id)');

const busColumns = db.prepare('PRAGMA table_info(buses)').all().map((c) => c.name);
if (!busColumns.includes('package_id')) {
  db.exec('ALTER TABLE buses ADD COLUMN package_id INTEGER REFERENCES packages(id)');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_buses_package ON buses(package_id)');

const tyreEventColumns = db.prepare('PRAGMA table_info(tyre_events)').all().map((c) => c.name);
const NEW_EVENT_COLUMN_TYPES = {
  repair_cost: 'REAL', retread_cost: 'REAL', scrap_value: 'REAL', vendor_name: 'TEXT',
  gate_pass_no: 'TEXT', invoice_no: 'TEXT', invoice_date: 'TEXT', vendor_location: 'TEXT',
  approved_by: 'TEXT', supervisor_name: 'TEXT', tyre_man_name: 'TEXT', patch_size: 'TEXT',
  nsd_g1: 'REAL', nsd_g2: 'REAL', nsd_g3: 'REAL', nsd_g4: 'REAL', store_manager: 'TEXT',
};
for (const [col, type] of Object.entries(NEW_EVENT_COLUMN_TYPES)) {
  if (!tyreEventColumns.includes(col)) {
    db.exec(`ALTER TABLE tyre_events ADD COLUMN ${col} ${type}`);
  }
}
if (!tyreEventColumns.includes('system_backfilled')) {
  db.exec('ALTER TABLE tyre_events ADD COLUMN system_backfilled INTEGER NOT NULL DEFAULT 0');
}
// Excel Parity Gap-Closure: retread_purpose/outcome are self-referencing
// CHECKs only, so ADD COLUMN is valid without a full table rebuild.
if (!tyreEventColumns.includes('retread_purpose')) {
  db.exec(`ALTER TABLE tyre_events ADD COLUMN retread_purpose TEXT CHECK (retread_purpose IS NULL OR retread_purpose IN ('Retread', 'Cut Repair'))`);
}
if (!tyreEventColumns.includes('outcome')) {
  db.exec(`ALTER TABLE tyre_events ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome IN ('Done', 'Rejected'))`);
}

// Status-model simplification: collapses whatever wide vocabulary a tyre's
// status currently holds (the original 4-value model, or the ~26-value
// granular expansion that briefly replaced it) down to the 6 operational
// statuses in utils/tyreLifecycle.js. The CASE mirrors LEGACY_STATUS_MAP
// there exactly -- every value either model has ever written is covered,
// with an ELSE fallback to 'In Store' as a last resort for anything
// unrecognized. tyre_events (the actual history) is untouched by this.
const tyresTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tyres'").get();
if (tyresTable && !tyresTable.sql.includes("'Under Retread'")) {
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  db.exec(`
    ALTER TABLE tyres RENAME TO tyres_old;
    CREATE TABLE tyres (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO tyres (
      id, tyre_number, brand, model, size, purchase_date, initial_nsd, purchase_cost,
      status, current_bus_id, current_position, current_depot_id, current_package_id, created_at, updated_at
    )
    SELECT
      id, tyre_number, brand, model, size, purchase_date, initial_nsd, purchase_cost,
      CASE status
        WHEN 'In Store' THEN 'In Store'
        WHEN 'Active' THEN 'Active'
        WHEN 'Under Repair' THEN 'Under Repair'
        WHEN 'Under Retread' THEN 'Under Retread'
        WHEN 'Warranty' THEN 'Warranty'
        WHEN 'Scrapped' THEN 'Scrapped'
        WHEN 'In Service' THEN 'Active'
        WHEN 'Condemned' THEN 'Scrapped'
        WHEN 'Purchased' THEN 'In Store'
        WHEN 'Received' THEN 'In Store'
        WHEN 'Inventory' THEN 'In Store'
        WHEN 'Reserved' THEN 'In Store'
        WHEN 'Awaiting Fitment' THEN 'In Store'
        WHEN 'Mounted' THEN 'Active'
        WHEN 'Running' THEN 'Active'
        WHEN 'Under Inspection' THEN 'Active'
        WHEN 'Rotated' THEN 'Active'
        WHEN 'Removed' THEN 'In Store'
        WHEN 'Repair Completed' THEN 'In Store'
        WHEN 'Waiting Installation' THEN 'In Store'
        WHEN 'Sent for Retread' THEN 'Under Retread'
        WHEN 'At Retread Vendor' THEN 'Under Retread'
        WHEN 'Retread Completed' THEN 'In Store'
        WHEN 'Returned to Inventory' THEN 'In Store'
        WHEN 'Warranty Pending' THEN 'Warranty'
        WHEN 'Warranty Approved' THEN 'Warranty'
        WHEN 'Warranty Rejected' THEN 'Warranty'
        WHEN 'Disposed' THEN 'Scrapped'
        WHEN 'Archived' THEN 'Scrapped'
        ELSE 'In Store'
      END,
      current_bus_id, current_position, current_depot_id, current_package_id, created_at, updated_at
    FROM tyres_old;
    DROP TABLE tyres_old;
    CREATE INDEX IF NOT EXISTS idx_tyres_bus ON tyres(current_bus_id);
    CREATE INDEX IF NOT EXISTS idx_tyres_depot ON tyres(current_depot_id);
    CREATE INDEX IF NOT EXISTS idx_tyres_package ON tyres(current_package_id);
    CREATE INDEX IF NOT EXISTS idx_tyres_status ON tyres(status);
  `);
  db.pragma('legacy_alter_table = OFF');
  const tyreFkIssues = db.pragma('foreign_key_check');
  if (tyreFkIssues.length) {
    throw new Error(`tyres table rebuild left dangling foreign keys: ${JSON.stringify(tyreFkIssues)}`);
  }
  db.pragma('foreign_keys = ON');
}

const tyreEventsTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tyre_events'").get();
if (tyreEventsTable && !tyreEventsTable.sql.includes('send_to_repair')) {
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  db.exec(`
    ALTER TABLE tyre_events RENAME TO tyre_events_old;
    CREATE TABLE tyre_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tyre_id INTEGER NOT NULL REFERENCES tyres(id),
      event_type TEXT NOT NULL CHECK (event_type IN (
        'nsd_reading', 'pressure_reading', 'rotation', 'replacement',
        'puncture_repair', 'inter_bus_transfer', 'send_to_store', 'condemnation',
        'purchase_intake', 'fitment_created', 'reservation', 'inspection_completed',
        'send_to_repair', 'retread_sent', 'retread_completed', 'warranty_claim', 'scrap', 'scrap_disposal'
      )),
      event_date TEXT NOT NULL DEFAULT (datetime('now')),
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
      system_backfilled INTEGER NOT NULL DEFAULT 0,
      performed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO tyre_events (
      id, tyre_id, event_type, event_date, bus_id, position, depot_id,
      from_bus_id, from_position, from_depot_id, to_bus_id, to_position, to_depot_id,
      related_tyre_id, nsd_value, pressure_value, repair_type, reason, stored_at,
      odometer_km, notes, flag_status, repair_cost, retread_cost, scrap_value,
      vendor_name, gate_pass_no, invoice_no, invoice_date, vendor_location, approved_by,
      supervisor_name, tyre_man_name, patch_size, system_backfilled, performed_by, created_at
    )
    SELECT
      id, tyre_id, event_type, event_date, bus_id, position, depot_id,
      from_bus_id, from_position, from_depot_id, to_bus_id, to_position, to_depot_id,
      related_tyre_id, nsd_value, pressure_value, repair_type, reason, stored_at,
      odometer_km, notes, flag_status, repair_cost, retread_cost, scrap_value,
      vendor_name, gate_pass_no, invoice_no, invoice_date, vendor_location, approved_by,
      supervisor_name, tyre_man_name, patch_size, system_backfilled, performed_by, created_at
    FROM tyre_events_old;
    DROP TABLE tyre_events_old;
    CREATE INDEX IF NOT EXISTS idx_tyre_events_tyre ON tyre_events(tyre_id, event_date);
    CREATE INDEX IF NOT EXISTS idx_tyre_events_type ON tyre_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_tyre_events_bus ON tyre_events(bus_id);
  `);
  db.pragma('legacy_alter_table = OFF');
  const eventFkIssues = db.pragma('foreign_key_check');
  if (eventFkIssues.length) {
    throw new Error(`tyre_events table rebuild left dangling foreign keys: ${JSON.stringify(eventFkIssues)}`);
  }
  db.pragma('foreign_keys = ON');
}

const thresholdsTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'thresholds'").get();
if (thresholdsTable && !thresholdsTable.sql.includes("'TOE'")) {
  db.exec(`
    ALTER TABLE thresholds RENAME TO thresholds_old;
    CREATE TABLE thresholds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parameter_type TEXT NOT NULL CHECK (parameter_type IN (
        'NSD', 'PRESSURE', 'INSPECTION_INTERVAL', 'ESCALATION_DAYS', 'ROTATION_INTERVAL',
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO thresholds SELECT * FROM thresholds_old;
    DROP TABLE thresholds_old;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_thresholds_scope ON thresholds(parameter_type, scope_type, scope_id) WHERE is_active = 1;
  `);
}

// alerts has no incoming foreign keys from other tables, so this rebuild
// (adding 'ROTATION' to parameter_type) is a plain rename/recreate/copy/drop
// like audit_log's, with no legacy_alter_table concern.
const alertsTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'alerts'").get();
if (alertsTable && !alertsTable.sql.includes("'ROTATION'")) {
  db.exec(`
    ALTER TABLE alerts RENAME TO alerts_old;
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tyre_id INTEGER NOT NULL REFERENCES tyres(id),
      bus_id INTEGER REFERENCES buses(id),
      depot_id INTEGER REFERENCES depots(id),
      parameter_type TEXT NOT NULL CHECK (parameter_type IN ('NSD', 'PRESSURE', 'INSPECTION', 'ROTATION')),
      severity TEXT NOT NULL CHECK (severity IN ('Warning', 'Critical')),
      status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Acknowledged', 'Resolved')),
      triggering_event_id INTEGER REFERENCES tyre_events(id),
      reading_value REAL,
      threshold_value REAL,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged_at TEXT,
      acknowledged_by INTEGER REFERENCES users(id),
      resolved_at TEXT,
      resolved_by INTEGER REFERENCES users(id),
      resolution_note TEXT,
      escalation_level INTEGER NOT NULL DEFAULT 0,
      escalated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO alerts SELECT * FROM alerts_old;
    DROP TABLE alerts_old;
    CREATE INDEX IF NOT EXISTS idx_alerts_tyre ON alerts(tyre_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_unique ON alerts(tyre_id, parameter_type) WHERE status IN ('Open', 'Acknowledged');
  `);
}

// Export the initialized connection database object for usage in the application
module.exports = db;
