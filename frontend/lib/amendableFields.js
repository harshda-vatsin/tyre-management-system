// Tyre Card Amendment / Correction workflow: mirrors the backend's
// AMENDABLE_FIELDS (backend/src/utils/tyreEvents.js) -- which tyre_events
// columns may be corrected per event_type. Kept as a separate frontend copy
// the same way lib/roles.js already mirrors backend/src/utils/roles.js.
export const AMENDABLE_FIELDS = {
  nsd_reading: ['nsd_value', 'notes'],
  pressure_reading: ['pressure_value', 'notes'],
  rotation: ['to_position', 'reason'],
  replacement: ['reason'],
  puncture_repair: ['repair_type', 'notes'],
  inter_bus_transfer: ['to_bus_id', 'to_position', 'reason'],
  send_to_store: ['nsd_value', 'stored_at', 'reason'],
  condemnation: ['nsd_value', 'reason'],
};

export const FIELD_LABELS = {
  nsd_value: 'NSD',
  pressure_value: 'Pressure',
  notes: 'Notes',
  to_position: 'To Position',
  reason: 'Reason',
  repair_type: 'Repair Type',
  to_bus_id: 'Destination Bus',
  stored_at: 'Stored At',
};
