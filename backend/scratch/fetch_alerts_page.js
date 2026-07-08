const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/alerts',
  method: 'GET',
}, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    // Look for __NEXT_DATA__
    const match = data.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        console.log('--- __NEXT_DATA__ ---');
        console.log(JSON.stringify(json, null, 2));
      } catch (e) {
        console.error('Failed to parse JSON:', e);
      }
    } else {
      console.log('__NEXT_DATA__ not found');
    }
    // Print any readable text in the body
    const bodyText = data.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log('--- Text Content ---');
    console.log(bodyText.slice(0, 1000));
  });
});

req.on('error', (e) => {
  console.error('Request failed:', e);
});

req.end();
