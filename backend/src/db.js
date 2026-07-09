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
  CREATE TABLE IF NOT EXISTS tyres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tyre_number TEXT NOT NULL UNIQUE,
    brand TEXT NOT NULL,
    model TEXT,
    size TEXT,
    purchase_date TEXT,
    initial_nsd REAL,
    status TEXT NOT NULL DEFAULT 'In Store' CHECK (status IN ('In Service', 'In Store', 'Condemned', 'Under Repair')),
    current_bus_id INTEGER REFERENCES buses(id),
    current_position TEXT,
    current_depot_id INTEGER REFERENCES depots(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- FR-TC-02: permanent, append-only tyre card event log. One row per event;
  -- rows are never updated or deleted (NFR-07). "position"/"bus_id"/"depot_id"
  -- hold the tyre's context AT the event (destination side for moves); the
  -- from_* columns hold the origin side for rotation/replacement/transfer.
  -- flag_status is reserved for the threshold-evaluation milestone -- it is
  -- written by nothing in this milestone and always stored NULL.
  CREATE TABLE IF NOT EXISTS tyre_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tyre_id INTEGER NOT NULL REFERENCES tyres(id),
    event_type TEXT NOT NULL CHECK (event_type IN (
      'nsd_reading', 'pressure_reading', 'rotation', 'replacement',
      'puncture_repair', 'inter_bus_transfer', 'send_to_store', 'condemnation'
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
    parameter_type TEXT NOT NULL CHECK (parameter_type IN ('NSD', 'PRESSURE', 'INSPECTION_INTERVAL', 'ESCALATION_DAYS')),
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

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tyre_id INTEGER NOT NULL REFERENCES tyres(id),
    bus_id INTEGER REFERENCES buses(id),
    depot_id INTEGER REFERENCES depots(id),
    parameter_type TEXT NOT NULL CHECK (parameter_type IN ('NSD', 'PRESSURE', 'INSPECTION')),
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
    action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'TRANSFER')),
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

// Export the initialized connection database object for usage in the application
module.exports = db;
