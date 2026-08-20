/**
 * @file app.js
 * @description Builds and configures the Express application -- middleware,
 * route mounts, 404 fallback, and the global error handler -- without
 * starting an HTTP listener. Split out of index.js so tests can import the
 * app directly and drive it with real HTTP requests against an ephemeral
 * port (see test/), instead of only being able to unit-test route logic
 * indirectly or by running the dev server by hand.
 */

const express = require('express');
const cors = require('cors');

// Side-effect import: registers every MIS sheet parser (misImport/parsers/*)
// with the parser registry. Must happen once at startup, before any
// /api/mis-imports request can find a parser for a sheet -- nothing else
// in the app's normal require graph pulls this in otherwise.
require('./misImport/parsers/index');

// Import route modules for each entity and resource area
const authRoutes = require('./routes/auth');
const depotRoutes = require('./routes/depots');
const packageRoutes = require('./routes/packages');
const busModelRoutes = require('./routes/busModels');
const busRoutes = require('./routes/buses');
const tyreRoutes = require('./routes/tyres');
const eventRoutes = require('./routes/events');
const thresholdRoutes = require('./routes/thresholds');
const alertRoutes = require('./routes/alerts');
const inspectionRoutes = require('./routes/inspection');
const rotationRoutes = require('./routes/rotation');
const wheelAlignmentRoutes = require('./routes/wheelAlignments');
const userRoutes = require('./routes/users');
const auditRoutes = require('./routes/audit');
const reportRoutes = require('./routes/reports');
const dashboardRoutes = require('./routes/dashboard');
const settingsRoutes = require('./routes/settings');
const importRoutes = require('./routes/imports');
const misImportRoutes = require('./routes/misImports');
const { findStuckImportSessions } = require('./misImport/importSessionStore');
const accessLogger = require('./middleware/accessLogger');

const app = express();

// Enable Cross-Origin Resource Sharing (CORS) for frontend-backend integration
app.use(cors());
// Parse incoming requests with JSON payloads
app.use(express.json());
app.use(accessLogger);

// Public health check endpoint to verify backend operational status. Stays
// a basic liveness signal first and foremost -- the stuck-import check
// (§10) is best-effort and never turns a DB hiccup into a false "down"
// reading for the whole app; if it can't be answered, it's just omitted.
app.get('/api/health', async (req, res) => {
  const body = { status: 'ok' };
  try {
    const stuck = await findStuckImportSessions();
    if (stuck.length > 0) {
      body.warnings = [`${stuck.length} MIS import session(s) appear stuck: ${stuck.map((s) => `#${s.id} (${s.status})`).join(', ')}`];
    }
  } catch {
    // Best-effort only -- liveness above still reports ok.
  }
  res.json(body);
});

// Mount resource-specific API routers under standard REST path segments
app.use('/api/auth', authRoutes);
app.use('/api/depots', depotRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/bus-models', busModelRoutes);
app.use('/api/buses', busRoutes);
app.use('/api/tyres', tyreRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/thresholds', thresholdRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/inspection-compliance', inspectionRoutes);
app.use('/api/rotation-compliance', rotationRoutes);
app.use('/api/wheel-alignments', wheelAlignmentRoutes);
app.use('/api/users', userRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/mis-imports', misImportRoutes);

// Fallback middleware to handle unmatched routes with a 404 response
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler middleware to capture uncaught execution exceptions
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
