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

// All timestamps are written by SQLite's datetime('now'), which is always
// UTC -- server-side date-math (alert escalation, inspection/rotation
// "days overdue") depends on that and re-parses these same strings as UTC,
// so nothing about how they're STORED changes here. This only controls how
// a timestamp is DISPLAYED: fixed to IST (UTC+5:30, no DST) regardless of
// the viewing browser's own local timezone, so the app reads the same time
// to every viewer no matter where they are.
const IST_TIME_ZONE = 'Asia/Kolkata';

const istDateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// For timestamps where the time-of-day is also meaningful (audit log,
// alert opened/resolved timestamps, tyre event dates). A bare date (no time
// component -- e.g. a manually-entered event_date with no clock time) is
// passed straight to formatDate instead of being timezone-shifted, since
// there's no time-of-day to convert and assuming midnight would risk
// nudging it onto the wrong calendar day.
export function formatDateTime(value) {
  if (!value) return '-';
  const str = String(value);
  if (!str.includes(' ') && !str.includes('T')) return formatDate(str);

  const utcDate = new Date(str.includes('T') ? str : `${str.replace(' ', 'T')}Z`);
  if (isNaN(utcDate.getTime())) return str;

  const parts = Object.fromEntries(istDateTimeFormatter.formatToParts(utcDate).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute} IST`;
}
