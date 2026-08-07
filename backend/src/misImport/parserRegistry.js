/**
 * @file parserRegistry.js
 * @description Static parser registry (Architecture Decision: "Static parser
 * registry, not dynamic directory auto-discovery" -- explicit registration
 * keeps behavior auditable). Multiple versions of the same logical sheet
 * register under the same `name` with different `templateVersion`; the
 * first one whose header shape actually matches wins. A sheet recognized by
 * name with no matching version fails closed, per §6.
 */

const PARSERS = [];

function registerParser(descriptor) {
  PARSERS.push(descriptor);
}

/**
 * @returns {{parser: object}|{unrecognized: true}|{versionMismatch: true, name: string}}
 */
function findParserForSheet(worksheet) {
  const candidates = PARSERS.filter((p) => p.name === worksheet.name);
  if (candidates.length === 0) return { unrecognized: true };
  const match = candidates.find((p) => p.detect(worksheet));
  if (!match) return { versionMismatch: true, name: worksheet.name };
  return { parser: match };
}

function listRegisteredSheetNames() {
  return [...new Set(PARSERS.map((p) => p.name))];
}

module.exports = { registerParser, findParserForSheet, listRegisteredSheetNames };
