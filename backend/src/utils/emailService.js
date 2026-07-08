const nodemailer = require('nodemailer');
const db = require('../db');

// FR-AL-01: "Notify the Depot Manager via in-app notification and email
// (configurable)." Configurable means SMTP delivery only activates when an
// operator has actually provided transport settings via env vars -- with no
// SMTP_HOST set, this falls back to the same log-only behaviour as before,
// so a dev/demo environment never fails or hangs trying to send mail.
let transporter = null;
let transporterConfigured = false;

function getTransporter() {
  if (transporterConfigured) return transporter;
  transporterConfigured = true;

  if (!process.env.SMTP_HOST) {
    transporter = null;
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

function formatAlertEmail(alert, tyre, depot, busReg) {
  const subject = `[EBTMS] ${alert.severity} ${alert.parameter_type} alert -- ${tyre.tyre_number}`;
  const lines = [
    `A ${alert.severity.toLowerCase()} threshold breach has been recorded in EBTMS.`,
    '',
    `Tyre: ${tyre.tyre_number}`,
    `Bus: ${busReg}`,
    `Position: ${tyre.current_position || '—'}`,
    `Depot: ${depot.name}`,
    `Parameter: ${alert.parameter_type}`,
    `Reading: ${alert.reading_value ?? '—'} (threshold: ${alert.threshold_value ?? '—'})`,
    '',
    'Open the Alerts page in EBTMS to acknowledge or resolve this alert.',
  ];
  return { subject, text: lines.join('\n') };
}

/**
 * Dispatches a threshold-breach email notification to the depot's active
 * Depot Manager. Fire-and-forget from the caller's perspective -- resolves
 * the recipient and, if SMTP is configured, sends the mail; any failure is
 * caught and logged rather than propagated, since a notification failure
 * must never break the alert-creation transaction that triggered it.
 *
 * @param {object} alert - The created/updated alert database row
 */
async function sendEmailNotification(alert) {
  try {
    const tyre = db.prepare('SELECT tyre_number, current_bus_id, current_position, current_depot_id FROM tyres WHERE id = ?').get(alert.tyre_id);
    if (!tyre) {
      console.error(`[NotificationService] Failed to resolve tyre for alert ID: ${alert.id}`);
      return;
    }

    const depot = db.prepare('SELECT name FROM depots WHERE id = ?').get(alert.depot_id);
    if (!depot) {
      console.error(`[NotificationService] Failed to resolve depot for alert ID: ${alert.id}`);
      return;
    }

    let busReg = '—';
    if (tyre.current_bus_id) {
      const bus = db.prepare('SELECT registration_no FROM buses WHERE id = ?').get(tyre.current_bus_id);
      if (bus) busReg = bus.registration_no;
    }

    const manager = db.prepare(`
      SELECT email, full_name FROM users
      WHERE role = 'Depot Manager' AND depot_id = ? AND is_active = 1
      LIMIT 1
    `).get(alert.depot_id);

    if (!manager?.email) {
      console.log(`[NotificationService] Alert #${alert.id} (${alert.severity} ${alert.parameter_type}) has no active Depot Manager with an email address in depot ${alert.depot_id} -- skipping delivery.`);
      return;
    }

    const smtp = getTransporter();
    if (!smtp) {
      console.log(`[NotificationService] Alert #${alert.id} (${alert.severity} ${alert.parameter_type}) resolved to recipient: ${manager.email}. SMTP is not configured (SMTP_HOST unset) -- delivery skipped, in-app notification only.`);
      return;
    }

    const { subject, text } = formatAlertEmail(alert, tyre, depot, busReg);
    await smtp.sendMail({
      from: process.env.SMTP_FROM || 'EBTMS Alerts <alerts@ebtms.local>',
      to: manager.email,
      subject,
      text,
    });
    console.log(`[NotificationService] Alert #${alert.id} emailed to ${manager.email}.`);
  } catch (err) {
    console.error(`[NotificationService] Failed to send/resolve alert email: ${err.message}`);
  }
}

module.exports = { sendEmailNotification };
