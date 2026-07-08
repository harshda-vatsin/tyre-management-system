const { chromium } = require('playwright');

const BASE = 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err).slice(0, 200)));

  async function login(username, password) {
    await page.goto(`${BASE}/login`);
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.sidebar');
  }

  // ---------- 1. Assign auditor to a depot, verify scoping ----------
  await login('admin', 'Passw0rd!');
  await page.goto(`${BASE}/admin/users`);
  await page.waitForSelector('td:text-is("auditor")');
  const auditorRow = page.locator('tr', { has: page.locator('td:text-is("auditor")') });
  await auditorRow.locator('button[aria-label="Row actions"]').click();
  await page.click('text=Edit');
  await page.waitForSelector('#user-form');
  await page.selectOption('#user-form select >> nth=1', { label: 'Delhi Central Depot' });
  await page.click('button:has-text("Save Changes")');
  await page.waitForTimeout(500);

  // Get an auth token via API to directly check scoping (faster/more precise than UI)
  const auditorToken = await page.evaluate(async () => {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'auditor', password: 'Passw0rd!' }) });
    const data = await res.json();
    return data.token;
  });

  const scopeCheck = await page.evaluate(async (token) => {
    const busesRes = await fetch('/api/buses', { headers: { Authorization: `Bearer ${token}` } });
    const buses = await busesRes.json();
    const nationalRes = await fetch('/api/dashboard/national', { headers: { Authorization: `Bearer ${token}` } });
    return {
      busesStatus: busesRes.status,
      depotIdsSeen: [...new Set(buses.data.map((b) => b.depot_id))],
      nationalStatus: nationalRes.status,
    };
  }, auditorToken);
  console.log('AUDITOR_SCOPE_CHECK:', JSON.stringify(scopeCheck));

  // ---------- 2. Depot deactivation blocks new bus creation ----------
  await page.goto(`${BASE}/depots`);
  await page.waitForSelector('text=Mumbai West Depot');
  await page.locator('tr:has-text("Mumbai West Depot")').locator('button[aria-label="Row actions"]').click();
  await page.click('text=Deactivate');
  await page.waitForSelector('text=Deactivate Depot');
  await page.click('button:has-text("Deactivate")');
  await page.waitForTimeout(500);

  const deactivateCheck = await page.evaluate(async (token) => {
    const depotsRes = await fetch('/api/depots', { headers: { Authorization: `Bearer ${token}` } });
    const depots = await depotsRes.json();
    const mumbai = depots.find((d) => d.name === 'Mumbai West Depot');
    const createRes = await fetch('/api/buses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ registration_no: 'ZZTEST9999', chassis_no: 'ZZTESTVIN9999', bus_model_id: 1, depot_id: mumbai.id, year_of_manufacture: 2024, date_of_entry_into_fleet: '2024-01-01', status: 'Active' }),
    });
    const body = await createRes.json();
    return { mumbaiActive: mumbai.is_active, createStatus: createRes.status, createBody: body };
  }, await page.evaluate(async () => {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Passw0rd!' }) });
    return (await res.json()).token;
  }));
  console.log('DEPOT_DEACTIVATE_CHECK:', JSON.stringify(deactivateCheck));

  // reactivate Mumbai so we don't leave test state behind
  await page.goto(`${BASE}/depots`);
  await page.waitForSelector('text=Mumbai West Depot');
  await page.locator('tr:has-text("Mumbai West Depot")').locator('button[aria-label="Row actions"]').click();
  await page.click('text=Activate');
  await page.waitForSelector('text=Activate Depot');
  await page.click('button:has-text("Activate")');
  await page.waitForTimeout(300);

  // ---------- 3. No "Delete" action on depots anymore ----------
  await page.locator('tr:has-text("Mumbai West Depot")').locator('button[aria-label="Row actions"]').click();
  const hasDeleteOption = await page.locator('.row-actions-menu >> text=Delete').count();
  console.log('DEPOT_DELETE_OPTION_COUNT (should be 0):', hasDeleteOption);
  await page.keyboard.press('Escape');

  // ---------- 4. Inline threshold warning in Batch Inspection ----------
  await page.goto(`${BASE}/batch-inspection`);
  await page.waitForSelector('text=Select Depot');
  await page.locator('.card select').first().selectOption({ label: 'Delhi Central Depot' });
  await page.fill('input[placeholder="Search registration number..."]', 'DL01EV1001');
  await page.waitForTimeout(600);
  await page.click('li:has-text("DL01EV1001")');
  await page.waitForSelector('.bus-diagram-grid');
  await page.locator('.bus-diagram-tyre:not(.empty)').first().click();
  await page.waitForSelector('.modal-panel');
  await page.fill('.modal-panel input[type="number"] >> nth=0', '1.5'); // deep below any sane NSD critical threshold
  await page.waitForTimeout(200);
  const warningVisible = await page.locator('.modal-panel .error-text, .modal-panel [style*="warning"]').count();
  await page.screenshot({ path: 'C:/Users/Harshda/AppData/Local/Temp/inline-threshold-warning.png' });
  console.log('INLINE_WARNING_ELEMENT_COUNT:', warningVisible);

  console.log('PAGE_ERRORS:', JSON.stringify(errors));
  await browser.close();
})().catch((err) => { console.error('SCRIPT_FAILED:', err); process.exit(1); });
