/**
 * @file referenceResolvers.js
 * @description Per-sheet-type wiring for the Master Data Cache (§2): which
 * raw fields on a NormalizedRow resolve through which cache lookup, and
 * which resolved field they populate. Runs once per row, in place, before
 * either Tier 1 validation or the Event Generator sees the row -- both of
 * those depend on resolved IDs already being present.
 */

const { normalizePositionCode } = require('../utils/busLayout');

const RESOLVERS = {};

function registerReferenceResolver(sheetType, resolveFn) {
  RESOLVERS[sheetType] = resolveFn;
}

function resolveReferences(normalizedRow, cache) {
  const resolver = RESOLVERS[normalizedRow.sheetType];
  if (resolver) resolver(normalizedRow, cache);
  return normalizedRow;
}

// Shared by every sheet type that carries a depot reference. Resolution
// itself stays purely in-memory (no DB write, §5) -- a depot name that
// doesn't resolve is flagged via newDepotRegistration instead, for the
// Replay Engine to act on (replayEngine.js) once it's actually inside a
// transaction a dry-run can roll back and a live run can commit. Same
// reasoning, same pattern, as resolveBusReference below.
function resolveDepotReference(row, cache) {
  row.depot_id = cache.resolveDepot(row.depot_raw);
  if (!row.depot_id && row.depot_raw) {
    row.newDepotRegistration = row.depot_raw;
  }
}

// Shared by every sheet type that carries a bus reference. Resolution
// itself stays exactly what it always was (in-memory, no DB round-trip,
// §5) -- a row whose bus doesn't exist yet is never created here. It's
// flagged via newBusRegistration instead, for the Replay Engine to act on
// (replayEngine.js) once it's actually inside a transaction a dry-run can
// roll back and a live run can commit -- the same reason Consumption's
// brand-new tyre is created at replay time, not at resolution time (§6).
// Never flagged without a depot to attach it to (buses.depot_id is NOT
// NULL): a resolved depot_id or a newDepotRegistration the Replay Engine
// will itself create first (both handled the same way there) both count --
// only a row whose depot text didn't resolve *and* wasn't even present
// leaves the bus reference unresolved with nothing to create.
function resolveBusReference(row, cache) {
  row.bus_id = cache.resolveBus(row.bus_number_raw);
  if (!row.bus_id && row.bus_number_raw && (row.depot_id || row.newDepotRegistration)) {
    row.newBusRegistration = row.bus_number_raw;
  }
}

registerReferenceResolver('puncture_repair', (row, cache) => {
  resolveDepotReference(row, cache);
  row.tyre_id = cache.resolveTyre(row.tyre_number_raw);
});

registerReferenceResolver('scrap', (row, cache) => {
  row.package_id = cache.resolvePackage(row.package_raw);
  resolveDepotReference(row, cache);
  row.tyre_id = cache.resolveTyre(row.tyre_number_raw);
});

registerReferenceResolver('warranty', (row, cache) => {
  row.package_id = cache.resolvePackage(row.package_raw);
  resolveDepotReference(row, cache);
  row.tyre_id = cache.resolveTyre(row.tyre_number_raw);
});

registerReferenceResolver('retread', (row, cache) => {
  row.package_id = cache.resolvePackage(row.package_raw);
  resolveDepotReference(row, cache);
  row.tyre_id = cache.resolveTyre(row.tyre_number_raw);
});

registerReferenceResolver('nsd', (row, cache) => {
  resolveDepotReference(row, cache);
  resolveBusReference(row, cache);
  row.tyre_id = cache.resolveTyre(row.tyre_number_raw);
  row.position = normalizePositionCode(row.position);
});

registerReferenceResolver('rotation', (row, cache) => {
  row.package_id = cache.resolvePackage(row.package_raw);
  resolveDepotReference(row, cache);
  resolveBusReference(row, cache);
  row.tyre_id = cache.resolveTyre(row.tyre_number_raw);
});

registerReferenceResolver('wheel_alignment', (row, cache) => {
  resolveDepotReference(row, cache);
  resolveBusReference(row, cache);
});

// Consumption is usually about a tyre entering inventory for the first
// time, so tyre_id is expected to come back unresolved most of the time --
// but not always: the same stencil number can legitimately reappear later
// (an old-ok-spare tyre re-fitted after an earlier removal), and the sheet
// doesn't distinguish "brand new" from "already known" in any single
// column. Attempting resolution here (rather than assuming "always new")
// is what lets the Event Generator tell the two cases apart and only
// create a tyre row when one genuinely doesn't exist yet (§6).
registerReferenceResolver('consumption', (row, cache) => {
  resolveDepotReference(row, cache);
  resolveBusReference(row, cache);
  row.tyre_id = cache.resolveTyre(row.tyre_number_raw);
  row.removed_tyre_id = cache.resolveTyre(row.removed_tyre_number_raw);
  // MIS workbooks commonly write dual-wheel position codes without the
  // hyphen (RLO/RRI/...) the canonical layout uses (utils/busLayout.js) --
  // normalized here, before fitment_created validates it against that layout.
  row.position = normalizePositionCode(row.position);
});

module.exports = { registerReferenceResolver, resolveReferences };
