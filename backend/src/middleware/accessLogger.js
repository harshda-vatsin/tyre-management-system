/**
 * @file accessLogger.js
 * @description Express middleware to log user requests and page views.
 * Measures response time and saves request metadata to the database.
 */

const db = require('../db');

function accessLogger(req, res, next) {
  // Exclude health check, assets, static files, and monitoring logs/stats requests
  const path = req.path || req.url;
  if (
    path.startsWith('/api/health') ||
    path.startsWith('/api/monitoring') || // Exclude monitoring api calls to avoid self-logging loop
    path.includes('/_next/') ||
    path.includes('/static/') ||
    path.endsWith('.js') ||
    path.endsWith('.css') ||
    path.endsWith('.png') ||
    path.endsWith('.ico') ||
    path.endsWith('.json')
  ) {
    return next();
  }

  const startHrTime = process.hrtime();

  res.on('finish', () => {
    const elapsedHrTime = process.hrtime(startHrTime);
    const elapsedTimeMs = Math.round(elapsedHrTime[0] * 1000 + elapsedHrTime[1] / 1e6);

    // Extract user info if authenticated by jwt/auth middleware
    const userId = req.user ? req.user.id : null;
    const username = req.user ? req.user.username : null;
    const role = req.user ? req.user.role : null;
    const method = req.method;
    const statusCode = res.statusCode;
    
    // Get client IP address
    const ipAddress = req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;

    db.prepare(`
      INSERT INTO access_logs (user_id, username, role, method, path, ip_address, user_agent, status_code, response_time_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run([userId, username, role, method, path, ipAddress, userAgent, statusCode, elapsedTimeMs])
      .catch((err) => {
        // Silent error reporting to prevent app crash if access logging fails
        console.error('[EBTMS Logger] Failed to save access log to database:', err);
      });
  });

  next();
}

module.exports = accessLogger;
