/**
 * @file excelCellUtils.js
 * @description Shared cell-reading helpers for MIS parsers. Centralizes the
 * exceljs quirks every parser would otherwise repeat: formula cells only
 * ever expose their computed result (§9 -- a cell's formula text is never
 * trusted, security or otherwise), rich-text runs collapse to plain text,
 * dates normalize to the app's plain 'YYYY-MM-DD' TEXT convention, and
 * multi-line header labels (a literal newline inside the cell, e.g.
 * "Make\n(JK/Ceat)") normalize to single-spaced text for header matching.
 */

function cellValue(cell) {
  if (!cell) return null;
  let value = cell.value;
  if (value === null || value === undefined) return null;

  if (typeof value === 'object' && Array.isArray(value.richText)) {
    value = value.richText.map((run) => run.text).join('');
  } else if (typeof value === 'object' && 'result' in value) {
    // Formula cell: never trust `formula`, only ever read `result`.
    value = value.result;
    if (value && typeof value === 'object' && Array.isArray(value.richText)) {
      value = value.richText.map((run) => run.text).join('');
    }
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  return value;
}

function normalizeHeader(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

function textOrNull(cell) {
  const value = cellValue(cell);
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

function numberOrNull(cell) {
  const value = cellValue(cell);
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function dateOrNull(cell) {
  const value = cellValue(cell);
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

module.exports = { cellValue, normalizeHeader, textOrNull, numberOrNull, dateOrNull };
