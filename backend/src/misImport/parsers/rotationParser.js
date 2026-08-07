/**
 * @file rotationParser.js
 * @description Parser for the "Tyre Rotation" sheet. Bespoke rather than
 * built on createColumnMappedParser (§6) because one Excel row here covers
 * up to 6 tyre-position slots (FR/FL/RRO/RRI/RLO/RLI) moved in the same
 * rotation visit -- this parser normalizes that to one NormalizedRow per
 * occupied slot, matching tyre_events' one-tyre-per-rotation-event shape
 * (createRotation() moves exactly one tyre at a time). All slots from the
 * same source row share sourceRow/rawRowJson as their natural group key.
 */

const { findHeaderRow } = require('../columnMappedParser');
const { cellValue, textOrNull, numberOrNull, dateOrNull } = require('../excelCellUtils');
const { normalizePositionCode } = require('../../utils/busLayout');

const NAME = 'Tyre Rotation';
const SHEET_TYPE = 'rotation';
const TEMPLATE_VERSION = 'v1';
const MAX_HEADER_SCAN_ROWS = 6;

const SHARED_COLUMNS = [
  { col: 2, header: 'Packages' },
  { col: 3, header: 'Location' },
  { col: 5, header: 'Bus No.' },
  { col: 6, header: 'Current Kms' },
  { col: 7, header: 'KMs @ Rotation' },
  { col: 8, header: 'Due Date of Rotation' },
  { col: 9, header: 'Date of Rotation' },
  { col: 28, header: 'Status' },
  { col: 29, header: 'Remark' },
];

// (fromPosition, nsdCol, tyreNoCol, newLocationCol)
const SLOTS = [
  { fromPosition: 'FR', nsdCol: 10, tyreCol: 11, newLocationCol: 12 },
  { fromPosition: 'FL', nsdCol: 13, tyreCol: 14, newLocationCol: 15 },
  { fromPosition: 'RRO', nsdCol: 16, tyreCol: 17, newLocationCol: 18 },
  { fromPosition: 'RRI', nsdCol: 19, tyreCol: 20, newLocationCol: 21 },
  { fromPosition: 'RLO', nsdCol: 22, tyreCol: 23, newLocationCol: 24 },
  { fromPosition: 'RLI', nsdCol: 25, tyreCol: 26, newLocationCol: 27 },
];

function detect(worksheet) {
  return findHeaderRow(worksheet, SHARED_COLUMNS, MAX_HEADER_SCAN_ROWS) !== null;
}

function parse(worksheet) {
  const headerRow = findHeaderRow(worksheet, SHARED_COLUMNS, MAX_HEADER_SCAN_ROWS);
  if (headerRow === null) return [];

  const results = [];
  for (let r = headerRow + 1; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r);
    if (row.cellCount === 0) continue;

    const rawRow = {};
    for (let c = 1; c <= row.cellCount; c++) {
      const value = cellValue(row.getCell(c));
      if (value !== null && value !== undefined && value !== '') rawRow[`col_${c}`] = value;
    }
    if (Object.keys(rawRow).length === 0) continue;

    const shared = {
      package_raw: textOrNull(row.getCell(2)),
      depot_raw: textOrNull(row.getCell(3)),
      bus_number_raw: textOrNull(row.getCell(5)),
      current_km: numberOrNull(row.getCell(6)),
      km_at_rotation: numberOrNull(row.getCell(7)),
      due_date: dateOrNull(row.getCell(8)),
      rotation_date: dateOrNull(row.getCell(9)),
      status: textOrNull(row.getCell(28)),
      remarks: textOrNull(row.getCell(29)),
    };

    for (const slot of SLOTS) {
      const tyreNumberRaw = textOrNull(row.getCell(slot.tyreCol));
      if (!tyreNumberRaw) continue; // slot not occupied on this row

      results.push({
        sheetType: SHEET_TYPE,
        sourceSheet: NAME,
        sourceRow: r,
        ...shared,
        from_position: slot.fromPosition,
        tyre_number_raw: tyreNumberRaw,
        nsd: numberOrNull(row.getCell(slot.nsdCol)),
        to_position: normalizePositionCode(textOrNull(row.getCell(slot.newLocationCol))),
        rawRowJson: rawRow,
      });
    }
  }
  return results;
}

const rotationParserV1 = {
  name: NAME,
  sheetType: SHEET_TYPE,
  templateVersion: TEMPLATE_VERSION,
  expectedHeaders: SHARED_COLUMNS.map((c) => c.header),
  requiredColumns: [],
  requiredFields: ['tyre_number_raw'],
  detect,
  parse,
};

module.exports = { rotationParserV1 };
