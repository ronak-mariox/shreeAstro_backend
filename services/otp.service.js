/**
 * Login codes (OTP), stored in Redis.
 *
 * Redis is used because a code should disappear on its own. Every key written
 * here has a TTL, so an unused code simply stops existing — nothing has to
 * clean it up, and an expired code cannot be verified because it is gone.
 *
 * Two keys per login attempt:
 *
 *   otp:login:phone:9876543210            the code itself   (expires in 5 min)
 *   otp:cooldown:login:phone:9876543210   "already sent"    (expires in 30 s)
 *
 * The code is never stored as plain text — only a hash of it. A six-digit code
 * is a million guesses, which a plain hash would give up instantly, so the hash
 * is an HMAC keyed with a server secret that Redis never sees.
 *
 * NOTE — SMS/email delivery is best-effort, layered on top of what already
 * worked before either existed:
 *   - the code is always printed to the server log,
 *   - it is always returned in the API response in development,
 *   - the master code in config/env.js always works, unchanged,
 *   - and `deliverOtp` now *also* tries MSG91 (phone) / SMTP (email) when an
 *     admin has configured one on the Third Parties tab. Unconfigured, or a
 *     failed send, changes nothing above — this never throws.
 */

const crypto = require('crypto');

const env = require('../config/env');
const { OTP_TTL_SECONDS, OTP_RESEND_SECONDS, OTP_MAX_ATTEMPTS } = require('../config/constants');
const { redis } = require('../config/redis');
const smsService = require('./sms.service');
const emailService = require('./email.service');

const OTP_LENGTH = 6;

/** e.g. "otp:login:phone:9876543210" */
function codeKey(purpose, channel, destination) {
  return `otp:${purpose}:${channel}:${destination}`;
}

function cooldownKey(purpose, channel, destination) {
  return `otp:cooldown:${purpose}:${channel}:${destination}`;
}

/** A random 6-digit code. randomInt, not Math.random — this is a credential. */
function generateCode() {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

function hashCode(code) {
  return crypto.createHmac('sha256', env.otp.secret).update(String(code)).digest('hex');
}

/**
 * Sends the code: always logged, and best-effort delivered for real when a
 * provider is configured. A delivery failure is caught and logged here, not
 * thrown — the code is already stored and verifiable regardless of whether
 * it reached the destination.
 */
async function deliverOtp({ channel, destination, code, purpose }) {
  console.log(`[otp] ${purpose} code for ${channel} ${destination}: ${code}`);

  try {
    const result =
      channel === 'phone'
        ? await smsService.sendOtpSms({ mobile: destination, otp: code })
        : await emailService.sendEmail({
            to: destination,
            subject: 'Your Shree Astro verification code',
            text: `Your verification code is ${code}. It expires in ${Math.round(OTP_TTL_SECONDS / 60)} minutes.`,
          });

    if (result.sent) {
      console.log(`[otp] delivered via ${channel === 'phone' ? 'MSG91' : 'SMTP'} to ${destination}`);
    }
  } catch (error) {
    console.error('[otp] delivery attempt failed:', error.message);
  }
}

/**
 * Step one: make a code, store it, send it.
 *
 * Returns `{ expiresInSeconds, resendInSeconds, devCode }`. `devCode` is the
 * code itself and is only included outside production.
 *
 * Throws `{ cooldown: seconds }` when a code was sent too recently — the caller
 * turns that into a 429.
 */
async function sendOtp({ channel, destination, purpose = 'login' }) {
  const cooldown = cooldownKey(purpose, channel, destination);

  /** Still inside the cooldown window? `ttl` is the seconds left on the key. */
  const waiting = await redis.ttl(cooldown);
  if (waiting > 0) {
    const error = new Error(`Please wait ${waiting}s before asking for another code.`);
    error.cooldown = waiting;
    throw error;
  }

  const code = generateCode();

  await deliverOtp({ channel, destination, code, purpose });

  /**
   * `attempts` starts at 0 and is counted up by verifyOtp. Storing it beside
   * the hash means a resend resets it too, which is the way out of a lockout.
   */
  await redis.set(
    codeKey(purpose, channel, destination),
    JSON.stringify({ codeHash: hashCode(code), attempts: 0 }),
    'EX',
    OTP_TTL_SECONDS,
  );

  await redis.set(cooldown, '1', 'EX', OTP_RESEND_SECONDS);

  return {
    expiresInSeconds: OTP_TTL_SECONDS,
    resendInSeconds: OTP_RESEND_SECONDS,
    /** Development only — see the note at the top of this file. */
    devCode: env.isProduction ? undefined : code,
  };
}

/**
 * Step two: check a code.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }`, where reason is one of
 * `not_requested` / `expired` / `attempts_exceeded` / `invalid`. The caller
 * decides what each one means over HTTP.
 *
 * A correct code is deleted straight away so it cannot be used twice.
 */
async function verifyOtp({ channel, destination, code, purpose = 'login' }) {
  /** The master code works for any account. Remove this with the master code. */
  if (env.otp.masterCode && String(code) === env.otp.masterCode) {
    await redis.del(codeKey(purpose, channel, destination));
    return { ok: true, usedMasterCode: true };
  }

  const key = codeKey(purpose, channel, destination);
  const stored = await redis.get(key);

  /** Gone means either never asked for, or expired — Redis deleted it for us. */
  if (!stored) {
    return { ok: false, reason: 'not_requested' };
  }

  const record = JSON.parse(stored);

  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, reason: 'attempts_exceeded' };
  }

  if (record.codeHash !== hashCode(code)) {
    record.attempts += 1;
    /**
     * Written back with the TTL it had left, so a wrong guess counts but does
     * not extend the code's life.
     */
    const secondsLeft = await redis.ttl(key);
    if (secondsLeft > 0) {
      await redis.set(key, JSON.stringify(record), 'EX', secondsLeft);
    }

    return {
      ok: false,
      reason: 'invalid',
      attemptsLeft: Math.max(OTP_MAX_ATTEMPTS - record.attempts, 0),
    };
  }

  await redis.del(key);
  return { ok: true };
}

/** Throws the code away — used when an account is deleted or blocked. */
async function clearOtp({ channel, destination, purpose = 'login' }) {
  await redis.del(codeKey(purpose, channel, destination), cooldownKey(purpose, channel, destination));
}

/** "9876543210" -> "••••••3210", "ronak@mail.com" -> "ro•••@mail.com". */
function maskDestination(channel, value) {
  const text = String(value);

  if (channel === 'phone') {
    return `${'•'.repeat(Math.max(text.length - 4, 0))}${text.slice(-4)}`;
  }

  const [local, domain] = text.split('@');
  const head = local.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(local.length - head.length, 1))}@${domain}`;
}

module.exports = {
  sendOtp,
  verifyOtp,
  clearOtp,
  maskDestination,
  OTP_LENGTH,
};
