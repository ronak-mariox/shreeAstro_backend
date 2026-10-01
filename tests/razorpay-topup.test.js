/**
 * Wallet top-ups through Razorpay (services/razorpay.service.js +
 * services/wallet.service.js), and the webhook Razorpay posts back.
 *
 * DB-backed like call-token/wallet-topup-guard, and it needs a MongoDB
 * *replica set*: the credit itself is a transaction. Point TEST_MONGODB_URI at
 * one, e.g. mongodb://127.0.0.1:27131/shree_astro_test_razorpay?replicaSet=rs0
 *
 * Nothing here reaches api.razorpay.com. Every outgoing call goes through
 * razorpayService.setHttp(), which is handed a small in-memory Razorpay: it
 * keeps the orders it is asked to open and the payments a test "makes" against
 * them, and answers the three endpoints the service uses. Signatures are real
 * HMACs under the test-only secrets below, so the verification code runs
 * exactly as it does in production.
 *
 * Credentials are switched by writing `process.env`, never through
 * integrationsService.save(): that writes the `.env` file in the working
 * directory, and this suite must not touch the project's own.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_razorpay';
process.env.NODE_ENV = 'development';

/** Test-only values; not real Razorpay credentials. */
const KEY_ID = 'rzp_test_UnitTestKey0001';
const KEY_SECRET = 'unit-test-key-secret';
const WEBHOOK_SECRET = 'unit-test-webhook-secret';
const PANEL_KEY_ID = 'rzp_test_PanelKey00001';
const PANEL_KEY_SECRET = 'panel-key-secret';
const PANEL_WEBHOOK_SECRET = 'panel-webhook-secret';

/** Razorpay configured through the plain environment variables. */
function useEnvKeys() {
  process.env.RAZORPAY_KEY_ID = KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
}
function clearEnvKeys() {
  process.env.RAZORPAY_KEY_ID = '';
  process.env.RAZORPAY_KEY_SECRET = '';
  process.env.RAZORPAY_WEBHOOK_SECRET = '';
}
/** Razorpay as the admin panel's Third Parties tab leaves it on process.env. */
function usePanelKeys({ enabled }) {
  process.env.INTEGRATION_RAZORPAY_KEY_ID = PANEL_KEY_ID;
  process.env.INTEGRATION_RAZORPAY_KEY_SECRET = PANEL_KEY_SECRET;
  process.env.INTEGRATION_RAZORPAY_WEBHOOK_SECRET = PANEL_WEBHOOK_SECRET;
  process.env.INTEGRATION_RAZORPAY_ENABLED = enabled ? 'true' : 'false';
}
function clearPanelKeys() {
  process.env.INTEGRATION_RAZORPAY_KEY_ID = '';
  process.env.INTEGRATION_RAZORPAY_KEY_SECRET = '';
  process.env.INTEGRATION_RAZORPAY_WEBHOOK_SECRET = '';
  process.env.INTEGRATION_RAZORPAY_ENABLED = 'false';
}

/** Set before anything is required, so a developer's own .env can never point this suite at a real account. */
useEnvKeys();
clearPanelKeys();

const crypto = require('crypto');
const mongoose = require('mongoose');

const env = require('../config/env');
const { createApp } = require('../app');
const { signAccessToken } = require('../utils/token');
const razorpayService = require('../services/razorpay.service');
const walletService = require('../services/wallet.service');
const settingsService = require('../services/settings.service');
const chatService = require('../services/chat.service');
const User = require('../models/User');
const Coupon = require('../models/Coupon');
const WalletTransaction = require('../models/WalletTransaction');
const walletRoutes = require('../routes/wallet.routes');
const paymentRoutes = require('../routes/payment.routes');

/** No live socket.io server here. */
require('../socket').getIO = () => ({ to: () => ({ emit: () => {} }) });

/** Records who a credit tried to wake paused chats for, instead of walking real sessions. */
const resumedFor = [];
chatService.resumePausedSessionsForUser = async userId => {
  resumedFor.push(String(userId));
  return [];
};

const PORT = 5096;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);
const errorOf = async fn => {
  try { await fn(); return null; } catch (error) { return error; }
};
const brief = error => ({ status: error?.status, code: error?.code, message: error?.message });

const hmac = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
const basicAuth = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

/* ------------------------------------------------------- the fake Razorpay */

const fake = {
  calls: [],
  orders: new Map(),
  payments: new Map(),
  /** Set to a description to make the next "create order" fail the way Razorpay does. */
  nextOrderError: null,
  seq: 0,
};
const reply = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});
const refusal = description => reply(400, { error: { code: 'BAD_REQUEST_ERROR', description } });

async function fakeHttp(url, init = {}) {
  const { host, pathname } = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  fake.calls.push({ method: init.method, host, path: pathname, body, authorization: init.headers?.Authorization });

  if (init.method === 'POST' && pathname === '/v1/orders') {
    if (fake.nextOrderError) {
      const description = fake.nextOrderError;
      fake.nextOrderError = null;
      return refusal(description);
    }
    fake.seq += 1;
    const order = {
      id: `order_T${String(fake.seq).padStart(6, '0')}`,
      entity: 'order',
      amount: body.amount,
      amount_paid: 0,
      currency: body.currency,
      receipt: body.receipt,
      notes: body.notes,
      status: 'created',
    };
    fake.orders.set(order.id, order);
    return reply(200, order);
  }

  const capture = /^\/v1\/payments\/([^/]+)\/capture$/.exec(pathname);
  if (init.method === 'POST' && capture) {
    const payment = fake.payments.get(capture[1]);
    if (!payment || payment.status !== 'authorized') {
      return refusal('This payment cannot be captured.');
    }
    payment.status = 'captured';
    return reply(200, payment);
  }

  const single = /^\/v1\/payments\/([^/]+)$/.exec(pathname);
  if (init.method === 'GET' && single) {
    const payment = fake.payments.get(single[1]);
    return payment ? reply(200, payment) : refusal('The id provided does not exist');
  }

  return reply(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'The requested URL was not found on the server.' } });
}
razorpayService.setHttp(fakeHttp);

const callsTo = (method, pattern) => fake.calls.filter(call => call.method === method && pattern.test(call.path));

/**
 * "Pays" an order: records a payment at the fake Razorpay and returns what its
 * checkout would hand the app — the payment id, the order id, and a signature
 * over the two under the key secret.
 */
function pay(orderId, { status = 'captured', method = 'upi', amount, secret = KEY_SECRET } = {}) {
  fake.seq += 1;
  const payment = {
    id: `pay_T${String(fake.seq).padStart(6, '0')}`,
    entity: 'payment',
    order_id: orderId,
    amount: amount ?? fake.orders.get(orderId).amount,
    currency: 'INR',
    status,
    method,
  };
  fake.payments.set(payment.id, payment);
  return {
    payment,
    razorpayPaymentId: payment.id,
    razorpayOrderId: orderId,
    razorpaySignature: hmac(`${orderId}|${payment.id}`, secret),
  };
}

/* --------------------------------------------------------------- helpers */

let userSeq = 0;
async function makeUser(overrides = {}) {
  userSeq += 1;
  return User.create({
    name: `Rzp Seeker ${userSeq}`,
    email: `rzpseeker${userSeq}@example.com`,
    phone: { countryCode: '+91', number: `94${String(userSeq).padStart(8, '0')}` },
    wallet: { balance: 0 },
    ...overrides,
  });
}
const walletOf = async id => (await User.findById(id)).wallet;
const balanceOf = async id => (await walletOf(id)).balance;
const rowOf = id => WalletTransaction.findById(id);
const creditRows = id => WalletTransaction.countDocuments({ owner: id, status: 'success', direction: 'credit' });

/** A signed-in seeker over HTTP. */
const api = user => async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${signAccessToken(user._id, 'user')}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/** A Razorpay webhook body, as the exact string that gets signed. */
function webhookBody(event, { payment, order } = {}) {
  return JSON.stringify({
    entity: 'event',
    account_id: 'acc_TestAccount001',
    event,
    contains: [payment && 'payment', order && 'order'].filter(Boolean),
    payload: {
      ...(payment ? { payment: { entity: payment } } : {}),
      ...(order ? { order: { entity: order } } : {}),
    },
    created_at: Math.floor(Date.now() / 1000),
  });
}

/** Posts a webhook. `signature` defaults to a genuine one; pass `null` to send none. */
async function postWebhook(raw, { signature, secret = WEBHOOK_SECRET } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const value = signature === undefined ? hmac(raw, secret) : signature;
  if (value) headers['X-Razorpay-Signature'] = value;
  const res = await fetch(`${BASE}/payments/razorpay/webhook`, { method: 'POST', headers, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  /* ======================================================= pure unit tests */

  section('unit — config');
  {
    const config = await razorpayService.getConfig();
    check('RAZORPAY_* env is read: enabled, test mode, source env',
      config.enabled === true && config.testMode === true && config.source === 'env' && config.keyId === KEY_ID, { ...config, keySecret: '…', webhookSecret: '…' });
    check('env.razorpay mirrors the plain env values',
      env.razorpay.keyId === KEY_ID && env.razorpay.enabled === true && env.razorpay.testMode === true
      && env.razorpay.keySecret === KEY_SECRET && env.razorpay.webhookSecret === WEBHOOK_SECRET);
    process.env.RAZORPAY_KEY_ID = 'rzp_live_UnitTestKey0001';
    check('a live key is not test mode — the only switch is the key itself', (await razorpayService.getConfig()).testMode === false);
    useEnvKeys();
  }

  section('unit — signatures');
  {
    const good = hmac('order_A|pay_B', KEY_SECRET);
    check('a genuine payment signature verifies',
      (await razorpayService.verifyPaymentSignature({ orderId: 'order_A', paymentId: 'pay_B', signature: good })) === true);
    check('the same signature for another order does not',
      (await razorpayService.verifyPaymentSignature({ orderId: 'order_X', paymentId: 'pay_B', signature: good })) === false);
    check('one signed with another secret does not',
      (await razorpayService.verifyPaymentSignature({ orderId: 'order_A', paymentId: 'pay_B', signature: hmac('order_A|pay_B', 'someone-else') })) === false);
    check('a missing or malformed signature is false, not a crash',
      (await razorpayService.verifyPaymentSignature({ orderId: 'order_A', paymentId: 'pay_B', signature: undefined })) === false
      && (await razorpayService.verifyPaymentSignature({ orderId: 'order_A', paymentId: 'pay_B', signature: 'abc' })) === false
      && (await razorpayService.verifyPaymentSignature({ orderId: 'order_A', paymentId: 'pay_B', signature: { length: 64 } })) === false);

    const raw = '{"event":"payment.captured"}';
    check('a genuine webhook signature verifies (string or Buffer body)',
      (await razorpayService.verifyWebhookSignature(raw, hmac(raw, WEBHOOK_SECRET))) === true
      && (await razorpayService.verifyWebhookSignature(Buffer.from(raw), hmac(raw, WEBHOOK_SECRET))) === true);
    check('a body changed by one byte does not', (await razorpayService.verifyWebhookSignature(`${raw} `, hmac(raw, WEBHOOK_SECRET))) === false);
    check('the key secret is not the webhook secret', (await razorpayService.verifyWebhookSignature(raw, hmac(raw, KEY_SECRET))) === false);
  }

  section('unit — routes are registered');
  {
    const routeFor = (router, path) => router.stack.find(layer => layer.route?.path === path)?.route;
    check('POST /wallet/topup/cancel exists', routeFor(walletRoutes, '/topup/cancel')?.methods.post === true);
    check('POST /wallet/topup/confirm runs a validator before the controller', (routeFor(walletRoutes, '/topup/confirm')?.stack.length ?? 0) >= 3);
    check('POST /payments/razorpay/webhook exists', routeFor(paymentRoutes, '/razorpay/webhook')?.methods.post === true);
  }

  /* ============================================================ integration */

  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await WalletTransaction.init();
  const server = createApp().listen(PORT);

  section('GET /settings says how a top-up is paid for');
  {
    const pub = await settingsService.publicSettings();
    check('payments: { gateway: "razorpay", enabled: true, testMode: true, keyId }',
      pub.payments?.gateway === 'razorpay' && pub.payments.enabled === true && pub.payments.testMode === true && pub.payments.keyId === KEY_ID, pub.payments);
    check('exact keys', Object.keys(pub.payments).sort().join(',') === 'enabled,gateway,keyId,testMode');
    const text = JSON.stringify(pub);
    check('the payload never carries a secret', !text.includes(KEY_SECRET) && !text.includes(WEBHOOK_SECRET));
  }

  section('startTopUp opens a Razorpay order');
  let seeker;
  {
    seeker = await makeUser();
    fake.calls.length = 0;
    const started = await walletService.startTopUp({ userId: seeker._id, amount: 100 });
    const [call] = callsTo('POST', /^\/v1\/orders$/);
    const row = await rowOf(started.transactionId);

    check('one call, to api.razorpay.com/v1/orders', fake.calls.length === 1 && call?.host === 'api.razorpay.com', fake.calls.map(c => `${c.method} ${c.host}${c.path}`));
    check('basic auth is keyId:keySecret', call?.authorization === basicAuth(KEY_ID, KEY_SECRET));
    check('amount is paise: ₹100 -> 10000, INR, auto-capture', call?.body.amount === 10000 && call.body.currency === 'INR' && call.body.payment_capture === 1, call?.body);
    check('receipt is the transaction reference', call?.body.receipt === started.reference && /^TXN-/.test(started.reference), call?.body.receipt);
    check('notes carry transactionId and userId',
      call?.body.notes?.transactionId === started.transactionId && call.body.notes.userId === String(seeker._id), call?.body.notes);

    check('response keeps every existing field',
      typeof started.transactionId === 'string' && started.reference === row.reference && started.amount === 100
      && started.couponCode === null && started.bonusAmount === 0, started);
    check('gateway is razorpay and orderId is the Razorpay order', started.gateway === 'razorpay' && /^order_/.test(started.orderId) && started.orderId === started.razorpay.orderId, started);
    check('razorpay block: keyId, orderId, paise amount, currency, name, description',
      started.razorpay.keyId === KEY_ID && started.razorpay.amount === 10000 && started.razorpay.currency === 'INR'
      && started.razorpay.name === 'Shree Astro' && started.razorpay.description === 'Wallet top-up', started.razorpay);
    check('prefill comes from the account',
      started.razorpay.prefill.name === seeker.name && started.razorpay.prefill.contact === `+91${seeker.phone.number}`
      && started.razorpay.prefill.email === seeker.email, started.razorpay.prefill);
    check('exact response keys', Object.keys(started).sort().join(',')
      === ['transactionId', 'reference', 'orderId', 'amount', 'couponCode', 'bonusAmount', 'gateway', 'razorpay'].sort().join(','), Object.keys(started));
    check('exact razorpay keys', Object.keys(started.razorpay).sort().join(',')
      === ['keyId', 'orderId', 'amount', 'currency', 'name', 'description', 'prefill'].sort().join(','), Object.keys(started.razorpay));
    check('the response never carries the secret', !JSON.stringify(started).includes(KEY_SECRET));

    check('the row is pending, gateway razorpay, and remembers the order id',
      row.status === 'pending' && row.payment.gateway === 'razorpay' && row.payment.orderId === started.orderId, row.payment);
    check('nothing is credited yet', (await balanceOf(seeker._id)) === 0);

    const bare = await makeUser({ email: undefined, name: undefined });
    const bareStart = await walletService.startTopUp({ userId: bare._id, amount: 100 });
    check('prefill omits what the account does not have',
      Object.keys(bareStart.razorpay.prefill).join(',') === 'contact', bareStart.razorpay.prefill);

    const tooSmall = await errorOf(() => walletService.startTopUp({ userId: seeker._id, amount: 1 }));
    const ordersBefore = callsTo('POST', /^\/v1\/orders$/).length;
    check('the limits still apply, before any order is opened', tooSmall?.status === 400 && callsTo('POST', /^\/v1\/orders$/).length === ordersBefore, brief(tooSmall));
  }

  section('Razorpay refuses the order -> 502, and the row is closed');
  {
    const user = await makeUser();
    fake.nextOrderError = 'Order amount less than minimum amount allowed';
    const refused = await errorOf(() => walletService.startTopUp({ userId: user._id, amount: 100 }));
    check('502 payment_gateway_error', refused?.status === 502 && refused.code === 'payment_gateway_error', brief(refused));
    check("with Razorpay's own description", refused?.message === 'Order amount less than minimum amount allowed', refused?.message);
    const rows = await WalletTransaction.find({ owner: user._id });
    check('the row is failed, with the reason', rows.length === 1 && rows[0].status === 'failed'
      && rows[0].payment.failureReason === 'Order amount less than minimum amount allowed', rows.map(r => [r.status, r.payment.failureReason]));

    razorpayService.setHttp(async () => { throw new Error('getaddrinfo ENOTFOUND api.razorpay.com'); });
    const unreachable = await errorOf(() => walletService.startTopUp({ userId: user._id, amount: 100 }));
    razorpayService.setHttp(fakeHttp);
    check('an unreachable gateway is a 502 too, without the internal reason',
      unreachable?.status === 502 && unreachable.code === 'payment_gateway_error' && !/ENOTFOUND/.test(unreachable.message), brief(unreachable));
    check('nothing was credited', (await balanceOf(user._id)) === 0);
  }

  section('confirmTopUp with a valid signature credits once');
  {
    const user = await makeUser();
    const started = await walletService.startTopUp({ userId: user._id, amount: 250 });
    const paid = pay(started.orderId, { method: 'upi' });

    fake.calls.length = 0;
    const confirmed = await walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...paid });
    check('the row is success', confirmed.status === 'success', confirmed.status);
    check('the wallet is credited, and totalAdded with it', (await balanceOf(user._id)) === 250 && (await walletOf(user._id)).totalAdded === 250);
    check('balanceAfter is the new balance', confirmed.balanceAfter === 250, confirmed.balanceAfter);
    check('payment id and Razorpay\'s method are recorded',
      confirmed.payment.paymentId === paid.razorpayPaymentId && confirmed.payment.method === 'upi', confirmed.payment);
    check('the payment was read back from Razorpay, not taken on trust',
      callsTo('GET', new RegExp(`^/v1/payments/${paid.razorpayPaymentId}$`)).length === 1);
    check('an already-captured payment is not captured again', callsTo('POST', /\/capture$/).length === 0);

    const again = await walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...paid });
    check('a repeat confirm hands back the successful row', again.status === 'success' && String(again._id) === started.transactionId);
    check('and does not credit twice', (await balanceOf(user._id)) === 250 && (await creditRows(user._id)) === 1);

    const bareAgain = await walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId });
    check('nor does a repeat with no payment details', bareAgain.status === 'success' && (await balanceOf(user._id)) === 250);
  }

  section('three confirms at the same moment credit once');
  {
    const user = await makeUser();
    const started = await walletService.startTopUp({ userId: user._id, amount: 300 });
    const paid = pay(started.orderId);
    const results = await Promise.all([1, 2, 3].map(() =>
      walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...paid })));
    check('all three see a successful row', results.every(row => row.status === 'success'), results.map(r => r.status));
    check('the wallet holds exactly one credit', (await balanceOf(user._id)) === 300 && (await walletOf(user._id)).totalAdded === 300, await walletOf(user._id));
  }

  section('what is refused, and that nothing is credited');
  {
    const user = await makeUser();
    const other = await makeUser();
    const started = await walletService.startTopUp({ userId: user._id, amount: 400 });
    const confirm = extra => errorOf(() => walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...extra }));

    const paid = pay(started.orderId);
    const wrong = await confirm({ ...paid, razorpaySignature: hmac(`${paid.razorpayOrderId}|${paid.razorpayPaymentId}`, 'not-the-secret') });
    check('wrong signature -> 400 payment_signature_invalid', wrong?.status === 400 && wrong.code === 'payment_signature_invalid', brief(wrong));

    const tampered = await confirm({ ...paid, razorpaySignature: `${paid.razorpaySignature.slice(0, -1)}${paid.razorpaySignature.endsWith('0') ? '1' : '0'}` });
    check('a signature one character off -> the same', tampered?.code === 'payment_signature_invalid');

    const missing = await confirm({});
    check('no payment details at all -> 400 payment_signature_invalid, naming the fields',
      missing?.status === 400 && missing.code === 'payment_signature_invalid' && Boolean(missing.fields?.razorpaySignature), brief(missing));

    /** A perfectly genuine payment — for a different (cheaper) order of someone else's. */
    const theirs = await walletService.startTopUp({ userId: other._id, amount: 100 });
    const theirPayment = pay(theirs.orderId);
    const borrowed = await confirm(theirPayment);
    check("someone else's order id, validly signed -> 400 payment_signature_invalid",
      borrowed?.status === 400 && borrowed.code === 'payment_signature_invalid', brief(borrowed));
    const relabelled = await confirm({ ...theirPayment, razorpayOrderId: started.orderId });
    check('their payment relabelled as this order -> the signature no longer fits', relabelled?.code === 'payment_signature_invalid');

    const notMine = await errorOf(() => walletService.confirmTopUp({ userId: other._id, transactionId: started.transactionId, ...paid }));
    check("confirming another seeker's top-up -> 404", notMine?.status === 404, brief(notMine));

    const short = pay(started.orderId, { amount: 100 });
    const mismatch = await confirm(short);
    check('amount mismatch (₹1 paid for a ₹400 top-up) -> 400 payment_not_captured',
      mismatch?.status === 400 && mismatch.code === 'payment_not_captured', brief(mismatch));

    for (const status of ['created', 'failed', 'refunded']) {
      const attempt = pay(started.orderId, { status });
      const refused = await confirm(attempt);
      check(`a payment that is "${status}" -> 400 payment_not_captured`, refused?.status === 400 && refused.code === 'payment_not_captured', brief(refused));
    }

    /** Validly signed for this order, but Razorpay says the payment belongs to another one. */
    const stray = pay(started.orderId);
    stray.payment.order_id = theirs.orderId;
    const strayRefused = await confirm(stray);
    check('a payment Razorpay files under another order -> 400 payment_not_captured', strayRefused?.code === 'payment_not_captured', brief(strayRefused));

    const ghost = await confirm({
      razorpayPaymentId: 'pay_DoesNotExist', razorpayOrderId: started.orderId,
      razorpaySignature: hmac(`${started.orderId}|pay_DoesNotExist`, KEY_SECRET),
    });
    check('a payment Razorpay has never heard of -> 502, not a credit', ghost?.status === 502 && ghost.code === 'payment_gateway_error', brief(ghost));

    check('after all of that the row is still pending', (await rowOf(started.transactionId)).status === 'pending');
    check('and nothing was credited to either wallet', (await balanceOf(user._id)) === 0 && (await balanceOf(other._id)) === 0);

    const honest = await walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...paid });
    check('the genuine payment still goes through afterwards', honest.status === 'success' && (await balanceOf(user._id)) === 400);
  }

  section('an authorized payment is captured, then credited');
  {
    const user = await makeUser();
    const started = await walletService.startTopUp({ userId: user._id, amount: 500 });
    const paid = pay(started.orderId, { status: 'authorized', method: 'card' });
    fake.calls.length = 0;
    const confirmed = await walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...paid });
    const [capture] = callsTo('POST', /\/capture$/);
    check('POST /v1/payments/:id/capture was called', capture?.path === `/v1/payments/${paid.razorpayPaymentId}/capture`, fake.calls.map(c => `${c.method} ${c.path}`));
    check('for the full amount in paise', capture?.body.amount === 50000 && capture.body.currency === 'INR', capture?.body);
    check('and the wallet is credited', confirmed.status === 'success' && (await balanceOf(user._id)) === 500 && confirmed.payment.method === 'card');

    /** Razorpay's own auto-capture wins the race: our capture is refused, but the payment is captured. */
    const racer = await makeUser();
    const raced = await walletService.startTopUp({ userId: racer._id, amount: 500 });
    const racedPayment = pay(raced.orderId, { status: 'authorized' });
    razorpayService.setHttp(async (url, init = {}) => {
      if (init.method === 'POST' && /\/capture$/.test(new URL(url).pathname)) {
        racedPayment.payment.status = 'captured';
        return refusal('This payment has already been captured');
      }
      return fakeHttp(url, init);
    });
    const racedConfirm = await walletService.confirmTopUp({ userId: racer._id, transactionId: raced.transactionId, ...racedPayment });
    razorpayService.setHttp(fakeHttp);
    check('a capture refused because it was already captured still credits', racedConfirm.status === 'success' && (await balanceOf(racer._id)) === 500);

    /** …and one that really cannot be captured does not. */
    const stuck = await makeUser();
    const stuckStart = await walletService.startTopUp({ userId: stuck._id, amount: 500 });
    const stuckPayment = pay(stuckStart.orderId, { status: 'authorized' });
    razorpayService.setHttp(async (url, init = {}) =>
      (init.method === 'POST' && /\/capture$/.test(new URL(url).pathname) ? refusal('Capture failed') : fakeHttp(url, init)));
    const stuckError = await errorOf(() => walletService.confirmTopUp({ userId: stuck._id, transactionId: stuckStart.transactionId, ...stuckPayment }));
    razorpayService.setHttp(fakeHttp);
    check('a capture that fails -> 400 payment_not_captured, nothing credited',
      stuckError?.code === 'payment_not_captured' && (await balanceOf(stuck._id)) === 0, brief(stuckError));
  }

  section('a coupon bonus still pays on a verified top-up');
  {
    await Coupon.create({ code: 'RZPBONUS10', title: 'Top-up bonus', kind: 'percent', value: 10, appliesTo: ['topup'], perUserLimit: 1 });
    const user = await makeUser();
    const started = await walletService.startTopUp({ userId: user._id, amount: 1000, couponCode: 'rzpbonus10' });
    check('start promises the bonus and still charges the full amount',
      started.couponCode === 'RZPBONUS10' && started.bonusAmount === 100 && started.razorpay.amount === 100000, started);

    const unpaid = await errorOf(() => walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId }));
    check('no bonus (and no credit) without a verified payment', unpaid?.code === 'payment_signature_invalid' && (await balanceOf(user._id)) === 0);

    const paid = pay(started.orderId);
    const confirmed = await walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...paid });
    check('the wallet gets the top-up and the bonus', (await balanceOf(user._id)) === 1100, await balanceOf(user._id));
    const bonusRow = await WalletTransaction.findOne({ owner: user._id, type: 'bonus' });
    check('as a second ledger row', bonusRow?.amount === 100 && /RZPBONUS10/.test(bonusRow.title) && String(confirmed.coupon.bonusTransaction) === String(bonusRow._id));
    await walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...paid });
    check('a repeat confirm pays neither twice', (await balanceOf(user._id)) === 1100 && (await creditRows(user._id)) === 2);

    const bad = await errorOf(() => walletService.startTopUp({ userId: user._id, amount: 1000, couponCode: 'NOSUCHCODE' }));
    const ordersBefore = callsTo('POST', /^\/v1\/orders$/).length;
    check('a bad code is refused before any order is opened', bad?.code === 'coupon_invalid' && callsTo('POST', /^\/v1\/orders$/).length === ordersBefore, brief(bad));
  }

  section('cancelTopUp');
  {
    const user = await makeUser();
    const other = await makeUser();
    const started = await walletService.startTopUp({ userId: user._id, amount: 200 });

    const stranger = await walletService.cancelTopUp({ userId: other._id, transactionId: started.transactionId, reason: 'not mine' });
    check("another seeker cannot cancel it — they are told nothing", stranger.cancelled === false && stranger.transaction === null
      && (await rowOf(started.transactionId)).status === 'pending');

    const cancelled = await walletService.cancelTopUp({ userId: user._id, transactionId: started.transactionId, reason: 'Checkout dismissed' });
    check('a pending row becomes failed, with the reason',
      cancelled.cancelled === true && cancelled.transaction.status === 'failed' && cancelled.transaction.payment.failureReason === 'Checkout dismissed', cancelled.transaction?.payment);
    const twice = await walletService.cancelTopUp({ userId: user._id, transactionId: started.transactionId, reason: 'again' });
    check('cancelling again changes nothing', twice.cancelled === false && twice.transaction.status === 'failed'
      && twice.transaction.payment.failureReason === 'Checkout dismissed');
    check('nothing was credited', (await balanceOf(user._id)) === 0);

    const noReason = await walletService.startTopUp({ userId: user._id, amount: 200 });
    const plain = await walletService.cancelTopUp({ userId: user._id, transactionId: noReason.transactionId });
    check('no reason given still records one', plain.transaction.payment.failureReason === 'Payment cancelled.', plain.transaction.payment.failureReason);

    const unknown = await walletService.cancelTopUp({ userId: user._id, transactionId: new mongoose.Types.ObjectId() });
    check('an unknown top-up is not an error', unknown.cancelled === false && unknown.transaction === null);

    const done = await walletService.startTopUp({ userId: user._id, amount: 200 });
    await walletService.confirmTopUp({ userId: user._id, transactionId: done.transactionId, ...pay(done.orderId) });
    const late = await walletService.cancelTopUp({ userId: user._id, transactionId: done.transactionId, reason: 'too late' });
    const doneRow = await rowOf(done.transactionId);
    check('a successful top-up is left alone', late.cancelled === false && late.transaction.status === 'success'
      && doneRow.status === 'success' && !doneRow.payment.failureReason && (await balanceOf(user._id)) === 200);
  }

  section('money taken after a cancel still reaches the wallet — once');
  {
    /** Checkout dismissed, then the app comes back with a genuine, captured payment. */
    const user = await makeUser();
    const started = await walletService.startTopUp({ userId: user._id, amount: 350 });
    await walletService.cancelTopUp({ userId: user._id, transactionId: started.transactionId, reason: 'Checkout dismissed' });
    const paid = pay(started.orderId);

    const forged = await errorOf(() => walletService.confirmTopUp({
      userId: user._id, transactionId: started.transactionId, ...paid, razorpaySignature: 'f'.repeat(64),
    }));
    check('a cancelled row is no easier to forge', forged?.code === 'payment_signature_invalid' && (await balanceOf(user._id)) === 0);

    const confirmed = await walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...paid });
    check('cancel -> confirm with a valid signature + captured payment: credited',
      confirmed.status === 'success' && (await balanceOf(user._id)) === 350, confirmed.status);
    check('the failure reason is cleared', !(await rowOf(started.transactionId)).payment.failureReason);
    await walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...paid });
    const replay = await postWebhook(webhookBody('payment.captured', { payment: paid.payment }));
    check('once — a repeat confirm and a late webhook add nothing',
      replay.status === 200 && (await balanceOf(user._id)) === 350 && (await creditRows(user._id)) === 1);

    /** Checkout dismissed, then the UPI request is approved: only Razorpay tells us. */
    const upi = await makeUser();
    const upiStart = await walletService.startTopUp({ userId: upi._id, amount: 350 });
    await walletService.cancelTopUp({ userId: upi._id, transactionId: upiStart.transactionId, reason: 'Checkout dismissed' });
    const upiPayment = pay(upiStart.orderId);
    const hook = await postWebhook(webhookBody('payment.captured', { payment: upiPayment.payment }));
    const upiRow = await rowOf(upiStart.transactionId);
    check('cancel -> payment.captured webhook: credited',
      hook.status === 200 && hook.body.ok === true && !hook.body.ignored && upiRow.status === 'success' && (await balanceOf(upi._id)) === 350, hook.body);
    check('with the failure reason cleared and the payment recorded', !upiRow.payment.failureReason && upiRow.payment.paymentId === upiPayment.razorpayPaymentId);
    await postWebhook(webhookBody('order.paid', { payment: upiPayment.payment, order: { ...fake.orders.get(upiStart.orderId), amount_paid: 35000, status: 'paid' } }));
    await walletService.confirmTopUp({ userId: upi._id, transactionId: upiStart.transactionId, ...upiPayment });
    check('once — order.paid and the app confirm that follow add nothing', (await balanceOf(upi._id)) === 350 && (await creditRows(upi._id)) === 1);
    const lateCancel = await walletService.cancelTopUp({ userId: upi._id, transactionId: upiStart.transactionId, reason: 'late' });
    check('and a cancel arriving after the money cannot undo it', lateCancel.cancelled === false && (await rowOf(upiStart.transactionId)).status === 'success');

    /** Checkout dismissed, and the payment really did fail. */
    const failed = await makeUser();
    const failedStart = await walletService.startTopUp({ userId: failed._id, amount: 350 });
    await walletService.cancelTopUp({ userId: failed._id, transactionId: failedStart.transactionId, reason: 'Checkout dismissed' });
    const failedPayment = pay(failedStart.orderId, { status: 'failed' });
    const failedHook = await postWebhook(webhookBody('payment.failed', {
      payment: { ...failedPayment.payment, error_description: 'Payment was declined by the bank' },
    }));
    const failedRow = await rowOf(failedStart.transactionId);
    check('cancel -> payment.failed webhook: stays failed, nothing credited',
      failedHook.status === 200 && failedRow.status === 'failed' && (await balanceOf(failed._id)) === 0, failedHook.body);
    check('and keeps the reason it was closed with', failedRow.payment.failureReason === 'Checkout dismissed', failedRow.payment.failureReason);
  }

  section('the webhook');
  {
    /* ---- webhook first, app confirm after ---- */
    const user = await makeUser();
    const started = await walletService.startTopUp({ userId: user._id, amount: 600 });
    const paid = pay(started.orderId, { method: 'netbanking' });
    resumedFor.length = 0;

    const raw = webhookBody('payment.captured', { payment: paid.payment });
    const bad = await postWebhook(raw, { signature: hmac(raw, 'not-the-webhook-secret') });
    check('bad signature -> 400', bad.status === 400 && bad.body.code === 'webhook_signature_invalid', bad);
    const none = await postWebhook(raw, { signature: null });
    check('missing signature -> 400', none.status === 400, none);
    const resigned = await postWebhook(raw.replace('"amount":60000', '"amount":60000 '), { signature: hmac(raw, WEBHOOK_SECRET) });
    check('a body altered after signing -> 400', resigned.status === 400, resigned);
    check('none of those credited anything', (await balanceOf(user._id)) === 0 && (await rowOf(started.transactionId)).status === 'pending');

    const good = await postWebhook(raw);
    const row = await rowOf(started.transactionId);
    check('good signature -> 200 { ok: true }', good.status === 200 && good.body.ok === true && good.body.ignored === undefined, good);
    check('and the wallet is credited', row.status === 'success' && (await balanceOf(user._id)) === 600 && row.balanceAfter === 600);
    check('with the payment id and method from the event', row.payment.paymentId === paid.razorpayPaymentId && row.payment.method === 'netbanking', row.payment);
    check('paused chats are woken for that seeker', resumedFor.join(',') === String(user._id), resumedFor);

    const resent = await postWebhook(raw);
    check('Razorpay re-sending it is a 200 that credits nothing', resent.status === 200 && (await balanceOf(user._id)) === 600);
    const appAfter = await walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...paid });
    check('the app confirming afterwards gets the successful row and credits nothing',
      appAfter.status === 'success' && (await balanceOf(user._id)) === 600 && (await creditRows(user._id)) === 1);

    /* ---- app confirm first, webhook after ---- */
    const second = await makeUser();
    const secondStart = await walletService.startTopUp({ userId: second._id, amount: 600 });
    const secondPaid = pay(secondStart.orderId);
    await walletService.confirmTopUp({ userId: second._id, transactionId: secondStart.transactionId, ...secondPaid });
    resumedFor.length = 0;
    const after = await postWebhook(webhookBody('payment.captured', { payment: secondPaid.payment }));
    check('the other order: confirm, then the webhook -> 200, still one credit',
      after.status === 200 && after.body.ok === true && (await balanceOf(second._id)) === 600 && (await creditRows(second._id)) === 1, after);
    check('a webhook that credited nothing wakes nothing', resumedFor.length === 0, resumedFor);

    /* ---- both at the same moment ---- */
    const third = await makeUser();
    const thirdStart = await walletService.startTopUp({ userId: third._id, amount: 600 });
    const thirdPaid = pay(thirdStart.orderId);
    const [hookResult, confirmResult] = await Promise.all([
      postWebhook(webhookBody('payment.captured', { payment: thirdPaid.payment })),
      walletService.confirmTopUp({ userId: third._id, transactionId: thirdStart.transactionId, ...thirdPaid }),
    ]);
    check('webhook and confirm racing: both succeed, one credit',
      hookResult.status === 200 && confirmResult.status === 'success' && (await balanceOf(third._id)) === 600 && (await creditRows(third._id)) === 1,
      { hook: hookResult, balance: await balanceOf(third._id) });

    /* ---- order.paid on its own ---- */
    const fourth = await makeUser();
    const fourthStart = await walletService.startTopUp({ userId: fourth._id, amount: 150 });
    const fourthPaid = pay(fourthStart.orderId, { method: 'wallet' });
    const paidOrder = { ...fake.orders.get(fourthStart.orderId), amount_paid: 15000, status: 'paid' };
    const orderPaid = await postWebhook(webhookBody('order.paid', { payment: fourthPaid.payment, order: paidOrder }));
    check('order.paid credits too', orderPaid.status === 200 && (await balanceOf(fourth._id)) === 150
      && (await rowOf(fourthStart.transactionId)).payment.method === 'wallet', orderPaid);

    /* ---- what is ignored ---- */
    const fifth = await makeUser();
    const fifthStart = await walletService.startTopUp({ userId: fifth._id, amount: 700 });
    const underpaid = pay(fifthStart.orderId, { amount: 100 });
    const cheap = await postWebhook(webhookBody('payment.captured', { payment: underpaid.payment }));
    check('an amount that is not the row\'s -> 200 ignored, nothing credited',
      cheap.status === 200 && cheap.body.ignored === true && (await balanceOf(fifth._id)) === 0 && (await rowOf(fifthStart.transactionId)).status === 'pending', cheap);

    const authorizedOnly = pay(fifthStart.orderId, { status: 'authorized' });
    const early = await postWebhook(webhookBody('payment.authorized', { payment: authorizedOnly.payment }));
    check('an event we do not act on -> 200 { ok: true, ignored: true }', early.status === 200 && early.body.ok === true && early.body.ignored === true, early);
    const refund = await postWebhook(webhookBody('refund.created', {}));
    check('an event with no payment in it -> ignored', refund.status === 200 && refund.body.ignored === true, refund);

    const foreign = await postWebhook(webhookBody('payment.captured', {
      payment: { id: 'pay_Foreign', entity: 'payment', order_id: 'order_NotOurs', amount: 70000, currency: 'INR', status: 'captured', method: 'upi' },
    }));
    check('an order that is not ours -> 200 ignored', foreign.status === 200 && foreign.body.ignored === true, foreign);
    check('none of the ignored events credited anything', (await balanceOf(fifth._id)) === 0);

    /* ---- payment.failed, and a second attempt on the same order ---- */
    const declined = pay(fifthStart.orderId, { status: 'failed', method: 'card' });
    const failedHook = await postWebhook(webhookBody('payment.failed', {
      payment: { ...declined.payment, error_code: 'BAD_REQUEST_ERROR', error_description: 'Your payment was declined by the bank' },
    }));
    const failedRow = await rowOf(fifthStart.transactionId);
    check('payment.failed marks the pending row failed, with Razorpay\'s reason',
      failedHook.status === 200 && failedHook.body.ok === true && !failedHook.body.ignored && failedRow.status === 'failed'
      && failedRow.payment.failureReason === 'Your payment was declined by the bank' && (await balanceOf(fifth._id)) === 0, failedRow.payment);

    const retry = pay(fifthStart.orderId);
    const retried = await postWebhook(webhookBody('payment.captured', { payment: retry.payment }));
    check('a second attempt on the same order that is captured still credits — once',
      retried.status === 200 && (await rowOf(fifthStart.transactionId)).status === 'success' && (await balanceOf(fifth._id)) === 700 && (await creditRows(fifth._id)) === 1);
    const lateFailure = await postWebhook(webhookBody('payment.failed', { payment: declined.payment }));
    check('a payment.failed arriving after success changes nothing',
      lateFailure.status === 200 && (await rowOf(fifthStart.transactionId)).status === 'success' && (await balanceOf(fifth._id)) === 700);

    /* ---- no webhook secret ---- */
    process.env.RAZORPAY_WEBHOOK_SECRET = '';
    const sixth = await makeUser();
    const sixthStart = await walletService.startTopUp({ userId: sixth._id, amount: 150 });
    const sixthPaid = pay(sixthStart.orderId);
    const sixthRaw = webhookBody('payment.captured', { payment: sixthPaid.payment });
    const unconfigured = await postWebhook(sixthRaw, { signature: hmac(sixthRaw, '') });
    check('no webhook secret -> 503 webhook_unconfigured, nothing credited',
      unconfigured.status === 503 && unconfigured.body.code === 'webhook_unconfigured' && (await balanceOf(sixth._id)) === 0, unconfigured);
    useEnvKeys();
  }

  section('over HTTP: start, confirm (both spellings), cancel');
  {
    const user = await makeUser();
    const caller = api(user);

    const started = await caller('POST', '/wallet/topup', { amount: 120 });
    check('POST /wallet/topup -> 201 with the razorpay block',
      started.status === 201 && started.body.gateway === 'razorpay' && started.body.razorpay?.amount === 12000 && started.body.razorpay.keyId === KEY_ID, started);

    const paid = pay(started.body.orderId);
    resumedFor.length = 0;
    const confirmed = await caller('POST', '/wallet/topup/confirm', {
      transactionId: started.body.transactionId,
      razorpay_payment_id: paid.razorpayPaymentId,
      razorpay_order_id: paid.razorpayOrderId,
      razorpay_signature: paid.razorpaySignature,
    });
    check("confirm accepts Razorpay's own snake_case names",
      confirmed.status === 200 && confirmed.body.transaction?.status === 'success' && confirmed.body.transaction.balanceAfter === 120, confirmed);
    check('the confirm response shape is unchanged', Object.keys(confirmed.body.transaction).sort().join(',')
      === ['id', 'reference', 'amount', 'balanceAfter', 'status', 'method', 'couponCode', 'bonusAmount'].sort().join(','), confirmed.body.transaction);
    check('and reports how it was paid', confirmed.body.transaction.method === 'upi');
    check('paused chats are woken', resumedFor.join(',') === String(user._id), resumedFor);

    const second = await caller('POST', '/wallet/topup', { amount: 120 });
    const secondPaid = pay(second.body.orderId);
    const camel = await caller('POST', '/wallet/topup/confirm', { transactionId: second.body.transactionId, ...secondPaid, payment: undefined });
    check('and the camelCase names', camel.status === 200 && camel.body.transaction?.balanceAfter === 240, camel);

    const third = await caller('POST', '/wallet/topup', { amount: 120 });
    const forged = await caller('POST', '/wallet/topup/confirm', {
      transactionId: third.body.transactionId,
      razorpay_payment_id: 'pay_Forged', razorpay_order_id: third.body.orderId, razorpay_signature: 'a'.repeat(64),
    });
    check('a forged signature -> 400 payment_signature_invalid', forged.status === 400 && forged.body.code === 'payment_signature_invalid', forged);
    const oldStyle = await caller('POST', '/wallet/topup/confirm', { transactionId: third.body.transactionId, paymentId: 'pay_just_trust_me' });
    check('the old gateway-less confirm body credits nothing on a Razorpay row',
      oldStyle.status === 400 && oldStyle.body.code === 'payment_signature_invalid' && (await balanceOf(user._id)) === 240, oldStyle);

    const cancelled = await caller('POST', '/wallet/topup/cancel', { transactionId: third.body.transactionId, reason: 'Checkout dismissed' });
    check('POST /wallet/topup/cancel -> 200 { ok, cancelled: true, transaction }',
      cancelled.status === 200 && cancelled.body.ok === true && cancelled.body.cancelled === true
      && cancelled.body.transaction?.status === 'failed' && cancelled.body.transaction.failureReason === 'Checkout dismissed', cancelled);
    const cancelledAgain = await caller('POST', '/wallet/topup/cancel', { transactionId: third.body.transactionId });
    check('again -> 200, cancelled: false', cancelledAgain.status === 200 && cancelledAgain.body.cancelled === false && cancelledAgain.body.transaction?.status === 'failed', cancelledAgain);
    const cancelDone = await caller('POST', '/wallet/topup/cancel', { transactionId: started.body.transactionId, reason: 'x' });
    check('a finished top-up -> 200, untouched', cancelDone.status === 200 && cancelDone.body.cancelled === false && cancelDone.body.transaction?.status === 'success', cancelDone);
    const cancelUnknown = await caller('POST', '/wallet/topup/cancel', { transactionId: String(new mongoose.Types.ObjectId()), reason: 'x' });
    check('an unknown top-up -> 200, transaction: null', cancelUnknown.status === 200 && cancelUnknown.body.ok === true && cancelUnknown.body.transaction === null, cancelUnknown);
    const cancelGarbage = await caller('POST', '/wallet/topup/cancel', { transactionId: 'not-an-id' });
    check('a malformed id is a 422, not a 500', cancelGarbage.status === 422, cancelGarbage);
    const confirmGarbage = await caller('POST', '/wallet/topup/confirm', { transactionId: 'not-an-id' });
    check('same for confirm', confirmGarbage.status === 422, confirmGarbage);

    const anonymous = await fetch(`${BASE}/wallet/topup/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('cancel needs a signed-in seeker', anonymous.status === 401, anonymous.status);
    check('the wallet holds exactly the two verified top-ups', (await balanceOf(user._id)) === 240);
  }

  section('configured on the admin panel only (no RAZORPAY_* env)');
  {
    clearEnvKeys();
    usePanelKeys({ enabled: true });

    const config = await razorpayService.getConfig();
    check('getConfig: the enabled integration is the source',
      config.enabled === true && config.source === 'integration' && config.keyId === PANEL_KEY_ID && config.testMode === true, { ...config, keySecret: '…', webhookSecret: '…' });
    const pub = await settingsService.publicSettings();
    check('GET /settings shows the panel\'s key id, never its secrets',
      pub.payments.gateway === 'razorpay' && pub.payments.keyId === PANEL_KEY_ID
      && !JSON.stringify(pub).includes(PANEL_KEY_SECRET) && !JSON.stringify(pub).includes(PANEL_WEBHOOK_SECRET), pub.payments);

    const user = await makeUser();
    fake.calls.length = 0;
    const started = await walletService.startTopUp({ userId: user._id, amount: 180 });
    check('a top-up starts, with the panel\'s keys on the wire',
      started.gateway === 'razorpay' && started.razorpay.keyId === PANEL_KEY_ID
      && callsTo('POST', /^\/v1\/orders$/)[0]?.authorization === basicAuth(PANEL_KEY_ID, PANEL_KEY_SECRET), started);

    const signedWithEnvSecret = pay(started.orderId, { secret: KEY_SECRET });
    const stale = await errorOf(() => walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...signedWithEnvSecret }));
    check('a signature under the (now unused) env secret is refused', stale?.code === 'payment_signature_invalid', brief(stale));

    const paid = pay(started.orderId, { secret: PANEL_KEY_SECRET });
    const confirmed = await walletService.confirmTopUp({ userId: user._id, transactionId: started.transactionId, ...paid });
    check('and one under the panel\'s secret credits', confirmed.status === 'success' && (await balanceOf(user._id)) === 180);

    const hooked = await makeUser();
    const hookedStart = await walletService.startTopUp({ userId: hooked._id, amount: 180 });
    const hookedPaid = pay(hookedStart.orderId, { secret: PANEL_KEY_SECRET });
    const raw = webhookBody('payment.captured', { payment: hookedPaid.payment });
    const wrongSecret = await postWebhook(raw, { secret: WEBHOOK_SECRET });
    const rightSecret = await postWebhook(raw, { secret: PANEL_WEBHOOK_SECRET });
    check('the webhook is verified with the panel\'s webhook secret',
      wrongSecret.status === 400 && rightSecret.status === 200 && (await balanceOf(hooked._id)) === 180, { wrongSecret, rightSecret });

    /* ---- both configured: the panel wins ---- */
    useEnvKeys();
    const both = await razorpayService.getConfig();
    check('panel and env both set: the panel wins, whole', both.source === 'integration' && both.keyId === PANEL_KEY_ID
      && both.keySecret === PANEL_KEY_SECRET && both.webhookSecret === PANEL_WEBHOOK_SECRET);

    process.env.INTEGRATION_RAZORPAY_KEY_SECRET = '';
    const half = await razorpayService.getConfig();
    check('a panel entry with no key secret is not usable: env is the fallback', half.source === 'env' && half.keyId === KEY_ID && half.keySecret === KEY_SECRET);

    /* ---- saved on the panel, but switched off ---- */
    usePanelKeys({ enabled: false });
    const disabled = await razorpayService.getConfig();
    check('panel disabled, env set: env is used', disabled.source === 'env' && disabled.keyId === KEY_ID);

    clearEnvKeys();
    const off = await razorpayService.getConfig();
    check('panel disabled and no env: no gateway', off.enabled === false && off.source === 'none' && off.keyId === '' && off.keySecret === '', { ...off });
    const offSettings = await settingsService.publicSettings();
    check('GET /settings says so: { gateway: "none", enabled: false, testMode: false }',
      offSettings.payments.gateway === 'none' && offSettings.payments.enabled === false && offSettings.payments.testMode === false
      && offSettings.payments.keyId === undefined, offSettings.payments);

    env.isProduction = true;
    env.allowUnverifiedTopUps = false;
    const refused = await errorOf(() => walletService.startTopUp({ userId: user._id, amount: 180 }));
    env.isProduction = false;
    check('in production that is 503 payments_unavailable', refused?.status === 503 && refused.code === 'payments_unavailable', brief(refused));

    clearPanelKeys();
    useEnvKeys();
  }

  section('the production guard, with and without a gateway');
  {
    const user = await makeUser();

    /** A gateway-less row opened in development, before any of this. */
    clearEnvKeys();
    fake.calls.length = 0;
    const unverified = await walletService.startTopUp({ userId: user._id, amount: 900 });
    check('development, no gateway: exactly the old response',
      unverified.gateway === 'none' && /^ORD-/.test(unverified.orderId) && unverified.razorpay === undefined
      && Object.keys(unverified).sort().join(',') === ['transactionId', 'reference', 'orderId', 'amount', 'couponCode', 'bonusAmount', 'gateway'].sort().join(','), unverified);
    check('and Razorpay is never called', fake.calls.length === 0);
    const devOther = await walletService.startTopUp({ userId: user._id, amount: 110 });
    const devConfirmed = await walletService.confirmTopUp({ userId: user._id, transactionId: devOther.transactionId, paymentId: 'pay_dev', method: 'upi' });
    check('development, no gateway: confirm still credits on the caller\'s word',
      devConfirmed.status === 'success' && devConfirmed.balanceAfter === 110 && devConfirmed.payment.method === 'upi' && (await balanceOf(user._id)) === 110);
    await walletService.confirmTopUp({ userId: user._id, transactionId: devOther.transactionId });
    check('…once', (await balanceOf(user._id)) === 110);
    const devCancel = await walletService.startTopUp({ userId: user._id, amount: 110 });
    await walletService.cancelTopUp({ userId: user._id, transactionId: devCancel.transactionId, reason: 'changed my mind' });
    const revived = await errorOf(() => walletService.confirmTopUp({ userId: user._id, transactionId: devCancel.transactionId }));
    check('a cancelled gateway-less row cannot be confirmed (pending-only)', revived?.status === 400 && (await balanceOf(user._id)) === 110, brief(revived));

    env.isProduction = true;
    env.allowUnverifiedTopUps = false;

    const closed = await errorOf(() => walletService.startTopUp({ userId: user._id, amount: 200 }));
    check('production + no gateway -> 503 payments_unavailable', closed?.status === 503 && closed.code === 'payments_unavailable', brief(closed));

    useEnvKeys();
    const open = await walletService.startTopUp({ userId: user._id, amount: 200 });
    check('production + Razorpay -> allowed, through the gateway', open.gateway === 'razorpay' && Boolean(open.razorpay?.orderId), open);
    const paid = pay(open.orderId);
    const confirmed = await walletService.confirmTopUp({ userId: user._id, transactionId: open.transactionId, ...paid });
    check('and a verified payment credits', confirmed.status === 'success' && (await balanceOf(user._id)) === 310, await balanceOf(user._id));

    const cashIn = await errorOf(() => walletService.confirmTopUp({ userId: user._id, transactionId: unverified.transactionId, paymentId: 'pay_anything' }));
    check('production + Razorpay: an old gateway-less row still cannot be cashed in',
      cashIn?.status === 503 && cashIn.code === 'payments_unavailable' && (await balanceOf(user._id)) === 310, brief(cashIn));
    const cashInSigned = await errorOf(() => walletService.confirmTopUp({ userId: user._id, transactionId: unverified.transactionId, ...paid }));
    check('not even with a genuine signature for some other order', cashInSigned?.status === 503 && (await balanceOf(user._id)) === 310, brief(cashInSigned));

    env.isProduction = false;
    env.allowUnverifiedTopUps = false;
  }

  section('the ledger adds up');
  {
    const users = await User.find({}).select('wallet');
    let ok = true;
    for (const user of users) {
      const [sum] = await WalletTransaction.aggregate([
        { $match: { owner: user._id, status: 'success', direction: 'credit' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      if ((sum?.total || 0) !== user.wallet.balance) ok = false;
    }
    check(`every one of the ${users.length} wallets equals the sum of its successful credits`, ok);
    const stuckSuccess = await WalletTransaction.countDocuments({ type: 'topup', status: 'success', 'payment.gateway': 'razorpay', 'payment.paymentId': { $exists: false } });
    check('no Razorpay top-up is successful without a payment id', stuckSuccess === 0, stuckSuccess);
    check('no call ever left for anywhere but api.razorpay.com', fake.calls.every(call => call.host === 'api.razorpay.com'));
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(error => {
  console.error('CRASHED:', error);
  process.exit(1);
});
