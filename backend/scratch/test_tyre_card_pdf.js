const http = require('http');

function request(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = [];
      res.on('data', (chunk) => { data.push(chunk); });
      res.on('end', () => {
        const buffer = Buffer.concat(data);
        try {
          const parsed = JSON.parse(buffer.toString());
          resolve({ status: res.statusCode, headers: res.headers, data: parsed, buffer });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, data: buffer.toString(), buffer });
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
  const token = res.data.token;
  if (!token) {
    console.error('Failed to login:', res.data);
    return;
  }

  console.log('--- 2. Export PDF for Tyre #1 ---');
  res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/tyres/1/export-pdf',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  console.log('Export Status:', res.status);
  console.log('PDF File Size (bytes):', res.buffer.length);
  
  if (res.status === 200) {
    const pdfText = res.buffer.toString('binary');
    // Search for DL01EV1001 in the PDF content
    const countMatches = (pdfText.match(/DL01EV1001/g) || []).length;
    console.log('Occurrences of DL01EV1001 in PDF:', countMatches);
    if (countMatches >= 2) {
      console.log('SUCCESS: DL01EV1001 is present multiple times in the PDF!');
    } else {
      console.log('FAIL: DL01EV1001 is missing or not present in both profile and history rows');
    }
  } else {
    console.log('FAIL: API returned error status', res.status);
  }
}

runTests().catch(console.error);
