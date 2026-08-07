/**
 * @file retreadParser.js
 * @description Parser for the "Retread Tyre History" sheet. Two
 * independently-dated intents per row: retread_sent (dispatch) and
 * retread_completed (received back from the retreader).
 */

const { createColumnMappedParser } = require('../columnMappedParser');

const retreadParserV1 = createColumnMappedParser({
  name: 'Retread Tyre History',
  sheetType: 'retread',
  templateVersion: 'v1',
  maxHeaderScanRows: 6,
  columns: [
    { col: 2, header: 'Package', field: 'package_raw' },
    { col: 3, header: 'Depot', field: 'depot_raw' },
    { col: 5, header: 'Removal Date for Retread', field: 'removal_date', type: 'date' },
    { col: 6, header: 'Tyre Stensile No.', field: 'tyre_number_raw' },
    { col: 7, header: 'Make (JK/Ceat)', field: 'make' },
    { col: 8, header: 'NSD at removal for Retread', field: 'nsd_at_removal', type: 'number' },
    { col: 9, header: 'New Tyre Life(KM) (Before Rtd)', field: 'tyre_life_before_retread_km', type: 'number' },
    { col: 10, header: 'Tyre For (RTD/Cut Rep)', field: 'retread_purpose_raw' },
    { col: 11, header: 'Date of Dispatch(Fo Retread)', field: 'dispatch_date', type: 'date' },
    { col: 12, header: 'Gate Pass No./Other Doc.', field: 'gate_pass_no' },
    { col: 13, header: 'Vendor(Retreader) Name', field: 'vendor_name' },
    { col: 14, header: 'Location', field: 'vendor_location' },
    { col: 15, header: 'Received on Invoice No', field: 'invoice_no' },
    { col: 16, header: 'Invoice Date', field: 'invoice_date', type: 'date' },
    { col: 17, header: 'Retread Status( Retread Done/Reject)', field: 'retread_status_raw' },
    { col: 18, header: 'Rejected Reason (If Reject for retread by vendor)', field: 'rejected_reason' },
  ],
  requiredFields: ['tyre_number_raw'],
});

module.exports = { retreadParserV1 };
