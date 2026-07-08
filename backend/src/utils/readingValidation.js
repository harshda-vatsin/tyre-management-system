/**
 * @file readingValidation.js
 * @description Sanity bound validation utilities for tyre sensor readings.
 * Ensures NSD (Non-Skid Depth) and Pressure values are within reasonable physical limits.
 */

// Reasonable physical limits for tyre measurements
const NSD_BOUNDS = { min: 0, max: 25, label: 'NSD (mm)' };
const PRESSURE_BOUNDS = { min: 0, max: 200, label: 'Pressure (psi)' };

/**
 * Validates if a numeric reading falls within the specified bounding range.
 * 
 * @param {any} value - Input value to validate
 * @param {{min: number, max: number, label: string}} bounds - Safe bounds definitions
 * @returns {{valid: boolean, value?: number, error?: string}} Validation outcome object
 */
function validateBounded(value, bounds) {
  const num = Number(value);
  if (value === undefined || value === null || value === '' || Number.isNaN(num)) {
    return { valid: false, error: `${bounds.label} must be a number` };
  }
  if (num < bounds.min || num > bounds.max) {
    return { valid: false, error: `${bounds.label} must be between ${bounds.min} and ${bounds.max}` };
  }
  return { valid: true, value: num };
}

/**
 * Validates a Non-Skid Depth (NSD) value.
 * @param {any} value
 */
const validateNsd = (value) => validateBounded(value, NSD_BOUNDS);

/**
 * Validates a Tyre Pressure value.
 * @param {any} value
 */
const validatePressure = (value) => validateBounded(value, PRESSURE_BOUNDS);

module.exports = { validateNsd, validatePressure };
