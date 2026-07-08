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

  console.log('--- 2. Fetch Audit Logs as Admin ---');
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/audit',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  console.log('Admin fetch status:', res.status);
  console.log('Total entries count:', res.data.total);
  if (res.data.data && res.data.data.length > 0) {
    console.log('Sample entry:', res.data.data[0]);
  }

  console.log('--- 3. Fetch Audit Logs with filter Action = CREATE ---');
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/audit?action=CREATE',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  console.log('CREATE filter status:', res.status);
  console.log('CREATE entries count:', res.data.total);

  console.log('--- 4. Login as ts_del (Restricted Tyre Supervisor) ---');
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { username: 'ts_del', password: 'Passw0rd!' });
  const supervisorToken = res.data.token;

  console.log('--- 5. Attempt to Fetch Audit Logs as ts_del ---');
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/audit',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${supervisorToken}` }
  });
  console.log('Supervisor fetch status:', res.status, res.data); // Expect 403
}

runTests().catch(console.error);
