/**
 * @file auditLog.js
 * @description Provides helper utilities to write immutable entries to the `audit_log` table
 * capturing CRUD mutations performed by users or automated system processes.
 */

const db = require('../db');

// SQL Statement to write rows into the audit_log table
const insertAudit = db.prepare(`
  INSERT INTO audit_log (user_id, username, action, entity_type, entity_id, before_json, after_json)
  VALUES (@user_id, @username, @action, @entity_type, @entity_id, @before_json, @after_json)
`);

/**
 * Inserts a new row in the security/audit log table.
 * 
 * @param {object} params - Audit log parameters
 * @param {object|null} params.user - The user object triggering the event (null indicates a system action)
 * @param {string} params.action - Action classification ('CREATE', 'UPDATE', 'DELETE', 'TRANSFER')
 * @param {string} params.entityType - Affected system resource entity type (e.g. 'tyre', 'alert')
 * @param {string|number} params.entityId - ID identifier of the modified entity resource
 * @param {object} [params.before] - Optional historical snapshot of the record state before mutation
 * @param {object} [params.after] - Optional snapshot of the record state after mutation
 */
function writeAuditLog({ user, action, entityType, entityId, before, after }) {
  insertAudit.run({
    user_id: user?.id ?? null,
    username: user?.username ?? 'system',
    action,
    entity_type: entityType,
    entity_id: entityId != null ? String(entityId) : null,
    before_json: before ? JSON.stringify(before) : null,
    after_json: after ? JSON.stringify(after) : null,
  });
}

module.exports = { writeAuditLog };
