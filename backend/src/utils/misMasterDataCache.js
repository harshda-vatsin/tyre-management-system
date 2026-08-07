/**
 * @file misMasterDataCache.js
 * @description Master Data Cache for the MIS importer (architecture §2/§6).
 * Preloads Depots/Packages/BusModels/Buses/Tyres into in-memory Maps once per
 * import run, so resolving a NormalizedRow's raw reference text to an
 * internal ID never costs a DB round-trip -- that's what keeps Tier 1
 * validation (§5) purely in-memory. A tyre created mid-import
 * (purchase_intake on an earlier row) is registered back into the cache so
 * later rows in the *same* import that reference it by tyre number resolve
 * without waiting for the next full rebuild.
 */

const db = require('../db');

function indexByLowerKeys(rows, keys) {
  const map = new Map();
  for (const row of rows) {
    for (const key of keys) {
      const val = row[key];
      if (val) map.set(String(val).trim().toLowerCase(), row.id);
    }
  }
  return map;
}

function resolveFrom(index, rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  const trimmed = String(rawValue).trim();
  if (!trimmed) return null;
  return index.get(trimmed.toLowerCase()) ?? null;
}

async function buildMasterDataCache() {
  const [depots, packages, busModels, buses, tyres] = await Promise.all([
    db.prepare('SELECT id, name, code FROM depots').all(),
    db.prepare('SELECT id, name, code FROM packages').all(),
    db.prepare('SELECT id, name FROM bus_models').all(),
    db.prepare('SELECT id, registration_no, depot_id FROM buses').all(),
    db.prepare('SELECT id, tyre_number FROM tyres').all(),
  ]);

  const depotIndex = indexByLowerKeys(depots, ['name', 'code']);
  const packageIndex = indexByLowerKeys(packages, ['name', 'code']);
  const busModelIndex = indexByLowerKeys(busModels, ['name']);
  const busIndex = indexByLowerKeys(buses, ['registration_no']);
  const tyreIndex = indexByLowerKeys(tyres, ['tyre_number']);
  const busDepotById = new Map(buses.map((b) => [b.id, b.depot_id]));

  return {
    resolveDepot: (raw) => resolveFrom(depotIndex, raw),
    resolvePackage: (raw) => resolveFrom(packageIndex, raw),
    resolveBusModel: (raw) => resolveFrom(busModelIndex, raw),
    resolveBus: (raw) => resolveFrom(busIndex, raw),
    resolveTyre: (raw) => resolveFrom(tyreIndex, raw),
    depotIdForBus: (busId) => busDepotById.get(busId) ?? null,

    // Called by the Replay Engine right after a purchase_intake/fitment
    // event creates a new tyre mid-import, so a later row in the same
    // workbook that references this tyre by number resolves in-memory
    // instead of failing resolution just because the cache predates it.
    registerTyre: (tyreNumber, tyreId) => {
      if (!tyreNumber) return;
      tyreIndex.set(String(tyreNumber).trim().toLowerCase(), tyreId);
    },
    registerBus: (registrationNo, busId, depotId) => {
      if (!registrationNo) return;
      busIndex.set(String(registrationNo).trim().toLowerCase(), busId);
      busDepotById.set(busId, depotId ?? null);
    },

    // Called by the Replay Engine right after a row's unresolved depot text
    // creates a new depot mid-import (§ depot auto-provisioning), so a
    // later row in the same workbook referencing the same depot name
    // resolves in-memory instead of creating a second depot for it.
    registerDepot: (depotName, depotId) => {
      if (!depotName) return;
      depotIndex.set(String(depotName).trim().toLowerCase(), depotId);
    },
  };
}

module.exports = { buildMasterDataCache };
