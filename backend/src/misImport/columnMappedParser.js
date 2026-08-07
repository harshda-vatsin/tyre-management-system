/**
 * @file columnMappedParser.js
 * @description Factory that builds a parser descriptor (§6: name,
 * templateVersion, expectedHeaders, requiredColumns, detect(), parse()) from
 * a declarative column map, instead of hand-writing near-identical
 * read-this-cell-into-that-field code per sheet. Every MIS sheet in the
 * sample workbook is fundamentally the same shape -- a header row somewhere
 * in the first few rows, then one data row per record -- so the only thing
 * that actually differs sheet to sheet is *which* columns matter, which
 * lives entirely in the column map passed in.
 *
 * A parser built here has zero lifecycle-mapping knowledge (§2, §6): it
 * only knows how to turn one Excel row into a NormalizedRow. What that row
 * *implies* for tyre lifecycle state is the Event Generator's job, not this
 * one's.
 */

const { cellValue, normalizeHeader, textOrNull, numberOrNull, dateOrNull } = require('./excelCellUtils');

function findHeaderRow(worksheet, columns, maxScanRows) {
  const scanLimit = Math.min(maxScanRows, worksheet.rowCount);
  for (let r = 1; r <= scanLimit; r++) {
    const row = worksheet.getRow(r);
    const isMatch = columns.every(
      ({ col, header }) => normalizeHeader(cellValue(row.getCell(col))).toLowerCase() === header.toLowerCase()
    );
    if (isMatch) return r;
  }
  return null;
}

function readTyped(cell, type) {
  if (type === 'number') return numberOrNull(cell);
  if (type === 'date') return dateOrNull(cell);
  return textOrNull(cell);
}

/**
 * @param {object} spec
 * @param {string} spec.name - exact worksheet tab name this parser claims
 * @param {string} spec.sheetType - matches a mis_<sheetType>_records table
 * @param {string} spec.templateVersion
 * @param {Array<{col:number, header:string, field:string, type?:string}>} spec.columns
 * @param {string[]} [spec.requiredFields] - normalized-row fields Tier 1 (§5)
 *   treats as the MIS-formability minimum; carried on the descriptor for the
 *   validator to consume, not enforced here
 * @param {number} [spec.maxHeaderScanRows]
 */
function createColumnMappedParser(spec) {
  const { name, sheetType, templateVersion, columns, requiredFields = [], maxHeaderScanRows = 8 } = spec;
  const mappedCols = new Set(columns.map((c) => c.col));

  function detect(worksheet) {
    return findHeaderRow(worksheet, columns, maxHeaderScanRows) !== null;
  }

  function parse(worksheet) {
    const headerRow = findHeaderRow(worksheet, columns, maxHeaderScanRows);
    if (headerRow === null) return [];

    const results = [];
    for (let r = headerRow + 1; r <= worksheet.rowCount; r++) {
      const row = worksheet.getRow(r);
      if (row.cellCount === 0) continue;

      const normalized = { sheetType, sourceSheet: name, sourceRow: r };
      const rawRow = {};
      let hasAnyMappedValue = false;

      for (const { col, header, field, type } of columns) {
        const cell = row.getCell(col);
        const value = readTyped(cell, type);
        normalized[field] = value;
        const raw = cellValue(cell);
        if (raw !== null && raw !== undefined && raw !== '') rawRow[header] = raw;
        if (value !== null) hasAnyMappedValue = true;
      }

      // Every other populated cell in the row's used range, not just the
      // mapped columns -- this is what makes raw_row_json a genuine full
      // capture rather than just a restatement of the named fields (§6).
      for (let c = 1; c <= row.cellCount; c++) {
        if (mappedCols.has(c)) continue;
        const raw = cellValue(row.getCell(c));
        if (raw !== null && raw !== undefined && raw !== '') rawRow[`col_${c}`] = raw;
      }

      if (!hasAnyMappedValue && Object.keys(rawRow).length === 0) continue; // fully blank row

      normalized.rawRowJson = rawRow;
      results.push(normalized);
    }
    return results;
  }

  return {
    name,
    sheetType,
    templateVersion,
    expectedHeaders: columns.map((c) => c.header),
    requiredColumns: columns.filter((c) => requiredFields.includes(c.field)).map((c) => c.header),
    requiredFields,
    detect,
    parse,
  };
}

module.exports = { createColumnMappedParser, findHeaderRow };
