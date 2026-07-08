const http = require('http');

function request(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, data });
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- 1. Login as Admin ---');
  let res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { username: 'admin', password: 'Passw0rd!' });
  console.log('Admin login status:', res.status);
  const adminToken = res.data.token;
  if (!adminToken) {
    console.error('Failed to login as admin:', res.data);
    return;
  }

  console.log('--- 2. Fetch Dashboard Summary as Admin ---');
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/dashboard/national',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  console.log('National Dashboard metrics:', res.data);

  console.log('--- 3. Login as ts_del ---');
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { username: 'ts_del', password: 'Passw0rd!' });
  console.log('ts_del login status:', res.status);
  const tsToken = res.data.token;
  if (!tsToken) {
    console.error('Failed to login as ts_del:', res.data);
    return;
  }

  console.log('--- 4. Log NSD 1.5 mm Event for TYR-0001 as ts_del ---');
  // First get TYR-0001 tyre ID
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/tyres?search=TYR-0001',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${tsToken}` }
  });
  const tyr1 = res.data.data.find(t => t.tyre_number === 'TYR-0001');
  if (!tyr1) {
    console.error('TYR-0001 not found');
    return;
  }
  console.log('TYR-0001 ID:', tyr1.id);

  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/events',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tsToken}`
    },
  }, { event_type: 'nsd_reading', tyre_id: tyr1.id, nsd_value: 1.5 });
  console.log('Log event response status:', res.status, res.data);

  console.log('--- 5. Get Bus DL01EV1001 details to see FL position tyre ---');
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/buses/1', // ID 1 is DL01EV1001
    method: 'GET',
    headers: { 'Authorization': `Bearer ${tsToken}` }
  });
  console.log('Bus DL01EV1001 FL tyre position data:', res.data.tyre_position_map.find(slot => slot.position === 'FL'));

  console.log('--- 6. Log Batch Inspection for DL01EV1002 ---');
  // Let's find tyres on DL01EV1002
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/buses/2', // DL01EV1002
    method: 'GET',
    headers: { 'Authorization': `Bearer ${tsToken}` }
  });
  const mountedTyres = res.data.tyre_position_map.filter(slot => slot.tyre);
  if (mountedTyres.length < 2) {
    console.error('Not enough mounted tyres on DL01EV1002');
    return;
  }
  const t1 = mountedTyres[0].tyre.id;
  const t2 = mountedTyres[1].tyre.id;
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/events/batch',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tsToken}`
    },
  }, {
    bus_id: 2,
    readings: [
      { tyre_id: t1, nsd_value: 3.5 },
      { tyre_id: t2, pressure_value: 70 }
    ]
  });
  console.log('Batch inspection response status:', res.status, res.data);

  console.log('--- 7. Get Alerts list as Admin ---');
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/alerts',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const alertsArray = res.data.data || [];
  const openAlerts = alertsArray.filter(a => a.status === 'Open');
  console.log(`Found ${openAlerts.length} open alerts`);
  openAlerts.forEach(a => {
    console.log(`Alert ID ${a.id}: parameter_type=${a.parameter_type}, severity=${a.severity}, status=${a.status}, tyre=${a.tyre_number}`);
  });

  const tyr1Alert = openAlerts.find(a => a.tyre_id === tyr1.id);
  if (tyr1Alert) {
    console.log('--- 8. Acknowledge TYR-0001 Alert ---');
    res = await request({
      hostname: 'localhost',
      port: 4000,
      path: `/api/alerts/${tyr1Alert.id}/acknowledge`,
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    console.log('Acknowledge alert status:', res.status, res.data);

    console.log('--- 9. Resolve TYR-0001 Alert ---');
    res = await request({
      hostname: 'localhost',
      port: 4000,
      path: `/api/alerts/${tyr1Alert.id}/resolve`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      }
    }, { resolution_note: 'Resolved critical wear by scheduling tyre rotation.' });
    console.log('Resolve alert status:', res.status, res.data);
  } else {
    console.error('Critical NSD alert on TYR-0001 not found in open alerts list!');
  }
}

runTests().catch(console.error);
