/**
 * @file exportService.js
 * @description Generates formatted Microsoft Excel workbooks and Adobe PDF documents
 * containing EBTMS report datasets.
 */

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

// Company branding label prefixed to all reports
const COMPANY_BRANDING_PLACEHOLDER = '[COMPANY LOGO] — EV Bus Tyre Management Company';

/**
 * Formats filter keys and values into a readable summary string.
 * 
 * @param {Array<object>} filterSchema - Filter configurations
 * @param {object} filters - Applied filter values
 * @returns {string} Formatted filter text string
 */
function formatFilters(filterSchema, filters) {
  const applied = filterSchema
    .filter((f) => filters[f.key] !== undefined && filters[f.key] !== null && filters[f.key] !== '')
    .map((f) => `${f.label}: ${filters[f.key]}`);
  return applied.length ? applied.join('  |  ') : 'None';
}

/**
 * Safely stringifies cell values, converting null or undefined to empty strings.
 * 
 * @param {any} value
 * @returns {string} Cell value string
 */
function cellText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Builds an Excel (.xlsx) workbook buffer using ExcelJS.
 * 
 * @param {object} params
 * @param {string} params.reportName - Title of the report
 * @param {string} params.generatedAt - Creation timestamp string
 * @param {string} params.generatedByUsername - Creator's username
 * @param {Array<object>} params.filterSchema - Filters schema definitions
 * @param {object} params.filters - Active filters mapping
 * @param {Array<object>} params.columns - Target columns list
 * @param {Array<object>} params.rows - Rows data array
 * @returns {Promise<Buffer>} Excel file buffer
 */
async function buildXlsx({ reportName, generatedAt, generatedByUsername, filterSchema, filters, columns, rows }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'EBTMS';
  workbook.created = new Date(generatedAt);

  const sheet = workbook.addWorksheet(reportName.slice(0, 31));

  // Write company branding and title block in the worksheet headers
  sheet.mergeCells(1, 1, 1, columns.length);
  sheet.getCell(1, 1).value = COMPANY_BRANDING_PLACEHOLDER;
  sheet.getCell(1, 1).font = { italic: true, color: { argb: 'FF888888' } };

  sheet.mergeCells(2, 1, 2, columns.length);
  sheet.getCell(2, 1).value = reportName;
  sheet.getCell(2, 1).font = { bold: true, size: 14 };

  sheet.mergeCells(3, 1, 3, columns.length);
  sheet.getCell(3, 1).value = `Generated: ${generatedAt}  |  By: ${generatedByUsername}`;
  sheet.getCell(3, 1).font = { size: 10, color: { argb: 'FF555555' } };

  sheet.mergeCells(4, 1, 4, columns.length);
  sheet.getCell(4, 1).value = `Filters: ${formatFilters(filterSchema, filters)}`;
  sheet.getCell(4, 1).font = { size: 10, color: { argb: 'FF555555' } };

  // Generate table headers starting at line 6
  const headerRowIndex = 6;
  const headerRow = sheet.getRow(headerRowIndex);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D3A63' } };
  });

  // Populate data rows into the sheet
  rows.forEach((row, rIdx) => {
    const excelRow = sheet.getRow(headerRowIndex + 1 + rIdx);
    columns.forEach((col, cIdx) => {
      excelRow.getCell(cIdx + 1).value = row[col.key] ?? '';
    });
  });

  // Calculate dynamic columns width based on contents length
  columns.forEach((col, i) => {
    const headerLen = col.label.length;
    const maxDataLen = rows.reduce((max, r) => Math.max(max, cellText(r[col.key]).length), 0);
    sheet.getColumn(i + 1).width = Math.min(40, Math.max(12, headerLen, maxDataLen) + 2);
  });

  return workbook.xlsx.writeBuffer();
}

/**
 * Builds a PDF document stream using pdfkit, piping the output directly to the response object.
 * 
 * @param {object} data
 * @param {string} data.reportName - Title of the report
 * @param {string} data.generatedAt - Creation timestamp string
 * @param {string} data.generatedByUsername - Creator's username
 * @param {Array<object>} data.filterSchema - Filters schema definitions
 * @param {object} data.filters - Active filters mapping
 * @param {Array<object>} data.columns - Target columns list
 * @param {Array<object>} data.rows - Rows data array
 * @param {import('express').Response} res - Express response object
 */
function buildPdf({ reportName, generatedAt, generatedByUsername, filterSchema, filters, columns, rows }, res) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape', bufferPages: true });
  doc.pipe(res);

  // Lay out report metadata header
  doc.fontSize(8).fillColor('#888888').text(COMPANY_BRANDING_PLACEHOLDER, { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold').text(reportName);
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica').fillColor('#555555').text(`Generated: ${generatedAt}   |   By: ${generatedByUsername}`);
  doc.text(`Filters: ${formatFilters(filterSchema, filters)}`);
  doc.moveDown(0.6);

  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / columns.length;
  const rowHeight = 16;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  // Draws headers row
  function drawHeaderRow(y) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
    doc.rect(startX, y, usableWidth, rowHeight).fill('#1d3a63');
    doc.fillColor('#ffffff');
    columns.forEach((col, i) => {
      doc.text(col.label, startX + i * colWidth + 2, y + 4, { width: colWidth - 4, height: rowHeight, ellipsis: true });
    });
  }

  let y = doc.y;
  drawHeaderRow(y);
  y += rowHeight;

  // Lay out data rows
  doc.font('Helvetica').fontSize(8).fillColor('#000000');
  rows.forEach((row, idx) => {
    // Add page if row overflows page height limits
    if (y + rowHeight > bottomLimit) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeaderRow(y);
      y += rowHeight;
      doc.font('Helvetica').fontSize(8).fillColor('#000000');
    }
    // Zebra striping effect on alternate rows
    if (idx % 2 === 1) {
      doc.rect(startX, y, usableWidth, rowHeight).fill('#f4f6f8');
      doc.fillColor('#000000');
    }
    columns.forEach((col, i) => {
      doc.text(cellText(row[col.key]), startX + i * colWidth + 2, y + 4, { width: colWidth - 4, height: rowHeight, ellipsis: true });
    });
    y += rowHeight;
  });

  if (rows.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#888888').text('No data matches the applied filters.', startX, y + 6);
  }

  // Inject page numbers dynamically after laying out all pages
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor('#888888').text(
      `Page ${i - range.start + 1} of ${range.count}`,
      startX,
      doc.page.height - doc.page.margins.bottom + 10,
      { width: usableWidth, align: 'center' }
    );
  }

  doc.end();
}

const EVENT_TYPE_LABELS = {
  nsd_reading: 'NSD Reading',
  pressure_reading: 'Pressure Reading',
  rotation: 'Rotation',
  replacement: 'Replacement',
  puncture_repair: 'Puncture Repair',
  inter_bus_transfer: 'Inter-Bus Transfer',
  send_to_store: 'Sent to Store',
  condemnation: 'Condemnation',
};

function getEventDescription(e) {
  switch (e.event_type) {
    case 'nsd_reading':
      return `NSD: ${e.nsd_value} mm at ${e.position || '—'} (${e.bus_registration_no || '—'})`;
    case 'pressure_reading':
      return `Pressure: ${e.pressure_value} psi at ${e.position || '—'} (${e.bus_registration_no || '—'})`;
    case 'rotation':
      return `${e.from_position || '—'} → ${e.to_position || '—'} on ${e.bus_registration_no || '—'}${e.reason ? ` — ${e.reason}` : ''}`;
    case 'replacement':
      return e.to_position
        ? `Installed at ${e.to_position} on ${e.bus_registration_no || '—'}, replacing tyre ${e.related_tyre_number || '—'}${e.reason ? ` — ${e.reason}` : ''}`
        : `Removed from ${e.from_position} on ${e.bus_registration_no || '—'}, replaced by tyre ${e.related_tyre_number || '—'}${e.reason ? ` — ${e.reason}` : ''}`;
    case 'puncture_repair':
      return `${e.repair_type || '—'} repair${e.notes ? ` — ${e.notes}` : ''}`;
    case 'inter_bus_transfer':
      return `${e.from_bus_registration_no || '—'}/${e.from_position || '—'} → ${e.to_bus_registration_no || '—'}/${e.to_position || '—'}${e.reason ? ` — ${e.reason}` : ''}`;
    case 'send_to_store':
      return `Removed from ${e.from_bus_registration_no || '—'}/${e.from_position || '—'}, NSD ${e.nsd_value || '—'} mm, stored at ${e.stored_at || '—'} — ${e.reason || '—'}`;
    case 'condemnation':
      return `Condemned at NSD ${e.nsd_value || '—'} mm — ${e.reason || '—'}`;
    default:
      return '—';
  }
}

async function buildTyreCardPdf({ tyre, events, latestNsd, latestPressure, generatedAt, generatedByUsername }, res) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'portrait', bufferPages: true });
  doc.pipe(res);

  // Generate QR code buffer containing stable EBTMS payload format
  const QRCode = require('qrcode');
  const qrPayload = `EBTMS:TYRE:V1:${tyre.tyre_number}`;
  let qrBuffer = null;
  try {
    qrBuffer = await QRCode.toBuffer(qrPayload, { width: 60, margin: 1 });
  } catch (err) {
    console.error('[buildTyreCardPdf] Failed to generate QR buffer:', err);
  }

  // Lay out branding header
  doc.fontSize(8).fillColor('#888888').text('EV Bus Tyre Management System (EBTMS) | Confidential', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(16).fillColor('#10233f').font('Helvetica-Bold').text('Individual Tyre Card Report');
  doc.moveDown(0.2);
  doc.fontSize(8).font('Helvetica').fillColor('#555555').text(`Generated At: ${generatedAt}   |   Generated By: ${generatedByUsername}`);
  doc.moveDown(0.8);

  // Draw the QR code image at top-right corner
  if (qrBuffer) {
    doc.image(qrBuffer, 499.28, 36, { width: 60 });
  }

  // Draw a separator line
  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let y = doc.y;
  doc.moveTo(startX, y).lineTo(startX + usableWidth, y).strokeColor('#e4e8ee').stroke();
  doc.moveDown(0.8);

  // Section: Profile details
  y = doc.y;
  doc.fontSize(12).fillColor('#1d3a63').font('Helvetica-Bold').text('Tyre Profile & Status');
  doc.moveDown(0.4);

  const leftColX = startX;
  const rightColX = startX + usableWidth / 2 + 10;

  y = doc.y;
  doc.fontSize(9).fillColor('#000000');
  
  // Left Column
  doc.font('Helvetica-Bold').text('Tyre Number: ', leftColX, y, { continued: true }).font('Helvetica').text(tyre.tyre_number || '—');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Brand / Manufacturer: ', leftColX, doc.y, { continued: true }).font('Helvetica').text(tyre.brand || '—');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Model / Type: ', leftColX, doc.y, { continued: true }).font('Helvetica').text(tyre.model || '—');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Size Specification: ', leftColX, doc.y, { continued: true }).font('Helvetica').text(tyre.size || '—');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Date of Purchase: ', leftColX, doc.y, { continued: true }).font('Helvetica').text(tyre.purchase_date || '—');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Initial NSD: ', leftColX, doc.y, { continued: true }).font('Helvetica').text(tyre.initial_nsd != null ? `${tyre.initial_nsd} mm` : '—');

  // Right Column (Align with y coordinate of left column start)
  doc.font('Helvetica-Bold').text('Current Status: ', rightColX, y, { continued: true }).font('Helvetica').text(tyre.status || '—');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Current Depot: ', rightColX, doc.y, { continued: true }).font('Helvetica').text(tyre.depot_name || '—');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Current Bus / Position: ', rightColX, doc.y, { continued: true }).font('Helvetica').text(
    tyre.bus_registration_no ? `${tyre.bus_registration_no} / ${tyre.current_position || '—'}` : '—'
  );
  doc.moveDown(0.3);
  
  const nsdText = latestNsd ? `${latestNsd.nsd_value} mm (${latestNsd.event_date})` : '—';
  doc.font('Helvetica-Bold').text('Latest NSD Reading: ', rightColX, doc.y, { continued: true }).font('Helvetica').text(nsdText);
  doc.moveDown(0.3);

  const pressureText = latestPressure ? `${latestPressure.pressure_value} psi (${latestPressure.event_date})` : '—';
  doc.font('Helvetica-Bold').text('Latest Pressure Reading: ', rightColX, doc.y, { continued: true }).font('Helvetica').text(pressureText);

  doc.moveDown(1.5);

  // Section: History
  doc.fontSize(12).fillColor('#1d3a63').font('Helvetica-Bold').text('Tyre Card History', startX, doc.y);
  doc.moveDown(0.5);

  const historyColumns = [
    { label: 'Date', width: 90 },
    { label: 'Event Type', width: 100 },
    { label: 'Details', width: 220 },
    { label: 'Recorded By', width: 110 },
  ];

  const rowHeight = 22;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  function drawHistoryHeader(y) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
    doc.rect(startX, y, usableWidth, rowHeight).fill('#1d3a63');
    doc.fillColor('#ffffff');
    let curX = startX;
    historyColumns.forEach((col) => {
      doc.text(col.label, curX + 4, y + 6, { width: col.width - 8, height: rowHeight - 6, ellipsis: true });
      curX += col.width;
    });
  }

  y = doc.y;
  drawHistoryHeader(y);
  y += rowHeight;

  doc.font('Helvetica').fontSize(8).fillColor('#000000');
  events.forEach((e, idx) => {
    // Add page if row overflows
    if (y + rowHeight > bottomLimit) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHistoryHeader(y);
      y += rowHeight;
      doc.font('Helvetica').fontSize(8).fillColor('#000000');
    }

    if (idx % 2 === 1) {
      doc.rect(startX, y, usableWidth, rowHeight).fill('#f4f6f8');
      doc.fillColor('#000000');
    }

    let curX = startX;
    const typeLabel = EVENT_TYPE_LABELS[e.event_type] || e.event_type;
    const details = getEventDescription(e);
    const performedBy = e.performed_by_name || '—';

    doc.text(e.event_date || '—', curX + 4, y + 6, { width: historyColumns[0].width - 8, ellipsis: true });
    curX += historyColumns[0].width;
    
    doc.text(typeLabel, curX + 4, y + 6, { width: historyColumns[1].width - 8, ellipsis: true });
    curX += historyColumns[1].width;
    
    doc.text(details, curX + 4, y + 6, { width: historyColumns[2].width - 8, ellipsis: true });
    curX += historyColumns[2].width;
    
    doc.text(performedBy, curX + 4, y + 6, { width: historyColumns[3].width - 8, ellipsis: true });
    
    y += rowHeight;
  });

  if (events.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#888888').text('No events recorded yet.', startX, y + 6);
  }

  // Inject page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor('#888888').text(
      `Page ${i - range.start + 1} of ${range.count}`,
      startX,
      doc.page.height - doc.page.margins.bottom + 10,
      { width: usableWidth, align: 'center' }
    );
  }

  doc.end();
}

module.exports = { buildXlsx, buildPdf, buildTyreCardPdf };
