/**
 * @file punctureRepairParser.js
 * @description Parser for the "Puncture Repaire Details" sheet (sic --
 * matches the workbook's actual tab spelling exactly, since detect() keys
 * off it). Two lifecycle intents per row, both dated independently
 * (declared vs. repaired date), which is exactly why the Event Generator --
 * not this file -- owns deciding what those intents are (§2, §6).
 */

const { createColumnMappedParser } = require('../columnMappedParser');

const punctureRepairParserV1 = createColumnMappedParser({
  name: 'Puncture Repaire Details',
  sheetType: 'puncture_repair',
  templateVersion: 'v1',
  maxHeaderScanRows: 6,
  columns: [
    { col: 2, header: 'Depot', field: 'depot_raw' },
    { col: 4, header: 'Declared for Pun. Repair Date', field: 'declared_date', type: 'date' },
    { col: 5, header: 'Make (JK/Ceat)', field: 'make' },
    { col: 6, header: 'Tyre No', field: 'tyre_number_raw' },
    { col: 7, header: 'NSD', field: 'nsd', type: 'number' },
    { col: 9, header: 'Repaired Date', field: 'repaired_date', type: 'date' },
    { col: 10, header: 'Repair Patch Size', field: 'patch_size' },
    { col: 11, header: 'Supervisor', field: 'supervisor_name' },
    { col: 12, header: 'Tyre Man', field: 'tyre_man_name' },
    { col: 13, header: 'Remarks', field: 'remarks' },
  ],
  requiredFields: ['tyre_number_raw'],
});

module.exports = { punctureRepairParserV1 };
