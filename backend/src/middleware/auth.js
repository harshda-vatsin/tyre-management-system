/**
 * @file auth.js
 * @description Authentication and authorization middlewares.
 * Uses JSON Web Tokens (JWT) to authenticate user requests, authorize them based on roles,
 * and enforce depot-level scoping boundaries to restrict access.
 */

const jwt = require('jsonwebtoken');
const { isDepotScoped } = require('../utils/roles');

// Secret key used to sign and verify JSON Web Tokens
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

/**
 * Express middleware to authenticate request using a JWT token in the Authorization header.
 * Exposes the decoded token payload on `req.user`.
 * 
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next middleware function
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Express middleware factory to check if the authenticated user has one of the allowed roles.
 * 
 * @param {...string} allowedRoles - List of allowed role names
 * @returns {function(import('express').Request, import('express').Response, import('express').NextFunction): void} Express middleware
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role permissions' });
    }
    next();
  };
}

/**
 * Express middleware to enforce depot-scoping check boundaries.
 * Users with fleet-wide roles (like Admin, National Fleet Manager) can access any depot.
 * Depot-scoped roles (like Depot Manager, Tyre Supervisor) can only read or write resources
 * within their assigned depot_id.
 * 
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next middleware function
 */
function enforceDepotScope(req, res, next) {
  const { depot_id: userDepotId } = req.user;

  // Let fleet-wide users pass through unrestricted -- includes a Read-Only
  // Auditor with no depot_id assigned (SRS: "Configurable (Depot or All)").
  if (!isDepotScoped(req.user)) {
    return next();
  }

  // Resolve target depot ID from request parameter, body, or query params
  const targetDepotId = Number(req.params.depotId || req.body.depot_id || req.query.depot_id);

  if (!userDepotId) {
    return res.status(403).json({ error: 'User has no depot assigned' });
  }

  // Restrict access if targeted depot does not match user's assigned depot
  if (targetDepotId && targetDepotId !== userDepotId) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }

  next();
}

module.exports = { authenticate, authorize, enforceDepotScope, JWT_SECRET };
