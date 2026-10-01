/**
 * Razorpay — the payment gateway behind a wallet top-up.
 *
 * This file only talks to Razorpay and checks its signatures. It moves no
 * money and knows nothing about wallets: services/wallet.service.js decides
 * what a verified payment is worth and credits it.
 *
 * No SDK: three REST calls (create an order, read a payment, capture one) over
 * Node's own `fetch`, and two HMACs over Node's own `crypto`.
 *
 * Test mode and live mode are the same code. `rzp_test_…` keys take Razorpay's
 * test cards and test UPI ids and move nothing; `rzp_live_…` keys charge real
 * money. Which one is running is only ever a question of which keys are
 * configured — see `getConfig()`.
 */

const crypto = require('crypto');

const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const integrationsService = require('./integrations.service');

const API_BASE = 'https://api.razorpay.com/v1';

/** A gateway that has not answered in this long is treated as unreachable rather than left holding the request open. */
const TIMEOUT_MS = 15000;

const defaultHttp = (url, init) => fetch(url, init);

/**
 * The one function every outgoing call goes through — `fetch`'s own shape,
 * `(url, init) => Response`. Swapped by tests (`setHttp`) so no suite ever
 * reaches api.razorpay.com.
 */
let http = defaultHttp;

/** Replaces the HTTP call; called with nothing, puts the real one back. */
function setHttp(fn) {
  http = typeof fn === 'function' ? fn : defaultHttp;
}

/**
 * The Razorpay credentials in force right now.
 *
 * Two places can hold them, and the admin panel wins:
 *   1. Settings → Third parties → Razorpay on the panel, saved and enabled
 *      (INTEGRATION_RAZORPAY_* — services/integrations.service.js);
 *   2. otherwise the plain RAZORPAY_* environment variables (config/env.js).
 *
 * Resolved on every call rather than once at boot, because a save on the panel
 * lands on `process.env` while the server is running and must govern the very
 * next top-up. A source is used whole — the key pair and the webhook secret
 * come from the same place, never one from each.
 *
 * @returns {Promise<{
 *   keyId: string, keySecret: string, webhookSecret: string,
 *   enabled: boolean, testMode: boolean, source: 'integration'|'env'|'none',
 * }>}
 */
async function getConfig() {
  const saved = await integrationsService.get('razorpay');
  const fromPanel = Boolean(saved?.keyId && saved?.keySecret);

  const keyId = fromPanel ? String(saved.keyId).trim() : env.razorpay.keyId;
  const keySecret = fromPanel ? String(saved.keySecret).trim() : env.razorpay.keySecret;
  const webhookSecret = fromPanel ? String(saved.webhookSecret || '').trim() : env.razorpay.webhookSecret;
  const enabled = Boolean(keyId && keySecret);

  return {
    keyId,
    keySecret,
    webhookSecret,
    enabled,
    testMode: enabled && keyId.startsWith('rzp_test_'),
    source: fromPanel ? 'integration' : enabled ? 'env' : 'none',
  };
}

/** What the caller is told when Razorpay itself is the problem — never a 500, and never our own credentials. */
function gatewayError(message) {
  return new ApiError(502, message, undefined, 'payment_gateway_error');
}

/**
 * One authenticated call to Razorpay.
 *
 * A refusal comes back as `{ error: { code, description } }`; the description
 * is written for a person ("Order amount less than minimum amount allowed"),
 * so it is what the caller is shown.
 */
async function request(method, path, body) {
  const config = await getConfig();
  if (!config.enabled) {
    throw new ApiError(
      503,
      'Online recharge is temporarily unavailable. Please contact support to add money.',
      undefined,
      'payments_unavailable',
    );
  }

  let response;
  let payload = null;
  try {
    response = await http(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    /** The path and the reason, never the headers — those carry the key. */
    console.error(`[razorpay] ${method} ${path} did not complete: ${error.message}`);
    throw gatewayError('The payment gateway could not be reached. Please try again.');
  }

  if (!response.ok) {
    const description = payload?.error?.description;
    console.error(`[razorpay] ${method} ${path} -> ${response.status} ${payload?.error?.code || ''} ${description || ''}`);
    throw gatewayError(description || 'The payment gateway refused the request. Please try again.');
  }
  return payload;
}

/**
 * Opens an order — the thing a checkout pays against.
 *
 * `amountPaise` is paise, as Razorpay counts money (₹100 is 10000).
 * `payment_capture: 1` asks Razorpay to capture a payment as soon as it is
 * authorised, so the money is actually taken without a second call from us.
 *
 * @returns {Promise<{ id: string, amount: number, currency: string, status: string }>}
 */
async function createOrder({ amountPaise, receipt, notes }) {
  const order = await request('POST', '/orders', {
    amount: amountPaise,
    currency: 'INR',
    receipt,
    notes,
    payment_capture: 1,
  });

  if (!order?.id) {
    throw gatewayError('The payment gateway did not open an order. Please try again.');
  }
  return { id: order.id, amount: order.amount, currency: order.currency, status: order.status };
}

/** A payment as Razorpay holds it: `{ id, order_id, amount, currency, status, method, … }`. */
async function fetchPayment(paymentId) {
  return request('GET', `/payments/${encodeURIComponent(paymentId)}`);
}

/**
 * Takes the money for a payment that is only `authorized`.
 *
 * Orders here are opened with auto-capture, so this is the exception: an
 * account whose dashboard is set to manual capture, or a confirm that arrives
 * in the moment between authorisation and capture.
 */
async function capturePayment(paymentId, { amountPaise, currency = 'INR' }) {
  return request('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, {
    amount: amountPaise,
    currency,
  });
}

/** Compared in constant time, so how long a wrong signature takes to refuse says nothing about how wrong it was. */
function matches(expectedHex, given) {
  const expected = Buffer.from(expectedHex, 'utf8');
  const actual = Buffer.from(typeof given === 'string' ? given : '', 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * Was this checkout result really produced by Razorpay?
 *
 * The checkout hands the app `razorpay_signature`, an HMAC-SHA256 of
 * `order_id|payment_id` under the key secret — which only Razorpay and this
 * server hold, so the app cannot make one up.
 *
 * @returns {Promise<boolean>}
 */
async function verifyPaymentSignature({ orderId, paymentId, signature }) {
  const { keySecret } = await getConfig();
  if (!keySecret || !orderId || !paymentId || !signature) {
    return false;
  }
  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return matches(expected, signature);
}

/**
 * Was this webhook really posted by Razorpay?
 *
 * `X-Razorpay-Signature` is an HMAC-SHA256 of the request body under the
 * webhook secret. It has to be the body exactly as it arrived — the bytes, not
 * the parsed JSON written back out, which need not be the same bytes.
 *
 * @param {Buffer|string} rawBody
 * @returns {Promise<boolean>}
 */
async function verifyWebhookSignature(rawBody, signature) {
  const { webhookSecret } = await getConfig();
  if (!webhookSecret || rawBody === undefined || rawBody === null || !signature) {
    return false;
  }
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return matches(expected, signature);
}

module.exports = {
  getConfig,
  createOrder,
  fetchPayment,
  capturePayment,
  verifyPaymentSignature,
  verifyWebhookSignature,
  setHttp,
  API_BASE,
};
