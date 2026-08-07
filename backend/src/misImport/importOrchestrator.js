/**
 * @file importOrchestrator.js
 * @description Ties every MIS import component together, at two levels:
 *
 *   prepareSheetRowUnits() -- one worksheet: detect/parse -> resolve
 *   references -> Tier 1 validate (formability, duplicate classification)
 *   -> derive event intents. Stops short of replay -- it hands back
 *   RowUnits, it doesn't run them.
 *
 *   runWorkbookImport() -- the real top-level entry point. Prepares every
 *   worksheet in the workbook, merges all of their RowUnits into one list
 *   sorted by event date (§1/§3's global chronological merge), and calls
 *   the Replay Engine exactly once for the whole workbook. This is what
 *   makes a tyre's history spanning multiple sheets (e.g. Rotation +
 *   Puncture Repair) replay as one continuous timeline: replay() groups by
 *   tyre_id for its chunk/transaction boundaries (§7), not by sheet, so
 *   rows from different sheets for the same tyre only end up in the same
 *   chunk if they're handed to replay() together -- which requires
 *   preparing every sheet first, before replaying any of them.
 *
 *   runSheetImport() -- a single-sheet convenience wrapper over the same
 *   two primitives, kept for isolated per-sheet testing/debugging. Real
 *   imports should go through runWorkbookImport().
 */

const { findParserForSheet } = require('./parserRegistry');
const { resolveReferences } = require('./referenceResolvers');
const { validateRow } = require('./tier1Validator');
const { buildFingerprintIndex, recordAsSeen } = require('./fingerprintService');
const { deriveEventIntents, EVENT_GENERATOR_VERSION } = require('./eventGenerator');
const { replay } = require('./replayEngine');

async function prepareSheetRowUnits(worksheet, { importSessionId, masterDataCache }) {
  const found = findParserForSheet(worksheet);
  if (found.unrecognized) {
    return { status: 'unrecognized_sheet', name: worksheet.name, totalParsed: 0, rowUnits: [], perRow: [] };
  }
  if (found.versionMismatch) {
    return { status: 'version_mismatch', name: found.name, totalParsed: 0, rowUnits: [], perRow: [] };
  }

  const { parser } = found;
  const normalizedRows = parser.parse(worksheet);
  const fingerprintIndex = await buildFingerprintIndex(parser.sheetType);

  const perRow = [];
  const rowUnits = [];

  for (const row of normalizedRows) {
    resolveReferences(row, masterDataCache);
    const validation = validateRow(row, { requiredFields: parser.requiredFields, fingerprintIndex });

    if (validation.formability === 'rejected') {
      perRow.push({ sourceSheet: parser.name, sourceRow: row.sourceRow, outcome: 'rejected_shape', reason: validation.rejectReason });
      continue;
    }
    if (validation.duplicate.outcome === 'exact_duplicate') {
      perRow.push({ sourceSheet: parser.name, sourceRow: row.sourceRow, outcome: 'skipped_exact_duplicate' });
      continue;
    }
    if (validation.duplicate.outcome === 'conflicting_duplicate') {
      // Never inserted as-is: the fingerprint UNIQUE constraint means an
      // MIS record sharing an existing fingerprint can't be stored without
      // either overwriting (breaks immutability) or being reviewed first.
      // Flagged for a human decision, per the "new human-in-the-loop review
      // state" called out in the architecture's fingerprint decision.
      perRow.push({ sourceSheet: parser.name, sourceRow: row.sourceRow, outcome: 'flagged_conflicting_duplicate' });
      continue;
    }

    row.import_session_id = importSessionId;
    row.fingerprint = validation.duplicate.fingerprint;
    row.schema_version = 1;
    row.event_generator_version = EVENT_GENERATOR_VERSION;
    // Fold this row's fingerprint back into the index immediately so a
    // later row in the *same* workbook that duplicates it gets classified
    // correctly too, instead of both passing Tier 1 and colliding on the
    // DB's UNIQUE constraint at insert time.
    recordAsSeen(fingerprintIndex, row.fingerprint, row.rawRowJson);

    const eventIntents = deriveEventIntents(row);
    rowUnits.push({ misRecord: row, eventIntents, sheetType: parser.sheetType });
  }

  return {
    status: 'ok',
    sheetType: parser.sheetType,
    templateVersion: parser.templateVersion,
    totalParsed: normalizedRows.length,
    rowUnits,
    perRow,
  };
}

// The earliest event date among a row's own intents -- generic across
// every sheet type, since it only ever looks at whatever eventDate values
// the Event Generator already attached (§6), never a sheet-specific field
// name.
function primarySortDate(rowUnit) {
  const dates = rowUnit.eventIntents.map((intent) => intent.eventDate).filter(Boolean);
  if (dates.length === 0) return '';
  return dates.reduce((min, d) => (d < min ? d : min));
}

function byPrimarySortDate(a, b) {
  const da = primarySortDate(a);
  const db_ = primarySortDate(b);
  return da < db_ ? -1 : da > db_ ? 1 : 0;
}

async function runWorkbookImport(workbook, { importSessionId, dryRun, user, masterDataCache, onProgress }) {
  const sheetResults = [];
  const allRowUnits = [];
  let totalParsed = 0;

  for (const worksheet of workbook.worksheets) {
    const prepared = await prepareSheetRowUnits(worksheet, { importSessionId, masterDataCache });
    sheetResults.push({
      name: worksheet.name,
      status: prepared.status,
      sheetType: prepared.sheetType,
      templateVersion: prepared.templateVersion,
      totalParsed: prepared.totalParsed,
      stored: 0,
      perRow: prepared.perRow,
    });
    if (prepared.status !== 'ok') continue;
    totalParsed += prepared.totalParsed;
    allRowUnits.push(...prepared.rowUnits);
  }

  allRowUnits.sort(byPrimarySortDate);

  const replayOutcomes = await replay(allRowUnits, { dryRun, user, masterDataCache, onProgress });

  // Fold replay outcomes back into each sheet's own perRow list --
  // misRecord.sourceSheet survives into every outcome object returned by
  // replay() (see replayEngine.js), so this is a plain group-by.
  const outcomesBySheet = new Map();
  for (const outcome of replayOutcomes) {
    if (!outcomesBySheet.has(outcome.sourceSheet)) outcomesBySheet.set(outcome.sourceSheet, []);
    outcomesBySheet.get(outcome.sourceSheet).push({ ...outcome, outcome: 'stored' });
  }
  for (const sheetResult of sheetResults) {
    if (sheetResult.status !== 'ok') continue;
    const stored = outcomesBySheet.get(sheetResult.name) || [];
    sheetResult.perRow = [...sheetResult.perRow, ...stored];
    sheetResult.stored = stored.length;
  }

  return {
    status: 'ok',
    totalParsed,
    totalStored: replayOutcomes.length,
    sheets: sheetResults,
  };
}

async function runSheetImport(worksheet, { importSessionId, dryRun, user, masterDataCache }) {
  const prepared = await prepareSheetRowUnits(worksheet, { importSessionId, masterDataCache });
  if (prepared.status !== 'ok') return prepared;

  const sorted = [...prepared.rowUnits].sort(byPrimarySortDate);
  const replayOutcomes = await replay(sorted, { dryRun, user, masterDataCache });

  return {
    status: 'ok',
    sheetType: prepared.sheetType,
    templateVersion: prepared.templateVersion,
    totalParsed: prepared.totalParsed,
    stored: replayOutcomes.length,
    perRow: [...prepared.perRow, ...replayOutcomes.map((o) => ({ ...o, outcome: 'stored' }))],
  };
}

module.exports = { prepareSheetRowUnits, runWorkbookImport, runSheetImport };
