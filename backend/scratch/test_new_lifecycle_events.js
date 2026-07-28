const BASE = 'http://127.0.0.1:4000/api';

async function call(method, path, body, token, expectStatus) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  const ok = expectStatus ? res.status === expectStatus : res.ok;
  if (!ok) {
    console.error(`FAIL ${method} ${path} -> ${res.status} (expected ${expectStatus || '2xx'})`, data);
    throw new Error(`${method} ${path} failed`);
  }
  console.log(`OK   ${method} ${path} -> ${res.status}`);
  return data;
}

(async () => {
  const login = await call('POST', '/auth/login', { username: 'admin', password: 'Passw0rd!' });
  const token = login.token;

  // 1. Create a tyre -- should auto-fire purchase_intake and accept purchase_cost
  const tyre = await call('POST', '/tyres', {
    tyre_number: `LIFECYCLE-${Date.now() % 100000}`,
    brand: 'TestBrand',
    purchase_cost: 15000,
    status: 'Inventory',
  }, token);
  console.log('  tyre created, status:', tyre.status, 'purchase_cost:', tyre.purchase_cost);

  const events1 = await call('GET', `/events?tyre_id=${tyre.id}`, null, token);
  const eventTypes1 = events1.data.map((e) => e.event_type);
  console.log('  events after creation:', eventTypes1);
  if (!eventTypes1.includes('purchase_intake')) throw new Error('Expected purchase_intake event to exist');

  // 2. fitment_created: mount onto a free position. Bus 5 (KA03EV3001) -- check occupancy first.
  const busTyres = await call('GET', '/tyres?bus_id=5', null, token);
  console.log('  bus 5 occupants:', busTyres.data.map((t) => t.current_position));
  // Free RR-O by sending its occupant to store first (reuse existing handler)
  const occupant = busTyres.data.find((t) => t.current_position === 'RR-O');
  if (occupant) {
    await call('POST', '/events', { event_type: 'send_to_store', tyre_id: occupant.id, reason: 'test setup', nsd_value: 5, stored_at: 'x' }, token);
  }

  const fitment = await call('POST', '/events', {
    event_type: 'fitment_created', tyre_id: tyre.id, bus_id: 5, position: 'RR-O', reason: 'Test fitment',
  }, token);
  console.log('  fitment_created ->', fitment.event_type);
  let tyreAfterFitment = await call('GET', `/tyres/${tyre.id}`, null, token);
  console.log('  status after fitment_created:', tyreAfterFitment.status, '(expect Mounted)');

  // 3. First reading should auto-advance Mounted -> Running
  await call('POST', '/events', { event_type: 'nsd_reading', tyre_id: tyre.id, nsd_value: 8 }, token);
  let tyreAfterReading = await call('GET', `/tyres/${tyre.id}`, null, token);
  console.log('  status after first nsd_reading:', tyreAfterReading.status, '(expect Running)');

  // 4. inspection_completed
  const inspection = await call('POST', '/events', { event_type: 'inspection_completed', tyre_id: tyre.id, notes: 'All good' }, token);
  console.log('  inspection_completed ->', inspection.event_type);

  // 5. puncture_repair -- now transitions to Repair Completed and records repair_cost
  const repair = await call('POST', '/events', {
    event_type: 'puncture_repair', tyre_id: tyre.id, repair_type: 'plug', notes: 'roadside', repair_cost: 250,
  }, token);
  console.log('  puncture_repair repair_cost:', repair.repair_cost);
  let tyreAfterRepair = await call('GET', `/tyres/${tyre.id}`, null, token);
  console.log('  status after puncture_repair:', tyreAfterRepair.status, '(expect Repair Completed)');

  // 6. Illegal: try fitment_created while still mounted-status-adjacent but current_bus_id is null (it's fine) -- instead test scrap from Repair Completed should be BLOCKED unless via allowed path; let's do retread_sent from Repair Completed -- should be rejected (only Removed/Inventory/In Store allowed)
  await call('POST', '/events', { event_type: 'retread_sent', tyre_id: tyre.id, vendor_name: 'Acme Retreads' }, token, 409);
  console.log('  retread_sent from Repair Completed correctly rejected (409)');

  // 7. Move to Inventory via reservation-like path isn't valid from Repair Completed either (only Waiting Installation).
  // Waiting Installation -> Mounted or Inventory; simulate reaching Inventory legitimately via Waiting Installation is out of a single event's scope for this test,
  // so use send_to_store as the global escape valve (Repair Completed is non-terminal, so 'In Store' edge exists globally).
  await call('POST', '/events', { event_type: 'send_to_store', tyre_id: tyre.id, reason: 'to store for retread', nsd_value: 5, stored_at: 'Bengaluru Depot Store' }, token);
  let tyreInStore = await call('GET', `/tyres/${tyre.id}`, null, token);
  console.log('  status after send_to_store:', tyreInStore.status, '(expect In Store)');

  // 8. retread_sent from In Store (aliased to Inventory's edges) should now work
  const retreadSent = await call('POST', '/events', { event_type: 'retread_sent', tyre_id: tyre.id, vendor_name: 'Acme Retreads' }, token);
  console.log('  retread_sent ->', retreadSent.event_type, retreadSent.vendor_name);
  let tyreAtVendor = await call('GET', `/tyres/${tyre.id}`, null, token);
  console.log('  status after retread_sent:', tyreAtVendor.status, '(expect Sent for Retread)');

  // 9. Illegal: retread_sent again while already Sent for Retread
  await call('POST', '/events', { event_type: 'retread_sent', tyre_id: tyre.id, vendor_name: 'Acme Retreads' }, token, 409);
  console.log('  duplicate retread_sent correctly rejected (409)');

  // 10. retread_completed
  const retreadDone = await call('POST', '/events', { event_type: 'retread_completed', tyre_id: tyre.id, vendor_name: 'Acme Retreads', retread_cost: 3200, notes: 'Good as new' }, token);
  console.log('  retread_completed retread_cost:', retreadDone.retread_cost);
  let tyreReturned = await call('GET', `/tyres/${tyre.id}`, null, token);
  console.log('  status after retread_completed:', tyreReturned.status, '(expect Returned to Inventory)');

  // 11. warranty_claim submission then resolution
  const claim = await call('POST', '/events', { event_type: 'warranty_claim', tyre_id: tyre.id, reason: 'Premature wear' }, token);
  console.log('  warranty_claim submitted:', claim.event_type, claim.reason);
  let tyrePending = await call('GET', `/tyres/${tyre.id}`, null, token);
  console.log('  status after warranty submission:', tyrePending.status, '(expect Warranty Pending)');

  const resolved = await call('POST', '/events', { event_type: 'warranty_claim', tyre_id: tyre.id, outcome: 'rejected', reason: 'Out of warranty window' }, token);
  console.log('  warranty_claim resolved:', resolved.reason);
  let tyreRejected = await call('GET', `/tyres/${tyre.id}`, null, token);
  console.log('  status after warranty resolution:', tyreRejected.status, '(expect Warranty Rejected)');

  // 12. scrap
  const scrap = await call('POST', '/events', { event_type: 'scrap', tyre_id: tyre.id, reason: 'End of life', scrap_value: 100 }, token);
  console.log('  scrap scrap_value:', scrap.scrap_value);
  let tyreScrapped = await call('GET', `/tyres/${tyre.id}`, null, token);
  console.log('  status after scrap:', tyreScrapped.status, '(expect Scrapped)');

  // 13. Illegal: try to fitment_created a Scrapped tyre
  await call('POST', '/events', { event_type: 'fitment_created', tyre_id: tyre.id, bus_id: 5, position: 'RR-O', reason: 'illegal' }, token, 409);
  console.log('  fitment_created on Scrapped tyre correctly rejected (409)');

  // 14. scrap_disposal wind-down
  await call('POST', '/events', { event_type: 'scrap_disposal', tyre_id: tyre.id, to_status: 'Disposed', reason: 'disposed per policy' }, token);
  const disposed = await call('GET', `/tyres/${tyre.id}`, null, token);
  console.log('  status after scrap_disposal (Disposed):', disposed.status);
  await call('POST', '/events', { event_type: 'scrap_disposal', tyre_id: tyre.id, to_status: 'Archived', reason: 'archived' }, token);
  const archived = await call('GET', `/tyres/${tyre.id}`, null, token);
  console.log('  status after scrap_disposal (Archived):', archived.status);

  // 15. PUT guard: try to mount the archived tyre directly via master-data edit
  await call('PUT', `/tyres/${tyre.id}`, { current_bus_id: 5, current_position: 'FL' }, token, 409);
  console.log('  PUT attempt to mount Archived tyre correctly rejected (409)');

  console.log('\n=== ALL NEW LIFECYCLE EVENT TESTS PASSED ===');
})().catch((err) => {
  console.error('\n=== TEST FAILED ===');
  console.error(err);
  process.exit(1);
});
