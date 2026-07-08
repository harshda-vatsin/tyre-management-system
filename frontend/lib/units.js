// SRS §8.3/NFR-09: pressure is always stored and submitted in PSI (matching
// every threshold and event row already in the system) -- this module only
// converts for display, and for converting a kPa-typed input back to PSI
// before it's sent to the API. kPa is the only other supported unit.
const PSI_TO_KPA = 6.89476;

export function psiToKpa(psi) {
  return psi * PSI_TO_KPA;
}

export function kpaToPsi(kpa) {
  return kpa / PSI_TO_KPA;
}

// value is always in PSI (the storage unit). Returns a display string in
// whichever unit the caller resolves from SettingsContext.
export function formatPressure(value, unit) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  if (unit === 'kPa') return `${Math.round(psiToKpa(num))} kPa`;
  return `${num} psi`;
}
