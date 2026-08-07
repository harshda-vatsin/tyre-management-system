# MIS Import Validation Report

**System:** EBTMS (EV Bus Tyre Management System)
**Scope:** MIS Excel Importer, lifecycle event generation, and report/dashboard compatibility
**Validation workbook:** `Varanasi Tyre MIS Report Format Jul-26.xlsx`
**Status:** Validated against a clean database end-to-end; all findings below are from a real, executed import, not a design review.

---

## 1. Architecture Summary

The importer is a five-stage pipeline, each stage a separate module under `backend/src/misImport/`:

| Stage | Module | Responsibility |
|---|---|---|
| Parse | `parsers/*.js` | Turn one Excel worksheet into `NormalizedRow` objects. No lifecycle knowledge — column-to-field mapping only. |
| Resolve | `referenceResolvers.js` | Match each row's raw text (depot/bus/tyre names) against the in-memory Master Data Cache. Never writes to the database. |
| Validate | `tier1Validator.js` + `fingerprintService.js` | "Formability" check (required fields present) and three-way duplicate classification (new / exact duplicate / conflicting duplicate) via a content-hashed fingerprint. |
| Generate | `eventGenerator.js` | Maps a resolved row to zero or more lifecycle event *intents* (e.g. one Consumption row → `purchase_intake` + `fitment_created`). Versioned (`EVENT_GENERATOR_VERSION`) so re-derivation is traceable later. |
| Replay | `replayEngine.js` | Executes intents through the same `createTyreEvent()`/`createWheelAlignment()` functions manual entry uses. One mode, two outcomes: Preview wraps the whole run in a transaction that always rolls back; Confirm commits each tyre's event sequence as its own independent transaction. |

Supporting infrastructure:
- **Master Data Cache** (`utils/misMasterDataCache.js`) — preloads all depots/packages/bus models/buses/tyres once per run so resolution never costs a DB round-trip.
- **MIS Record Repositories** (`misRecordRepository.js`) — one dedicated, immutable table per sheet type (`mis_consumption_records`, `mis_nsd_records`, etc.), written once by the Replay Engine and never updated by lifecycle amendments.
- **Traceability** — every `tyre_events`/`wheel_alignments` row the importer creates carries `source_mis_record_type`/`source_mis_record_id` back to the exact MIS record and, transitively, the exact source cell.
- **Decoupled outcome model** — a row's MIS record persists even if its lifecycle event fails validation. A failed event never blocks or corrupts the row's own storage; it is recorded as a reviewable failure instead.

---

## 2. Import Workflow

```
POST /api/mis-imports              Upload + synchronous Preview (dry-run)
GET  /api/mis-imports              List sessions
GET  /api/mis-imports/:id          Session detail / live progress
GET  /api/mis-imports/:id/rows     Per-row detail (linkage status, failure reasons)
POST /api/mis-imports/:id/confirm  Enqueue the background Commit job
POST /api/mis-imports/:id/cancel   Cancel before the job picks it up
```

1. **Upload** — the workbook is parsed and the entire pipeline runs once as a dry run, inside a single transaction that always rolls back. Nothing is written. The response returns full counts and a per-sheet breakdown.
2. **Preview review** — an Administrator inspects the counts, sheet breakdown, and (via `/rows`) individual row outcomes before committing.
3. **Confirm** — enqueues a background job (`pg-boss`, Postgres-native queue). The HTTP request returns immediately (`202 queued`); the job re-runs the identical pipeline with `dryRun: false`.
4. **Commit** — each tyre's full event sequence is its own real, independent transaction. A crash mid-import leaves everything already committed durably committed; only the in-flight chunk is lost. The job retries automatically (bounded, 2 attempts) and retries are safe: already-stored rows are protected by fingerprint-based duplicate detection, so a retry never double-inserts.
5. **Session state** — `previewed → queued → running → committed | failed | cancelled`, polled via `GET /api/mis-imports/:id`.

Admin-only at every step (`ROLES.ADMIN`), gated by a system-wide kill switch (`system_settings.mis_import_enabled`).

---

## 3. Auto-Provisioning Behavior

The importer is designed to ingest a workbook against a **cold, empty database** — no manual pre-setup of master data is required. Four entities can be auto-created mid-import, all via the same pattern: a resolver flags "not found, but here's the raw text," and the Replay Engine creates the real row *inside the row's own transaction* (so Preview can roll it back and Confirm can commit it, using identical code either way).

| Entity | Flag | Created by | Notes |
|---|---|---|---|
| **Depot** | `newDepotRegistration` | `insertDepot()` | Code auto-generated from the name (alnum, uppercased, collision-suffixed). Must run before bus creation (`buses.depot_id` is `NOT NULL`). |
| **Bus** | `newBusRegistration` | `insertBus()` | Assigned a shared placeholder bus model, **"Unknown (MIS Import)"**, with the fixed 6-position layout `FL, FR, RLO, RLI, RRI, RRO`. `chassis_no` synthesized deterministically (`MIS-IMPORT-<REG>`) since no sheet carries one. |
| **Tyre** | (via `resolveOrCreateTyre()`) | `insertTyre()` | Every history-bearing sheet (Puncture/Scrap/Warranty/Retread/NSD/Rotation) can introduce a tyre that simply predates the workbook. Default status `Active`; `purchase_date` is **only** backfilled for Consumption's own incoming tyre (the one sheet that states a real acquisition date) — every other auto-provisioned tyre gets no fabricated date. |
| **Removed tyre** (replacement) | (via `createRemovedTyre` descriptor) | `insertTyre()` | Consumption rows naming a "Removed Tyre No." that isn't yet known get that tyre auto-provisioned too, with an inferred prior fitment at the row's own bus/position, so `createReplacement()`'s "must already be mounted" precondition is satisfiable. |

Mechanics: each entity has a unique placeholder `Symbol` (`NEW_DEPOT_PLACEHOLDER`, `NEW_BUS_PLACEHOLDER`, `NEW_TYRE_PLACEHOLDER`, `NEW_REMOVED_TYRE_PLACEHOLDER`) written into an intent's payload at generation time, substituted with the real ID once the Replay Engine creates the row. A per-run overlay (in-memory `Map`) makes a second row referencing the same new depot/bus/tyre resolve to the *same* real ID instead of creating a duplicate — proven by dedicated tests (§10) covering both the single-creation and reuse-on-second-reference paths, in both dry-run and live mode.

---

## 4. Supported MIS Sheets

| Sheet name (exact tab match) | `sheetType` | Lifecycle intents produced |
|---|---|---|
| Tyre Cons. New-Retread-Old Ok | `consumption` | `purchase_intake` + (`fitment_created` **or** `replacement`) |
| Puncture Repaire Details | `puncture_repair` | `send_to_repair` + `puncture_repair` |
| Retread Tyre History | `retread` | `retread_sent` + `retread_completed` |
| Scraped Tyre Details | `scrap` | `scrap` |
| Warranty Tyre History | `warranty` | `warranty_claim` |
| Tyre NSD Report | `nsd` | `nsd_reading` + `pressure_reading` (+ inferred `fitment_created` if the tyre is new) |
| Tyre Rotation | `rotation` | `rotation` (+ inferred `fitment_created` if the tyre is new) |
| Wheel Alignment | `wheel_alignment` | `wheel_alignment` (writes to `wheel_alignments`, not `tyre_events`) |

**Not recognized (no parser exists):** *Tyre Summary*, *Tyre Card-Tyre History*. Both are Excel-formula-driven rollup/report views of the other sheets (daily closing-stock grids, computed lifetime summaries), not primary source records — consistent with the architecture's "ignore computed report cells" rule applied elsewhere (e.g. NSD Report's % wear / projected mileage columns are deliberately never parsed). Their absence from `findParserForSheet()` is by design, not a gap.

---

## 5. Tyre Lifecycle Supported

**Statuses** (`tyreLifecycle.js`, unchanged by this work): `In Store`, `Active`, `Under Repair`, `Under Retread`, `Warranty`, `Scrapped` (terminal — no transitions out). Any non-terminal status can transition to any other.

**Event types the MIS importer can produce:** `purchase_intake`, `fitment_created`, `replacement`, `rotation`, `nsd_reading`, `pressure_reading`, `puncture_repair`, `send_to_repair`, `scrap`, `warranty_claim`, `retread_sent`, `retread_completed`, `wheel_alignment`.

**Event types the MIS importer can never produce (architectural, permanent):** `condemnation`, `inter_bus_transfer`, `send_to_store`, `reservation`, `inspection_completed`. No sheet in this MIS format represents a formal condemnation review, a depot-to-depot transfer, a manual store-return, a reservation, or a standalone inspection-completed milestone — these remain exclusively manual-entry workflows (`utils/tyreEvents.js`, via the Log Event UI). This is not something a workbook can close; it would require inventing a new sheet mapping the source format doesn't have.

Every event the importer writes goes through the exact same `createTyreEvent()`/`createWheelAlignment()` functions manual entry uses — audit logging, threshold evaluation, and alert generation are identical regardless of source.

---

## 6. Report Compatibility Matrix

All 15 reports and both dashboards were executed against the committed validation import; every one returns `HTTP 200` with no runtime errors.

| Report | Tables read | Populated by MIS data | Notes |
|---|---|---|---|
| Tyre Status | `tyres`, `tyre_events` (nsd/pressure) | ✅ Full | |
| Flagged Tyres | `alerts` | ✅ Full | Requires active thresholds (§9 — config, not import). |
| Tyre History | `tyre_events` (all types) | ✅ Full, accurate | Shows exactly the event types that occurred — never "incomplete," just scoped to real history. |
| Bus Tyre Health | `tyres`, `buses`, `bus_models`, `tyre_events` | ✅ Full | Works against the auto-provisioned placeholder bus model too. |
| Rotation & Replacement Log | `tyre_events` (rotation, replacement) | ✅ Full | Both sides of each replacement pair correctly cross-referenced via `related_tyre_id`. |
| Puncture Incident | `tyre_events` (puncture_repair) | ✅ Full | |
| Inter-Bus Transfer Log | `tyre_events` (inter_bus_transfer) | ⬜ Always empty | No MIS sheet produces this event type — permanent, by design (§5). |
| Tyre Life | `tyres`, `tyre_events` (fitment_created, replacement, removal-type events) | ✅ Populated where the source states it | `purchase_date`/`life_used_km` are real for tyres the sheet gives dates/km for; correctly `null` (not fabricated) for auto-provisioned historical tyres the workbook never dates. |
| Inspection Compliance | `tyres`, `tyre_events` (nsd_reading) | ✅ Full | Requires active thresholds (§9). |
| Condemned Tyres | `tyres` (status), `tyre_events` (condemnation) | ⚠️ Status only | Shows `status: Scrapped` correctly but `condemned_date`/`reason`/`authorised_by` are blank for every MIS-scrapped tyre — see §9, intentional. |
| Retread History | `tyre_events` (retread_sent, retread_completed) | ⬜ Empty (this workbook) | Source sheet has zero real data rows — verified directly (§8). |
| Warranty Claims | `tyre_events` (warranty_claim) | ✅ Full | |
| Scrap Analysis | `tyre_events` (scrap) | ✅ Full, complete detail | **Authoritative report for MIS-sourced write-offs** (§9). |
| Wheel Alignment | `wheel_alignments` | ⬜ Empty (this workbook) | Source sheet has zero real data rows — verified directly (§8). |
| Stock Summary | `tyres` (grouped) | ✅ Full | |
| National Dashboard | all of the above + `alerts` | ✅ Full | |
| Depot Dashboard | all of the above + `alerts`, scoped | ✅ Full | |

---

## 7. Final Import Statistics (Validation Workbook)

Clean database → threshold reseed → single upload → Preview → Confirm. All figures below are from the committed result.

### Per-sheet parse/store breakdown

| Sheet | Rows parsed | Rows stored | Rejected (blank/shape) | Duplicate-flagged |
|---|---:|---:|---:|---:|
| Tyre Cons. New-Retread-Old Ok | 997 | 131 | 866 | 0 |
| Puncture Repaire Details | 403 | 14 | 389 | 0 |
| Scraped Tyre Details | 221 | 146 | 71 | 4 |
| Tyre NSD Report | 917 | 305 | 611 | 1 |
| Tyre Rotation | 18 | 18 | 0 | 0 |
| Warranty Tyre History | 224 | 25 | 199 | 0 |
| Retread Tyre History | 495 | 0 | 495 | 0 |
| Wheel Alignment | 394 | 0 | 394 | 0 |
| **Total** | **3,669** | **639** | 3,025 | 5 |

### Records created

| Entity | Count |
|---|---:|
| Depots | 1 (auto-created — "Varanasi") |
| Buses | 51 (all auto-created) |
| Tyres | 466 |
| Lifecycle events (total) | 1,137 |
| — Replacement events | 208 (104 transactions) |
| — Fitment created | 263 |
| — Purchase intake | 131 |
| — Pressure readings | 244 |
| — NSD readings | 92 |
| — Scrap | 146 |
| — Warranty claims | 25 |
| — Puncture repair / Send to repair | 12 / 12 |
| — Rotation | 4 |
| Alerts generated | 17 (16 Warning + 1 Critical, all NSD) |

### Linkage outcome (of the 639 stored MIS records)

| Status | Count | Meaning |
|---|---:|---|
| Linked | 368 | Every intended event succeeded. |
| Partially linked | 194 | Some but not all intended events succeeded (e.g. the incoming half of a replacement recorded, the swap itself blocked). |
| Unlinked | 77 | Row stored for the record, but no event could be generated — reason captured per row. |

Every one of the 639 stored rows — regardless of linkage outcome — remains queryable via `GET /api/mis-imports/:id/rows` with its specific failure reason attached. Nothing is silently discarded.

---

## 8. Known Source-Data Limitations

These are properties of this specific workbook, independently verified by reading the raw cells — not inferred from error messages alone:

- **~3,025 blank rows** across all sheets — Excel template scaffolding (row-number/date formulas with no actual record data), correctly rejected at Tier 1.
- **Retread Tyre History and Wheel Alignment are entirely empty** — checked every row in both sheets directly; the tyre-number/bus-number columns are blank throughout. No retreading or wheel alignment activity is represented in this export, genuinely.
- **Tyres referenced after they were already scrapped** (36 rows, NSD + Puncture) — e.g. tyre `C0132205024` was declared scrapped `2026-05-23`, but the NSD sheet still carries a reading for it dated `2026-07-24`. The NSD/Puncture sheets are stale relative to the Scrap sheet for these specific tyres; correctly blocked by the lifecycle state machine rather than silently un-scrapping a tyre.
- **Cross-sheet position disagreement** (~200+ rows, mostly NSD and Rotation) — two sheets claim different tyres at the same bus position with no arbitrating record in the file (verified: one side traces to a real, dated, invoiced Consumption fitment; the other is a bare NSD/Rotation snapshot with no such provenance). Correctly left for manual review rather than guessing a winner.
- **A handful of non-numeric NSD cells** and **one malformed Rotation cell** (a stray numeric value where a position code belongs) — isolated data-entry artifacts, correctly rejected.
- **Some Consumption rows reuse a tyre number inconsistently** ("Replacement tyre must have status 'In Store'") — the same physical tyre number appears in multiple rows without a single consistent narrative of where it actually was at each point.

None of the above are backend defects. Every category was cross-verified against a second, independent sheet in the same workbook before being classified as source data, not code.

---

## 9. Remaining Intentional Limitations

These are deliberate design boundaries, not omissions:

1. **`condemnation`, `inter_bus_transfer`, `send_to_store`, `reservation`, `inspection_completed` are manual-only.** No MIS sheet format represents these; closing this would mean inventing a sheet mapping that doesn't exist in the source, which is out of scope for an importer whose job is to faithfully represent what a workbook actually contains.
2. **Condemned Tyres Report is not merged with MIS scrap data.** `condemnation` (SRS UC-13, a formal Depot-Manager review workflow) and `scrap` (the MIS format's terminal write-off path) are legitimately distinct real-world processes with different approval semantics — merging them would let the report claim an `authorised_by` for a review that never happened. **Scrap Analysis Report is the authoritative, complete report for MIS-imported write-offs** (verified: full reason/vendor/date/depot detail for all 146 tyres the Condemned report shows only bare status for).
3. **No fabricated dates or distances.** `purchase_date` is only ever backfilled where the sheet states one (Consumption's own incoming tyre); every history-bearing sheet's auto-provisioned tyre — which by definition predates the workbook — gets no invented acquisition date. Total tyre-specific distance (vs. bus-level odometer) remains outside the data model, as it always has been (pre-existing, documented in `reportService.js`).
4. **Threshold configuration is operational, not code.** Alert generation and inspection/rotation compliance depend on `thresholds` rows existing; a fresh database needs `npm run seed:thresholds` (or equivalent) run once as part of setup. This is deliberately kept out of the importer itself — an importer should not silently mutate unrelated system configuration.

---

## 10. Regression Tests Added

49 backend tests pass in total (`node --test`, isolated Postgres database per file). Tests added or rewritten during this validation effort:

**`test/misImportPipeline.test.js`**
- `runWorkbookImport: a tyre number with no prior history is auto-provisioned so the row still links`
- `runWorkbookImport: an MIS record persists even when its lifecycle event cannot be created (decoupled outcome)` — rewritten; the original scenario (unresolvable tyre reference) became obsolete once tyre auto-provisioning made it resolvable, replaced with a genuine business-rule-conflict scenario (position already occupied).
- `fingerprint classification: two different unresolved tyres on the same date must not collide onto one fingerprint` — regression test for the false-duplicate bug found and fixed during this validation (NSD/Puncture/Scrap/Warranty/Retread/Rotation fingerprints now fall back to raw tyre-number text when the ID hasn't resolved yet, matching Consumption's existing pattern).
- `bus auto-provisioning: a dry run never creates the missing bus` / `...an unknown bus is created from the row, fitment links correctly, and re-referencing it never creates a duplicate`
- `depot auto-provisioning: a dry run never creates the missing depot` / `...an unknown depot name creates the depot, and also unblocks bus auto-provisioning under it`
- `replacement detection: a Consumption row naming an unresolved removed tyre generates a real replacement, not a bare fitment`
- `replacement detection: an already-known removed tyre is reused, never re-created`
- `Tyre Life fields: purchase_date and fitment odometer_km are captured from the Consumption sheet`
- `Tyre Life fields: an auto-provisioned historical tyre (not from Consumption) gets no fabricated purchase_date`

**`test/seedThresholds.test.js`** (new file)
- Creates the 4 default GLOBAL thresholds on an empty table
- Running it again is a no-op, never creates duplicates
- Does not touch unrelated tables

**`test/tyreLifeReport.test.js`** (new file)
- A replaced-in tyre gets `last_fitment_odometer_km` from its replacement event, not null
- `life_used_km` computes correctly across a replacement chain (fitment → replaced out)
- `createReplacement`: `odometer_km` is optional — manual entry (no `odometer_km` passed) behaves exactly as before, proving backward compatibility

---

## 11. Production Readiness Conclusion

**Assessment: Ready for production use**, with one operational prerequisite.

- The full backend test suite (49 tests) passes, including regression coverage for every defect found and fixed during this validation (a real transaction-poisoning bug from an unsubstituted placeholder, a false-duplicate fingerprint collision, and the three original report-completeness gaps).
- The entire pipeline was validated end-to-end against a **genuinely clean database** — not a pre-seeded one — proving depot, bus, and tyre auto-provisioning all work from zero without manual setup.
- All 15 reports and both dashboards return correct, meaningful data against the committed import with no runtime errors.
- Every remaining gap (§8, §9) is either a verified property of the source workbook or a deliberate, documented design boundary — none are latent backend defects.
- **Operational prerequisite:** a fresh database must have baseline threshold configuration seeded (`npm run seed:thresholds`) before alerts and compliance metrics will reflect real values — this is a one-time setup step, not a code gap, and should be part of the deployment runbook for any new environment.

No new reports, statuses, workflows, database tables, or APIs were introduced in the course of this validation. Every change was either a correction to existing importer logic, an additive and backward-compatible parameter on an existing function, or a fix to an existing report's query.
