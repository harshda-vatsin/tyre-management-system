const Database = require('better-sqlite3');
const path = require('path');

// Intercept console logs to check notification messages
const logs = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => {
  logs.push(args.join(' '));
  originalLog(...args);
};
console.warn = (...args) => {
  logs.push(args.join(' '));
  originalWarn(...args);
};
console.error = (...args) => {
  logs.push(args.join(' '));
  originalError(...args);
};

// Load database and events logic
const db = require('../src/db');
const { createTyreEvent } = require('../src/utils/tyreEvents');

async function runVerification() {
  console.log('--- EBTMS Notification Pipeline Verification (SMTP Removed) ---');

  // Clear log intercepts from startup logs
  logs.length = 0;

  const admin = db.prepare("SELECT * FROM users WHERE role = 'System Administrator' LIMIT 1").get();
  const tyre = db.prepare("SELECT * FROM tyres WHERE tyre_number = 'TYR-0008'").get();

  // Clear existing alerts to start fresh
  db.prepare("DELETE FROM alerts WHERE tyre_id = ?").run(tyre.id);

  // --- Test A: Critical NSD Breach creates Alert & Triggers log ---
  console.log('\n[Test A] Logging Critical NSD Breach...');
  createTyreEvent(admin, 'nsd_reading', {
    tyre_id: tyre.id,
    nsd_value: 1.0,
    event_date: '2026-07-03'
  });

  const alertA = db.prepare("SELECT * FROM alerts WHERE tyre_id = ? AND parameter_type = 'NSD'").get(tyre.id);
  console.log('Alert successfully created:', alertA ? `ID: ${alertA.id}, Severity: ${alertA.severity}` : 'No');
  
  const hasDeferredLog = logs.some(log => log.includes('[NotificationService]') && log.includes('resolved to recipient') && log.includes('deferred'));
  console.log('Notification triggered and logged as deferred:', hasDeferredLog);

  // --- Test B: Duplicate Breach Suppression ---
  console.log('\n[Test B] Logging duplicate breach (same severity)...');
  logs.length = 0;
  createTyreEvent(admin, 'nsd_reading', {
    tyre_id: tyre.id,
    nsd_value: 1.2, // Still Critical breach
    event_date: '2026-07-03'
  });
  
  const duplicateAlertLogs = logs.filter(log => log.includes('[NotificationService]'));
  console.log('Email delivery notifications triggered on duplicate (expected 0):', duplicateAlertLogs.length);

  // --- Test C: Warning -> Critical Escalation ---
  console.log('\n[Test C] Testing Warning to Critical Escalation...');
  // Reset alert to Warning first
  db.prepare("DELETE FROM alerts WHERE tyre_id = ?").run(tyre.id);
  createTyreEvent(admin, 'nsd_reading', {
    tyre_id: tyre.id,
    nsd_value: 3.5, // Warning breach
    event_date: '2026-07-03'
  });
  
  // Now escalate to Critical
  logs.length = 0;
  createTyreEvent(admin, 'nsd_reading', {
    tyre_id: tyre.id,
    nsd_value: 1.0, // Critical breach (escalation)
    event_date: '2026-07-03'
  });

  const escalationLogs = logs.filter(log => log.includes('[NotificationService]'));
  console.log('Email delivery notifications triggered on escalation (expected 1):', escalationLogs.length);
  if (escalationLogs.length > 0) {
    console.log('Escalation message:', escalationLogs[0]);
  }

  // Restore original console log handlers
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;

  // Clean up test data
  db.prepare("DELETE FROM alerts WHERE tyre_id = ?").run(tyre.id);
  console.log('\nVerification complete.');
}

runVerification().catch(err => {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  console.error(err);
});
