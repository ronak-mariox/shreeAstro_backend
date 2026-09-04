/**
 * SMS delivery via MSG91.
 *
 * otp.service.js is the only caller today. Nothing sent a real SMS before
 * this existed — the code was only ever logged — so an unconfigured MSG91 is
 * not a regression, `sendOtpSms` just reports `sent: false` instead of
 * throwing, and the caller keeps logging exactly as it always has.
 *
 * https://docs.msg91.com/reference/send-otp
 */

const integrationsService = require('./integrations.service');

const MSG91_OTP_URL = 'https://control.msg91.com/api/v5/otp';

/**
 * Sends an OTP over SMS. Returns `{ sent: true }` on success, or `{ sent:
 * false, reason }` when MSG91 is not configured or the request itself
 * failed — never thrown, so a provider outage cannot fail the login flow
 * that is falling back to the logged/dev code anyway.
 */
async function sendOtpSms({ mobile, otp }) {
  const config = await integrationsService.get('sms');
  if (!config?.authKey || !config?.templateId) {
    return { sent: false, reason: 'not_configured' };
  }

  const url = new URL(MSG91_OTP_URL);
  url.searchParams.set('otp', otp);
  url.searchParams.set('mobile', mobile);
  url.searchParams.set('template_id', config.templateId);
  if (config.senderId) {
    url.searchParams.set('sender', config.senderId);
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authkey: config.authKey, 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      console.error('[sms] MSG91 send failed:', response.status, await response.text().catch(() => ''));
      return { sent: false, reason: 'provider_error' };
    }

    return { sent: true };
  } catch (error) {
    console.error('[sms] MSG91 request failed:', error.message);
    return { sent: false, reason: 'provider_error' };
  }
}

module.exports = { sendOtpSms };
