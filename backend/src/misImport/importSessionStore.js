/**
 * @file importSessionStore.js
 * @description Reads/writes import_sessions + import_session_rows (§10).
 * The one place that translates a workbook-level result (from
 * importOrchestrator.js) into the persisted session record and per-row
 * detail table -- used by both the synchronous Preview route and the
 * background Confirm job, so the two can never disagree about what these
 * rows mean.
 */

const db = require('../db');

async function createImportSession({ uploadedBy, originalFilename, storedPath }) {
  return db
    .prepare('INSERT INTO import_sessions (uploaded_by, original_filename, stored_path, status) VALUES (?, ?, ?, ?) RETURNING *')
    .get(uploadedBy ?? null, originalFilename, storedPath, 'previewed');
}

async function getImportSession(id) {
  return db.prepare('SELECT * FROM import_sessions WHERE id = ?').get(id);
}

async function listImportSessions({ page = 1, pageSize = 20 } = {}) {
  const offset = (page - 1) * pageSize;
  const rows = await db
    .prepare('SELECT * FROM import_sessions ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(pageSize, offset);
  const { c: total } = await db.prepare('SELECT COUNT(*) c FROM import_sessions').get();
  return { rows, total, page, pageSize };
}

async function updateSessionStoredPath(id, storedPath) {
  await db.prepare('UPDATE import_sessions SET stored_path = ? WHERE id = ?').run(storedPath, id);
}

async function markQueued(id) {
  await db.prepare("UPDATE import_sessions SET status = 'queued' WHERE id = ?").run(id);
}

async function markRunning(id) {
  await db.prepare("UPDATE import_sessions SET status = 'running', started_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?").run(id);
}

async function markCommitted(id, counts) {
  await db
    .prepare(`
      UPDATE import_sessions
      SET status = 'committed',
          rows_total = ?, rows_stored = ?, events_linked = ?, events_unlinked = ?, rows_skipped_duplicate = ?,
          completed_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?
    `)
    .run(counts.rowsTotal, counts.rowsStored, counts.eventsLinked, counts.eventsUnlinked, counts.rowsSkippedDuplicate, id);
}

async function markFailed(id, errorSummary) {
  await db
    .prepare(`
      UPDATE import_sessions
      SET status = 'failed', error_summary = ?,
          completed_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?
    `)
    .run(errorSummary, id);
}

async function markCancelled(id) {
  await db
    .prepare(`
      UPDATE import_sessions
      SET status = 'cancelled',
          completed_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?
    `)
    .run(id);
}

// Incremental progress during a running Confirm job (§8) -- distinct from
// markCommitted's final counts, this can be called many times as chunks
// complete.
async function updateProgress(id, counts) {
  await db
    .prepare(`
      UPDATE import_sessions
      SET rows_stored = ?, events_linked = ?, events_unlinked = ?
      WHERE id = ?
    `)
    .run(counts.rowsStored, counts.eventsLinked, counts.eventsUnlinked, id);
}

// Same tallies as summarizeCounts, but from a flat replay() outcomes array
// rather than a full workbook result -- what the job worker's onProgress
// callback has in hand mid-run (§8), before the workbook-level result
// object even exists.
function summarizeOutcomeCounts(outcomes) {
  let rowsStored = 0;
  let eventsLinked = 0;
  let eventsUnlinked = 0;
  for (const row of outcomes) {
    if (!row.misRecordId) continue;
    rowsStored += 1;
    if (row.linkageStatus === 'linked') eventsLinked += 1;
    else if (row.linkageStatus === 'unlinked' || row.linkageStatus === 'partially_linked') eventsUnlinked += 1;
  }
  return { rowsStored, eventsLinked, eventsUnlinked };
}

// Summarizes a workbook-level result (importOrchestrator.runWorkbookImport)
// into the counts import_sessions tracks. Shared by preview (rows_total
// only really matters there) and confirm (all of them).
function summarizeCounts(workbookResult) {
  let rowsTotal = 0;
  let rowsStored = 0;
  let eventsLinked = 0;
  let eventsUnlinked = 0;
  let rowsSkippedDuplicate = 0;

  for (const sheet of workbookResult.sheets) {
    if (sheet.status !== 'ok') continue;
    rowsTotal += sheet.totalParsed;
    for (const row of sheet.perRow) {
      if (row.outcome === 'skipped_exact_duplicate') rowsSkippedDuplicate += 1;
      if (row.outcome === 'stored') {
        rowsStored += 1;
        if (row.linkageStatus === 'linked') eventsLinked += 1;
        else if (row.linkageStatus === 'unlinked' || row.linkageStatus === 'partially_linked') eventsUnlinked += 1;
      }
    }
  }

  return { rowsTotal, rowsStored, eventsLinked, eventsUnlinked, rowsSkippedDuplicate };
}

const OUTCOME_MAP = {
  rejected_shape: 'rejected_shape',
  skipped_exact_duplicate: 'skipped_exact_duplicate',
  flagged_conflicting_duplicate: 'flagged_conflicting_duplicate',
};

// dryRun matters here specifically because misRecordId/generatedEventIds
// come from *inside* the dry-run transaction, which the Replay Engine
// always rolls back (§4) -- by the time this function runs, those IDs no
// longer exist in the database. Referencing tyre_event_id from a preview
// isn't just misleading, it's a hard FK violation (mis_record_id has no
// DB-level FK, being a polymorphic pointer, but would be silently wrong
// data all the same); a live/commit run is the only case where these IDs
// are durable enough to store.
function toSessionRow(sessionId, sheetType, row, dryRun) {
  if (row.outcome === 'stored') {
    if (row.misRecordId) {
      const failureNotes = (row.eventFailures || []).map((f) => `${f.eventType}: ${f.message}`).join('; ') || null;
      return {
        import_session_id: sessionId,
        source_sheet: row.sourceSheet,
        source_row: row.sourceRow,
        sheet_type: sheetType,
        outcome: 'stored',
        mis_record_type: dryRun ? null : sheetType,
        mis_record_id: dryRun ? null : row.misRecordId,
        tyre_event_id: dryRun ? null : (row.generatedEventIds?.[0] ?? null),
        failure_reason: failureNotes,
      };
    }
    // A chunk-level failure (replayEngine.js's chunkError path) -- nothing
    // was actually stored for this row.
    return {
      import_session_id: sessionId,
      source_sheet: row.sourceSheet,
      source_row: row.sourceRow,
      sheet_type: sheetType,
      outcome: 'rejected_lifecycle',
      mis_record_type: null,
      mis_record_id: null,
      tyre_event_id: null,
      failure_reason: row.chunkError || 'Unknown failure',
    };
  }

  return {
    import_session_id: sessionId,
    source_sheet: row.sourceSheet,
    source_row: row.sourceRow,
    sheet_type: sheetType,
    outcome: OUTCOME_MAP[row.outcome] || 'rejected_shape',
    mis_record_type: null,
    mis_record_id: null,
    tyre_event_id: null,
    failure_reason: row.reason ?? null,
  };
}

const SESSION_ROW_COLUMNS = ['import_session_id', 'source_sheet', 'source_row', 'sheet_type', 'outcome', 'mis_record_type', 'mis_record_id', 'tyre_event_id', 'failure_reason'];
const SESSION_ROW_BATCH_SIZE = 500;

// A real workbook can carry thousands of rows, most of which end up as
// import_session_rows detail (§10 wants "why did row 482 fail" answerable
// without parsing JSON, for every row, not just the ones that succeeded).
// One INSERT per row here was the dominant cost in a full-workbook Confirm
// run -- batching keeps the same one-row-per-source-row detail without
// paying a network round-trip per row.
async function insertSessionRowBatch(batch) {
  // db.prepare() translates plain `?` placeholders positionally (db.js),
  // so a batch VALUES clause just needs one `?` per column per row --
  // numbering itself is handled for us.
  const rowPlaceholders = batch.map(() => `(${SESSION_ROW_COLUMNS.map(() => '?').join(', ')})`).join(', ');
  const values = batch.flatMap((r) => SESSION_ROW_COLUMNS.map((col) => r[col]));
  await db
    .prepare(`INSERT INTO import_session_rows (${SESSION_ROW_COLUMNS.join(', ')}) VALUES ${rowPlaceholders}`)
    .run(...values);
}

async function persistSessionRows(sessionId, workbookResult, { dryRun = false } = {}) {
  // Replaces whatever detail this session already had -- a re-preview
  // (master data changed since the last one) or a confirm following a
  // preview should each leave exactly one, current set of row detail
  // behind, not an accumulating mix of a stale dry-run's rows alongside
  // the real committed ones.
  await db.prepare('DELETE FROM import_session_rows WHERE import_session_id = ?').run(sessionId);

  const allRows = [];
  for (const sheet of workbookResult.sheets) {
    if (sheet.status !== 'ok') continue;
    for (const row of sheet.perRow) {
      allRows.push(toSessionRow(sessionId, sheet.sheetType, row, dryRun));
    }
  }

  for (let i = 0; i < allRows.length; i += SESSION_ROW_BATCH_SIZE) {
    await insertSessionRowBatch(allRows.slice(i, i + SESSION_ROW_BATCH_SIZE));
  }
}

// Per-sheet outcome tally, computed from the persisted row detail rather
// than held in memory only -- this is what lets the Preview Report survive
// a page refresh or a return visit after the background job finishes,
// instead of only ever being visible in the response to the original
// upload/confirm call.
async function getSheetBreakdown(sessionId) {
  const rows = await db
    .prepare(`
      SELECT source_sheet, sheet_type, outcome, COUNT(*) AS count
      FROM import_session_rows
      WHERE import_session_id = ?
      GROUP BY source_sheet, sheet_type, outcome
      ORDER BY source_sheet
    `)
    .all(sessionId);

  const bySheet = new Map();
  for (const row of rows) {
    if (!bySheet.has(row.source_sheet)) {
      bySheet.set(row.source_sheet, { name: row.source_sheet, sheetType: row.sheet_type, totalParsed: 0, stored: 0, outcomeBreakdown: {} });
    }
    const sheet = bySheet.get(row.source_sheet);
    sheet.totalParsed += row.count;
    if (row.outcome === 'stored') sheet.stored += row.count;
    sheet.outcomeBreakdown[row.outcome] = (sheet.outcomeBreakdown[row.outcome] || 0) + row.count;
  }
  return [...bySheet.values()];
}

async function listSessionRows(sessionId, { outcome, page = 1, pageSize = 50 } = {}) {
  const clauses = ['import_session_id = ?'];
  const params = [sessionId];
  if (outcome) {
    clauses.push('outcome = ?');
    params.push(outcome);
  }
  const offset = (page - 1) * pageSize;
  const rows = await db
    .prepare(`SELECT * FROM import_session_rows WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);
  const { c: total } = await db.prepare(`SELECT COUNT(*) c FROM import_session_rows WHERE ${clauses.join(' AND ')}`).get(...params);
  return { rows, total, page, pageSize };
}

// Health check support (§10): a session stuck in queued/running longer than
// this has almost certainly hit a real problem -- pg-boss's own
// expireInSeconds (importJobQueue.js, 600s) should have already failed it,
// so anything still showing as queued/running past a generous multiple of
// that is a genuine operational signal, not a false positive from a merely
// large import.
const STUCK_THRESHOLD_MINUTES = 20;

async function findStuckImportSessions() {
  return db
    .prepare(`
      SELECT id, original_filename, status, uploaded_by, started_at, created_at
      FROM import_sessions
      WHERE status IN ('queued', 'running')
        AND COALESCE(started_at, created_at) < to_char(now() AT TIME ZONE 'UTC' - interval '${STUCK_THRESHOLD_MINUTES} minutes', 'YYYY-MM-DD HH24:MI:SS')
      ORDER BY id
    `)
    .all();
}

module.exports = {
  createImportSession,
  getImportSession,
  listImportSessions,
  updateSessionStoredPath,
  markQueued,
  markRunning,
  markCommitted,
  markFailed,
  markCancelled,
  updateProgress,
  summarizeCounts,
  summarizeOutcomeCounts,
  persistSessionRows,
  listSessionRows,
  getSheetBreakdown,
  findStuckImportSessions,
};
