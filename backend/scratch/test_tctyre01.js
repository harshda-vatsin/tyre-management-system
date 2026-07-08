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
  const adminToken = res.data.token;
  if (!adminToken) {
    console.error('Failed to login:', res.data);
    return;
  }

  // Delete tyre first if it exists from previous manual runs
  console.log('--- 1b. Cleanup test tyre if exists ---');
  const checkTyreRes = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/tyres?search=TYR-TEST-999',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  if (checkTyreRes.data?.data?.length > 0) {
    const existingTyre = checkTyreRes.data.data[0];
    await request({
      hostname: 'localhost',
      port: 4000,
      path: `/api/tyres/${existingTyre.id}`,
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    console.log('Cleaned up existing TYR-TEST-999');
  }

  console.log('--- 2. Register tyre TYR-TEST-999 ---');
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/tyres',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    }
  }, {
    tyre_number: 'TYR-TEST-999',
    brand: 'MRF',
    model: 'EV Radial 275',
    size: '275/70 R22.5',
    initial_nsd: 12.5,
    status: 'In Store',
    current_depot_id: 1
  });
  console.log('Register status:', res.status);
  const newTyreId = res.data.id;
  console.log('Registered Tyre ID:', newTyreId);

  console.log('--- 3. Query Audit Log for tyre CREATE entries ---');
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/audit?action=CREATE&entity_type=tyre',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  console.log('Audit query status:', res.status);
  const matching = res.data.data?.find(log => log.entity_id === String(newTyreId));
  if (matching) {
    console.log('SUCCESS: Found matching audit entry!');
    console.log('Audit Entry details:', {
      id: matching.id,
      username: matching.username,
      action: matching.action,
      entity_type: matching.entity_type,
      entity_id: matching.entity_id
    });
    console.log('After JSON State:', JSON.parse(matching.after_json));
  } else {
    console.log('FAIL: Could not find CREATE audit entry for tyre ID', newTyreId);
  }
}

runTests().catch(console.error);
