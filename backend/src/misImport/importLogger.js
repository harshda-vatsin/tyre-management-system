/**
 * @file importLogger.js
 * @description Structured logging for the MIS importer (§10), keyed by
 * import session ID (and job ID, once one exists) as the correlation key --
 * plain, consistent, and enough to trace a stuck or failed import without
 * adopting a new logging framework app-wide just for this feature, matching
 * every other console.log/console.error call site in this codebase.
 */

function tag(sessionId, jobId) {
  return jobId ? `[MisImport session=${sessionId} job=${jobId}]` : `[MisImport session=${sessionId}]`;
}

function logImport(sessionId, phase, message, extra) {
  const parts = [tag(sessionId), phase ? `phase=${phase}` : null, message].filter(Boolean);
  console.log(parts.join(' '), extra !== undefined ? JSON.stringify(extra) : '');
}

function logImportError(sessionId, phase, message, err) {
  const parts = [tag(sessionId), phase ? `phase=${phase}` : null, message].filter(Boolean);
  console.error(parts.join(' '), err?.stack || err?.message || err || '');
}

module.exports = { logImport, logImportError };
