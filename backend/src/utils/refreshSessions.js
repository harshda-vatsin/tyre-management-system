/**
 * @file refreshSessions.js
 * @description Server-side refresh-token sessions backing persistent login.
 * Refresh tokens are opaque random strings (not JWTs); only their SHA-256
 * hash is stored. Every use rotates the token: the presented row is retired
 * and a fresh one issued in the same family. Presenting an already-retired
 * token outside a short grace window is treated as theft/replay and revokes
 * the whole family.
 */

const crypto = require('crypto');
const db = require('../db');

const DAY_MS = 24 * 60 * 60 * 1000;
// Idle lifetime of a single refresh token (slides forward on each rotation).
const IDLE_TTL_MS = (Number(process.env.REFRESH_TOKEN_IDLE_DAYS) || 7) * DAY_MS;
// Hard cap on a login session regardless of activity.
const ABSOLUTE_TTL_MS = (Number(process.env.REFRESH_TOKEN_MAX_DAYS) || 30) * DAY_MS;
// Two tabs can refresh with the same cookie at the same moment; the loser
// presents a token the winner just retired. Within this window that is
// treated as a benign race, not replay.
const ROTATION_GRACE_MS = 10 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** Starts a new session family for a user and returns the raw refresh token. */
async function createSession(userId) {
  const now = Date.now();
  const token = newToken();
  await db
    .prepare('INSERT INTO refresh_sessions (user_id, family_id, token_hash, expires_at, family_expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, crypto.randomUUID(), hashToken(token), iso(now + IDLE_TTL_MS), iso(now + ABSOLUTE_TTL_MS));
  // Opportunistic cleanup of long-dead rows keeps the table small.
  await db.prepare('DELETE FROM refresh_sessions WHERE family_expires_at < ?').run(iso(now - DAY_MS));
  return token;
}

/**
 * Validates and rotates a refresh token.
 *
 * @param {string} token - Raw refresh token from the cookie
 * @returns {Promise<{status: 'ok', userId: number, token: string|null}
 *   | {status: 'invalid'}>} `token` is null in the benign-race case: the
 *   browser already received the winner's newer cookie, so none is re-issued.
 */
async function rotateSession(token) {
  const row = await db.prepare('SELECT * FROM refresh_sessions WHERE token_hash = ?').get(hashToken(token));
  if (!row) return { status: 'invalid' };

  const now = Date.now();
  const expired = row.expires_at <= iso(now) || row.family_expires_at <= iso(now);

  if (row.revoked_at) {
    // Retired by rotation just now -> concurrent refresh; otherwise replay.
    if (row.replaced_at && now - Date.parse(row.replaced_at) <= ROTATION_GRACE_MS && !expired) {
      return { status: 'ok', userId: row.user_id, token: null };
    }
    await revokeFamily(row.family_id);
    return { status: 'invalid' };
  }
  if (expired) return { status: 'invalid' };

  const next = newToken();
  const rotated = await db.transaction(async () => {
    // Conditional update makes rotation atomic: only one concurrent caller
    // can retire the row; the other falls through to the grace path.
    const res = await db
      .prepare('UPDATE refresh_sessions SET revoked_at = ?, replaced_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(iso(now), iso(now), row.id);
    if (res.changes !== 1) return false;
    await db
      .prepare('INSERT INTO refresh_sessions (user_id, family_id, token_hash, expires_at, family_expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        row.user_id,
        row.family_id,
        hashToken(next),
        iso(Math.min(now + IDLE_TTL_MS, Date.parse(row.family_expires_at))),
        row.family_expires_at
      );
    return true;
  })();

  if (!rotated) return { status: 'ok', userId: row.user_id, token: null };
  return { status: 'ok', userId: row.user_id, token: next };
}

async function revokeFamily(familyId) {
  await db
    .prepare('UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?')
    .run(iso(Date.now()), familyId);
}

/** Revokes the whole session family a token belongs to (logout). */
async function revokeByToken(token) {
  const row = await db.prepare('SELECT family_id FROM refresh_sessions WHERE token_hash = ?').get(hashToken(token));
  if (row) await revokeFamily(row.family_id);
}

/** Revokes every session for a user (e.g. deactivation / password change). */
async function revokeAllForUser(userId) {
  await db
    .prepare('UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?')
    .run(iso(Date.now()), userId);
}

module.exports = { createSession, rotateSession, revokeByToken, revokeAllForUser, IDLE_TTL_MS };
