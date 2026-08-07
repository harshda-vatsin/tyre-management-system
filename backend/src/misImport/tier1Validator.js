/**
 * @file tier1Validator.js
 * @description Tier 1 -- in-memory validation, no DB round-trip (§5).
 * Cheap, per-row checks: does the row have enough to be storable as an MIS
 * record at all; which resolved references are still missing; and the
 * row's place in the new/exact-duplicate/conflicting-duplicate fingerprint
 * classification. The narrower, stricter lifecycle-formability gate
 * (state-transition legality, depot-scope authorization) is Tier 2 -- the
 * Replay Engine itself, running in preview mode (§4) -- not this file.
 */

const { classifyRow } = require('./fingerprintService');

// sheetType -> reference-field pairs to flag when the raw text was present
// but resolution failed. This is informational, not a rejection reason: an
// MIS record with an unresolved tyre reference is still a complete,
// storable business record -- it just won't be able to generate a
// lifecycle event later (linkage_status: unlinked), which is exactly the
// decoupled-outcome model this architecture exists to support (§1).
const REFERENCE_FIELDS_BY_SHEET_TYPE = {
  puncture_repair: [
    { raw: 'depot_raw', resolved: 'depot_id' },
    { raw: 'tyre_number_raw', resolved: 'tyre_id' },
  ],
  scrap: [
    { raw: 'package_raw', resolved: 'package_id' },
    { raw: 'depot_raw', resolved: 'depot_id' },
    { raw: 'tyre_number_raw', resolved: 'tyre_id' },
  ],
  warranty: [
    { raw: 'package_raw', resolved: 'package_id' },
    { raw: 'depot_raw', resolved: 'depot_id' },
    { raw: 'tyre_number_raw', resolved: 'tyre_id' },
  ],
  retread: [
    { raw: 'package_raw', resolved: 'package_id' },
    { raw: 'depot_raw', resolved: 'depot_id' },
    { raw: 'tyre_number_raw', resolved: 'tyre_id' },
  ],
  nsd: [
    { raw: 'depot_raw', resolved: 'depot_id' },
    { raw: 'bus_number_raw', resolved: 'bus_id' },
    { raw: 'tyre_number_raw', resolved: 'tyre_id' },
  ],
  rotation: [
    { raw: 'package_raw', resolved: 'package_id' },
    { raw: 'depot_raw', resolved: 'depot_id' },
    { raw: 'bus_number_raw', resolved: 'bus_id' },
    { raw: 'tyre_number_raw', resolved: 'tyre_id' },
  ],
  wheel_alignment: [
    { raw: 'depot_raw', resolved: 'depot_id' },
    { raw: 'bus_number_raw', resolved: 'bus_id' },
  ],
  // consumption deliberately excludes tyre_number_raw/tyre_id here -- an
  // unresolved incoming tyre is the expected, normal case (§6), not
  // something to flag as a linkage concern.
  consumption: [
    { raw: 'depot_raw', resolved: 'depot_id' },
    { raw: 'bus_number_raw', resolved: 'bus_id' },
    { raw: 'removed_tyre_number_raw', resolved: 'removed_tyre_id' },
  ],
};

// sheetType -> single-row temporal sanity check. Full cross-sheet
// chronology (a tyre's whole merged timeline, §1/§3) needs every sheet
// type's rows merged together first, which doesn't exist until the
// remaining parsers land (task tracked separately) -- this is only the
// narrow check available today: do this one row's own dates make sense
// relative to each other.
const TEMPORAL_CHECKS_BY_SHEET_TYPE = {
  puncture_repair: (row) => {
    if (row.declared_date && row.repaired_date && row.repaired_date < row.declared_date) {
      return ['Repaired Date is before Declared for Pun. Repair Date'];
    }
    return [];
  },
  retread: (row) => {
    const warnings = [];
    if (row.removal_date && row.dispatch_date && row.dispatch_date < row.removal_date) {
      warnings.push('Date of Dispatch is before Removal Date for Retread');
    }
    if (row.dispatch_date && row.invoice_date && row.invoice_date < row.dispatch_date) {
      warnings.push('Invoice Date is before Date of Dispatch');
    }
    return warnings;
  },
};

/**
 * @param {object} normalizedRow - already reference-resolved
 * @param {object} opts
 * @param {string[]} opts.requiredFields - from the parser descriptor
 * @param {Map<string,string>} opts.fingerprintIndex - from buildFingerprintIndex()
 */
function validateRow(normalizedRow, { requiredFields = [], fingerprintIndex }) {
  const missingRequired = requiredFields.filter(
    (f) => normalizedRow[f] === null || normalizedRow[f] === undefined || normalizedRow[f] === ''
  );
  const formability = missingRequired.length > 0 ? 'rejected' : 'ok';

  const referenceFields = REFERENCE_FIELDS_BY_SHEET_TYPE[normalizedRow.sheetType] || [];
  const unresolvedReferences = referenceFields
    .filter(({ raw, resolved }) => normalizedRow[raw] && !normalizedRow[resolved])
    .map(({ resolved }) => resolved);

  const temporalCheck = TEMPORAL_CHECKS_BY_SHEET_TYPE[normalizedRow.sheetType];
  const temporalWarnings = temporalCheck ? temporalCheck(normalizedRow) : [];

  // A row that fails MIS-formability never reaches fingerprinting -- there's
  // nothing coherent to even classify as new/duplicate (§5).
  const duplicate = formability === 'ok' ? classifyRow(fingerprintIndex, normalizedRow) : null;

  return {
    formability,
    rejectReason: formability === 'rejected' ? `missing required field(s): ${missingRequired.join(', ')}` : null,
    unresolvedReferences,
    temporalWarnings,
    duplicate,
  };
}

module.exports = { validateRow, REFERENCE_FIELDS_BY_SHEET_TYPE, TEMPORAL_CHECKS_BY_SHEET_TYPE };
