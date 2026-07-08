const http = require('http');
const db = require('../src/db');
const { generateQrPayload, parseQrPayload } = require('../src/utils/qrPayload');

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
  console.log('=== EBTMS QR Identification & Scanning Verification ===');

  // --- Test A: Payload Generation ---
  console.log('\n[Test A] Verifying QR Payload Format Generation...');
  const payload = generateQrPayload('TYR-0001');
  console.log('Generated Payload:', payload);
  console.log('Matches Expected Format (EBTMS:TYRE:V1:TYR-0001):', payload === 'EBTMS:TYRE:V1:TYR-0001');

  // Obtain login tokens for roles
  console.log('\nLogging in users...');
  
  // 1. Admin login
  let res = await request({
    hostname: 'localhost', port: 4000, path: '/api/auth/login', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { username: 'admin', password: 'Passw0rd!' });
  const adminToken = res.data.token;

  // 2. Mumbai Manager login
  res = await request({
    hostname: 'localhost', port: 4000, path: '/api/auth/login', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { username: 'dm_mum', password: 'Passw0rd!' });
  const mumbaiToken = res.data.token;

  // --- Test B: Existing Tyre Lookup ---
  console.log('\n[Test B] Looking up TYR-0001 as Admin...');
  res = await request({
    hostname: 'localhost', port: 4000, path: '/api/tyres/lookup/TYR-0001', method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  console.log('Status:', res.status);
  console.log('Returned Data:', res.data);
  console.log('Resolves correct tyre ID (1):', res.data.id === 1);

  // --- Test C: Invalid QR payloads ---
  console.log('\n[Test C] Parsing invalid QR payloads...');
  console.log('Parse "https://google.com":', parseQrPayload('https://google.com'));
  console.log('Parse "TYR-0001":', parseQrPayload('TYR-0001'));
  console.log('Parse "EBTMS:USER:V1:1":', parseQrPayload('EBTMS:USER:V1:1'));
  console.log('Parse "EBTMS:TYRE:V1:TYR-0001":', parseQrPayload('EBTMS:TYRE:V1:TYR-0001'));

  // --- Test D: Nonexistent Tyre Lookup ---
  console.log('\n[Test D] Looking up non-existent tyre number (TYR-NOT-FOUND)...');
  res = await request({
    hostname: 'localhost', port: 4000, path: '/api/tyres/lookup/TYR-NOT-FOUND', method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  console.log('Status:', res.status);
  console.log('Error message:', res.data.error);

  // --- Test E: Depot Scoping (Mumbai manager looking up Delhi tyre TYR-0001) ---
  console.log('\n[Test E] Verifying Depot Scoping lookup restriction...');
  res = await request({
    hostname: 'localhost', port: 4000, path: '/api/tyres/lookup/TYR-0001', method: 'GET',
    headers: { 'Authorization': `Bearer ${mumbaiToken}` }
  });
  console.log('Status (expect 403):', res.status);
  console.log('Error message:', res.data.error);

  // --- Test F: Stability check ---
  console.log('\n[Test F] Verifying QR payload remains unchanged after tyre details modify...');
  const initialPayload = generateQrPayload('TYR-0001');
  
  // Simulate updating tyre bus/position in DB
  const beforeState = db.prepare("SELECT * FROM tyres WHERE tyre_number = 'TYR-0001'").get();
  db.prepare("UPDATE tyres SET current_position = 'RR-O' WHERE tyre_number = 'TYR-0001'").run();
  
  const updatedPayload = generateQrPayload('TYR-0001');
  console.log('Initial QR Payload:', initialPayload);
  console.log('After Rotation QR Payload:', updatedPayload);
  console.log('Payloads remain identical:', initialPayload === updatedPayload);
  
  // Restore state
  db.prepare("UPDATE tyres SET current_position = ? WHERE tyre_number = 'TYR-0001'").run(beforeState.current_position);

  // --- Test G: PDF Export with QR code ---
  console.log('\n[Test G] Exporting TYR-0001 PDF and verifying format...');
  res = await request({
    hostname: 'localhost', port: 4000, path: '/api/tyres/1/export-pdf', method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  console.log('Export Status:', res.status);
  console.log('PDF File Size (bytes):', res.buffer.length);
  const isPdf = res.buffer.slice(0, 4).toString() === '%PDF';
  console.log('Starts with PDF signature (%PDF):', isPdf);

  console.log('\nVerification suite complete.');
}

runTests().catch(console.error);
