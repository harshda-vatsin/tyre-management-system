const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'ebtms.sqlite'));

const SELECT_TYRE = `
  SELECT
    t.*,
    d.name AS depot_name, d.code AS depot_code,
    b.registration_no AS bus_registration_no
  FROM tyres t
  LEFT JOIN depots d ON d.id = t.current_depot_id
  LEFT JOIN buses b ON b.id = t.current_bus_id
`;

const tyre = db.prepare(`${SELECT_TYRE} WHERE t.id = ?`).get(1);
console.log('Tyre Profile Bus Registration:', tyre.bus_registration_no);

const events = db.prepare(`
  SELECT
    e.*,
    b.registration_no AS bus_registration_no,
    fb.registration_no AS from_bus_registration_no,
    tb.registration_no AS to_bus_registration_no,
    rt.tyre_number AS related_tyre_number,
    u.full_name AS performed_by_name
  FROM tyre_events e
  LEFT JOIN buses b ON b.id = e.bus_id
  LEFT JOIN buses fb ON fb.id = e.from_bus_id
  LEFT JOIN buses tb ON tb.id = e.to_bus_id
  LEFT JOIN tyres rt ON rt.id = e.related_tyre_id
  LEFT JOIN users u ON u.id = e.performed_by
  WHERE e.tyre_id = ?
  ORDER BY e.event_date DESC, e.id DESC
`).all(1);

console.log('Events retrieved count:', events.length);
events.forEach(e => {
  console.log(`Event ID: ${e.id} | Type: ${e.event_type} | Bus Ref: ${e.bus_registration_no} | Details:`);
  console.log(getEventDescription(e));
});

function getEventDescription(e) {
  switch (e.event_type) {
    case 'nsd_reading':
      return `NSD: ${e.nsd_value} mm at ${e.position || '—'} (${e.bus_registration_no || '—'})`;
    case 'pressure_reading':
      return `Pressure: ${e.pressure_value} psi at ${e.position || '—'} (${e.bus_registration_no || '—'})`;
    case 'rotation':
      return `${e.from_position || '—'} → ${e.to_position || '—'} on ${e.bus_registration_no || '—'}${e.reason ? ` — ${e.reason}` : ''}`;
    case 'replacement':
      return e.to_position
        ? `Installed at ${e.to_position} on ${e.bus_registration_no || '—'}, replacing tyre ${e.related_tyre_number || '—'}${e.reason ? ` — ${e.reason}` : ''}`
        : `Removed from ${e.from_position} on ${e.bus_registration_no || '—'}, replaced by tyre ${e.related_tyre_number || '—'}${e.reason ? ` — ${e.reason}` : ''}`;
    case 'puncture_repair':
      return `${e.repair_type || '—'} repair${e.notes ? ` — ${e.notes}` : ''}`;
    case 'inter_bus_transfer':
      return `${e.from_bus_registration_no || '—'}/${e.from_position || '—'} → ${e.to_bus_registration_no || '—'}/${e.to_position || '—'}${e.reason ? ` — ${e.reason}` : ''}`;
    case 'send_to_store':
      return `Removed from ${e.from_bus_registration_no || '—'}/${e.from_position || '—'}, NSD ${e.nsd_value || '—'} mm, stored at ${e.stored_at || '—'} — ${e.reason || '—'}`;
    case 'condemnation':
      return `Condemned at NSD ${e.nsd_value || '—'} mm — ${e.reason || '—'}`;
    default:
      return '—';
  }
}
