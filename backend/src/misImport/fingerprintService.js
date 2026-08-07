/**
 * @file fingerprintService.js
 * @description Three-way fingerprint classification (Architecture Decision:
 * "Three-way fingerprint outcome: new / exact duplicate / conflicting
 * duplicate"). The identity key is hashed over *resolved* IDs plus whatever
 * dates make a record unique within a tyre's history -- not raw text, which
 * can vary harmlessly between exports (e.g. "Varanasi " vs "varanasi").
 * Content comparison for the exact-vs-conflicting distinction reuses
 * raw_row_json itself: since it's a full, untouched capture of the source
 * row (§6), comparing it between imports is exactly "did the company
 * re-export a correction, or the same data again" -- no separate
 * business-field allowlist needed per sheet type.
 */

const crypto = require('crypto');
const db = require('../db');

const FINGERPRINT_KEYS = {};
function registerFingerprintKey(sheetType, keyFn) {
  FINGERPRINT_KEYS[sheetType] = keyFn;
}

const TABLE_BY_SHEET_TYPE = {
  puncture_repair: 'mis_puncture_records',
  scrap: 'mis_scrap_records',
  warranty: 'mis_warranty_records',
  retread: 'mis_retread_records',
  nsd: 'mis_nsd_records',
  rotation: 'mis_rotation_records',
  wheel_alignment: 'mis_wheel_alignment_records',
  consumption: 'mis_consumption_records',
};

function sortObjectKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.keys(obj)
    .sort()
    .reduce((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
}

function computeFingerprint(normalizedRow) {
  const keyFn = FINGERPRINT_KEYS[normalizedRow.sheetType];
  if (!keyFn) throw new Error(`No fingerprint key registered for sheetType "${normalizedRow.sheetType}"`);
  const parts = keyFn(normalizedRow).map((p) => (p === null || p === undefined ? '' : String(p)));
  return crypto
    .createHash('sha256')
    .update([normalizedRow.sheetType, ...parts].join('|'))
    .digest('hex');
}

// Preloaded once per import run (§2: "Preloads existing fingerprints") so
// classifying every row is an in-memory Map lookup, matching Tier 1's
// no-DB-round-trip requirement (§5).
async function buildFingerprintIndex(sheetType) {
  const table = TABLE_BY_SHEET_TYPE[sheetType];
  if (!table) throw new Error(`No MIS table registered for sheetType "${sheetType}"`);
  const rows = await db.prepare(`SELECT fingerprint, raw_row_json FROM ${table}`).all();
  const index = new Map();
  for (const row of rows) {
    index.set(row.fingerprint, JSON.stringify(sortObjectKeys(row.raw_row_json)));
  }
  return index;
}

/**
 * @returns {{ outcome: 'new'|'exact_duplicate'|'conflicting_duplicate', fingerprint: string }}
 */
function classifyRow(fingerprintIndex, normalizedRow) {
  const fingerprint = computeFingerprint(normalizedRow);
  if (!fingerprintIndex.has(fingerprint)) return { outcome: 'new', fingerprint };
  const existingContent = fingerprintIndex.get(fingerprint);
  const incomingContent = JSON.stringify(sortObjectKeys(normalizedRow.rawRowJson));
  return {
    outcome: existingContent === incomingContent ? 'exact_duplicate' : 'conflicting_duplicate',
    fingerprint,
  };
}

// Two rows classified 'new' against the same *stale* index within one
// import run would both pass Tier 1 and then collide on the real DB
// UNIQUE constraint at insert time. The index is a snapshot taken before
// the run started (§2: "Preloads existing fingerprints"), so every row
// classified 'new' has to be folded back in immediately -- otherwise a
// second row genuinely duplicating the first *within the same workbook*
// would never be caught until the database rejects it.
function recordAsSeen(fingerprintIndex, fingerprint, rawRowJson) {
  fingerprintIndex.set(fingerprint, JSON.stringify(sortObjectKeys(rawRowJson)));
}

// Falls back to the raw tyre-number text when tyre_id hasn't resolved --
// exactly Consumption's own reasoning below (a brand-new-to-this-import
// tyre has no resolved ID yet to hash over at Tier 1 time, §6), now equally
// true for every history-bearing sheet since tyre auto-provisioning
// (§ tyre auto-provisioning) lets them introduce a never-seen-before tyre
// too. Hashing bare tyre_id (= null for all of them) would collide every
// unresolved row sharing this sheet's other key fields (most commonly the
// same date) onto one fingerprint, and it did: NSD readings taken on the
// same inspection date but naming completely different tyres were being
// misclassified as the same record and dropped as "duplicates" before this
// fix, purely because none of their tyre_ids had resolved yet.
function tyreIdentityKey(row) {
  return row.tyre_id ?? (row.tyre_number_raw ? String(row.tyre_number_raw).trim().toLowerCase() : null);
}

// Puncture Repaire Details: a tyre's puncture-repair record is uniquely
// identified by which tyre, declared when, repaired when -- Sr. No. isn't
// stable across re-exports and carries no identity meaning of its own.
registerFingerprintKey('puncture_repair', (row) => [tyreIdentityKey(row), row.declared_date, row.repaired_date]);

registerFingerprintKey('scrap', (row) => [tyreIdentityKey(row), row.scrap_declared_date]);
registerFingerprintKey('warranty', (row) => [tyreIdentityKey(row), row.warranty_declared_date]);
registerFingerprintKey('retread', (row) => [tyreIdentityKey(row), row.dispatch_date]);
registerFingerprintKey('nsd', (row) => [tyreIdentityKey(row), row.inspection_date]);
registerFingerprintKey('rotation', (row) => [tyreIdentityKey(row), row.rotation_date, row.from_position]);

// Hashed over the raw registration text rather than row.bus_id: a bus a
// row references can now still be unresolved at this point and only get
// created later, at replay time (§ bus auto-provisioning) -- exactly the
// same reason Consumption's fingerprint (below) hashes over raw tyre-number
// text instead of tyre_id. Hashing the resolved ID here would make every
// unresolved-bus row on the same date collide on one fingerprint.
registerFingerprintKey('wheel_alignment', (row) => [
  row.bus_number_raw ? String(row.bus_number_raw).trim().toLowerCase() : null,
  row.alignment_date,
]);

// Consumption is the one sheet type whose row brings a brand-new tyre into
// existence, so there's no resolved tyre_id yet to hash over (§6) -- the
// raw tyre number text is this row's only stable natural key, paired with
// the invoice it arrived on.
registerFingerprintKey('consumption', (row) => [
  row.tyre_number_raw ? String(row.tyre_number_raw).trim().toLowerCase() : null,
  row.invoice_no,
  row.fitment_date,
]);

module.exports = {
  registerFingerprintKey,
  computeFingerprint,
  buildFingerprintIndex,
  classifyRow,
  recordAsSeen,
  TABLE_BY_SHEET_TYPE,
};
