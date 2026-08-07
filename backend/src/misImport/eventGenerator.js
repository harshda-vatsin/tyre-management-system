/**
 * @file eventGenerator.js
 * @description The Event Generator (Architecture Decision: "Parser and
 * Event Generator as separate components"). Takes a resolved NormalizedRow
 * and derives zero or more lifecycle event intents from it -- this is the
 * only place sheet data meets lifecycle-mapping rules; a parser never makes
 * this decision. Each mapping is versioned via EVENT_GENERATOR_VERSION
 * (§13), stamped onto every MIS record so a future "re-derive under current
 * rules" tool can tell which records were produced under superseded logic.
 *
 * Runs in-process immediately after parsing during a live import (no extra
 * DB round-trip). The same registry is also what a future standalone
 * regeneration tool would call directly against MIS records read back out
 * of the database (§12) -- nothing here assumes it's only ever called
 * during a live import.
 */

const EVENT_GENERATOR_VERSION = 1;

// Placeholder written into an intent's payload wherever the real value is
// "whatever tyre this row's own createTyre step just created" -- the
// Replay Engine substitutes the real ID in after creating it (§6:
// Consumption is the only sheet type whose row brings a brand-new tyre
// into existence).
const NEW_TYRE_PLACEHOLDER = Symbol('newTyreId');

// Same substitution mechanism, for a row whose bus reference doesn't exist
// yet (§ bus auto-provisioning) -- referenceResolvers.js flags this as
// newBusRegistration; the Replay Engine substitutes the real ID in after
// creating it, same as NEW_TYRE_PLACEHOLDER above.
const NEW_BUS_PLACEHOLDER = Symbol('newBusId');

// Same substitution mechanism again, for a row whose depot text doesn't
// resolve to an existing depot (§ depot auto-provisioning) --
// referenceResolvers.js flags this as newDepotRegistration. Depots are
// created before buses/tyres within a row's replay (replayEngine.js), since
// both of those need a real depot_id -- but a createTyre descriptor built
// here, at Tier 1 time, still only ever sees an unresolved depot as "not
// yet a real ID", exactly like NEW_BUS_PLACEHOLDER/NEW_TYRE_PLACEHOLDER.
const NEW_DEPOT_PLACEHOLDER = Symbol('newDepotId');

// § replacement detection: distinct from NEW_TYRE_PLACEHOLDER because
// Consumption's replacement branch can introduce two brand-new tyres in the
// same row -- the incoming one (NEW_TYRE_PLACEHOLDER, via createTyre) and
// the outgoing one being replaced (this, via createRemovedTyre). Two
// different symbols keyed off two different descriptor fields so the
// Replay Engine can create and substitute both independently within one
// row's transaction.
const NEW_REMOVED_TYRE_PLACEHOLDER = Symbol('newRemovedTyreId');

const GENERATORS = {};

function registerEventGenerator(sheetType, deriveFn) {
  GENERATORS[sheetType] = deriveFn;
}

// History-bearing sheets (every sheet type except Consumption) describe a
// tyre already in service, not one newly entering inventory -- but on a
// cold/empty database (or simply a tyre whose Consumption row predates this
// workbook), that tyre is just as "new to this system" as a Consumption
// row's ever is. Mirrors Consumption's own createTyre pattern (§6) instead
// of inventing a second mechanism: same NEW_TYRE_PLACEHOLDER symbol, same
// Replay Engine find-or-create handling, only the default starting status
// differs (Active -- already in the field -- vs. Consumption's In Store).
// Returns { tyreRef: null } when there's truly nothing to key a record on
// (no resolved tyre_id and no raw tyre number to fall back to).
function resolveOrCreateTyre(row, { status = 'Active' } = {}) {
  if (row.tyre_id) return { tyreRef: row.tyre_id, createTyre: null };
  if (!row.tyre_number_raw) return { tyreRef: null, createTyre: null };
  return {
    tyreRef: NEW_TYRE_PLACEHOLDER,
    createTyre: {
      tyre_number: row.tyre_number_raw,
      brand: row.make || 'Unknown',
      status,
      current_depot_id: row.depot_id ?? (row.newDepotRegistration ? NEW_DEPOT_PLACEHOLDER : null),
    },
  };
}

// Puncture Repaire Details: one row, two independently-dated intents.
// repair_type is hardcoded to 'patch' -- the source sheet only ever
// records a patch size (the column is literally named "Repair Patch
// Size"), never a plug/patch/tube distinction, so there is no raw signal
// to derive anything else from. If a future template version adds that
// distinction, it becomes a v2 mapping here, not a guess in this one.
registerEventGenerator('puncture_repair', (row) => {
  const { tyreRef, createTyre } = resolveOrCreateTyre(row);
  if (!tyreRef) return [];
  const intents = [];

  if (row.declared_date) {
    intents.push({
      eventType: 'send_to_repair',
      eventDate: row.declared_date,
      payload: {
        tyre_id: tyreRef,
        reason: 'Declared for puncture repair (MIS import)',
        nsd_value: row.nsd ?? null,
        event_date: row.declared_date,
      },
    });
  }

  if (row.repaired_date) {
    intents.push({
      eventType: 'puncture_repair',
      eventDate: row.repaired_date,
      payload: {
        tyre_id: tyreRef,
        repair_type: 'patch',
        patch_size: row.patch_size ?? null,
        supervisor_name: row.supervisor_name ?? null,
        tyre_man_name: row.tyre_man_name ?? null,
        notes: row.remarks ?? null,
        event_date: row.repaired_date,
      },
    });
  }

  if (createTyre && intents.length > 0) intents[0].createTyre = createTyre;
  return intents;
});

function normalizeWarrantyOutcome(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase();
  if (v.includes('reject')) return 'rejected';
  if (v.includes('approv')) return 'approved';
  if (v.includes('close')) return 'closed';
  return null;
}

function normalizeRetreadPurpose(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase();
  if (v.includes('cut')) return 'Cut Repair';
  if (v.includes('rtd') || v.includes('retread')) return 'Retread';
  return null;
}

function normalizeRetreadOutcome(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase();
  if (v.includes('reject')) return 'Rejected';
  if (v.includes('done')) return 'Done';
  return null;
}

// Scraped Tyre Details: terminal write-off. The sheet conflates "gate pass"
// and "invoice" into one column (its own header says "Gate Pass/Invoice
// No.") -- mapped to both createScrap() fields rather than picking one
// arbitrarily, since the source genuinely doesn't distinguish them.
registerEventGenerator('scrap', (row) => {
  if (!row.scrap_declared_date) return [];
  const { tyreRef, createTyre } = resolveOrCreateTyre(row);
  if (!tyreRef) return [];
  return [{
    eventType: 'scrap',
    eventDate: row.scrap_declared_date,
    createTyre,
    payload: {
      tyre_id: tyreRef,
      reason: row.scrap_cause || row.remarks || 'Scrapped (MIS import)',
      vendor_name: row.vendor_name ?? null,
      vendor_location: row.vendor_address ?? null,
      gate_pass_no: row.gate_pass_no ?? null,
      invoice_no: row.gate_pass_no ?? null,
      invoice_date: row.gate_pass_date ?? null,
      approved_by: row.approved_by ?? null,
      store_manager: row.store_manager ?? null,
      nsd_value: row.min_nsd ?? null,
      event_date: row.scrap_declared_date,
    },
  }];
});

// Warranty Tyre History: createWarrantyClaim() requires *either* an
// outcome (approved/rejected/closed) *or* a reason to submit -- the sheet
// always has a Cause, so a claim with an unrecognized/blank status still
// submits validly with just that reason.
registerEventGenerator('warranty', (row) => {
  if (!row.warranty_declared_date) return [];
  const { tyreRef, createTyre } = resolveOrCreateTyre(row);
  if (!tyreRef) return [];
  return [{
    eventType: 'warranty_claim',
    eventDate: row.claim_status_date || row.warranty_declared_date,
    createTyre,
    payload: {
      tyre_id: tyreRef,
      outcome: normalizeWarrantyOutcome(row.warranty_claim_status),
      reason: row.warranty_cause || 'Warranty claim (MIS import)',
      notes: row.remarks ?? null,
      vendor_name: row.vendor_name ?? null,
      gate_pass_no: row.gate_pass_no ?? null,
      invoice_no: row.gate_pass_no ?? null,
      invoice_date: row.gate_pass_date ?? null,
      approved_by: row.approved_by ?? null,
      vendor_location: row.vendor_address ?? null,
      nsd_value: row.min_nsd ?? null,
      event_date: row.claim_status_date || row.warranty_declared_date,
    },
  }];
});

// Retread Tyre History: retread_sent (dispatch) + retread_completed
// (received back from the retreader), each independently dated.
registerEventGenerator('retread', (row) => {
  const { tyreRef, createTyre } = resolveOrCreateTyre(row);
  if (!tyreRef) return [];
  const intents = [];
  if (row.dispatch_date) {
    intents.push({
      eventType: 'retread_sent',
      eventDate: row.dispatch_date,
      payload: {
        tyre_id: tyreRef,
        vendor_name: row.vendor_name ?? null,
        vendor_location: row.vendor_location ?? null,
        gate_pass_no: row.gate_pass_no ?? null,
        reason: null,
        odometer_km: null,
        retread_purpose: normalizeRetreadPurpose(row.retread_purpose_raw),
        event_date: row.dispatch_date,
      },
    });
  }
  if (row.invoice_date) {
    intents.push({
      eventType: 'retread_completed',
      eventDate: row.invoice_date,
      payload: {
        tyre_id: tyreRef,
        vendor_name: row.vendor_name ?? null,
        vendor_location: row.vendor_location ?? null,
        invoice_no: row.invoice_no ?? null,
        invoice_date: row.invoice_date,
        retread_cost: null,
        notes: null,
        outcome: normalizeRetreadOutcome(row.retread_status_raw),
        reason: row.rejected_reason ?? null,
        event_date: row.invoice_date,
      },
    });
  }
  if (createTyre && intents.length > 0) intents[0].createTyre = createTyre;
  return intents;
});

// Tyre NSD Report: nsd_reading + pressure_reading, sharing one inspection
// date. Either can be emitted independently of the other -- a row with NSD
// readings but no Psi (or vice versa) still yields one valid intent.
// createReadingEvent() requires the tyre already mounted (readings are
// taken in place, never off a shelf) -- same reasoning and same
// fitment_created-first chain as the Rotation generator below, using this
// row's own bus/position (the sheet carries both) as the starting fitment
// for a tyre we've never seen before.
registerEventGenerator('nsd', (row) => {
  const intents = [];
  if (!row.inspection_date) return intents;
  const { tyreRef, createTyre } = resolveOrCreateTyre(row);
  if (!tyreRef) return intents;

  if (createTyre) {
    if (!(row.bus_id || row.newBusRegistration) || !row.position) return [];
    intents.push({
      eventType: 'fitment_created',
      eventDate: row.inspection_date,
      createTyre,
      payload: {
        tyre_id: tyreRef,
        bus_id: row.bus_id ?? NEW_BUS_PLACEHOLDER,
        position: row.position,
        reason: 'Initial position on record (inferred from MIS NSD Report sheet)',
        event_date: row.inspection_date,
      },
    });
  }

  const hasNsd = [row.nsd_g1, row.nsd_g2, row.nsd_g3, row.nsd_g4].some((v) => v !== null && v !== undefined);
  if (hasNsd) {
    intents.push({
      eventType: 'nsd_reading',
      eventDate: row.inspection_date,
      payload: {
        tyre_id: tyreRef,
        nsd_g1: row.nsd_g1 ?? null,
        nsd_g2: row.nsd_g2 ?? null,
        nsd_g3: row.nsd_g3 ?? null,
        nsd_g4: row.nsd_g4 ?? null,
        notes: null,
        event_date: row.inspection_date,
      },
    });
  }
  if (row.pressure_psi !== null && row.pressure_psi !== undefined) {
    intents.push({
      eventType: 'pressure_reading',
      eventDate: row.inspection_date,
      payload: {
        tyre_id: tyreRef,
        pressure_value: row.pressure_psi,
        notes: null,
        event_date: row.inspection_date,
      },
    });
  }
  return intents;
});

// Tyre Rotation: createRotation() moves one tyre to one new position. A
// slot with no "New Location" recorded didn't actually move -- nothing to
// generate for it.
registerEventGenerator('rotation', (row) => {
  if (!row.to_position || !row.rotation_date) return [];
  const { tyreRef, createTyre } = resolveOrCreateTyre(row);
  if (!tyreRef) return [];

  const intents = [];
  // createRotation() requires the tyre already mounted (it moves an
  // existing fitment from one position to another, never establishes the
  // first one) -- a brand-new tyre this row is the first sighting of has to
  // be fitted at its from_position before it can rotate to to_position.
  // Without a resolvable bus for that starting fitment, there's nothing
  // safe to record for a tyre we've never seen before.
  if (createTyre) {
    if (!(row.bus_id || row.newBusRegistration) || !row.from_position) return [];
    intents.push({
      eventType: 'fitment_created',
      eventDate: row.rotation_date,
      createTyre,
      payload: {
        tyre_id: tyreRef,
        bus_id: row.bus_id ?? NEW_BUS_PLACEHOLDER,
        position: row.from_position,
        reason: 'Initial position on record (inferred from MIS Rotation sheet)',
        event_date: row.rotation_date,
      },
    });
  }

  intents.push({
    eventType: 'rotation',
    eventDate: row.rotation_date,
    payload: {
      tyre_id: tyreRef,
      to_position: row.to_position,
      reason: row.remarks || 'Scheduled rotation (MIS import)',
      event_date: row.rotation_date,
      odometer_km: row.km_at_rotation ?? null,
      nsd_value: row.nsd ?? null,
    },
  });
  return intents;
});

// Wheel Alignment: a bus-level operation with no tyre involved at all,
// feeding createWheelAlignment() (utils/wheelAlignmentService.js) instead
// of createTyreEvent() -- kind: 'wheel_alignment' tells the Replay Engine
// which pathway to call (§10).
registerEventGenerator('wheel_alignment', (row) => {
  if (!(row.bus_id || row.newBusRegistration) || !row.alignment_date) return [];

  const measurements = [];
  const fr = [row.toe_fr_before, row.toe_fr_after, row.caster_fr_before, row.caster_fr_after, row.camber_fr_before, row.camber_fr_after, row.sai_fr_before, row.sai_fr_after];
  if (fr.some((v) => v !== null && v !== undefined)) {
    measurements.push({
      position: 'FR',
      toe_before: row.toe_fr_before, toe_after: row.toe_fr_after,
      caster_before: row.caster_fr_before, caster_after: row.caster_fr_after,
      camber_before: row.camber_fr_before, camber_after: row.camber_fr_after,
      sai_before: row.sai_fr_before, sai_after: row.sai_fr_after,
    });
  }
  const fl = [row.toe_fl_before, row.toe_fl_after, row.caster_fl_before, row.caster_fl_after, row.camber_fl_before, row.camber_fl_after, row.sai_fl_before, row.sai_fl_after];
  if (fl.some((v) => v !== null && v !== undefined)) {
    measurements.push({
      position: 'FL',
      toe_before: row.toe_fl_before, toe_after: row.toe_fl_after,
      caster_before: row.caster_fl_before, caster_after: row.caster_fl_after,
      camber_before: row.camber_fl_before, camber_after: row.camber_fl_after,
      sai_before: row.sai_fl_before, sai_after: row.sai_fl_after,
    });
  }
  if (measurements.length === 0) return [];

  return [{
    eventType: 'wheel_alignment',
    kind: 'wheel_alignment',
    eventDate: row.alignment_date,
    payload: {
      bus_id: row.bus_id ?? NEW_BUS_PLACEHOLDER,
      alignment_date: row.alignment_date,
      current_km: row.current_km ?? null,
      due_date: row.due_date ?? null,
      status: row.status || 'Done',
      remarks: row.remarks ?? null,
      measurements,
    },
  }];
});

// Tyre Cons. New-Retread-Old Ok: the one sheet type where the tyre this
// row is about doesn't exist in the database yet -- purchase_intake's
// intent carries createTyre so the Replay Engine creates the row first,
// then substitutes NEW_TYRE_PLACEHOLDER with the real ID in whichever
// fitment intent follows (§6).
registerEventGenerator('consumption', (row) => {
  if (!row.tyre_number_raw) return [];
  const intents = [];

  // row.tyre_id is only set here if the Master Data Cache already found a
  // matching tyre_number (§6) -- most consumption rows won't have one, but
  // a stencil number reappearing (an old-ok-spare tyre re-fitted after an
  // earlier removal) is real and shouldn't try to create a second tyre row
  // with the same number.
  const tyreRef = row.tyre_id ?? NEW_TYRE_PLACEHOLDER;

  intents.push({
    eventType: 'purchase_intake',
    eventDate: row.received_date || row.invoice_date,
    createTyre: row.tyre_id ? null : {
      tyre_number: row.tyre_number_raw,
      brand: row.make || 'Unknown',
      status: 'In Store',
      // Consumption is the one sheet whose row states this tyre's real
      // acquisition date, so it's the one createTyre descriptor (of every
      // sheet type's) that's honest to backfill purchase_date from --
      // every other sheet's auto-provisioned tyre predates this workbook
      // and its true purchase date is genuinely unknown, not just unstated.
      purchase_date: row.invoice_date || row.received_date || null,
      current_depot_id: row.depot_id ?? (row.newDepotRegistration ? NEW_DEPOT_PLACEHOLDER : null),
    },
    payload: {
      tyre_id: tyreRef,
      notes: `Consumption record${row.tyre_kind ? ` (${row.tyre_kind}${row.consumption_status ? `, ${row.consumption_status}` : ''})` : ''}`,
      vendor_name: null,
      gate_pass_no: null,
      invoice_no: row.invoice_no ?? null,
      invoice_date: row.invoice_date ?? null,
      event_date: row.received_date || row.invoice_date,
    },
  });

  if ((row.bus_id || row.newBusRegistration) && row.position && row.fitment_date) {
    if (row.removed_tyre_id || row.removed_tyre_number_raw) {
      // The tyre being replaced is itself almost always "new to this
      // import" too (it was fitted before this reporting window) --
      // createReplacement() requires it already mounted (§ replacement
      // detection), so an unresolved removed tyre gets the same
      // auto-provisioning treatment as every other history-bearing sheet's
      // tyre (eventGenerator.js's resolveOrCreateTyre), via its own
      // createRemovedTyre descriptor/placeholder pair -- kept separate from
      // NEW_TYRE_PLACEHOLDER/createTyre above since a single row can
      // introduce both a brand-new incoming tyre AND a brand-new outgoing
      // one in the same replay. An inferred prior fitment (this row's own
      // bus/position, since that's where the removed tyre must have been)
      // establishes "mounted" first; only then can replacement() run.
      const removedTyreRef = row.removed_tyre_id ?? NEW_REMOVED_TYRE_PLACEHOLDER;
      if (!row.removed_tyre_id) {
        intents.push({
          eventType: 'fitment_created',
          eventDate: row.fitment_date,
          createRemovedTyre: {
            tyre_number: row.removed_tyre_number_raw,
            brand: 'Unknown',
            status: 'In Store',
            current_depot_id: row.depot_id ?? (row.newDepotRegistration ? NEW_DEPOT_PLACEHOLDER : null),
          },
          payload: {
            tyre_id: removedTyreRef,
            bus_id: row.bus_id ?? NEW_BUS_PLACEHOLDER,
            position: row.position,
            reason: 'Prior fitment on record (inferred from MIS Consumption sheet -- replaced by this same row)',
            event_date: row.fitment_date,
          },
        });
      }
      // createReplacement() derives the bus/position from the tyre being
      // replaced's own current_bus_id/current_position (just established
      // above if it wasn't already), never from this row's own bus_id --
      // no NEW_BUS_PLACEHOLDER substitution needed here even when the
      // sheet's stated bus is new.
      intents.push({
        eventType: 'replacement',
        eventDate: row.fitment_date,
        payload: {
          tyre_id: removedTyreRef,
          new_tyre_id: tyreRef,
          reason: row.removal_reason ?? null,
          // Excel Parity / Tyre Life Report: same "Fitment Kms" column as
          // the plain fitment_created branch below -- most real Consumption
          // rows in practice ARE replacements (a new/retread/old-ok-spare
          // tyre swapped in for a removed one), so this is the odometer_km
          // value tyreLifeReport actually needs for the majority of
          // imported tyres, not an edge case.
          odometer_km: row.fitment_km ?? null,
          event_date: row.fitment_date,
        },
      });
    } else {
      intents.push({
        eventType: 'fitment_created',
        eventDate: row.fitment_date,
        payload: {
          tyre_id: tyreRef,
          bus_id: row.bus_id ?? NEW_BUS_PLACEHOLDER,
          position: row.position,
          reason: null,
          // Excel Parity / Tyre Life Report: the sheet's own "Fitment Kms"
          // column is exactly what tyreLifeReport's last_fitment_odometer_km
          // reads (lastEventValueSql('fitment_created', 'odometer_km')) --
          // previously never carried into the event payload at all, so
          // Life Used (km) was silently null for every MIS-imported tyre.
          odometer_km: row.fitment_km ?? null,
          event_date: row.fitment_date,
        },
      });
    }
  }

  return intents;
});

function deriveEventIntents(normalizedRow) {
  const generator = GENERATORS[normalizedRow.sheetType];
  if (!generator) return [];
  return generator(normalizedRow);
}

module.exports = {
  registerEventGenerator, deriveEventIntents, EVENT_GENERATOR_VERSION,
  NEW_TYRE_PLACEHOLDER, NEW_BUS_PLACEHOLDER, NEW_DEPOT_PLACEHOLDER, NEW_REMOVED_TYRE_PLACEHOLDER,
};
