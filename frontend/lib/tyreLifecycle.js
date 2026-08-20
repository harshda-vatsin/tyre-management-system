// Mirrors backend/src/utils/tyreLifecycle.js's simplified operational
// status model -- kept as a separate frontend copy the same way lib/roles.js
// already mirrors backend/src/utils/roles.js. A status only ever answers
// "where is the tyre right now"; everything that HAPPENED to it (fitted,
// rotated, sent for repair, repair completed, sent for retread, retread
// completed, warranty filed/approved/closed, scrapped, ...) is a timeline
// event instead, never a status value.

export const ALL_STATUSES = ['In Store', 'Active', 'Under Repair', 'Under Retread', 'Warranty', 'Scrapped'];

export const TERMINAL_STATUSES = ['Scrapped'];

// Every status either this model or the earlier, more granular one has ever
// written to a tyre record, collapsed down to one of the 6 above. Used
// defensively -- e.g. if a cached/stale value ever reaches the UI -- so
// nothing renders an unrecognized status.
export const LEGACY_STATUS_MAP = {
  'In Store': 'In Store',
  Active: 'Active',
  'Under Repair': 'Under Repair',
  'Under Retread': 'Under Retread',
  Warranty: 'Warranty',
  Scrapped: 'Scrapped',
  'In Service': 'Active',
  Condemned: 'Scrapped',
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

export function normalizeStatus(status) {
  return LEGACY_STATUS_MAP[status] || 'In Store';
}

const STATUS_BADGE_CLASS = {
  'In Store': 'badge-info',
  Active: 'badge-success',
  'Under Repair': 'badge-warning',
  'Under Retread': 'badge-warning',
  Warranty: 'badge-warning',
  Scrapped: 'badge-critical',
};

export function statusBadgeClass(status) {
  return STATUS_BADGE_CLASS[normalizeStatus(status)] || 'badge-info';
}

// Reuses the app's existing validated 4-color palette (blue/green/amber/red).
export const TYRE_STATUS_COLORS = {
  'In Store': '#1baf7a',
  Active: '#2a78d6',
  'Under Repair': '#eda100',
  'Under Retread': '#eda100',
  Warranty: '#eda100',
  Scrapped: '#e34948',
};

// { value, label, elevated?, hiddenFromLogEvent? } -- elevated matches the
// backend's ELEVATED_EVENT_TYPES (Depot Manager/Administrator only);
// hiddenFromLogEvent marks events the system fires itself (purchase_intake)
// rather than ones a user picks from the Log Event dropdown.
export const EVENT_TYPES = [
  { value: 'nsd_reading', label: 'NSD Reading' },
  { value: 'pressure_reading', label: 'Pressure Reading' },
  { value: 'rotation', label: 'Tyre Rotation' },
  { value: 'replacement', label: 'Tyre Replacement' },
  { value: 'send_to_repair', label: 'Send to Repair' },
  { value: 'puncture_repair', label: 'Repair Completed' },
  { value: 'inter_bus_transfer', label: 'Inter-Bus Transfer' },
  { value: 'send_to_store', label: 'Sending to Store', elevated: true },
  { value: 'condemnation', label: 'Condemnation', elevated: true },
  { value: 'purchase_intake', label: 'Purchase Intake', hiddenFromLogEvent: true },
  { value: 'fitment_created', label: 'Fitment (Mount from Store)' },
  { value: 'reservation', label: 'Reservation Update' },
  { value: 'inspection_completed', label: 'Inspection Completed' },
  { value: 'retread_sent', label: 'Send to Retread' },
  { value: 'retread_completed', label: 'Retread Completed' },
  { value: 'warranty_claim', label: 'Warranty Claim' },
  { value: 'scrap', label: 'Scrap', elevated: true },
  { value: 'scrap_disposal', label: 'Scrap Disposal' },
];

export const EVENT_TYPE_LABELS = Object.fromEntries(EVENT_TYPES.map((e) => [e.value, e.label]));

// Human-readable one-line description of a tyre_events row, used by the
// Tyre Card History / Lifecycle Timeline. pressureUnit is only needed for
// the pressure_reading case.
export function describeEvent(e, pressureUnit, formatPressure) {
  switch (e.event_type) {
    case 'nsd_reading':
      return `NSD: ${e.nsd_value} mm at ${e.position} (${e.bus_registration_no})`;
    case 'pressure_reading':
      return `Pressure: ${formatPressure ? formatPressure(e.pressure_value, pressureUnit) : `${e.pressure_value} PSI`} at ${e.position} (${e.bus_registration_no})`;
    case 'rotation':
      return `${e.from_position} → ${e.to_position} on ${e.bus_registration_no}${e.reason ? ` - ${e.reason}` : ''}`;
    case 'replacement':
      return e.to_position
        ? `Installed at ${e.to_position} on ${e.bus_registration_no}, replacing tyre ${e.related_tyre_number}${e.reason ? ` - ${e.reason}` : ''}`
        : `Removed from ${e.from_position} on ${e.bus_registration_no}, replaced by tyre ${e.related_tyre_number}${e.reason ? ` - ${e.reason}` : ''}`;
    case 'send_to_repair':
      return `Sent to repair${e.from_bus_registration_no ? ` (removed from ${e.from_bus_registration_no}/${e.from_position})` : ''}${e.reason ? ` - ${e.reason}` : ''}`;
    case 'puncture_repair':
      return `Repair completed: ${e.repair_type}${e.repair_cost != null ? ` (cost ${e.repair_cost})` : ''}${e.bus_registration_no ? `, remounted at ${e.position} on ${e.bus_registration_no}` : ', returned to store'}${e.notes ? ` - ${e.notes}` : ''}`;
    case 'inter_bus_transfer':
      return `${e.from_bus_registration_no}/${e.from_position} → ${e.to_bus_registration_no}/${e.to_position}${e.reason ? ` - ${e.reason}` : ''}`;
    case 'send_to_store':
      return `Removed from ${e.from_bus_registration_no || '-'}/${e.from_position || '-'}, NSD ${e.nsd_value} mm, stored at ${e.stored_at} - ${e.reason}`;
    case 'condemnation':
      return `Condemned at NSD ${e.nsd_value} mm - ${e.reason}`;
    case 'purchase_intake':
      return `Tyre record created${e.notes ? ` - ${e.notes}` : ''}`;
    case 'fitment_created':
      return `Mounted at ${e.position} on ${e.bus_registration_no}${e.reason ? ` - ${e.reason}` : ''}`;
    case 'reservation':
      return `Reservation updated${e.reason ? ` - ${e.reason}` : ''}`;
    case 'inspection_completed':
      return `Inspection completed${e.bus_registration_no ? ` at ${e.position} on ${e.bus_registration_no}` : ''}${e.notes ? ` - ${e.notes}` : ''}`;
    case 'retread_sent':
      return `Sent to retread vendor "${e.vendor_name}"${e.reason ? ` - ${e.reason}` : ''}`;
    case 'retread_completed':
      return `Retread completed by "${e.vendor_name || '-'}"${e.retread_cost != null ? `, cost ${e.retread_cost}` : ''}${e.notes ? ` - ${e.notes}` : ''}`;
    case 'warranty_claim':
      return e.reason || 'Warranty claim update';
    case 'scrap':
      return `Scrapped${e.scrap_value != null ? ` (value ${e.scrap_value})` : ''} - ${e.reason}`;
    case 'scrap_disposal':
      return e.reason || 'Disposal update';
    default:
      return '-';
  }
}
