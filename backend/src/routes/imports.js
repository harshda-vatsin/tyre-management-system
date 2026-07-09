/**
 * @file imports.js
 * @description CSV Bulk Import endpoint for onboarding/initial-migration data
 * entry -- depots, buses, and tyres. Each row goes through the exact same
 * validation/creation logic as the single-record create routes (see
 * utils/bulkImport.js), so a bulk file is held to identical rules as the
 * manual form. One bad row does not abort the rest of the file: every row is
 * attempted and the response reports created records and per-row errors.
 */

const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { authenticate } = require('../middleware/auth');
const { ROLES } = require('../utils/roles');
const { importDepotRow, importBusRow, importTyreRow } = require('../utils/bulkImport');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Depot creation is Administrator-only (FR-DM-01, mirrors routes/depots.js);
// buses/tyres additionally allow Depot Manager (mirrors routes/buses.js and
// routes/tyres.js WRITE_ROLES).
const IMPORTERS = {
  depots: { fn: importDepotRow, roles: [ROLES.ADMIN] },
  buses: { fn: importBusRow, roles: [ROLES.ADMIN, ROLES.DEPOT_MANAGER] },
  tyres: { fn: importTyreRow, roles: [ROLES.ADMIN, ROLES.DEPOT_MANAGER] },
};

// Column headers are normalized (trimmed, lowercased, spaces -> underscores)
// so a human-edited CSV ("Registration No", "registration_no", " Registration_No ")
// all resolve to the same row key the importer functions expect.
function parseCsv(buffer) {
  return parse(buffer, {
    columns: (header) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_')),
    skip_empty_lines: true,
    trim: true,
  });
}

router.use(authenticate);

router.post('/:entity', upload.single('file'), (req, res) => {
  const config = IMPORTERS[req.params.entity];
  if (!config) return res.status(404).json({ error: `Unknown import entity: ${req.params.entity}` });
  if (!config.roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient role permissions' });
  }
  if (!req.file) return res.status(400).json({ error: 'A CSV file is required (form field "file")' });

  let rows;
  try {
    rows = parseCsv(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: `Failed to parse CSV: ${err.message}` });
  }
  if (rows.length === 0) return res.status(400).json({ error: 'CSV file has no data rows' });

  const created = [];
  const errors = [];
  rows.forEach((row, idx) => {
    const rowNum = idx + 2; // +1 for header row, +1 to convert 0-index to 1-index
    try {
      const result = config.fn(req.user, row);
      if (result.error) errors.push({ row: rowNum, error: result.error });
      else created.push(result.created);
    } catch (err) {
      errors.push({ row: rowNum, error: err.message });
    }
  });

  res.status(created.length ? 201 : 400).json({ created, errors, totalRows: rows.length });
});

module.exports = router;
