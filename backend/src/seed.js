/**
 * @file seed.js
 * @description Data seeder script for EBTMS.
 * Performs database cleaning (clearAll) and populates the database with realistic mock data
 * (depots, users with pre-hashed passwords, bus models, buses, tyres in service and in stock,
 * and default system threshold bounds) inside a database transaction block.
 */

const bcrypt = require('bcrypt');
const db = require('./db');
const { getPositionLayout } = require('./utils/busLayout');

const DEV_PASSWORD = 'Passw0rd!';

function clearAll() {
  const tables = ['audit_log', 'alerts', 'tyre_events', 'tyres', 'buses', 'bus_models', 'thresholds', 'users', 'depots'];
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  for (const t of tables) db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t);
}

function seed() {
  const insertDepot = db.prepare(`
    INSERT INTO depots (name, code, region, address) VALUES (@name, @code, @region, @address)
  `);
  const insertUser = db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role, depot_id)
    VALUES (@username, @email, @password_hash, @full_name, @role, @depot_id)
  `);
  const insertBusModel = db.prepare(`
    INSERT INTO bus_models (name, manufacturer, num_positions, position_labels_json)
    VALUES (@name, @manufacturer, @num_positions, @position_labels_json)
  `);
  const insertBus = db.prepare(`
    INSERT INTO buses (depot_id, registration_no, chassis_no, bus_model_id, year_of_manufacture, date_of_entry_into_fleet, status, odometer_km)
    VALUES (@depot_id, @registration_no, @chassis_no, @bus_model_id, @year_of_manufacture, @date_of_entry_into_fleet, @status, @odometer_km)
  `);
  const insertTyre = db.prepare(`
    INSERT INTO tyres (tyre_number, brand, model, size, purchase_date, initial_nsd, status, current_bus_id, current_position, current_depot_id)
    VALUES (@tyre_number, @brand, @model, @size, @purchase_date, @initial_nsd, @status, @current_bus_id, @current_position, @current_depot_id)
  `);
  const insertThreshold = db.prepare(`
    INSERT INTO thresholds (parameter_type, scope_type, scope_id, warning_min, warning_max, critical_min, critical_max, unit, updated_by)
    VALUES (@parameter_type, @scope_type, @scope_id, @warning_min, @warning_max, @critical_min, @critical_max, @unit, @updated_by)
  `);

  const runSeed = db.transaction(() => {
    clearAll();

    const depots = [
      { name: 'Delhi Central Depot', code: 'DEL-C', region: 'North', address: 'Sector 18, Rohini, New Delhi' },
      { name: 'Mumbai West Depot', code: 'MUM-W', region: 'West', address: 'Andheri West, Mumbai' },
      { name: 'Bengaluru South Depot', code: 'BLR-S', region: 'South', address: 'Electronic City, Bengaluru' },
    ];
    const depotIds = {};
    for (const d of depots) {
      const info = insertDepot.run(d);
      depotIds[d.code] = info.lastInsertRowid;
    }

    const passwordHash = bcrypt.hashSync(DEV_PASSWORD, 10);
    const users = [
      { username: 'admin', email: 'admin@ebtms.local', full_name: 'Aditi Sharma', role: 'System Administrator', depot_id: null },
      { username: 'nfm', email: 'nfm@ebtms.local', full_name: 'Rohan Mehta', role: 'National Fleet Manager', depot_id: null },
      { username: 'dm_del', email: 'dm.del@ebtms.local', full_name: 'Karan Singh', role: 'Depot Manager', depot_id: depotIds['DEL-C'] },
      { username: 'dm_mum', email: 'dm.mum@ebtms.local', full_name: 'Priya Nair', role: 'Depot Manager', depot_id: depotIds['MUM-W'] },
      { username: 'ts_del', email: 'ts.del@ebtms.local', full_name: 'Vikram Rao', role: 'Tyre Supervisor', depot_id: depotIds['DEL-C'] },
      { username: 'ts_mum', email: 'ts.mum@ebtms.local', full_name: 'Anjali Deshmukh', role: 'Tyre Supervisor', depot_id: depotIds['MUM-W'] },
      { username: 'auditor', email: 'auditor@ebtms.local', full_name: 'Suresh Iyer', role: 'Read-Only Auditor', depot_id: null },
    ];
    const userIds = {};
    for (const u of users) {
      const info = insertUser.run({ ...u, password_hash: passwordHash });
      userIds[u.username] = info.lastInsertRowid;
    }

    // FR-BM-XX: num_positions is the only admin-entered value -- position
    // codes are generated from it (utils/busLayout.js), never hardcoded, so
    // seed data and runtime-created bus models can never drift apart.
    function busModelRow({ name, manufacturer, numPositions }) {
      const positionLabels = getPositionLayout(numPositions);
      return {
        name,
        manufacturer,
        num_positions: positionLabels.length,
        position_labels_json: JSON.stringify(positionLabels),
      };
    }

    const busModels = [
      busModelRow({ name: 'Tata Starbus EV', manufacturer: 'Tata Motors', numPositions: 6 }),
      busModelRow({ name: 'Olectra K7', manufacturer: 'Olectra Greentech', numPositions: 6 }),
      busModelRow({ name: 'PMI eBuzz', manufacturer: 'PMI Electro Mobility', numPositions: 6 }),
      busModelRow({ name: 'Tata Starbus EV Articulated', manufacturer: 'Tata Motors', numPositions: 10 }),
    ];
    const busModelIds = {};
    const busModelPositions = {};
    for (const m of busModels) {
      const info = insertBusModel.run(m);
      busModelIds[m.name] = info.lastInsertRowid;
      busModelPositions[m.name] = JSON.parse(m.position_labels_json);
    }

    const buses = [
      { depot_id: depotIds['DEL-C'], registration_no: 'DL01EV1001', chassis_no: 'MAT123456DEL0001', bus_model_id: busModelIds['Tata Starbus EV'], year_of_manufacture: 2023, date_of_entry_into_fleet: '2023-04-10', status: 'Active', odometer_km: 42500 },
      { depot_id: depotIds['DEL-C'], registration_no: 'DL01EV1002', chassis_no: 'MAT123456DEL0002', bus_model_id: busModelIds['Tata Starbus EV'], year_of_manufacture: 2023, date_of_entry_into_fleet: '2023-05-02', status: 'Active', odometer_km: 31200 },
      { depot_id: depotIds['MUM-W'], registration_no: 'MH02EV2001', chassis_no: 'MAT223456MUM0001', bus_model_id: busModelIds['Olectra K7'], year_of_manufacture: 2022, date_of_entry_into_fleet: '2022-11-20', status: 'Active', odometer_km: 55800 },
      { depot_id: depotIds['MUM-W'], registration_no: 'MH02EV2002', chassis_no: 'MAT223456MUM0002', bus_model_id: busModelIds['Olectra K7'], year_of_manufacture: 2022, date_of_entry_into_fleet: '2022-12-05', status: 'Under Maintenance', odometer_km: 61200 },
      { depot_id: depotIds['BLR-S'], registration_no: 'KA03EV3001', chassis_no: 'MAT323456BLR0001', bus_model_id: busModelIds['PMI eBuzz'], year_of_manufacture: 2024, date_of_entry_into_fleet: '2024-01-15', status: 'Active', odometer_km: 18900 },
      { depot_id: depotIds['BLR-S'], registration_no: 'KA03EV3002', chassis_no: 'MAT323456BLR0002', bus_model_id: busModelIds['Tata Starbus EV Articulated'], year_of_manufacture: 2024, date_of_entry_into_fleet: '2024-03-01', status: 'Active', odometer_km: 9800 },
    ];
    const busIds = {};
    const busModelIdToName = Object.fromEntries(Object.entries(busModelIds).map(([n, id]) => [id, n]));
    for (const b of buses) {
      const info = insertBus.run(b);
      busIds[b.registration_no] = info.lastInsertRowid;
    }

    const brands = ['MRF', 'CEAT', 'Apollo', 'Michelin'];
    let tyreCounter = 1;
    const tyres = [];

    // Mount a full set of tyres on the first three active 6-position buses.
    const mountedOn = ['DL01EV1001', 'DL01EV1002', 'MH02EV2001'];
    for (const reg of mountedOn) {
      const bus = buses.find((b) => b.registration_no === reg);
      const positionsForBus = busModelPositions[busModelIdToName[bus.bus_model_id]];
      for (const pos of positionsForBus) {
        tyres.push({
          tyre_number: `TYR-${String(tyreCounter).padStart(4, '0')}`,
          brand: brands[tyreCounter % brands.length],
          model: 'EV Radial 275/70 R22.5',
          size: '275/70 R22.5',
          purchase_date: '2025-02-01',
          initial_nsd: 12,
          status: 'In Service',
          current_bus_id: busIds[reg],
          current_position: pos,
          current_depot_id: bus.depot_id,
        });
        tyreCounter += 1;
      }
    }

    // Spare tyres sitting in depot stock (not mounted).
    for (let i = 0; i < 6; i += 1) {
      tyres.push({
        tyre_number: `TYR-${String(tyreCounter).padStart(4, '0')}`,
        brand: brands[tyreCounter % brands.length],
        model: 'EV Radial 275/70 R22.5',
        size: '275/70 R22.5',
        purchase_date: '2025-06-20',
        initial_nsd: 13,
        status: 'In Store',
        current_bus_id: null,
        current_position: null,
        current_depot_id: i % 2 === 0 ? depotIds['DEL-C'] : depotIds['MUM-W'],
      });
      tyreCounter += 1;
    }

    // A couple of condemned / under-repair tyres for status filter coverage.
    tyres.push({
      tyre_number: `TYR-${String(tyreCounter).padStart(4, '0')}`,
      brand: 'MRF',
      model: 'EV Radial 275/70 R22.5',
      size: '275/70 R22.5',
      purchase_date: '2024-08-10',
      initial_nsd: 12,
      status: 'Condemned',
      current_bus_id: null,
      current_position: null,
      current_depot_id: depotIds['DEL-C'],
    });
    tyreCounter += 1;
    tyres.push({
      tyre_number: `TYR-${String(tyreCounter).padStart(4, '0')}`,
      brand: 'CEAT',
      model: 'EV Radial 275/70 R22.5',
      size: '275/70 R22.5',
      purchase_date: '2025-01-05',
      initial_nsd: 12,
      status: 'Under Repair',
      current_bus_id: null,
      current_position: null,
      current_depot_id: depotIds['MUM-W'],
    });

    for (const t of tyres) insertTyre.run(t);

    const thresholds = [
      { parameter_type: 'NSD', scope_type: 'GLOBAL', scope_id: null, warning_min: null, warning_max: 4, critical_min: null, critical_max: 2, unit: 'mm' },
      { parameter_type: 'PRESSURE', scope_type: 'GLOBAL', scope_id: null, warning_min: 90, warning_max: 120, critical_min: 80, critical_max: 130, unit: 'psi' },
      { parameter_type: 'INSPECTION_INTERVAL', scope_type: 'GLOBAL', scope_id: null, warning_min: null, warning_max: 7, critical_min: null, critical_max: 14, unit: 'days' },
      { parameter_type: 'ESCALATION_DAYS', scope_type: 'GLOBAL', scope_id: null, warning_min: null, warning_max: 3, critical_min: null, critical_max: null, unit: 'days' },
    ];
    for (const t of thresholds) insertThreshold.run({ ...t, updated_by: userIds['admin'] });

    return {
      depots: depots.length,
      users: users.length,
      busModels: busModels.length,
      buses: buses.length,
      tyres: tyres.length,
      thresholds: thresholds.length,
    };
  });

  // Execute the transaction in SQLite
  const summary = runSeed();
  console.log('Seed complete:', summary);
  console.log(`All seeded users share the password: ${DEV_PASSWORD}`);
  console.log('Usernames:', ['admin', 'nfm', 'dm_del', 'dm_mum', 'ts_del', 'ts_mum', 'auditor'].join(', '));
}

// Run seed execution immediately when executing the script
seed();
