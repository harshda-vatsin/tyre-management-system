/**
 * @file index.js
 * @description Express server entry point for the EV Bus Tyre Management System (EBTMS) backend.
 * Mounts standard middleares (CORS, JSON body parser), wires API route handlers,
 * and starts the HTTP server listening on the configured PORT.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Import route modules for each entity and resource area
const authRoutes = require('./routes/auth');
const depotRoutes = require('./routes/depots');
const busModelRoutes = require('./routes/busModels');
const busRoutes = require('./routes/buses');
const tyreRoutes = require('./routes/tyres');
const eventRoutes = require('./routes/events');
const thresholdRoutes = require('./routes/thresholds');
const alertRoutes = require('./routes/alerts');
const inspectionRoutes = require('./routes/inspection');
const userRoutes = require('./routes/users');
const auditRoutes = require('./routes/audit');
const reportRoutes = require('./routes/reports');
const dashboardRoutes = require('./routes/dashboard');
const settingsRoutes = require('./routes/settings');

const app = express();
const PORT = process.env.PORT || 4000;

// Enable Cross-Origin Resource Sharing (CORS) for frontend-backend integration
app.use(cors());
// Parse incoming requests with JSON payloads
app.use(express.json());

// Public health check endpoint to verify backend operational status
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Mount resource-specific API routers under standard REST path segments
app.use('/api/auth', authRoutes);
app.use('/api/depots', depotRoutes);
app.use('/api/bus-models', busModelRoutes);
app.use('/api/buses', busRoutes);
app.use('/api/tyres', tyreRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/thresholds', thresholdRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/inspection-compliance', inspectionRoutes);
app.use('/api/users', userRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);

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

// Begin listening for incoming HTTP requests on the specified port
app.listen(PORT, () => {
  console.log(`EBTMS backend listening on http://localhost:${PORT}`);
});
