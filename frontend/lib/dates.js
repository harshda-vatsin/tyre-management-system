// NFR-09: "Date format shall be DD/MM/YYYY." API dates arrive as SQLite
// TEXT (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS) -- this formats them for display
// without touching how they're stored or submitted (date <input> fields
// stay native ISO, which is what the HTML date input type requires).
export function formatDate(value) {
  if (!value) return '-';
  const datePart = String(value).slice(0, 10);
  const [y, m, d] = datePart.split('-');
  if (!y || !m || !d) return value;
  return `${d}/${m}/${y}`;
}

// For timestamps where the time-of-day is also meaningful (audit log,
// alert opened/resolved timestamps).
export function formatDateTime(value) {
  if (!value) return '-';
  const [datePart, timePart] = String(value).split(' ');
  const formattedDate = formatDate(datePart);
  return timePart ? `${formattedDate} ${timePart.slice(0, 5)}` : formattedDate;
}
