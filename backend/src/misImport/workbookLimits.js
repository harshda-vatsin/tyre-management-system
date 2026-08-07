/**
 * @file workbookLimits.js
 * @description Zip-bomb / resource-exhaustion guards (§9), in two layers:
 *
 *   1. checkDecompressedSize() -- runs *before* ExcelJS ever touches the
 *      file. An .xlsx is a zip; a small compressed upload can still expand
 *      to gigabytes. JSZip's central-directory read exposes every entry's
 *      uncompressedSize without actually decompressing its contents (a
 *      cheap metadata read, not a second full parse), so a file that would
 *      blow up on load is rejected before load() is ever called.
 *   2. assertWorkbookWithinLimits() -- runs *after* a workbook has already
 *      loaded successfully: reject anything wildly larger than a real
 *      monthly MIS export has any business being, before the
 *      parse/validate/replay pipeline spends any work on it.
 *
 * Both are real, meaningful mitigations for the actual deployment shape (a
 * single VM, Admin-only endpoint, trusted internal users) -- neither is a
 * substitute for true streaming-decompression limits, which would need
 * ExcelJS's streaming reader instead of workbook.xlsx.load() and are a
 * larger change than this pass covers. Pair this with a container/process
 * memory limit (PM2's max_memory_restart or a Docker memory cap) as the
 * actual backstop against a genuinely adversarial file -- that operational
 * control cannot be replaced by application code alone.
 */

const JSZip = require('jszip');

const MAX_ROWS_PER_SHEET = 50_000;
const MAX_TOTAL_ROWS = 200_000;
const MAX_TOTAL_CELLS = 4_000_000;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200MB decompressed

class WorkbookTooLargeError extends Error {}

// Deliberately silent on a load failure here: "not a valid zip" is a format
// problem (400), not a size problem (413), and ExcelJS's own load() call
// right after this one already reports that case correctly -- this
// function's only job is catching an oversized *valid* archive before that
// second parse gets anywhere near it.
async function checkDecompressedSize(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return;
  }

  let totalUncompressed = 0;
  for (const entry of Object.values(zip.files)) {
    totalUncompressed += entry._data?.uncompressedSize || 0;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new WorkbookTooLargeError(
        `Workbook decompresses to more than ${Math.round(MAX_UNCOMPRESSED_BYTES / (1024 * 1024))}MB -- rejected before parsing`
      );
    }
  }
}

function assertWorkbookWithinLimits(workbook) {
  let totalRows = 0;
  let totalCells = 0;

  for (const worksheet of workbook.worksheets) {
    if (worksheet.rowCount > MAX_ROWS_PER_SHEET) {
      throw new WorkbookTooLargeError(
        `Sheet "${worksheet.name}" has ${worksheet.rowCount} rows, over the ${MAX_ROWS_PER_SHEET.toLocaleString()}-row limit per sheet`
      );
    }
    totalRows += worksheet.rowCount;
    // actualColumnCount reflects the sheet's real used range, not a
    // theoretical max -- cheap to sum without touching every cell.
    totalCells += worksheet.rowCount * (worksheet.actualColumnCount || worksheet.columnCount || 1);
  }

  if (totalRows > MAX_TOTAL_ROWS) {
    throw new WorkbookTooLargeError(`Workbook has ${totalRows.toLocaleString()} rows across all sheets, over the ${MAX_TOTAL_ROWS.toLocaleString()}-row limit`);
  }
  if (totalCells > MAX_TOTAL_CELLS) {
    throw new WorkbookTooLargeError(`Workbook has an estimated ${totalCells.toLocaleString()} cells, over the ${MAX_TOTAL_CELLS.toLocaleString()}-cell limit`);
  }
}

class WorkbookTimeoutError extends Error {}

// The Preview phase runs synchronously inside an HTTP request handler
// (§1: Phase 1 is not queued) -- unlike Confirm, which has pg-boss's own
// expireInSeconds as its bound, a slow preview ties up an Express request
// directly. This is the wall-clock backstop for that path specifically.
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new WorkbookTimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = {
  checkDecompressedSize, assertWorkbookWithinLimits, WorkbookTooLargeError, WorkbookTimeoutError, withTimeout,
  MAX_ROWS_PER_SHEET, MAX_TOTAL_ROWS, MAX_TOTAL_CELLS, MAX_UNCOMPRESSED_BYTES,
};
