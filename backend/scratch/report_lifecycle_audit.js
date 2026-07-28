const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'ebtms.sqlite'), { readonly: true });

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

section('Tyre status breakdown');
console.table(db.prepare(`SELECT status, COUNT(*) AS count FROM tyres GROUP BY status ORDER BY count DESC`).all());

section('Tyres by current location type');
console.table(db.prepare(`
  SELECT
    CASE
      WHEN current_bus_id IS NOT NULL THEN 'Mounted on bus'
      WHEN status = 'Condemned' THEN 'Condemned (no location)'
      ELSE 'In depot store'
    END AS location,
    COUNT(*) AS count
  FROM tyres GROUP BY location
`).all());

section('Total tyres');
console.log(db.prepare(`SELECT COUNT(*) AS total FROM tyres`).get());

section('Tyre lifecycle events - counts by type');
console.table(db.prepare(`SELECT event_type, COUNT(*) AS count FROM tyre_events GROUP BY event_type ORDER BY count DESC`).all());

section('Tyre lifecycle events - total & date range');
console.log(db.prepare(`SELECT COUNT(*) AS total_events, MIN(event_date) AS earliest, MAX(event_date) AS latest FROM tyre_events`).get());

section('Tyre event amendments (corrections to event log)');
console.log(db.prepare(`SELECT COUNT(*) AS total_amendments FROM tyre_event_amendments`).get());

section('Alerts - by status');
console.table(db.prepare(`SELECT status, COUNT(*) AS count FROM alerts GROUP BY status ORDER BY count DESC`).all());

section('Alerts - by parameter type & severity');
console.table(db.prepare(`SELECT parameter_type, severity, COUNT(*) AS count FROM alerts GROUP BY parameter_type, severity ORDER BY parameter_type, severity`).all());

section('Open/Acknowledged alerts detail (top 20 by opened_at desc)');
console.table(db.prepare(`
  SELECT a.id, t.tyre_number, a.parameter_type, a.severity, a.status, a.reading_value, a.threshold_value, a.opened_at
  FROM alerts a JOIN tyres t ON t.id = a.tyre_id
  WHERE a.status != 'Resolved'
  ORDER BY a.opened_at DESC LIMIT 20
`).all());

section('Audit log - counts by action');
console.table(db.prepare(`SELECT action, COUNT(*) AS count FROM audit_log GROUP BY action ORDER BY count DESC`).all());

section('Audit log - counts by entity_type');
console.table(db.prepare(`SELECT entity_type, COUNT(*) AS count FROM audit_log GROUP BY entity_type ORDER BY count DESC`).all());

section('Audit log - counts by action x entity_type');
console.table(db.prepare(`SELECT entity_type, action, COUNT(*) AS count FROM audit_log GROUP BY entity_type, action ORDER BY entity_type, action`).all());

section('Audit log - total & date range');
console.log(db.prepare(`SELECT COUNT(*) AS total_entries, MIN(created_at) AS earliest, MAX(created_at) AS latest FROM audit_log`).get());

section('Audit log - most recent 15 entries');
console.table(db.prepare(`SELECT id, username, action, entity_type, entity_id, created_at FROM audit_log ORDER BY id DESC LIMIT 15`).all());

section('Distinct entity_types ever audited');
console.table(db.prepare(`SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type`).all());

db.close();
