/**
 * @file replayEngine.js
 * @description The Replay Engine (§4): replay(rowUnits, { dryRun, user }).
 * One function, two modes, never two implementations -- the only
 * difference between Preview and Confirm is whether the outer transaction
 * commits or is discarded.
 *
 * Groups globally-sorted RowUnits by tyre so each tyre's own event
 * sequence commits or rolls back as one unit (§7), while one tyre's
 * failure never aborts another's. Within a tyre's chunk, db.transaction()
 * nests automatically (it's already proven for this elsewhere in db.js):
 * calling it again while already inside a transaction issues a real
 * SAVEPOINT instead of a fresh BEGIN. That's what turns processRowUnit into
 * the "row-level savepoint" (§4 step 2) for free, and it's also exactly
 * what createTyreEvent()'s own internal db.transaction() call becomes when
 * invoked from inside processRowUnit -- the "nested savepoint per event
 * attempt" (§4 step 4), without this file ever naming a savepoint itself.
 */

const db = require('../db');
const { createTyreEvent } = require('../utils/tyreEvents');
const { createWheelAlignment } = require('../utils/wheelAlignmentService');
const { insertMisRecord, updateLinkageStatus, recordGeneratedEvent, insertTyre, insertBus, insertDepot } = require('./misRecordRepository');
const { NEW_TYRE_PLACEHOLDER, NEW_BUS_PLACEHOLDER, NEW_DEPOT_PLACEHOLDER, NEW_REMOVED_TYRE_PLACEHOLDER } = require('./eventGenerator');
const { runInReplayContext } = require('./replayContext');
const { writeAuditLog } = require('../utils/auditLog');

class DryRunRollback extends Error {
  constructor() {
    super('dry-run: preview transaction intentionally rolled back');
  }
}

function groupByTyre(rowUnits) {
  const groups = new Map();
  for (const rowUnit of rowUnits) {
    const key = rowUnit.misRecord.tyre_id ?? `unresolved:${rowUnit.misRecord.sourceSheet}:${rowUnit.misRecord.sourceRow}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rowUnit);
  }
  return groups;
}

// Substitutes a placeholder symbol (NEW_TYRE_PLACEHOLDER, NEW_BUS_PLACEHOLDER,
// or NEW_DEPOT_PLACEHOLDER) anywhere it appears in an intent's payload with
// the real ID of whatever this same row just created (§6, consumption's
// purchase_intake -> fitment_created/replacement chain; § bus/depot
// auto-provisioning for a bus/depot the row introduced).
function substitutePlaceholder(payload, placeholder, realId) {
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = value === placeholder ? realId : value;
  }
  return out;
}

// Same substitution, but also reaches into an intent's sibling createTyre/
// createRemovedTyre descriptor (§ tyre auto-provisioning for history-bearing
// sheets; § replacement detection) -- those objects sit next to payload, not
// inside it, so a plain substitutePlaceholder over payload alone would miss
// a NEW_DEPOT_PLACEHOLDER written into either one's current_depot_id.
function substituteInDescriptor(descriptor, placeholder, realId) {
  if (!descriptor || descriptor.current_depot_id !== placeholder) return descriptor;
  return { ...descriptor, current_depot_id: realId };
}

function substituteEverywhere(intent, placeholder, realId) {
  return {
    ...intent,
    payload: substitutePlaceholder(intent.payload, placeholder, realId),
    createTyre: substituteInDescriptor(intent.createTyre, placeholder, realId),
    createRemovedTyre: substituteInDescriptor(intent.createRemovedTyre, placeholder, realId),
  };
}

// A dry run and a live run must behave identically while processing rows
// -- only whether the result survives afterward should differ. Without
// this, they didn't: gating the *shared* masterDataCache's registerTyre
// behind isPreviewMode() (as this used to do directly) correctly stopped a
// dry run from corrupting state for whatever runs after it, but it also
// meant a *second* row in the same dry run introducing the same new tyre
// never saw the first row's creation and took a different path (create
// its own tyre) than the same two rows would take live (reuse the first
// one's). Both rows still reported the right outcome either way, but the
// number of tyre-creation attempts differed between modes, which is
// exactly the kind of preview/live drift this architecture exists to rule
// out.
//
// The fix: every row in one replay() call -- dry run or live -- reads and
// writes the same per-run overlay, uniformly, with no mode branching in
// processRowUnit at all. Only afterward does replay() decide whether to
// fold that overlay into the real, longer-lived masterDataCache (live) or
// throw it away untouched (dry run, preserving the original guarantee
// that a preview can never corrupt state for anything that runs later).
function createTyreOverlay(masterDataCache) {
  const overlay = new Map();
  return {
    resolveTyre(raw) {
      if (!raw) return null;
      const key = String(raw).trim().toLowerCase();
      return overlay.has(key) ? overlay.get(key) : masterDataCache?.resolveTyre(raw) ?? null;
    },
    registerTyre(raw, id) {
      if (!raw) return;
      overlay.set(String(raw).trim().toLowerCase(), id);
    },
    commit() {
      for (const [tyreNumber, id] of overlay) masterDataCache?.registerTyre(tyreNumber, id);
    },
  };
}

// Same shared-per-run-overlay reasoning as createTyreOverlay() above,
// applied to a bus a row introduces for the first time (§ bus
// auto-provisioning): dry-run and live must attempt bus creation the same
// number of times for the same input, and only a live run's creations may
// ever reach the real, longer-lived masterDataCache.
function createBusOverlay(masterDataCache) {
  const overlay = new Map();
  return {
    resolveBus(raw) {
      if (!raw) return null;
      const key = String(raw).trim().toLowerCase();
      if (overlay.has(key)) return overlay.get(key).id;
      return masterDataCache?.resolveBus(raw) ?? null;
    },
    registerBus(raw, id, depotId) {
      if (!raw) return;
      overlay.set(String(raw).trim().toLowerCase(), { id, depotId });
    },
    commit() {
      for (const [registrationNo, { id, depotId }] of overlay) masterDataCache?.registerBus(registrationNo, id, depotId);
    },
  };
}

// Same shared-per-run-overlay reasoning again, applied to a depot a row
// introduces for the first time (§ depot auto-provisioning).
function createDepotOverlay(masterDataCache) {
  const overlay = new Map();
  return {
    resolveDepot(name) {
      if (!name) return null;
      const key = String(name).trim().toLowerCase();
      if (overlay.has(key)) return overlay.get(key);
      return masterDataCache?.resolveDepot(name) ?? null;
    },
    registerDepot(name, id) {
      if (!name) return;
      overlay.set(String(name).trim().toLowerCase(), id);
    },
    commit() {
      for (const [name, id] of overlay) masterDataCache?.registerDepot(name, id);
    },
  };
}

const processRowUnit = db.transaction(async function processRowUnitInner(rowUnit, user, tyreOverlay, busOverlay, depotOverlay) {
  const { misRecord, sheetType } = rowUnit;
  let eventIntents = rowUnit.eventIntents;

  // Depot auto-provisioning: a row can reference a depot name that doesn't
  // exist yet -- referenceResolvers.js flags this as newDepotRegistration
  // rather than creating it there, same in-memory-only-during-Preview
  // reasoning as bus/tyre auto-provisioning below. Runs first (before
  // insertMisRecord, further down) and updates misRecord.depot_id in place,
  // so the persisted MIS record and the bus-creation step right after both
  // see the real depot_id rather than null.
  if (!misRecord.depot_id && misRecord.newDepotRegistration) {
    const alreadyCreated = depotOverlay?.resolveDepot(misRecord.newDepotRegistration);
    let newDepotId;
    if (alreadyCreated) {
      newDepotId = alreadyCreated;
    } else {
      const newDepot = await insertDepot({ name: misRecord.newDepotRegistration });
      await writeAuditLog({ user, action: 'CREATE', entityType: 'depot', entityId: newDepot.id, after: newDepot });
      newDepotId = newDepot.id;
      depotOverlay?.registerDepot(misRecord.newDepotRegistration, newDepotId);
    }
    misRecord.depot_id = newDepotId;
    eventIntents = eventIntents.map((intent) => substituteEverywhere(intent, NEW_DEPOT_PLACEHOLDER, newDepotId));
  }

  // Bus auto-provisioning: a row can reference a bus registration number
  // that doesn't exist yet -- referenceResolvers.js flags this as
  // newBusRegistration rather than creating it there, since reference
  // resolution has to stay a pure in-memory step with no DB writes during
  // Preview (§5). The actual INSERT only happens here, inside this row's
  // own transaction/savepoint, so a dry run rolls it back with everything
  // else and a live run commits it for real -- same reasoning, and same
  // overlay-recheck-at-creation-time pattern, as the tyre case below.
  // Deliberately unconditional on which intents this row has: a
  // rotation/NSD-only row whose bus doesn't exist yet still gets it
  // created (visible in Bus Master immediately), even though those two
  // intent types don't themselves carry bus_id in their payload. Also
  // updates misRecord.bus_id in place (mirroring depot_id above), so the
  // persisted MIS record on a sheet with its own bus_id column (NSD,
  // Rotation, Wheel Alignment, Consumption) points at the real bus, not null.
  if (!misRecord.bus_id && misRecord.newBusRegistration) {
    const alreadyCreated = busOverlay?.resolveBus(misRecord.newBusRegistration);
    let newBusId;
    if (alreadyCreated) {
      newBusId = alreadyCreated;
    } else {
      const newBus = await insertBus({
        registration_no: misRecord.newBusRegistration,
        depot_id: misRecord.depot_id,
        package_id: misRecord.package_id ?? null,
      });
      await writeAuditLog({ user, action: 'CREATE', entityType: 'bus', entityId: newBus.id, after: newBus });
      newBusId = newBus.id;
      busOverlay?.registerBus(misRecord.newBusRegistration, newBusId, newBus.depot_id);
    }
    misRecord.bus_id = newBusId;
    eventIntents = eventIntents.map((intent) => substituteEverywhere(intent, NEW_BUS_PLACEHOLDER, newBusId));
  }

  // Consumption is the one sheet type where the row's own tyre doesn't
  // exist yet -- its purchase_intake intent carries createTyre, so the row
  // is created here, before any intent runs, and every later intent's
  // placeholder reference to it is resolved to the real ID (§6). The same
  // mechanism now also covers history-bearing sheets whose tyre reference
  // simply predates this workbook (§ tyre auto-provisioning,
  // eventGenerator.js's resolveOrCreateTyre), and Consumption's own
  // replacement branch's outgoing tyre (§ replacement detection,
  // createRemovedTyre/NEW_REMOVED_TYRE_PLACEHOLDER) -- provisionTyre() below
  // is shared across all three, keyed off which descriptor field an intent
  // carries. Reference resolution ran once, up front, before any row was
  // replayed (importOrchestrator.js) -- so two different rows both
  // introducing the same tyre_number for the first time both saw "doesn't
  // exist yet" at that point, even though whichever one replays first will
  // have already created it by the time the second one actually runs.
  // Re-checking against the overlay right here, at the moment of creating,
  // rather than trusting the snapshot taken before this run started, is what
  // makes dry-run and live attempt tyre creation the same number of times
  // for the same input; see createTyreOverlay() for where that distinction
  // actually lives (reads/writes go through tyreOverlay uniformly here, no
  // mode branching).
  async function provisionTyre(descriptorField, placeholder) {
    const intent = eventIntents.find((i) => i[descriptorField]);
    if (!intent) return null;
    const descriptor = intent[descriptorField];
    const alreadyCreated = tyreOverlay?.resolveTyre(descriptor.tyre_number);
    let newTyreId;
    if (alreadyCreated) {
      newTyreId = alreadyCreated;
    } else {
      const newTyre = await insertTyre(descriptor);
      await writeAuditLog({ user, action: 'CREATE', entityType: 'tyre', entityId: newTyre.id, after: newTyre });
      newTyreId = newTyre.id;
      tyreOverlay?.registerTyre(descriptor.tyre_number, newTyreId);
    }
    eventIntents = eventIntents.map((i) => ({ ...i, payload: substitutePlaceholder(i.payload, placeholder, newTyreId) }));
    return newTyreId;
  }

  const newTyreId = await provisionTyre('createTyre', NEW_TYRE_PLACEHOLDER);
  if (newTyreId) misRecord.tyre_id = newTyreId;
  const newRemovedTyreId = await provisionTyre('createRemovedTyre', NEW_REMOVED_TYRE_PLACEHOLDER);
  if (newRemovedTyreId) misRecord.removed_tyre_id = newRemovedTyreId;

  const misRow = await insertMisRecord(sheetType, misRecord);

  const generated = [];
  const failures = [];
  for (const intent of eventIntents) {
    try {
      if (intent.kind === 'wheel_alignment') {
        const alignment = await createWheelAlignment(user, {
          ...intent.payload,
          source_mis_record_type: sheetType,
          source_mis_record_id: misRow.id,
        });
        await recordGeneratedEvent(sheetType, misRow.id, intent.eventType, { wheelAlignmentId: alignment.id });
        generated.push(alignment);
      } else {
        const events = await createTyreEvent(user, intent.eventType, {
          ...intent.payload,
          source_mis_record_type: sheetType,
          source_mis_record_id: misRow.id,
        });
        for (const ev of events) {
          await recordGeneratedEvent(sheetType, misRow.id, intent.eventType, { tyreEventId: ev.id });
          generated.push(ev);
        }
      }
    } catch (err) {
      // Nested savepoint (createTyreEvent's/createWheelAlignment's own
      // internal db.transaction()) already rolled back just this event
      // attempt -- the MIS record from the insert above is untouched. This
      // is the decoupled-outcome model (§1) actually taking effect, not a
      // bug being swallowed.
      failures.push({ eventType: intent.eventType, message: err.message });
    }
  }

  let linkageStatus;
  if (eventIntents.length === 0) linkageStatus = 'awaiting_review';
  else if (failures.length === 0) linkageStatus = 'linked';
  else if (generated.length === 0) linkageStatus = 'unlinked';
  else linkageStatus = 'partially_linked';

  await updateLinkageStatus(sheetType, misRow.id, linkageStatus);

  return {
    sourceSheet: misRecord.sourceSheet,
    sourceRow: misRecord.sourceRow,
    misRecordId: misRow.id,
    linkageStatus,
    generatedEventIds: generated.map((e) => e.id),
    eventFailures: failures,
  };
});

/**
 * @param {Array<{misRecord: object, eventIntents: object[], sheetType: string}>} rowUnits
 *   Globally chronologically sorted (§1/§3) -- already filtered to
 *   fingerprint-classified "new" rows only; duplicates never reach here.
 * @param {object} opts
 * @param {boolean} opts.dryRun
 * @param {object} opts.user - the importing user (authorization, performed_by)
 * @param {object} [opts.masterDataCache] - so a tyre created mid-import
 *   (Consumption's purchase_intake) is resolvable by later rows in the same
 *   run without waiting for a cache rebuild (§2)
 * @param {(progress: {completedGroups: number, totalGroups: number, outcomes: object[]}) => void} [opts.onProgress]
 *   Called after each tyre-group chunk finishes (success or failure), with
 *   the outcomes accumulated *so far* -- this is what lets a background job
 *   (§8) persist a live rows/events-processed count instead of only
 *   knowing the result once the entire import has finished.
 * @returns {Promise<object[]>} per-row outcomes, in the order processed
 */
async function replay(rowUnits, { dryRun, user, masterDataCache, onProgress }) {
  const groups = groupByTyre(rowUnits);
  const totalGroups = groups.size;
  let completedGroups = 0;
  const outcomes = [];

  const tyreOverlay = createTyreOverlay(masterDataCache);
  const busOverlay = createBusOverlay(masterDataCache);
  const depotOverlay = createDepotOverlay(masterDataCache);

  // Shared by both branches below: run one tyre's chunk in its own
  // savepoint (nested db.transaction()), and if it fails, record the
  // failure and move on rather than letting it propagate -- "one bad row
  // does not abort the rest of the file" (§11) applies at the chunk
  // boundary (one tyre's full sequence, §7), so a genuine, unexpected
  // failure here (a DB constraint this row's own validation didn't
  // anticipate, a concurrent import racing on the same tyre_number, ...)
  // must not abort every other tyre's chunk still waiting to run.
  async function runChunkAndRecord(tyreRowUnits) {
    const runChunk = db.transaction(async () => {
      const chunkOutcomes = [];
      for (const rowUnit of tyreRowUnits) {
        chunkOutcomes.push(await processRowUnit(rowUnit, user, tyreOverlay, busOverlay, depotOverlay));
      }
      return chunkOutcomes;
    });
    try {
      outcomes.push(...(await runChunk()));
    } catch (err) {
      outcomes.push(...tyreRowUnits.map((rowUnit) => ({
        sourceSheet: rowUnit.misRecord.sourceSheet,
        sourceRow: rowUnit.misRecord.sourceRow,
        misRecordId: null,
        linkageStatus: null,
        generatedEventIds: [],
        eventFailures: [],
        chunkError: err.message,
      })));
    }
    completedGroups += 1;
    onProgress?.({ completedGroups, totalGroups, outcomes });
  }

  await runInReplayContext(dryRun ? 'preview' : 'live', async () => {
    if (dryRun) {
      // A preview has nothing durable to protect, so there's no reason to
      // pay for §7's per-chunk independent-commit crash resilience here --
      // and a real reason not to. Chunk B can genuinely depend on chunk A
      // having *already happened* (§6: Consumption's second row
      // referencing a tyre the first row just introduced), and that's
      // only true throughout the whole preview if every chunk shares one
      // transaction that rolls back once, at the very end -- not if each
      // chunk rolls back independently the moment it finishes, which
      // would make chunk A's tyre disappear again before chunk B ever
      // looks for it, even though live would have actually committed it
      // by then.
      const runPreview = db.transaction(async () => {
        for (const [, tyreRowUnits] of groups) {
          await runChunkAndRecord(tyreRowUnits);
        }
        throw new DryRunRollback();
      });
      try {
        await runPreview();
      } catch (err) {
        if (!(err instanceof DryRunRollback)) throw err;
      }
    } else {
      // Live: each tyre's chunk stays its own independent, real
      // transaction (§7) -- an abrupt crash mid-import leaves whatever
      // already committed durably committed, with only the in-flight
      // chunk rolled back, rather than losing the whole run.
      for (const [, tyreRowUnits] of groups) {
        await runChunkAndRecord(tyreRowUnits);
      }
    }
  });

  // The overlay only ever reaches the real, longer-lived masterDataCache
  // here, and only for a live run -- a dry run's view of "tyres created
  // during this run" is discarded in full, the same guarantee the old
  // per-call isPreviewMode() gate gave, just enforced in one place instead
  // of at every call site that might mutate the cache.
  if (!dryRun) {
    tyreOverlay.commit();
    busOverlay.commit();
    depotOverlay.commit();
  }

  return outcomes;
}

module.exports = { replay };
