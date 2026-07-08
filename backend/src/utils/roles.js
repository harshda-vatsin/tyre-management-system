/**
 * @file roles.js
 * @description Defines the access role classifications and scoping array constants
 * matching the user privilege matrix outlined in SRS Section 6.
 */

const ROLES = {
  ADMIN: 'System Administrator',
  NATIONAL_FLEET_MANAGER: 'National Fleet Manager',
  DEPOT_MANAGER: 'Depot Manager',
  TYRE_SUPERVISOR: 'Tyre Supervisor',
  AUDITOR: 'Read-Only Auditor',
};

// Roles that have authorization to view all depots and global metrics.
// NOTE: this gates which roles may reach fleet-wide *endpoints* (e.g. the
// audit log) at all -- it is not the per-request depot filter. Use
// isDepotScoped() below for that; a Read-Only Auditor is fleet-wide-eligible
// here but still gets row-filtered to their own depot if one is assigned.
const FLEET_WIDE_ROLES = [ROLES.ADMIN, ROLES.NATIONAL_FLEET_MANAGER, ROLES.AUDITOR];

/**
 * Determines whether a request must be filtered down to the user's own
 * depot_id. Depot Manager and Tyre Supervisor are always scoped. A
 * Read-Only Auditor's scope is "Configurable (Depot or All)" per SRS
 * section 6: scoped to their assigned depot if one is set on their user
 * record, fleet-wide/read-everywhere if not.
 *
 * @param {{ role: string, depot_id?: number|null }} user - req.user
 * @returns {boolean}
 */
function isDepotScoped(user) {
  if (!user) return false;
  if (user.role === ROLES.DEPOT_MANAGER || user.role === ROLES.TYRE_SUPERVISOR) return true;
  if (user.role === ROLES.AUDITOR) return !!user.depot_id;
  return false;
}

module.exports = { ROLES, FLEET_WIDE_ROLES, isDepotScoped };
