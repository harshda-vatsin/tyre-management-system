/**
 * @file consumptionParser.js
 * @description Parser for the "Tyre Cons. New-Retread-Old Ok" sheet. One
 * row covers both a tyre entering inventory (new/retread/old-ok-spare) and,
 * on the same row, its fitment onto a bus in place of a removed tyre --
 * two lifecycle intents (purchase_intake + fitment_created/replacement),
 * the only sheet type where the "tyre" the row is about doesn't exist in
 * the database yet when the row is parsed (§2, §6; see eventGenerator.js
 * for how that's handled).
 */

const { createColumnMappedParser } = require('../columnMappedParser');

const consumptionParserV1 = createColumnMappedParser({
  name: 'Tyre Cons. New-Retread-Old Ok',
  sheetType: 'consumption',
  templateVersion: 'v1',
  maxHeaderScanRows: 6,
  columns: [
    { col: 2, header: 'Depot', field: 'depot_raw' },
    { col: 3, header: 'Invoice / Challan No.', field: 'invoice_no' },
    { col: 5, header: 'Invoice/Challan Date', field: 'invoice_date', type: 'date' },
    { col: 6, header: 'Date of Material Received/Ok-Spare', field: 'received_date', type: 'date' },
    { col: 7, header: 'Make (JK/Ceat)', field: 'make' },
    { col: 8, header: 'Non RTD/ RTD', field: 'tyre_kind' },
    { col: 9, header: 'NSD', field: 'nsd', type: 'number' },
    { col: 10, header: 'Tyre Status(Cons.)', field: 'consumption_status' },
    { col: 11, header: 'New/Retread-Tyre Number', field: 'tyre_number_raw' },
    { col: 12, header: 'Bus Number', field: 'bus_number_raw' },
    { col: 13, header: 'Tyre Position', field: 'position' },
    { col: 15, header: 'Fitment Date', field: 'fitment_date', type: 'date' },
    { col: 16, header: 'Fitment Kms', field: 'fitment_km', type: 'number' },
    { col: 17, header: 'Removed Tyre No.', field: 'removed_tyre_number_raw' },
    { col: 18, header: 'Remove Tyre NSD(Minimum)', field: 'removed_tyre_min_nsd', type: 'number' },
    { col: 19, header: 'Reason for Removed', field: 'removal_reason' },
  ],
  requiredFields: ['tyre_number_raw'],
});

module.exports = { consumptionParserV1 };
