const BASE = 'http://127.0.0.1:4000/api';

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    console.error(`FAIL ${method} ${path} -> ${res.status}`, data);
    throw new Error(`${method} ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  console.log(`OK   ${method} ${path} -> ${res.status}`);
  return data;
}

(async () => {
  const login = await call('POST', '/auth/login', { username: 'admin', password: 'Passw0rd!' });
  const token = login.token;

  // Continuation: test tyre id 34 (REGRESSION-5933) is already mounted at bus1/FL
  // from the prior partial run (replacement already exercised + verified OK).
  const TEST_TYRE_ID = 34;

  const nsd = await call('POST', '/events', { event_type: 'nsd_reading', tyre_id: TEST_TYRE_ID, nsd_value: 7.5 }, token);
  console.log('  nsd_reading flag_status:', nsd.flag_status);

  const pressure = await call('POST', '/events', { event_type: 'pressure_reading', tyre_id: TEST_TYRE_ID, pressure_value: 120 }, token);
  console.log('  pressure_reading flag_status:', pressure.flag_status);

  // Free bus1/FR (currently TYR-0002, id=2) so the test tyre can rotate there
  const sendToStore = await call('POST', '/events', {
    event_type: 'send_to_store', tyre_id: 2, reason: 'Regression test - freeing position',
    nsd_value: 6, stored_at: 'Delhi Central Depot Store',
  }, token);
  console.log('  send_to_store event:', sendToStore.event_type, '-> tyre now:', (await call('GET', '/tyres/2', null, token)).status);

  const rotation = await call('POST', '/events', {
    event_type: 'rotation', tyre_id: TEST_TYRE_ID, to_position: 'FR', reason: 'Regression test rotation',
  }, token);
  console.log('  rotation event:', rotation.event_type, '-> position', rotation.to_position);

  // Free bus2/FL (currently TYR-0007, id=7) so the test tyre can transfer there
  await call('POST', '/events', {
    event_type: 'send_to_store', tyre_id: 7, reason: 'Regression test - freeing bus2 FL',
    nsd_value: 6, stored_at: 'Mumbai West Depot Store',
  }, token);

  const transfer = await call('POST', '/events', {
    event_type: 'inter_bus_transfer', tyre_id: TEST_TYRE_ID, to_bus_id: 2, to_position: 'FL', reason: 'Regression test transfer',
  }, token);
  console.log('  inter_bus_transfer event:', transfer.event_type);

  const condemnation = await call('POST', '/events', {
    event_type: 'condemnation', tyre_id: TEST_TYRE_ID, reason: 'Regression test condemnation', nsd_value: 1,
  }, token);
  console.log('  condemnation event:', condemnation.event_type);

  const finalTyre = await call('GET', `/tyres/${TEST_TYRE_ID}`, null, token);
  console.log('  final test tyre status:', finalTyre.status, '(expect Condemned)');

  console.log('\n=== ALL REGRESSION CHECKS PASSED ===');
})().catch((err) => {
  console.error('\n=== REGRESSION TEST FAILED ===');
  console.error(err);
  process.exit(1);
});
