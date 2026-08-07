/**
 * @file workbookStorage.js
 * @description Persists the original uploaded workbook to local disk, keyed
 * by import session ID, so the background Confirm job (§8) can re-read the
 * exact same file the Preview ran against -- a single-VM deployment with no
 * object storage dependency, matching the rest of this app's storage model.
 */

const fs = require('fs/promises');
const path = require('path');

const UPLOAD_DIR = process.env.MIS_IMPORT_UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads', 'mis-imports');

async function ensureUploadDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

function storedPathFor(sessionId, originalFilename) {
  const ext = path.extname(originalFilename || '') || '.xlsx';
  return path.join(UPLOAD_DIR, `${sessionId}${ext}`);
}

async function saveUploadedWorkbook(buffer, storedPath) {
  await ensureUploadDir();
  await fs.writeFile(storedPath, buffer);
}

module.exports = { UPLOAD_DIR, storedPathFor, saveUploadedWorkbook, ensureUploadDir };
