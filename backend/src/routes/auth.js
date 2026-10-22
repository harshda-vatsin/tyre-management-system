const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { createSession, rotateSession, revokeByToken, IDLE_TTL_MS } = require('../utils/refreshSessions');

const router = express.Router();

// Access tokens are deliberately short-lived; the refresh cookie keeps the
// user signed in. (A separate variable name from the old JWT_EXPIRES_IN so a
// leftover long-lived value in an existing .env can't defeat this.)
const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || '15m';

const REFRESH_COOKIE = 'ebtms_refresh';
// Scoped to /api/auth so the cookie is never sent with ordinary API calls.
const COOKIE_PATH = '/api/auth';
// Nginx is HTTP-only until certbot is run (see deploy/nginx.conf); Secure
// cookies are never stored over plain HTTP, so production defaults to Secure
// but can be relaxed explicitly with COOKIE_SECURE=false until HTTPS is on.
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';

function cookieOptions() {
  return { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict', path: COOKIE_PATH };
}

function serializeCookie(name, value, { maxAgeMs, httpOnly, secure, sameSite, path }) {
  const parts = [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite[0].toUpperCase()}${sameSite.slice(1)}`];
  if (maxAgeMs !== undefined) {
    parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
    if (maxAgeMs <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function setRefreshCookie(res, token) {
  res.append('Set-Cookie', serializeCookie(REFRESH_COOKIE, token, { ...cookieOptions(), maxAgeMs: IDLE_TTL_MS }));
}

function clearRefreshCookie(res) {
  res.append('Set-Cookie', serializeCookie(REFRESH_COOKIE, '', { ...cookieOptions(), maxAgeMs: 0 }));
}

function readRefreshCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === REFRESH_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/**
 * CSRF defense for the cookie-authenticated endpoints. The refresh cookie is
 * SameSite=Strict (never sent on cross-site requests); on top of that, the
 * request must carry a custom header -- which a cross-site form or <img>
 * cannot add, and a cross-origin fetch can't add without a CORS preflight
 * that credentialed requests would fail -- and, when the browser sends an
 * Origin header, it must match the host the request was addressed to.
 */
function requireCsrfProtection(req, res, next) {
  if (req.get('X-Requested-With') !== 'ebtms') {
    return res.status(403).json({ error: 'CSRF check failed', code: 'CSRF' });
  }
  const origin = req.get('Origin');
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return res.status(403).json({ error: 'CSRF check failed', code: 'CSRF' });
    }
    if (originHost !== req.get('X-Forwarded-Host') && originHost !== req.get('Host')) {
      return res.status(403).json({ error: 'CSRF check failed', code: 'CSRF' });
    }
  }
  next();
}

function publicUser(user) {
  return { id: user.id, username: user.username, full_name: user.full_name, role: user.role, depot_id: user.depot_id };
}

// Claims (role, depot_id) are always built from the current users row, so
// role/depot changes and deactivation take effect at the next refresh.
function signAccessToken(user) {
  const payload = { id: user.id, username: user.username, role: user.role, depot_id: user.depot_id };
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_EXPIRES_IN });
}

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  setRefreshCookie(res, await createSession(user.id));

  res.json({ token: signAccessToken(user), user: publicUser(user) });
}));

// Exchanges the refresh cookie for a new access token, rotating the cookie.
router.post('/refresh', requireCsrfProtection, asyncHandler(async (req, res) => {
  const presented = readRefreshCookie(req);
  if (!presented) {
    return res.status(401).json({ error: 'No refresh session', code: 'REFRESH_INVALID' });
  }

  const result = await rotateSession(presented);
  const user = result.status === 'ok'
    ? await db.prepare('SELECT * FROM users WHERE id = ?').get(result.userId)
    : null;

  if (!user || !user.is_active) {
    if (result.status === 'ok') await revokeByToken(result.token || presented);
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'Session expired', code: 'REFRESH_INVALID' });
  }

  if (result.token) setRefreshCookie(res, result.token);
  res.json({ token: signAccessToken(user), user: publicUser(user) });
}));

// Revokes the server-side session and clears the cookie. Idempotent.
router.post('/logout', requireCsrfProtection, asyncHandler(async (req, res) => {
  const presented = readRefreshCookie(req);
  if (presented) await revokeByToken(presented);
  clearRefreshCookie(res);
  res.json({ ok: true });
}));

module.exports = router;
