/**
 * @file tyreLifecycle.js
 * @description Simplified operational status model. A status answers ONLY
 * "where is the tyre right now" -- it never describes an action that has
 * already happened (that belongs in the timeline as a tyre_events row).
 * This replaced an earlier, much more granular ~26-status model (Mounted,
 * Running, Repair Completed, Sent for Retread, Warranty Pending, Disposed,
 * ...) that kept conflating "current location" with "last action taken".
 * LEGACY_STATUS_MAP maps every status either model has ever written to
 * tyres.status down to one of the 6 below -- used both by the one-time
 * data migration in db.js and as a defensive normalizer.
 */

const ALL_STATUSES = ['In Store', 'Active', 'Under Repair', 'Under Retread', 'Warranty', 'Scrapped'];

// Scrapped is the only one-way door -- everything else is a normal location
// or a temporary detour that always leads back to In Store/Active.
const TERMINAL_STATUSES = ['Scrapped'];

const LEGACY_STATUS_MAP = {
  'In Store': 'In Store',
  Active: 'Active',
  'Under Repair': 'Under Repair',
  'Under Retread': 'Under Retread',
  Warranty: 'Warranty',
  Scrapped: 'Scrapped',
  // Original 4-status model (pre-lifecycle-expansion).
  'In Service': 'Active',
  Condemned: 'Scrapped',
  // First lifecycle-expansion pass's granular vocabulary.
  Purchased: 'In Store',
  Received: 'In Store',
  Inventory: 'In Store',
  Reserved: 'In Store',
  'Awaiting Fitment': 'In Store',
  Mounted: 'Active',
  Running: 'Active',
  'Under Inspection': 'Active',
  Rotated: 'Active',
  Removed: 'In Store',
  'Repair Completed': 'In Store',
  'Waiting Installation': 'In Store',
  'Sent for Retread': 'Under Retread',
  'At Retread Vendor': 'Under Retread',
  'Retread Completed': 'In Store',
  'Returned to Inventory': 'In Store',
  'Warranty Pending': 'Warranty',
  'Warranty Approved': 'Warranty',
  'Warranty Rejected': 'Warranty',
  Disposed: 'Scrapped',
  Archived: 'Scrapped',
};

function normalizeStatus(status) {
  return LEGACY_STATUS_MAP[status] || 'In Store';
}

// In Store/Active are the two normal resting states; Under Repair/Under
// Retread/Warranty are temporary detours that can be entered from -- and
// returned to In Store/Active from -- either of those (or each other,
// since which detour applies is a real-world judgment call, not something
// the state machine should gatekeep). Scrapped is reachable from anywhere
// non-terminal (a tyre can be written off directly out of active service,
// storage, repair, retread, or a warranty review) and has no way out.
const TRANSITIONS = {};
for (const status of ALL_STATUSES) {
  TRANSITIONS[status] = TERMINAL_STATUSES.includes(status) ? [] : ALL_STATUSES.filter((s) => s !== status);
}

const EVENT_TYPES = [
  'nsd_reading', 'pressure_reading', 'rotation', 'replacement',
  'puncture_repair', 'inter_bus_transfer', 'send_to_store', 'condemnation',
  'purchase_intake', 'fitment_created', 'reservation', 'inspection_completed',
  'send_to_repair', 'retread_sent', 'retread_completed', 'warranty_claim', 'scrap', 'scrap_disposal',
];

function assertKnownStatus(status) {
  if (!ALL_STATUSES.includes(status)) {
    throw new Error(`Unknown tyre lifecycle status: ${status}`);
  }
}

function canTransition(fromStatus, toStatus) {
  if (fromStatus === toStatus) return true;
  const allowed = TRANSITIONS[fromStatus];
  return Boolean(allowed && allowed.includes(toStatus));
}

module.exports = {
  ALL_STATUSES,
  TERMINAL_STATUSES,
  LEGACY_STATUS_MAP,
  normalizeStatus,
  TRANSITIONS,
  EVENT_TYPES,
  assertKnownStatus,
  canTransition,
};
