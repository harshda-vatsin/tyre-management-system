/**
 * @file warrantyParser.js
 * @description Parser for the "Warranty Tyre History" sheet. Same shape as
 * Scrap plus a claim-status/date pair.
 */

const { createColumnMappedParser } = require('../columnMappedParser');

const warrantyParserV1 = createColumnMappedParser({
  name: 'Warranty Tyre History',
  sheetType: 'warranty',
  templateVersion: 'v1',
  maxHeaderScanRows: 6,
  columns: [
    { col: 2, header: 'Package', field: 'package_raw' },
    { col: 3, header: 'Depot', field: 'depot_raw' },
    { col: 5, header: 'Warranty Declared Date', field: 'warranty_declared_date', type: 'date' },
    { col: 6, header: 'Warranty Tyre Serial no.', field: 'tyre_number_raw' },
    { col: 7, header: 'Make (JK/Ceat)', field: 'make' },
    { col: 8, header: 'Non RTD/ RTD', field: 'tyre_kind' },
    { col: 9, header: 'Last Removal Date', field: 'last_removal_date', type: 'date' },
    { col: 10, header: 'Minimum NSD', field: 'min_nsd', type: 'number' },
    { col: 11, header: "Tyre Life Before Retread (Km's)", field: 'tyre_life_before_retread_km', type: 'number' },
    { col: 12, header: "Tyre Life After Retread (Km's)", field: 'tyre_life_after_retread_km', type: 'number' },
    { col: 13, header: 'Total Tyre Life (Km)', field: 'total_tyre_life_km', type: 'number' },
    { col: 14, header: 'Cause of Tyre Warranty', field: 'warranty_cause' },
    { col: 15, header: "Remark's", field: 'remarks' },
    { col: 16, header: 'Warranty Claim Status', field: 'warranty_claim_status' },
    { col: 17, header: 'Date', field: 'claim_status_date', type: 'date' },
    { col: 18, header: 'Gate Pass/Invoice No.', field: 'gate_pass_no' },
    { col: 19, header: 'Gate Pass/Invoice No. Date', field: 'gate_pass_date', type: 'date' },
    { col: 20, header: 'Vendor Name', field: 'vendor_name' },
    { col: 21, header: 'Approved By(SPV Head)', field: 'approved_by' },
    { col: 22, header: 'Store Manager', field: 'store_manager' },
    { col: 23, header: 'Vendor Address', field: 'vendor_address' },
  ],
  requiredFields: ['tyre_number_raw'],
});

module.exports = { warrantyParserV1 };
