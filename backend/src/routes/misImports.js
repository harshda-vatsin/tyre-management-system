/**
 * @file misImports.js
 * @description MIS Excel Import endpoints (§1/§8/§9). Admin-only -- a single
 * confirm can create thousands of elevated lifecycle events at once, a
 * blast radius well beyond any single manual entry or even the CSV bulk
 * importer's per-row role gating (routes/imports.js).
 *
 *   POST   /api/mis-imports            upload + synchronous Preview (dry-run)
 *   GET    /api/mis-imports            list sessions
 *   GET    /api/mis-imports/:id        session detail / progress
 *   GET    /api/mis-imports/:id/rows   per-row detail (Preview Report / linkage review)
 *   POST   /api/mis-imports/:id/confirm  enqueue the background Commit job (§8)
 *   POST   /api/mis-imports/:id/cancel   cancel before the job picks it up
 */

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES } = require('../utils/roles');
const { asyncHandler } = require('../utils/asyncHandler');
const { buildMasterDataCache } = require('../utils/misMasterDataCache');
const { runWorkbookImport } = require('../misImport/importOrchestrator');
const {
  createImportSession, getImportSession, listImportSessions, updateSessionStoredPath,
  markQueued, markCancelled, summarizeCounts, persistSessionRows, listSessionRows, getSheetBreakdown,
} = require('../misImport/importSessionStore');
const { storedPathFor, saveUploadedWorkbook } = require('../misImport/workbookStorage');
const { enqueueImportConfirm } = require('../misImport/importJobQueue');
const { checkDecompressedSize, assertWorkbookWithinLimits, WorkbookTooLargeError, withTimeout, WorkbookTimeoutError } = require('../misImport/workbookLimits');
const { logImport, logImportError } = require('../misImport/importLogger');

// §9: bounds how long a synchronous Preview request can occupy an Express
// handler -- Confirm has pg-boss's own expireInSeconds for this same
// concern (importJobQueue.js); Preview has no queue between it and the
// request, so this is that same backstop for this path specifically.
const PREVIEW_TIMEOUT_MS = 90_000;

const router = express.Router();

// 25MB: generous for a multi-thousand-row workbook, small enough that a
// crafted/corrupt file can't tie up the request handler indefinitely. Real
// zip-bomb protection (decompressed size/cell count, §9) is a second gate
// applied after load, in workbookLimits.js.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.use(authenticate);
router.use(authorize(ROLES.ADMIN));

// Kill switch (§10): checked on every route, not just upload -- if an
// issue surfaces mid-rollout, an Admin can stop *all* importer activity
// (new uploads, confirms, cancels) via system_settings, without a deploy.
router.use(asyncHandler(async (req, res, next) => {
  const setting = await db.prepare("SELECT value FROM system_settings WHERE key = 'mis_import_enabled'").get();
  if (setting?.value === 'false') {
    return res.status(503).json({ error: 'The MIS Excel importer is temporarily disabled by an Administrator.' });
  }
  next();
}));

router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'An Excel file is required (form field "file")' });

  try {
    await checkDecompressedSize(req.file.buffer);
  } catch (err) {
    if (err instanceof WorkbookTooLargeError) return res.status(413).json({ error: err.message });
    throw err;
  }

  let workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: `Failed to read workbook: ${err.message}` });
  }
  if (workbook.worksheets.length === 0) {
    return res.status(400).json({ error: 'Workbook has no sheets' });
  }
  try {
    assertWorkbookWithinLimits(workbook);
  } catch (err) {
    if (err instanceof WorkbookTooLargeError) return res.status(413).json({ error: err.message });
    throw err;
  }

  const session = await createImportSession({
    uploadedBy: req.user.id,
    originalFilename: req.file.originalname,
    storedPath: 'pending',
  });
  logImport(session.id, 'preview', `Upload received: "${req.file.originalname}" (${req.file.size} bytes) by ${req.user.username}`);

  const storedPath = storedPathFor(session.id, req.file.originalname);
  await saveUploadedWorkbook(req.file.buffer, storedPath);
  await updateSessionStoredPath(session.id, storedPath);

  const masterDataCache = await buildMasterDataCache();
  let result;
  try {
    result = await withTimeout(
      runWorkbookImport(workbook, { importSessionId: session.id, dryRun: true, user: req.user, masterDataCache }),
      PREVIEW_TIMEOUT_MS,
      `Preview took longer than ${PREVIEW_TIMEOUT_MS / 1000}s -- the workbook may be unusually large or complex. Try splitting it into smaller files.`
    );
  } catch (err) {
    if (err instanceof WorkbookTimeoutError) {
      logImportError(session.id, 'preview', 'Preview timed out', err);
      return res.status(408).json({ error: err.message });
    }
    logImportError(session.id, 'preview', 'Preview failed unexpectedly', err);
    throw err;
  }

  await persistSessionRows(session.id, result, { dryRun: true });
  const counts = summarizeCounts(result);
  await db.prepare('UPDATE import_sessions SET rows_total = ? WHERE id = ?').run(counts.rowsTotal, session.id);
  logImport(session.id, 'preview', `Preview complete: ${result.totalParsed} rows parsed, ${result.totalStored} would be stored`);

  // Unrecognized sheets (findParserForSheet's "unrecognized_sheet" /
  // "version_mismatch" outcomes) never produce import_session_rows -- there's
  // nothing to persist for a sheet with no matching parser -- so they're
  // reported directly from the in-memory result rather than the DB
  // read-back below, which only ever sees sheets that had a parser.
  const unrecognized = result.sheets
    .filter((s) => s.status !== 'ok')
    .map((s) => ({ name: s.name, status: s.status }));

  const recognized = (await getSheetBreakdown(session.id)).map((s) => ({ ...s, status: 'ok' }));

  res.status(201).json({
    importSessionId: session.id,
    status: 'previewed',
    totalParsed: result.totalParsed,
    totalStored: result.totalStored,
    counts,
    sheets: [...recognized, ...unrecognized],
  });
}));

router.get('/', asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
  const result = await listImportSessions({ page, pageSize });
  res.json(result);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const session = await getImportSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Import session not found' });
  const sheets = (await getSheetBreakdown(session.id)).map((s) => ({ ...s, status: 'ok' }));
  res.json({ ...session, sheets });
}));

router.get('/:id/rows', asyncHandler(async (req, res) => {
  const session = await getImportSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Import session not found' });
  const page = Number(req.query.page) || 1;
  const pageSize = Math.min(Number(req.query.pageSize) || 50, 200);
  const result = await listSessionRows(session.id, { outcome: req.query.outcome, page, pageSize });
  res.json(result);
}));

router.post('/:id/confirm', asyncHandler(async (req, res) => {
  const session = await getImportSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Import session not found' });
  if (!['previewed', 'failed'].includes(session.status)) {
    return res.status(409).json({ error: `Cannot confirm an import session with status "${session.status}"` });
  }

  await markQueued(session.id);
  const jobId = await enqueueImportConfirm(session.id, req.user);
  logImport(session.id, 'confirm', `Confirm enqueued by ${req.user.username}`, { jobId });

  res.status(202).json({ importSessionId: session.id, status: 'queued', jobId });
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const session = await getImportSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Import session not found' });
  // Cooperative, and only effective before the job actually starts running
  // (§8) -- the worker checks this same status at pickup time and exits
  // without doing anything if it's already been cancelled. A chunk already
  // in flight always finishes on its own; there is no mid-chunk cancel.
  if (!['previewed', 'queued'].includes(session.status)) {
    return res.status(409).json({ error: `Cannot cancel an import session with status "${session.status}"` });
  }
  await markCancelled(session.id);
  logImport(session.id, 'cancel', `Cancelled by ${req.user.username}`);
  res.json({ importSessionId: session.id, status: 'cancelled' });
}));

module.exports = router;
