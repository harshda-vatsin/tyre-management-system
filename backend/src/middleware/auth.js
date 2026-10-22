/**
 * @file auth.js
 * @description Authentication and authorization middlewares.
 * Uses JSON Web Tokens (JWT) to authenticate user requests, authorize them based on roles,
 * and enforce depot-level scoping boundaries to restrict access.
 */

const jwt = require('jsonwebtoken');
const { isDepotScoped } = require('../utils/roles');

const DEV_JWT_SECRET = 'dev-secret-change-in-production';
const PLACEHOLDER_SECRETS = new Set([DEV_JWT_SECRET, 'change-this-in-production']);

/**
 * Resolves the JWT signing secret. In production the secret must be set
 * explicitly, be non-placeholder, and be long enough -- otherwise startup
 * fails rather than silently signing tokens with a publicly known value.
 * It must also be identical across restarts/deployments/instances, since a
 * changed secret invalidates every outstanding access token.
 *
 * @param {NodeJS.ProcessEnv} [env] - Environment to read (injectable for tests)
 * @returns {string} The secret
 */
function resolveJwtSecret(env = process.env) {
  const secret = env.JWT_SECRET;
  if (env.NODE_ENV === 'production') {
    if (!secret || PLACEHOLDER_SECRETS.has(secret) || secret.length < 32) {
      throw new Error('JWT_SECRET must be set to a unique value of at least 32 characters in production (e.g. `openssl rand -hex 32`).');
    }
    return secret;
  }
  return secret || DEV_JWT_SECRET;
}

// Secret key used to sign and verify JSON Web Tokens
const JWT_SECRET = resolveJwtSecret();

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
    return res.status(401).json({ error: 'Missing or malformed Authorization header', code: 'TOKEN_MISSING' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = payload;
    next();
  } catch (err) {
    // `code` lets the frontend tell a routine access-token expiry (silently
    // refreshed) apart from a token that was never valid.
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    return res.status(401).json({ error: 'Invalid or expired token', code });
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

module.exports = { authenticate, authorize, enforceDepotScope, JWT_SECRET, resolveJwtSecret };
