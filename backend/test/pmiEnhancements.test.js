const test = require('node:test');
const assert = require('node:assert/strict');
const { ALL_STATUSES, IN_STORE_SUB_STATUSES, normalizeStatus, canTransition, getInStoreDivision } = require('../src/utils/tyreLifecycle');
const { AMENDABLE_FIELDS } = require('../src/utils/tyreEvents');
const { computeTyreDistanceFromStints } = require('../src/utils/distanceService');

test('tyreLifecycle: contains Going for Retread and IN_STORE_SUB_STATUSES', () => {
  assert.ok(ALL_STATUSES.includes('Going for Retread'), 'ALL_STATUSES must include Going for Retread');
  assert.ok(ALL_STATUSES.includes('Under Retread'), 'ALL_STATUSES must include Under Retread');
  assert.deepEqual(IN_STORE_SUB_STATUSES, [
    'Newly Purchased',
    'Old',
    'Came Back from Puncture',
    'Came Back from Retreading',
    'Spare',
  ]);
  assert.equal(getInStoreDivision('Newly Purchased'), 'Newly Purchased');
  assert.equal(getInStoreDivision('Came Back from Puncture'), 'Old');
  assert.equal(getInStoreDivision('Came Back from Retreading'), 'Old');
  assert.equal(getInStoreDivision('Spare'), 'Old');
  assert.equal(getInStoreDivision('Old'), 'Old');
  assert.equal(normalizeStatus('Sent for Retread'), 'Going for Retread');
  assert.equal(normalizeStatus('Going for Retread'), 'Going for Retread');
});

test('tyreLifecycle: status transition validation allows valid paths', () => {
  // Going for Retread -> Under Retread
  assert.equal(canTransition('Going for Retread', 'Under Retread'), true);
  // Under Retread -> In Store
  assert.equal(canTransition('Under Retread', 'In Store'), true);
  // In Store -> Going for Retread
  assert.equal(canTransition('In Store', 'Going for Retread'), true);
  // Active -> Going for Retread
  assert.equal(canTransition('Active', 'Going for Retread'), true);
});

test('AMENDABLE_FIELDS: supports repair vendor fields and retread_started', () => {
  assert.ok(AMENDABLE_FIELDS.puncture_repair.includes('vendor_name'));
  assert.ok(AMENDABLE_FIELDS.puncture_repair.includes('vendor_location'));
  assert.ok(AMENDABLE_FIELDS.puncture_repair.includes('invoice_no'));
  assert.ok(AMENDABLE_FIELDS.puncture_repair.includes('invoice_date'));
  assert.ok(AMENDABLE_FIELDS.puncture_repair.includes('gate_pass_no'));

  assert.ok(AMENDABLE_FIELDS.send_to_repair.includes('vendor_name'));
  assert.ok(AMENDABLE_FIELDS.send_to_repair.includes('vendor_location'));

  assert.ok(AMENDABLE_FIELDS.retread_started.includes('vendor_name'));
  assert.ok(AMENDABLE_FIELDS.retread_started.includes('notes'));
});

test('distanceService: computeTyreDistanceFromStints correctly aggregates past stints and active bus stint', () => {
  const mockEvents = [
    // Stint 1: Fitment at 10,000 km, Replacement at 15,000 km -> 5,000 km
    { event_type: 'fitment_created', bus_id: 1, odometer_km: 10000, event_date: '2026-01-01T10:00:00Z' },
    { event_type: 'replacement', bus_id: 1, from_position: 'FL', odometer_km: 15000, event_date: '2026-02-01T10:00:00Z' },
    // Stint 2: Fitment at 20,000 km, Send to store at 28,500 km -> 8,500 km
    { event_type: 'fitment_created', bus_id: 2, odometer_km: 20000, event_date: '2026-03-01T10:00:00Z' },
    { event_type: 'send_to_store', bus_id: 2, odometer_km: 28500, event_date: '2026-04-01T10:00:00Z' },
    // Stint 3 (Active): Fitment at 50,000 km, live bus is currently at 54,200 km -> 4,200 km
    { event_type: 'fitment_created', bus_id: 3, odometer_km: 50000, event_date: '2026-05-01T10:00:00Z' },
  ];

  const totalKm = computeTyreDistanceFromStints(mockEvents, { id: 3, odometer_km: 54200 });
  // 5,000 + 8,500 + 4,200 = 17,700 km
  assert.equal(totalKm, 17700);
});

test('distanceService: computeTyreDistanceFromStints handles transfers and unmounted state', () => {
  const mockEvents = [
    // Stint on Bus 1: fitment at 10,000 km
    { event_type: 'fitment_created', bus_id: 1, odometer_km: 10000 },
    // Transfer from Bus 1 to Bus 2 at Bus 1 odometer 13,000 km
    { event_type: 'inter_bus_transfer', from_bus_id: 1, to_bus_id: 2, odometer_km: 13000 }, // +3000 km on Bus 1, starts on Bus 2 at 13000 (or respective bus odometer)
    // Send to store from Bus 2 at Bus 2 odometer 16,500 km
    { event_type: 'send_to_store', bus_id: 2, odometer_km: 16500 }, // +3500 km on Bus 2
  ];

  const totalKm = computeTyreDistanceFromStints(mockEvents, null);
  // 3,000 + 3,500 = 6,500 km
  assert.equal(totalKm, 6500);
});
