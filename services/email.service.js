/**
 * Transactional email, over whatever SMTP the admin has configured on the
 * Third Parties tab.
 *
 * Nothing sent real email before this existed, so an unconfigured SMTP is not
 * a regression — `sendEmail` just logs and reports `sent: false` instead of
 * throwing, the same way otp.service.js's `deliverOtp` already only logs a
 * code today. Callers should never let a failed send break the request that
 * triggered it.
 */

const nodemailer = require('nodemailer');

const integrationsService = require('./integrations.service');

/** Rebuilt only when the config actually changes, not on every send. */
let cachedTransporter = null;
let cachedKey = null;

function transporterFor(config) {
  const key = `${config.host}:${config.port}:${config.username}`;
  if (cachedTransporter && cachedKey === key) {
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.host,
    port: Number(config.port) || 587,
    /** 465 is SMTPS (implicit TLS); everything else negotiates STARTTLS itself. */
    secure: Number(config.port) === 465,
    auth: { user: config.username, pass: config.password },
  });
  cachedKey = key;
  return cachedTransporter;
}

/**
 * Sends one email. Returns `{ sent: true }` on success, or `{ sent: false,
 * reason }` when SMTP is not configured or the send itself failed — the
 * latter is never thrown, so a flaky mail provider cannot fail e.g. an OTP
 * request that also tried to deliver by email.
 */
async function sendEmail({ to, subject, text, html }) {
  const config = await integrationsService.get('email');
  if (!config?.host || !config?.username || !config?.password) {
    console.log(`[email] SMTP not configured — would have sent "${subject}" to ${to}`);
    return { sent: false, reason: 'not_configured' };
  }

  try {
    await transporterFor(config).sendMail({ from: config.username, to, subject, text, html });
    return { sent: true };
  } catch (error) {
    console.error('[email] send failed:', error.message);
    return { sent: false, reason: 'provider_error' };
  }
}

module.exports = { sendEmail };
