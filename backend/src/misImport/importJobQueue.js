/**
 * @file importJobQueue.js
 * @description Background job queue for the Confirm phase (§8, Architecture
 * Decision: "Postgres-native background jobs, not Redis/BullMQ"). Confirm
 * never runs inline inside the HTTP request -- this is the one place that
 * enqueues it and the one place that processes it.
 */

const ExcelJS = require('exceljs');
const { PgBoss } = require('pg-boss');
const { buildMasterDataCache } = require('../utils/misMasterDataCache');
const { runWorkbookImport } = require('./importOrchestrator');
const { assertWorkbookWithinLimits } = require('./workbookLimits');
const { logImport, logImportError } = require('./importLogger');
const {
  getImportSession, markRunning, markCommitted, markFailed, updateProgress, summarizeCounts, summarizeOutcomeCounts, persistSessionRows,
} = require('./importSessionStore');

const QUEUE_NAME = 'mis-import-confirm';

let boss = null;

function connectionString() {
  return process.env.DATABASE_URL || 'postgres://postgres:devpassword@localhost:5432/ebtms';
}

async function processConfirmJob({ importSessionId, user }, jobId) {
  const session = await getImportSession(importSessionId);
  if (!session) throw new Error(`Import session ${importSessionId} not found`);
  if (session.status === 'cancelled') {
    logImport(importSessionId, 'confirm', 'Job picked up but session was cancelled before it started -- skipping', undefined);
    return;
  }

  logImport(importSessionId, 'confirm', `Job started (worker picked up)`, { jobId });
  await markRunning(importSessionId);

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(session.stored_path);
    // Defense in depth: re-checked here too (not just at upload, §9) in
    // case the stored file was ever reached by a path other than the
    // upload route's own check.
    assertWorkbookWithinLimits(workbook);

    const masterDataCache = await buildMasterDataCache();

    const result = await runWorkbookImport(workbook, {
      importSessionId,
      dryRun: false,
      user,
      masterDataCache,
      // Fires after every tyre-group chunk commits (§7) -- each is an
      // independent, already-durable transaction by the time this runs, so
      // persisting a running count here reflects real progress, not a
      // guess. This is what turns "queued -> running -> committed" from a
      // three-state indicator into an actual progress bar a client can
      // poll GET /api/mis-imports/:id for.
      onProgress: ({ outcomes }) => {
        const partial = summarizeOutcomeCounts(outcomes);
        updateProgress(importSessionId, partial).catch((err) =>
          logImportError(importSessionId, 'confirm', 'Failed to persist progress', err)
        );
      },
    });

    await persistSessionRows(importSessionId, result, { dryRun: false });
    const counts = summarizeCounts(result);
    await updateProgress(importSessionId, counts);
    await markCommitted(importSessionId, counts);
    logImport(importSessionId, 'confirm', `Job committed: ${counts.rowsStored} rows stored, ${counts.eventsLinked} events linked, ${counts.eventsUnlinked} unlinked`);
  } catch (err) {
    logImportError(importSessionId, 'confirm', 'Job failed', err);
    await markFailed(importSessionId, err.message);
    throw err; // let pg-boss's own retry/dead-letter handling see the failure too
  }
}

async function startImportJobQueue() {
  if (boss) return boss;

  boss = new PgBoss({ connectionString: connectionString() });
  boss.on('error', (err) => console.error('[ImportJobQueue]', err));

  await boss.start();
  await boss.createQueue(QUEUE_NAME);

  await boss.work(QUEUE_NAME, { batchSize: 1 }, async ([job]) => {
    await processConfirmJob(job.data, job.id);
  });

  return boss;
}

async function stopImportJobQueue() {
  if (!boss) return;
  await boss.stop({ graceful: true });
  boss = null;
}

/**
 * @param {number} importSessionId
 * @param {object} user - the confirming user (authorization, performed_by
 *   on every event this job creates)
 * @returns {Promise<string>} the pg-boss job id
 */
async function enqueueImportConfirm(importSessionId, user) {
  if (!boss) throw new Error('Import job queue is not running -- call startImportJobQueue() at app startup first');
  return boss.send(
    QUEUE_NAME,
    { importSessionId, user },
    {
      // Automatic, bounded retry of a transient failure (connection blip,
      // deadlock) -- distinct from the user-initiated "retry failed rows"
      // flow (§8), which is a separate, narrower job scoped to only the
      // previously-failed subset and isn't built yet.
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      // §9: bounds a genuinely stuck job (rather than letting a session
      // sit at "running" forever) -- 10 minutes is generous for a real
      // monthly export at the row/cell ceilings in workbookLimits.js, but
      // still a real bound.
      expireInSeconds: 600,
    }
  );
}

module.exports = { startImportJobQueue, stopImportJobQueue, enqueueImportConfirm, QUEUE_NAME };
