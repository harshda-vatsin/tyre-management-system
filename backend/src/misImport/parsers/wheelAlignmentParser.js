/**
 * @file wheelAlignmentParser.js
 * @description Parser for the "Wheel Alignment" sheet. A bus-level
 * operation, not tied to an individual tyre -- no tyre_number column exists
 * in this sheet, unlike every other MIS sheet. Feeds the existing
 * wheel_alignments/wheel_alignment_measurements tables as its
 * lifecycle-equivalent output rather than tyre_events (§10).
 */

const { createColumnMappedParser } = require('../columnMappedParser');

const wheelAlignmentParserV1 = createColumnMappedParser({
  name: 'Wheel Alignment',
  sheetType: 'wheel_alignment',
  templateVersion: 'v1',
  maxHeaderScanRows: 8,
  columns: [
    { col: 2, header: 'Depot', field: 'depot_raw' },
    { col: 4, header: 'Bus No.', field: 'bus_number_raw' },
    { col: 5, header: 'Current Kms', field: 'current_km', type: 'number' },
    { col: 6, header: 'KMs @ Alignment', field: 'km_at_alignment', type: 'number' },
    { col: 7, header: 'Due Date of Alignment', field: 'due_date', type: 'date' },
    { col: 8, header: 'Date of Alignment', field: 'alignment_date', type: 'date' },
    { col: 9, header: 'Toe Before', field: 'toe_fr_before', type: 'number' },
    { col: 10, header: 'Toe After', field: 'toe_fr_after', type: 'number' },
    { col: 11, header: 'Caster Before', field: 'caster_fr_before', type: 'number' },
    { col: 12, header: 'Caster After', field: 'caster_fr_after', type: 'number' },
    { col: 13, header: 'Camber Before', field: 'camber_fr_before', type: 'number' },
    { col: 14, header: 'Camber After', field: 'camber_fr_after', type: 'number' },
    { col: 15, header: 'SAI Before', field: 'sai_fr_before', type: 'number' },
    { col: 16, header: 'SAI After', field: 'sai_fr_after', type: 'number' },
    { col: 17, header: 'Toe Before', field: 'toe_fl_before', type: 'number' },
    { col: 18, header: 'Toe After', field: 'toe_fl_after', type: 'number' },
    { col: 19, header: 'Caster Before', field: 'caster_fl_before', type: 'number' },
    { col: 20, header: 'Caster After', field: 'caster_fl_after', type: 'number' },
    { col: 21, header: 'Camber Before', field: 'camber_fl_before', type: 'number' },
    { col: 22, header: 'Camber After', field: 'camber_fl_after', type: 'number' },
    { col: 23, header: 'SAI Before', field: 'sai_fl_before', type: 'number' },
    { col: 24, header: 'SAI After', field: 'sai_fl_after', type: 'number' },
    { col: 29, header: 'Status', field: 'status' },
    { col: 30, header: 'Remark', field: 'remarks' },
  ],
  requiredFields: ['bus_number_raw'],
});

module.exports = { wheelAlignmentParserV1 };
