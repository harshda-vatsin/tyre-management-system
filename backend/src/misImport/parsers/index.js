/**
 * @file index.js
 * @description Explicit registration point for every MIS parser -- the one
 * file that has to change when a parser is added, by design (Architecture
 * Decision: static registry, not directory auto-discovery).
 */

const { registerParser } = require('../parserRegistry');
const { punctureRepairParserV1 } = require('./punctureRepairParser');
const { scrapParserV1 } = require('./scrapParser');
const { warrantyParserV1 } = require('./warrantyParser');
const { retreadParserV1 } = require('./retreadParser');
const { nsdParserV1 } = require('./nsdParser');
const { rotationParserV1 } = require('./rotationParser');
const { wheelAlignmentParserV1 } = require('./wheelAlignmentParser');
const { consumptionParserV1 } = require('./consumptionParser');

registerParser(punctureRepairParserV1);
registerParser(scrapParserV1);
registerParser(warrantyParserV1);
registerParser(retreadParserV1);
registerParser(nsdParserV1);
registerParser(rotationParserV1);
registerParser(wheelAlignmentParserV1);
registerParser(consumptionParserV1);
