/**
 * @file lifecycleStateMachine.js
 * @description Single choke point for every tyre status/location change.
 * Replaces the ad hoc updateTyre() calls previously scattered across
 * tyreEvents.js -- routing all of them through here guarantees a transition
 * is checked against the legal lifecycle graph (tyreLifecycle.js) before it
 * is written, so "status should never change without an event" and invalid
 * jumps (e.g. Condemned -> Mounted) are rejected rather than silently applied.
 */

const db = require('../db');
const { canTransition, assertKnownStatus } = require('./tyreLifecycle');
const { ApiError } = require('./apiError');

function assertValidTransition(fromStatus, toStatus) {
  assertKnownStatus(toStatus);
  if (!canTransition(fromStatus, toStatus)) {
    throw new ApiError(409, `Cannot move a tyre from "${fromStatus}" to "${toStatus}"`);
  }
}

/**
 * Validates and applies a tyre's status/location change in one step.
 * Pass the tyre's current status as `newStatus` (with only location fields
 * changing) for moves that don't change status at all, e.g. rotation --
 * this is always allowed (a no-op transition) and still centralizes the
 * write through this one function.
 *
 * @param {number} tyreId
 * @param {string} newStatus
 * @param {{current_bus_id?: number|null, current_position?: string|null, current_depot_id?: number|null, current_package_id?: number|null}} locationFields
 * @returns {{before: object, after: object}}
 */
function transitionTyreStatus(tyreId, newStatus, locationFields = {}) {
  const before = db.prepare('SELECT * FROM tyres WHERE id = ?').get(tyreId);
  if (!before) throw new ApiError(404, `Tyre ${tyreId} not found`);

  assertValidTransition(before.status, newStatus);

  const merged = {
    status: newStatus,
    current_bus_id: locationFields.current_bus_id !== undefined ? locationFields.current_bus_id : before.current_bus_id,
    current_position: locationFields.current_position !== undefined ? locationFields.current_position : before.current_position,
    current_depot_id: locationFields.current_depot_id !== undefined ? locationFields.current_depot_id : before.current_depot_id,
    current_package_id: locationFields.current_package_id !== undefined ? locationFields.current_package_id : before.current_package_id,
  };

  db.prepare(`
    UPDATE tyres SET status = ?, current_bus_id = ?, current_position = ?, current_depot_id = ?, current_package_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(merged.status, merged.current_bus_id, merged.current_position, merged.current_depot_id, merged.current_package_id, tyreId);

  const after = db.prepare('SELECT * FROM tyres WHERE id = ?').get(tyreId);
  return { before, after };
}

module.exports = { ApiError, assertValidTransition, transitionTyreStatus };
