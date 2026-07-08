/**
 * Helper utilities for EBTMS tyre QR payload formatting and validation in frontend.
 */

/**
 * Formats a tyre number into a stable EBTMS payload version 1 string.
 * @param {string} tyreNumber - Unique tyre registry number (e.g. TYR-0001)
 * @returns {string} Fully qualified payload
 */
export function generateQrPayload(tyreNumber) {
  return `EBTMS:TYRE:V1:${tyreNumber}`;
}

/**
 * Validates and extracts the tyre number from a raw string payload.
 * @param {string} payload - Raw scanned barcode/QR payload
 * @returns {string|null} The resolved tyre number, or null if the payload is invalid
 */
export function parseQrPayload(payload) {
  if (!payload || typeof payload !== 'string') return null;
  const parts = payload.trim().split(':');
  if (parts.length === 4 && parts[0] === 'EBTMS' && parts[1] === 'TYRE' && parts[2] === 'V1') {
    return parts[3];
  }
  return null;
}
