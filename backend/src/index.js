/**
 * @file index.js
 * @description Process entry point for the EV Bus Tyre Management System
 * (EBTMS) backend. Loads environment config, starts the HTTP listener for
 * the Express app built in app.js, and wires process-level shutdown/error
 * handling. App/middleware/route setup itself lives in app.js so it can be
 * imported directly (e.g. by test/) without opening a port.
 */

require('dotenv').config();
const db = require('./db');
const app = require('./app');
const { startImportJobQueue, stopImportJobQueue } = require('./misImport/importJobQueue');

const PORT = process.env.PORT || 4000;
// Nginx is the only public entry point; the backend only needs to be
// reachable from Nginx on the same VM, so bind to loopback by default.
// Override with HOST=0.0.0.0 only if something outside the VM needs direct
// access (not required by the intended architecture).
const HOST = process.env.HOST || '127.0.0.1';

if (!process.env.JWT_SECRET) {
  // Not fatal -- the dev fallback in middleware/auth.js still works -- but
  // every token would be signed with a publicly-known secret in production.
  console.warn('[EBTMS] JWT_SECRET is not set. Using the insecure development default is unsafe in production.');
}

// Wait for schema creation (db.js's `ready` promise) before accepting any
// connections -- otherwise an incoming request in the first few
// milliseconds of process startup could query a table that doesn't exist
// yet.
let server;
db.ready
  .then(() => startImportJobQueue())
  .then(() => {
    server = app.listen(PORT, HOST, () => {
      console.log(`EBTMS backend listening on http://${HOST}:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database schema or job queue:', err);
    process.exit(1);
  });

// PM2 sends SIGTERM on every restart/reload/stop, so closing the HTTP
// server and the DB pool here avoids leaving in-flight requests or
// connections dangling.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  const closeDb = () => stopImportJobQueue().then(() => db.close()).then(() => process.exit(0));
  if (!server) return closeDb();
  server.close(closeDb);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Log and keep the process alive on non-fatal async errors instead of
// letting Node crash the whole backend for one bad promise chain; PM2 would
// otherwise restart-loop on errors that don't actually require a restart.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
