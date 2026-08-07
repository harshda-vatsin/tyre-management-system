/**
 * @file scrapParser.js
 * @description Parser for the "Scraped Tyre Details" sheet. One row, one
 * intent: a terminal write-off (scrap).
 */

const { createColumnMappedParser } = require('../columnMappedParser');

const scrapParserV1 = createColumnMappedParser({
  name: 'Scraped Tyre Details',
  sheetType: 'scrap',
  templateVersion: 'v1',
  maxHeaderScanRows: 6,
  columns: [
    { col: 2, header: 'Package', field: 'package_raw' },
    { col: 3, header: 'Depot', field: 'depot_raw' },
    { col: 5, header: 'Scrap Declared Date', field: 'scrap_declared_date', type: 'date' },
    { col: 6, header: 'Scrap Tyre Serial no.', field: 'tyre_number_raw' },
    { col: 7, header: 'Make (JK/Ceat)', field: 'make' },
    { col: 8, header: 'Non RTD/ RTD', field: 'tyre_kind' },
    { col: 9, header: 'Last Removal Date', field: 'last_removal_date', type: 'date' },
    { col: 10, header: 'Minimum NSD', field: 'min_nsd', type: 'number' },
    { col: 11, header: "Tyre Life Before Retread (Km's)", field: 'tyre_life_before_retread_km', type: 'number' },
    { col: 12, header: "Tyre Life After Retread (Km's)", field: 'tyre_life_after_retread_km', type: 'number' },
    { col: 13, header: 'Total Tyre Life (Km)', field: 'total_tyre_life_km', type: 'number' },
    { col: 14, header: 'Cause of Tyre Scrapt', field: 'scrap_cause' },
    { col: 15, header: "Remark's", field: 'remarks' },
    { col: 16, header: 'Gate Pass/Invoice No.', field: 'gate_pass_no' },
    { col: 17, header: 'Gate Pass/Invoice No. Date', field: 'gate_pass_date', type: 'date' },
    { col: 18, header: 'Vendor Name', field: 'vendor_name' },
    { col: 19, header: 'Approved By(SPV Head)', field: 'approved_by' },
    { col: 20, header: 'Store Manager', field: 'store_manager' },
    { col: 21, header: 'Vendor Address', field: 'vendor_address' },
  ],
  requiredFields: ['tyre_number_raw'],
});

module.exports = { scrapParserV1 };
