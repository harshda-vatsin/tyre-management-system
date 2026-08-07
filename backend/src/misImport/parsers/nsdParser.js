/**
 * @file nsdParser.js
 * @description Parser for the "Tyre NSD Report" sheet. Deliberately excludes
 * every formula-derived report column (Week/Year, standard OTD lookup, Min,
 * % wear, Tyre Replace Plan, projected/remaining mileage, km/mm wear,
 * retreading kms, days remaining, retreading date) -- these are
 * recomputable from the stored facts, never themselves facts to preserve
 * (the "ignore computed report cells" rule). Two intents per row:
 * nsd_reading and pressure_reading, sharing one inspection date.
 */

const { createColumnMappedParser } = require('../columnMappedParser');

const nsdParserV1 = createColumnMappedParser({
  name: 'Tyre NSD Report',
  sheetType: 'nsd',
  templateVersion: 'v1',
  maxHeaderScanRows: 6,
  columns: [
    { col: 2, header: 'Depot Name', field: 'depot_raw' },
    { col: 3, header: 'Tyre New/ Retread', field: 'tyre_kind' },
    { col: 4, header: 'Vehicle Registration No.', field: 'bus_number_raw' },
    { col: 5, header: 'Tyre Dimension', field: 'tyre_dimension' },
    { col: 6, header: 'PR/LI/SI', field: 'pr_li_si' },
    { col: 7, header: 'Tyre Make', field: 'make' },
    { col: 8, header: 'Pattern', field: 'pattern' },
    { col: 9, header: 'Wheel Position', field: 'position' },
    { col: 10, header: 'Stencil No.', field: 'tyre_number_raw' },
    { col: 12, header: 'DOI(Date of Inspection)', field: 'inspection_date', type: 'date' },
    { col: 13, header: 'Psi', field: 'pressure_psi', type: 'number' },
    { col: 15, header: 'G1', field: 'nsd_g1', type: 'number' },
    { col: 16, header: 'G2', field: 'nsd_g2', type: 'number' },
    { col: 17, header: 'G3', field: 'nsd_g3', type: 'number' },
    { col: 18, header: 'G4', field: 'nsd_g4', type: 'number' },
    { col: 29, header: 'Vehicles Status', field: 'vehicle_status' },
    { col: 30, header: 'Tyre Fitting Condition(Running/Scrap/For Retread)', field: 'tyre_fitting_condition' },
  ],
  requiredFields: ['tyre_number_raw'],
});

module.exports = { nsdParserV1 };
