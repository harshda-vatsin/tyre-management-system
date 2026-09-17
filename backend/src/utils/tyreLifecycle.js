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

const ALL_STATUSES = ['In Store', 'Active', 'Under Repair', 'Going for Retread', 'Under Retread', 'Warranty', 'Scrapped'];

const IN_STORE_SUB_STATUSES = [
  'Newly Purchased',
  'Old',
  'Came Back from Puncture',
  'Came Back from Retreading',
  'Spare',
];

function getInStoreDivision(subStatus) {
  if (!subStatus) return 'Old';
  if (subStatus === 'Newly Purchased') return 'Newly Purchased';
  return 'Old';
}

// Scrapped is the only one-way door -- everything else is a normal location
// or a temporary detour that always leads back to In Store/Active. It stays
// in this list (so the generic transition graph below and the master-data
// PUT /tyres/:id route both still refuse to move a Scrapped tyre anywhere
// silently) even though a Scrapped tyre CAN be brought back: reactivateTyre()
// in lifecycleStateMachine.js is a deliberate, audited exception to this
// list, reachable only through the 'reactivation' tyre_events entry -- never
// through a raw status edit.
const TERMINAL_STATUSES = ['Scrapped'];

const LEGACY_STATUS_MAP = {
  'In Store': 'In Store',
  Active: 'Active',
  'Under Repair': 'Under Repair',
  'Going for Retread': 'Going for Retread',
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
  'Sent for Retread': 'Going for Retread',
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

// In Store/Active are the two normal resting states; Under Repair/Going for Retread/Under
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

// 'scrap' and 'scrap_disposal' were folded into 'condemnation' (relabeled
// "Scrap" in the UI) -- both were terminal write-off events with no
// meaningful distinction from condemnation once it absorbed scrap's paperwork
// fields (scrap_value, vendor_name, gate_pass_no, ...); see createCondemnation
// in tyreEvents.js and db.js's tyre_events_event_type_check migration.
const EVENT_TYPES = [
  'nsd_reading', 'pressure_reading', 'rotation', 'replacement',
  'puncture_repair', 'inter_bus_transfer', 'send_to_store', 'condemnation',
  'purchase_intake', 'fitment_created', 'reservation', 'inspection_completed',
  'send_to_repair', 'retread_sent', 'retread_started', 'retread_completed', 'warranty_claim',
  'reactivation',
];

// Canonical outcome vocabulary, keyed by event type -- the single source
// both the DB CHECK constraint (generated from this, see db.js's
// buildOutcomeCheckSql) and every createXxx() handler in tyreEvents.js
// validate against. retread_completed and warranty_claim both write to
// tyre_events.outcome but mean different things by it (a binary vendor
// result vs. a three-state claim workflow), which is exactly what let them
// drift apart before: two hardcoded arrays, one per handler, with nothing
// tying either to what the DB would actually accept. Only event types
// listed here may ever pass a non-null outcome; that is enforced by
// generating the CHECK constraint from this map, not by trusting every
// caller to stay in sync with it by hand.
const EVENT_OUTCOMES = {
  retread_completed: ['Done', 'Rejected'],
  warranty_claim: ['approved', 'rejected', 'closed'],
};

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
  IN_STORE_SUB_STATUSES,
  TERMINAL_STATUSES,
  LEGACY_STATUS_MAP,
  normalizeStatus,
  TRANSITIONS,
  EVENT_TYPES,
  EVENT_OUTCOMES,
  assertKnownStatus,
  canTransition,
  getInStoreDivision,
};
