/**
 * Offers & coupons, loyalty, referral, reviews & testimonials, careers — end
 * to end over HTTP.
 *
 * Needs a MongoDB *replica set* (orders and bookings run in transactions, and
 * the reviews page uses $unionWith), so point TEST_MONGODB_URI at one, e.g.
 *   mongodb://127.0.0.1:27117/shree_astro_test_growth?replicaSet=rs0
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_growth';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test:';
process.env.NODE_ENV = 'development';
process.env.OTP_MASTER_CODE = '123456';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connectRedis, redis } = require('../config/redis');
const { createApp } = require('../app');
const { hashPassword } = require('../utils/password');
const { istDateString, dateOffset } = require('../utils/istDate');
const astrologyApiClient = require('../services/astrologyApi.client');
const s3Service = require('../services/s3.service');

const PORT = 5094;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
let pass = 0, fail = 0;

const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

/** Asserts every named path exists on the object (dots walk into it). */
function hasFields(label, object, fields) {
  const missing = fields.filter((p) => {
    let value = object;
    for (const key of p.split('.')) {
      if (value === undefined || value === null) return true;
      value = value[key];
    }
    return value === undefined;
  });
  check(label, missing.length === 0, missing.length ? { missing, object } : undefined);
}

const originalAstrologyRequest = astrologyApiClient.request;

/** `api(token)` gives a caller; `api()` an anonymous one. */
const api = (token) => async (method, p, body) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/** A 1x1 PNG, for the multipart image uploads. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** The smallest thing multer will believe is a PDF. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const uploadedFiles = [];
const rememberUpload = (url) => {
  const relative = (url || '').split('/uploads/')[1];
  if (relative) uploadedFiles.push(path.join(__dirname, '..', 'uploads', relative));
};

async function adminLogin(email, password) {
  const step1 = await fetch(`${BASE}/auth/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json());
  const step2 = await fetch(`${BASE}/auth/admin/login/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: step1.devCode }),
  }).then((r) => r.json());
  return step2.accessToken;
}

async function register({ fullName, email, phone, referralCode }) {
  const res = await fetch(`${BASE}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName, email, phone, gender: 'male', dateOfBirth: '15/08/1995', timeOfBirth: '04:20 AM',
      placeOfBirth: 'Jaipur, Rajasthan', ...(referralCode ? { referralCode } : {}),
    }),
  });
  return { status: res.status, body: await res.json() };
}

const SHIPPING = {
  fullName: 'Arjun Sharma', phone: '9876543210', email: 'arjun@example.com',
  address: '12 MG Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001',
};
const CONTACT = { fullName: 'Arjun Sharma', phone: '9876543210', email: 'arjun@example.com' };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  /**
   * The models were compiled (via ../app) before the connection opened, so
   * mongoose built their indexes on connect — and the drop above took them
   * with it. Rebuild, so unique indexes (coupon codes, loyalty dedupe keys)
   * are real here, as they are in production.
   */
  await Promise.all(Object.values(mongoose.models).map((Model) => Model.syncIndexes()));
  await connectRedis();
  const stale = await redis.keys('*');
  if (stale.length) await redis.del(...stale.map((k) => k.replace('shreeastro-test:', '')));

  astrologyApiClient.request = async () => ({ geonames: [] });
  /** Uploads must land on local disk here, never on a real bucket the .env may point at. */
  s3Service.isConfigured = async () => false;

  const server = createApp().listen(PORT);
  const Admin = require('../models/Admin');
  const Astrologer = require('../models/Astrologer');
  const { ChatSession } = require('../models/Chat');
  const User = require('../models/User');
  const growthHooks = require('../services/growthHooks.service');
  const loyaltyService = require('../services/loyalty.service');

  await Admin.create([
    { name: 'Vaibhav Mehra', email: 'admin@shreeastro.com', passwordHash: await hashPassword('admin@123'), role: 'super_admin', status: 'active' },
    { name: 'Karan Doshi', email: 'finance@shreeastro.com', passwordHash: await hashPassword('admin@123'), role: 'finance', status: 'active' },
    { name: 'Meera Nair', email: 'content@shreeastro.com', passwordHash: await hashPassword('admin@123'), role: 'content_manager', status: 'active' },
  ]);
  const admin = api(await adminLogin('admin@shreeastro.com', 'admin@123'));
  const finance = api(await adminLogin('finance@shreeastro.com', 'admin@123'));
  const content = api(await adminLogin('content@shreeastro.com', 'admin@123'));
  const anon = api();

  const arjunReg = await register({ fullName: 'Arjun Sharma', email: 'arjun@example.com', phone: '9876543210' });
  check('registers without a referral code', arjunReg.status === 201 && arjunReg.body.referralApplied === false, arjunReg.body);
  const user = api(arjunReg.body.accessToken);
  const arjunId = arjunReg.body.user.id;
  const balance = async (caller = user) => (await caller('GET', '/wallet')).body.wallet.balance;
  const ledger = async (caller = user) => (await caller('GET', '/wallet/transactions?limit=100')).body.items;

  const astrologer = await Astrologer.create({ name: 'Pt. Ramesh Sharma', phone: { countryCode: '+91', number: '9000000001' }, email: 'ramesh@example.com' });

  /* ------------------------------------------------------- catalogue setup */
  const productRes = await admin('POST', '/admin/products', { name: 'Shri Yantra', category: 'yantra', price: 1000, stock: 20 });
  const P = productRes.body.product.id;
  const cheapRes = await admin('POST', '/admin/products', { name: 'Incense', category: 'incense', price: 150, stock: 20 });
  const CHEAP = cheapRes.body.product.id;
  const pujaRes = await admin('POST', '/admin/pujas', { name: 'Rudrabhishek', category: 'shiva', price: 500, maxPerSlot: 5 });
  const PJ = pujaRes.body.puja.id;
  const tomorrow = dateOffset(istDateString(), 1);

  /* ---------------------------------------------------------- admin: coupons */
  section('Admin: coupons and festival offers');
  const half = await admin('POST', '/admin/coupons', {
    code: 'half50', title: 'New user offer', kind: 'percent', value: 50, maxDiscount: 300, minAmount: 200,
    appliesTo: ['order', 'puja'], perUserLimit: 1, tag: 'NEW USER', tone: 'orange',
  });
  check('creates a coupon (code uppercased)', half.status === 201 && half.body.coupon.code === 'HALF50', half.body);
  hasFields('coupon row', half.body.coupon, ['id', 'code', 'title', 'kind', 'value', 'maxDiscount', 'minAmount', 'appliesTo', 'perUserLimit', 'usedCount', 'status', 'isPublic', 'tag', 'tone', 'label']);
  check('label is computed', half.body.coupon.label === '50% OFF', half.body.coupon.label);
  const HALF = half.body.coupon.id;

  const dup = await admin('POST', '/admin/coupons', { code: 'HALF50', title: 'Dup', kind: 'flat', value: 10, appliesTo: ['order'] });
  check('a duplicate code is a 409', dup.status === 409 && dup.body.code === 'duplicate_code', dup.body);
  const badKind = await admin('POST', '/admin/coupons', { code: 'BAD', title: 'Bad', kind: 'nope', value: 10, appliesTo: [] });
  check('validation is a 422 with fields', badKind.status === 422 && badKind.body.fields?.kind && badKind.body.fields?.appliesTo, badKind.body);

  const flat = await admin('POST', '/admin/coupons', { code: 'PUJA100', title: 'Puja flat', kind: 'flat', value: 100, appliesTo: ['puja'], perUserLimit: 3, isPublic: false });
  const expired = await admin('POST', '/admin/coupons', { code: 'OLD', title: 'Expired', kind: 'percent', value: 10, appliesTo: ['order'], validTo: '2020-01-01T00:00:00Z' });
  const limited = await admin('POST', '/admin/coupons', { code: 'ONEUSE', title: 'One use total', kind: 'flat', value: 50, appliesTo: ['order'], usageLimit: 1, perUserLimit: 5 });
  const topupCoupon = await admin('POST', '/admin/coupons', { code: 'TOPUP10', title: 'Top-up bonus', kind: 'percent', value: 10, appliesTo: ['topup'], perUserLimit: 1 });
  const paused = await admin('POST', '/admin/coupons', { code: 'PAUSED', title: 'Paused', kind: 'flat', value: 10, appliesTo: ['order'] });
  await admin('PATCH', `/admin/coupons/${paused.body.coupon.id}/status`, { status: 'paused' });
  check('coupon label for a flat coupon', flat.body.coupon?.label === '₹100 OFF', flat.body);

  const edited = await admin('PUT', `/admin/coupons/${HALF}`, { description: 'Half off your first order or puja.' });
  check('updates a coupon', edited.body.coupon?.description === 'Half off your first order or puja.', edited.body);
  const couponList = await admin('GET', '/admin/coupons?search=half');
  check('admin coupon list + search', couponList.body.total === 1 && couponList.body.items[0].code === 'HALF50', couponList.body);
  const financeCoupons = await finance('GET', '/admin/coupons');
  check('finance holds offers.view', financeCoupons.status === 200);
  const contentCoupons = await content('GET', '/admin/coupons');
  check('content manager does not (403)', contentCoupons.status === 403);

  const festivalForm = new FormData();
  festivalForm.append('title', 'Ganesh Chaturthi Special');
  festivalForm.append('subtitle', 'Get 2 consultations at the price of 1');
  festivalForm.append('badge', 'Limited Time');
  festivalForm.append('linkTo', '/astrologers');
  festivalForm.append('couponCode', 'half50');
  festivalForm.append('sortOrder', '2');
  festivalForm.append('image', new Blob([PNG], { type: 'image/png' }), 'ganesh.png');
  const festival = await admin('POST', '/admin/festival-offers', festivalForm);
  check('creates a festival offer (multipart with image)',
    festival.status === 201 && /\/uploads\/offers\//.test(festival.body.offer?.imageUrl || '') && festival.body.offer.couponCode === 'HALF50' && festival.body.offer.sortOrder === 2, festival.body);
  rememberUpload(festival.body.offer?.imageUrl);
  const F = festival.body.offer.id;
  const festival2 = await admin('POST', '/admin/festival-offers', { title: 'Diwali Prosperity Pack', badge: 'Mega Sale', linkTo: '/store', sortOrder: 1 });
  const festivalPast = await admin('POST', '/admin/festival-offers', { title: 'Last Year', endsAt: '2020-01-01T00:00:00Z' });
  const festivalHidden = await admin('POST', '/admin/festival-offers', { title: 'Hidden one', status: 'hidden' });
  check('festival offers created', festival2.status === 201 && festivalPast.status === 201 && festivalHidden.status === 201);
  const festivalEdit = await admin('PUT', `/admin/festival-offers/${F}`, { subtitle: '2 for 1 on consultations' });
  check('updates a festival offer', festivalEdit.body.offer?.subtitle === '2 for 1 on consultations', festivalEdit.body);

  /* ------------------------------------------------------------ public offers */
  section('Public: GET /offers');
  const offersAnon = await anon('GET', '/offers');
  check('offers page loads anonymously', offersAnon.status === 200, offersAnon.body);
  hasFields('offers shape', offersAnon.body, ['coupons', 'festivals', 'loyalty.tiers', 'loyalty.earn']);
  const codes = offersAnon.body.coupons.map((c) => c.code);
  check('lists live public coupons only', codes.includes('HALF50') && codes.includes('TOPUP10') && !codes.includes('PUJA100') && !codes.includes('OLD') && !codes.includes('PAUSED'), codes);
  hasFields('public coupon shape', offersAnon.body.coupons[0], ['id', 'code', 'title', 'kind', 'value', 'minAmount', 'appliesTo', 'tag', 'tone', 'label']);
  check('no limits leak', offersAnon.body.coupons[0].usageLimit === undefined && offersAnon.body.coupons[0].usedCount === undefined);
  const festivalTitles = offersAnon.body.festivals.map((f) => f.title);
  check('festivals: active, in window, sorted', festivalTitles.join('|') === 'Diwali Prosperity Pack|Ganesh Chaturthi Special', festivalTitles);
  check('tiers come from settings', offersAnon.body.loyalty.tiers.length === 4 && offersAnon.body.loyalty.tiers[1].key === 'gold'
    && offersAnon.body.loyalty.tiers[1].minPoints === 500 && offersAnon.body.loyalty.tiers[0].maxPoints === 499 && offersAnon.body.loyalty.tiers[3].maxPoints === null
    && Array.isArray(offersAnon.body.loyalty.tiers[1].perks), offersAnon.body.loyalty.tiers);
  check('earn rates', offersAnon.body.loyalty.earn.find((e) => e.key === 'chat')?.pointsPer100 === 10 && offersAnon.body.loyalty.earn.find((e) => e.key === 'call')?.pointsPer100 === 12, offersAnon.body.loyalty.earn);
  check('no me/referral anonymously', offersAnon.body.loyalty.me === undefined && offersAnon.body.referral === undefined);
  const offersMe = await user('GET', '/offers');
  hasFields('signed-in offers carry me + referral', offersMe.body, ['loyalty.me.points', 'loyalty.me.tier', 'referral.code', 'referral.link', 'referral.rewardAmount', 'referral.invited']);
  check('signup bonus already credited (50 pts, silver)', offersMe.body.loyalty.me.points === 50 && offersMe.body.loyalty.me.tier === 'silver' && offersMe.body.loyalty.me.pointsToNext === 450, offersMe.body.loyalty.me);
  check('referral code format', /^SA[A-Z0-9]{6}$/.test(offersMe.body.referral.code) && offersMe.body.referral.link.endsWith(`/login?ref=${offersMe.body.referral.code}`), offersMe.body.referral);

  /* ------------------------------------------------------- coupon validate */
  section('POST /coupons/validate');
  const v1 = await user('POST', '/coupons/validate', { code: 'half50', context: 'order', amount: 1000 });
  check('valid: 50% capped at 300', v1.status === 200 && v1.body.valid === true && v1.body.discount === 300 && v1.body.payable === 700 && v1.body.coupon.code === 'HALF50', v1.body);
  const v2 = await user('POST', '/coupons/validate', { code: 'HALF50', context: 'order', amount: 150 });
  check('below minimum is coupon_invalid', v2.status === 400 && v2.body.code === 'coupon_invalid' && /₹200/.test(v2.body.error), v2.body);
  const v3 = await user('POST', '/coupons/validate', { code: 'HALF50', context: 'topup', amount: 1000 });
  check('wrong context is coupon_invalid', v3.status === 400 && v3.body.code === 'coupon_invalid' && /top-up/.test(v3.body.error), v3.body);
  const v4 = await user('POST', '/coupons/validate', { code: 'OLD', context: 'order', amount: 1000 });
  check('expired is coupon_invalid', v4.status === 400 && /expired/i.test(v4.body.error), v4.body);
  const v5 = await user('POST', '/coupons/validate', { code: 'NOPE', context: 'order', amount: 1000 });
  check('unknown is coupon_invalid', v5.status === 400 && v5.body.code === 'coupon_invalid', v5.body);
  const v6 = await user('POST', '/coupons/validate', { code: 'PAUSED', context: 'order', amount: 1000 });
  check('paused is coupon_invalid', v6.status === 400 && v6.body.code === 'coupon_invalid', v6.body);
  const v7 = await anon('POST', '/coupons/validate', { code: 'HALF50', context: 'order', amount: 1000 });
  check('anonymous cannot validate', v7.status === 401);
  const v8 = await user('POST', '/coupons/validate', { code: 'HALF50', context: 'nope', amount: -1 });
  check('validation 422', v8.status === 422 && v8.body.fields?.context && v8.body.fields?.amount, v8.body);

  /* ------------------------------------------------------- coupon on topup */
  section('Coupon on a top-up');
  const t1 = await user('POST', '/wallet/topup', { amount: 5000, couponCode: 'topup10' });
  check('start returns the bonus', t1.status === 201 && t1.body.bonusAmount === 500 && t1.body.couponCode === 'TOPUP10', t1.body);
  const c1 = await user('POST', '/wallet/topup/confirm', { transactionId: t1.body.transactionId });
  check('confirm reports the bonus', c1.status === 200 && c1.body.transaction.bonusAmount === 500, c1.body);
  check('wallet holds top-up + bonus', (await balance()) === 5500);
  const bonusRow = (await ledger()).find((t) => t.type === 'bonus');
  check('bonus ledger row', bonusRow && bonusRow.amount === 500 && /TOPUP10/.test(bonusRow.title), bonusRow);
  const t2 = await user('POST', '/wallet/topup', { amount: 1000, couponCode: 'TOPUP10' });
  check('per-user limit on a top-up coupon', t2.status === 400 && t2.body.code === 'coupon_invalid' && /already used/.test(t2.body.error), t2.body);
  const t3 = await user('POST', '/wallet/topup', { amount: 1000, couponCode: 'HALF50' });
  check('a non-topup coupon is refused before anything opens', t3.status === 400 && t3.body.code === 'coupon_invalid', t3.body);
  const t4 = await user('POST', '/wallet/topup', { amount: 4500 });
  await user('POST', '/wallet/topup/confirm', { transactionId: t4.body.transactionId });
  check('plain top-up still works', (await balance()) === 10000);

  /* ------------------------------------------------------- coupon on order */
  section('Coupon on an order');
  const o1 = await user('POST', '/orders', { items: [{ productId: P, qty: 1 }], shipping: SHIPPING, couponCode: 'half50' });
  check('order with coupon', o1.status === 201, o1.body);
  const order1 = o1.body.order;
  hasFields('order JSON carries the coupon', order1, ['subtotal', 'discount', 'couponCode', 'total', 'coupon']);
  check('subtotal 1000, tax 180, free shipping, 300 off → 880', order1.subtotal === 1000 && order1.tax === 180 && order1.shippingFee === 0 && order1.discount === 300 && order1.total === 880 && order1.couponCode === 'HALF50', order1);
  check('wallet debited the discounted total', (await balance()) === 10000 - 880);
  const halfAfter = await admin('GET', `/admin/coupons/${HALF}`).then(() => admin('GET', '/admin/coupons?search=HALF50'));
  check('usedCount incremented', halfAfter.body.items[0].usedCount === 1, halfAfter.body.items[0]);
  const redemptions = await admin('GET', `/admin/coupons/${HALF}/redemptions`);
  check('redemption row with the user and the order', redemptions.body.total === 1 && redemptions.body.items[0].user?.name === 'Arjun Sharma'
    && redemptions.body.items[0].reference === order1.id && redemptions.body.items[0].discount === 300 && redemptions.body.items[0].context === 'order', redemptions.body);
  const o2 = await user('POST', '/orders', { items: [{ productId: P, qty: 1 }], shipping: SHIPPING, couponCode: 'HALF50' });
  check('second use is refused (per-user limit)', o2.status === 400 && o2.body.code === 'coupon_invalid' && /already used/.test(o2.body.error), o2.body);
  check('nothing charged for the refused order', (await balance()) === 10000 - 880);
  const o3 = await user('POST', '/orders', { items: [{ productId: P, qty: 1 }], shipping: SHIPPING, couponCode: 'OLD' });
  check('expired coupon refused on an order', o3.status === 400 && o3.body.code === 'coupon_invalid');
  const deleteUsed = await admin('DELETE', `/admin/coupons/${HALF}`);
  check('a used coupon cannot be deleted (409)', deleteUsed.status === 409 && deleteUsed.body.code === 'coupon_used', deleteUsed.body);
  const deleteFresh = await admin('DELETE', `/admin/coupons/${paused.body.coupon.id}`);
  check('an unused one can', deleteFresh.body.deleted === true, deleteFresh.body);

  const priyaReg = await register({ fullName: 'Priya Sharma', email: 'priya@example.com', phone: '9876500001' });
  const priya = api(priyaReg.body.accessToken);
  const pt = await priya('POST', '/wallet/topup', { amount: 5000 });
  await priya('POST', '/wallet/topup/confirm', { transactionId: pt.body.transactionId });
  const one1 = await user('POST', '/orders', { items: [{ productId: CHEAP, qty: 1 }], shipping: SHIPPING, couponCode: 'ONEUSE' });
  check('usage-limited coupon: first use ok', one1.status === 201 && one1.body.order.discount === 50, one1.body);
  const one2 = await priya('POST', '/orders', { items: [{ productId: CHEAP, qty: 1 }], shipping: SHIPPING, couponCode: 'ONEUSE' });
  check('usage-limited coupon: second user refused', one2.status === 400 && /usage limit/.test(one2.body.error), one2.body);
  const cancelled = await user('POST', `/orders/${one1.body.order.id}/cancel`);
  check('cancelling a discounted order refunds what was paid', cancelled.body.order?.status === 'cancelled' && (await ledger()).find((t) => t.type === 'refund')?.amount === one1.body.order.total, cancelled.body);

  /* ----------------------------------------------------- coupon on booking */
  section('Coupon on a puja booking');
  const b1 = await user('POST', '/puja-bookings', { pujaId: PJ, date: tomorrow, time: '8:00 AM', contact: CONTACT, couponCode: 'puja100' });
  check('booking with a flat coupon', b1.status === 201, b1.body);
  const booking1 = b1.body.booking;
  check('subtotal 500, 100 off, total 400', booking1.subtotal === 500 && booking1.discount === 100 && booking1.total === 400 && booking1.amount === 400 && booking1.couponCode === 'PUJA100', booking1);
  const balAfterBooking = await balance();
  check('wallet debited 400', balAfterBooking === 10000 - 880 - 400);
  const b2 = await user('POST', '/puja-bookings', { pujaId: PJ, date: tomorrow, time: '9:00 AM', contact: CONTACT, couponCode: 'HALF50' });
  check('a used-up coupon is refused on a booking', b2.status === 400 && b2.body.code === 'coupon_invalid', b2.body);
  const b3 = await user('POST', '/puja-bookings', { pujaId: PJ, date: tomorrow, time: '9:00 AM', contact: CONTACT });
  check('booking without a coupon', b3.status === 201 && b3.body.booking.discount === 0 && b3.body.booking.total === 500, b3.body);

  /* ----------------------------------------------------------- loyalty */
  section('Loyalty: order delivered, puja completed, chat end');
  const loyalty0 = await user('GET', '/loyalty');
  hasFields('loyalty shape', loyalty0.body, ['points', 'lifetimePoints', 'tier', 'nextTier', 'pointsToNext', 'cashbackPercent', 'history', 'tiers']);
  check('starts with the signup bonus', loyalty0.body.points === 50 && loyalty0.body.history.length === 1 && loyalty0.body.history[0].type === 'bonus' && loyalty0.body.history[0].source?.kind === 'signup', loyalty0.body);

  for (const status of ['packed', 'shipped', 'out_for_delivery', 'delivered']) {
    // eslint-disable-next-line no-await-in-loop
    await admin('PATCH', `/admin/orders/${order1.id}/status`, { status });
  }
  const loyalty1 = await user('GET', '/loyalty');
  check('delivered order of ₹880 → 8 pts/₹100 = 70 points', loyalty1.body.points === 50 + 70, loyalty1.body);
  const earnRow = loyalty1.body.history.find((h) => h.source?.kind === 'order');
  check('history row names the order', earnRow && earnRow.type === 'earn' && earnRow.points === 70 && earnRow.source.id === order1.id && /ORD-/.test(earnRow.reason) && earnRow.balanceAfter === 120, earnRow);
  const Order = require('../models/Order');
  await growthHooks.onOrderDelivered(await Order.findById(order1.id));
  check('re-running the delivered hook awards nothing twice', (await user('GET', '/loyalty')).body.points === 120);

  await admin('PATCH', `/admin/puja-bookings/${booking1.id}`, { status: 'completed' });
  const loyalty2 = await user('GET', '/loyalty');
  check('completed puja of ₹400 → 32 points', loyalty2.body.points === 120 + 32, loyalty2.body);

  const chat = await ChatSession.create({
    user: arjunId, astrologer: astrologer._id, channel: 'chat', status: 'ended', startedAt: new Date(Date.now() - 600000), endedAt: new Date(),
    durationSeconds: 600, billing: { ratePerMinute: 25, amountCharged: 250, isSettled: true },
    review: { rating: 5, comment: 'Spot on about my career.', ratedAt: new Date() },
  });
  const chatResult = await growthHooks.onConsultationEnded(chat);
  check('chat end of ₹250 → 10 pts/₹100 = 25 points', chatResult.points?.points === 25 && (await user('GET', '/loyalty')).body.points === 152 + 25, chatResult.points);
  check('no cashback while cashbackEnabled is off', chatResult.cashback === null);
  const chatAgain = await growthHooks.onConsultationEnded(chat);
  check('chat end hook is idempotent', chatAgain.points === null && (await user('GET', '/loyalty')).body.points === 177);
  const callChat = await ChatSession.create({
    user: arjunId, astrologer: astrologer._id, channel: 'call', status: 'ended', startedAt: new Date(Date.now() - 300000), endedAt: new Date(),
    durationSeconds: 300, billing: { ratePerMinute: 40, amountCharged: 200, isSettled: true },
    review: { rating: 4, comment: 'Good call, a little rushed.', ratedAt: new Date() },
  });
  await growthHooks.onConsultationEnded(callChat);
  check('call end uses the call rate (12/₹100 → 24)', (await user('GET', '/loyalty')).body.points === 177 + 24);
  const unpaid = await ChatSession.create({ user: arjunId, astrologer: astrologer._id, channel: 'chat', status: 'ended', billing: { amountCharged: 0 } });
  const unpaidResult = await growthHooks.onConsultationEnded(unpaid);
  check('a free session earns nothing', unpaidResult.points === null);

  const notes = await user('GET', '/notifications?limit=50');
  const rewardNotes = notes.body.items.filter((n) => n.type === 'reward');
  check('reward notifications ("You earned N points")', rewardNotes.length >= 4 && rewardNotes.some((n) => n.title === 'You earned 70 points'), rewardNotes.map((n) => n.title));

  section('Loyalty: tiers and admin adjust');
  const adjust = await admin('POST', '/admin/loyalty/adjust', { userId: arjunId, points: 400, reason: 'Goodwill for a delayed order' });
  check('admin adjust', adjust.status === 201 && adjust.body.transaction?.type === 'adjust' && adjust.body.loyalty?.points === 601, adjust.body);
  const loyalty3 = await user('GET', '/loyalty');
  check('601 lifetime → gold, 1399 to platinum, 2% cashback', loyalty3.body.tier === 'gold' && loyalty3.body.nextTier === 'platinum' && loyalty3.body.pointsToNext === 1399 && loyalty3.body.cashbackPercent === 2, loyalty3.body);
  const deduct = await admin('POST', '/admin/loyalty/adjust', { userId: arjunId, points: -1, reason: 'Correction' });
  check('a deduction lowers points but not lifetime/tier', deduct.body.loyalty?.points === 600 && deduct.body.loyalty?.lifetimePoints === 601 && deduct.body.loyalty?.tier === 'gold', deduct.body);
  const tooMuch = await admin('POST', '/admin/loyalty/adjust', { userId: arjunId, points: -5000, reason: 'Oops' });
  check('cannot deduct below zero', tooMuch.status === 400, tooMuch.body);
  const zero = await admin('POST', '/admin/loyalty/adjust', { userId: arjunId, points: 0, reason: 'Nothing' });
  check('zero points is a 422', zero.status === 422);
  const noPerm = await content('POST', '/admin/loyalty/adjust', { userId: arjunId, points: 5, reason: 'Nope' });
  check('adjust needs wallets.adjust', noPerm.status === 403);
  const historyPage = await user('GET', '/loyalty/history?limit=2&page=2');
  check('history paginates', historyPage.body.items.length === 2 && historyPage.body.page === 2 && historyPage.body.total >= 7, historyPage.body);
  const detail = await admin('GET', `/admin/users/${arjunId}`);
  hasFields('admin user detail carries loyalty + referral', detail.body.user, ['loyalty.points', 'loyalty.tier', 'loyalty.lifetimePoints', 'referral.code', 'referral.invited', 'referral.completed', 'referral.earned']);
  check('tierFor', loyaltyService.tierFor(0) === 'silver' && loyaltyService.tierFor(499) === 'silver' && loyaltyService.tierFor(500) === 'gold' && loyaltyService.tierFor(2000) === 'platinum' && loyaltyService.tierFor(9999) === 'diamond');

  const cashbackOn = await admin('PATCH', '/admin/settings', { loyalty: { cashbackEnabled: true } });
  check('settings accept loyalty.cashbackEnabled', cashbackOn.status === 200 && cashbackOn.body.settings.loyalty.cashbackEnabled === true, cashbackOn.body.settings?.loyalty);
  const goldChat = await ChatSession.create({
    user: arjunId, astrologer: astrologer._id, channel: 'chat', status: 'ended', billing: { amountCharged: 1000, isSettled: true },
  });
  const before = await balance();
  const goldResult = await growthHooks.onConsultationEnded(goldChat);
  check('gold cashback: 2% of ₹1000 = ₹20 as type cashback', goldResult.cashback?.type === 'cashback' && goldResult.cashback.amount === 20 && (await balance()) === before + 20, goldResult.cashback);
  await growthHooks.onConsultationEnded(goldChat);
  check('cashback once per session', (await balance()) === before + 20);
  const publicSettings = await anon('GET', '/settings');
  hasFields('public settings expose loyalty + referral', publicSettings.body.settings, ['loyalty.tiers', 'loyalty.pointsPer100.chat', 'referral.rewardAmount', 'referral.minFirstSpend']);
  await admin('PATCH', '/admin/settings', { loyalty: { cashbackEnabled: false } });

  /* ----------------------------------------------------------- referral */
  section('Referral');
  const ref = await user('GET', '/referral');
  hasFields('referral shape', ref.body, ['code', 'link', 'rewardAmount', 'stats.invited', 'stats.completed', 'stats.earned', 'recent']);
  check('reward is ₹200, nobody invited yet', ref.body.rewardAmount === 200 && ref.body.stats.invited === 0, ref.body);
  const CODE = ref.body.code;
  const selfRef = await register({ fullName: 'Self Referrer', email: 'self@example.com', phone: '9876500009', referralCode: CODE });
  check('a stranger with a bad code still registers (referralApplied false)',
    (await register({ fullName: 'Nobody', email: 'nobody@example.com', phone: '9876500008', referralCode: 'SAZZZZZZ' })).body.referralApplied === false);
  check('registration with a valid code', selfRef.status === 201 && selfRef.body.referralApplied === true, selfRef.body);
  const kavyaReg = await register({ fullName: 'Kavya Reddy', email: 'kavya@example.com', phone: '9876500002', referralCode: CODE.toLowerCase() });
  check('code is case-insensitive', kavyaReg.body.referralApplied === true, kavyaReg.body);
  const kavya = api(kavyaReg.body.accessToken);
  const kavyaId = kavyaReg.body.user.id;
  const ref2 = await user('GET', '/referral');
  check('invited counts, names masked', ref2.body.stats.invited === 2 && ref2.body.recent[0].name === 'Kavya R.' && ref2.body.recent[0].status === 'signed_up', ref2.body);

  const kt = await kavya('POST', '/wallet/topup', { amount: 3000 });
  await kavya('POST', '/wallet/topup/confirm', { transactionId: kt.body.transactionId });
  const small = await kavya('POST', '/orders', { items: [{ productId: CHEAP, qty: 1 }], shipping: SHIPPING });
  check('small order placed (₹150 + tax + shipping = 226)', small.body.order?.total === 226, small.body.order);
  const ko = await kavya('POST', '/orders', { items: [{ productId: P, qty: 1 }], shipping: SHIPPING });
  const arjunBefore = await balance();
  const kavyaBefore = await balance(kavya);
  await admin('PATCH', `/admin/orders/${ko.body.order.id}/status`, { status: 'delivered' });
  check('first delivered order ≥ ₹100 pays both sides ₹200', (await balance()) === arjunBefore + 200 && (await balance(kavya)) === kavyaBefore + 200);
  const arjunRow = (await ledger()).find((t) => t.type === 'referral_bonus');
  const kavyaRow = (await ledger(kavya)).find((t) => t.type === 'referral_bonus');
  check('referral_bonus rows on both ledgers', arjunRow?.amount === 200 && kavyaRow?.amount === 200 && /Kavya R\./.test(arjunRow.description), [arjunRow, kavyaRow]);
  const ref3 = await user('GET', '/referral');
  check('stats: 1 completed, ₹200 earned', ref3.body.stats.completed === 1 && ref3.body.stats.earned === 200 && ref3.body.recent.find((r) => r.name === 'Kavya R.').status === 'rewarded', ref3.body);
  const arjunLoyalty = await user('GET', '/loyalty');
  check('referrer got 100 bonus points', arjunLoyalty.body.history.some((h) => h.source?.kind === 'referral' && h.points === 100), arjunLoyalty.body.history.map((h) => [h.type, h.points]));
  await admin('PATCH', `/admin/orders/${small.body.order.id}/status`, { status: 'delivered' });
  check('a second delivered order pays no second reward', (await balance()) === arjunBefore + 200);
  const refNotes = await user('GET', '/notifications?limit=50');
  check('referral notification', refNotes.body.items.some((n) => n.type === 'referral' && /₹200/.test(n.title)), refNotes.body.items.filter((n) => n.type === 'referral'));
  const adminRefs = await admin('GET', '/admin/referrals?status=rewarded');
  check('admin referral list', adminRefs.body.total === 1 && adminRefs.body.items[0].referrer?.name === 'Arjun Sharma' && adminRefs.body.items[0].referred?.name === 'Kavya Reddy', adminRefs.body);
  const adminRefSearch = await admin('GET', '/admin/referrals?search=kavya');
  check('admin referral search', adminRefSearch.body.total === 1);
  const kavyaDetail = await admin('GET', `/admin/users/${kavyaId}`);
  check('referred user detail names the referrer', kavyaDetail.body.user.referral?.referredBy?.name === 'Arjun Sharma', kavyaDetail.body.user.referral);

  /* ------------------------------------------------------------- reviews */
  section('Reviews: public list, summary, moderation');
  const rated = await user('POST', `/puja-bookings/${booking1.id}/rate`, { rating: 3, comment: 'Stream lagged a bit.' });
  check('puja rated', rated.status === 200);
  const reviews = await anon('GET', '/reviews');
  check('public reviews list', reviews.status === 200 && reviews.body.total === 3, reviews.body);
  hasFields('review list shape', reviews.body, ['items', 'total', 'page', 'limit', 'summary.average', 'summary.count', 'summary.breakdown', 'summary.categories']);
  const consultationItem = reviews.body.items.find((r) => r.kind === 'consultation' && r.rating === 5);
  hasFields('consultation review item', consultationItem, ['id', 'kind', 'rating', 'comment', 'pinned', 'createdAt', 'reviewer.name', 'astrologer.id', 'astrologer.name', 'channel', 'durationSeconds']);
  check('reviewer name is masked', consultationItem.reviewer.name === 'Arjun S.' && consultationItem.astrologer.name === 'Pt. Ramesh Sharma', consultationItem.reviewer);
  const pujaItem = reviews.body.items.find((r) => r.kind === 'puja');
  check('puja review item', pujaItem && pujaItem.puja?.name === 'Rudrabhishek' && pujaItem.puja.slug === 'rudrabhishek' && pujaItem.comment === 'Stream lagged a bit.', pujaItem);
  check('summary: avg 4.0 of 3, breakdown, categories', reviews.body.summary.count === 3 && reviews.body.summary.average === 4 && reviews.body.summary.breakdown[5] === 1 && reviews.body.summary.breakdown[4] === 1 && reviews.body.summary.breakdown[3] === 1
    && reviews.body.summary.categories.consultation === 4.5 && reviews.body.summary.categories.puja === 3, reviews.body.summary);
  const five = await anon('GET', '/reviews?rating=5');
  check('rating filter', five.body.total === 1 && five.body.items[0].rating === 5);
  const min4 = await anon('GET', '/reviews?min=4');
  check('min filter', min4.body.total === 2);
  const onlyPuja = await anon('GET', '/reviews?kind=puja');
  check('kind filter', onlyPuja.body.total === 1 && onlyPuja.body.items[0].kind === 'puja');
  const badQuery = await anon('GET', '/reviews?rating=9');
  check('bad rating is a 422', badQuery.status === 422);

  const adminReviews = await admin('GET', '/admin/reviews');
  check('admin sees all with full names', adminReviews.body.total === 3 && adminReviews.body.items[0].reviewer.name === 'Arjun Sharma' && adminReviews.body.items[0].hidden === false, adminReviews.body.items[0]);
  const searched = await admin('GET', '/admin/reviews?search=rushed');
  check('admin review search', searched.body.total === 1 && searched.body.items[0].rating === 4);
  const pinned = await admin('PATCH', `/admin/reviews/consultation/${callChat._id}`, { pinned: true, reply: 'Thank you, we will slow down next time.' });
  check('pin + reply', pinned.status === 200 && pinned.body.review.pinned === true && pinned.body.review.reply === 'Thank you, we will slow down next time.', pinned.body);
  const afterPin = await anon('GET', '/reviews');
  check('pinned first', afterPin.body.items[0].id === String(callChat._id) && afterPin.body.items[0].pinned === true, afterPin.body.items.map((r) => [r.id, r.pinned]));
  const hidden = await admin('PATCH', `/admin/reviews/puja/${booking1.id}`, { hidden: true });
  check('hide a puja review', hidden.body.review?.hidden === true, hidden.body);
  const afterHide = await anon('GET', '/reviews');
  check('hidden review leaves the list and the summary', afterHide.body.total === 2 && afterHide.body.summary.count === 2 && afterHide.body.summary.categories.puja === null, afterHide.body.summary);
  const hiddenList = await admin('GET', '/admin/reviews?hidden=true');
  check('admin hidden filter', hiddenList.body.total === 1 && hiddenList.body.items[0].kind === 'puja');
  const flagged = await admin('PATCH', `/admin/reviews/consultation/${chat._id}`, { flagged: true, flagReason: 'Suspicious' });
  check('flag', flagged.body.review?.flagged === true && flagged.body.review.flagReason === 'Suspicious');
  check('flagged leaves the public list', (await anon('GET', '/reviews')).body.total === 1);
  await admin('PATCH', `/admin/reviews/consultation/${chat._id}`, { flagged: false, flagReason: '' });
  await admin('PATCH', `/admin/reviews/puja/${booking1.id}`, { hidden: false });
  check('unhide/unflag restores', (await anon('GET', '/reviews')).body.total === 3);
  const noReview = await admin('PATCH', `/admin/reviews/consultation/${unpaid._id}`, { hidden: true });
  check('a session without a review is 404', noReview.status === 404);
  const badReviewKind = await admin('PATCH', `/admin/reviews/article/${chat._id}`, { hidden: true });
  check('unknown kind is 422', badReviewKind.status === 422);
  const contentReviews = await content('GET', '/admin/reviews');
  check('content manager holds reviews.view', contentReviews.status === 200);
  const financeReviews = await finance('PATCH', `/admin/reviews/consultation/${chat._id}`, { pinned: true });
  check('finance does not hold reviews.manage', financeReviews.status === 403);

  section('Testimonials');
  const form = new FormData();
  form.append('kind', 'story');
  form.append('title', 'From Debt to Financial Freedom');
  form.append('quote', 'After following the remedies I cleared my debt.');
  form.append('name', 'Rajat Khanna');
  form.append('city', 'Delhi');
  form.append('tag', 'Career & Finance');
  form.append('outcome', '₹12L debt → Business owner');
  form.append('duration', 'in 18 months');
  form.append('sortOrder', '2');
  form.append('avatar', new Blob([PNG], { type: 'image/png' }), 'rajat.png');
  form.append('thumbnail', new Blob([PNG], { type: 'image/png' }), 'thumb.png');
  const story = await content('POST', '/admin/testimonials', form);
  check('creates a story (multipart with avatar + thumbnail)',
    story.status === 201 && /\/uploads\/testimonials\//.test(story.body.testimonial?.avatarUrl || '') && /\/uploads\/testimonials\//.test(story.body.testimonial?.thumbnailUrl || ''), story.body);
  rememberUpload(story.body.testimonial?.avatarUrl);
  rememberUpload(story.body.testimonial?.thumbnailUrl);
  const S = story.body.testimonial.id;
  const story2 = await admin('POST', '/admin/testimonials', { kind: 'story', title: 'Found My Soulmate at 34', name: 'Ananya Sharma', outcome: 'Single → Happily engaged', sortOrder: 1 });
  const video = await admin('POST', '/admin/testimonials', { kind: 'video', title: 'Marriage Prediction Came True', name: 'Deepika Mehta', city: 'Mumbai', duration: '2:34', views: 28400, videoUrl: 'https://youtu.be/x' });
  const draft = await admin('POST', '/admin/testimonials', { kind: 'video', title: 'Draft', name: 'Someone', status: 'draft' });
  check('more testimonials', story2.status === 201 && video.status === 201 && draft.status === 201);
  const badT = await admin('POST', '/admin/testimonials', { kind: 'podcast', title: 'x', name: 'y' });
  check('bad kind is 422', badT.status === 422 && badT.body.fields?.kind);
  const editedT = await admin('PUT', `/admin/testimonials/${S}`, { city: 'New Delhi' });
  check('update', editedT.body.testimonial?.city === 'New Delhi');
  const stories = await anon('GET', '/testimonials?kind=story&limit=3');
  check('public stories, sorted, published only', stories.body.items.length === 2 && stories.body.items[0].title === 'Found My Soulmate at 34' && stories.body.items[1].name === 'Rajat Khanna', stories.body);
  hasFields('public story shape', stories.body.items[1], ['id', 'kind', 'title', 'quote', 'name', 'city', 'tag', 'outcome', 'duration', 'avatarUrl']);
  check('no audit fields leak', stories.body.items[0].createdBy === undefined && stories.body.items[0].status === undefined);
  const videos = await anon('GET', '/testimonials?kind=video');
  check('public videos exclude drafts', videos.body.items.length === 1 && videos.body.items[0].views === 28400 && videos.body.items[0].videoUrl === 'https://youtu.be/x', videos.body);
  const all = await anon('GET', '/testimonials');
  check('all published', all.body.items.length === 3);
  const unpublish = await admin('PATCH', `/admin/testimonials/${S}/status`, { status: 'draft' });
  check('status patch', unpublish.body.testimonial?.status === 'draft' && (await anon('GET', '/testimonials?kind=story')).body.items.length === 1);
  const adminT = await admin('GET', '/admin/testimonials?kind=video');
  check('admin list by kind', adminT.body.total === 2);
  const goneT = await admin('DELETE', `/admin/testimonials/${draft.body.testimonial.id}`);
  check('delete', goneT.body.deleted === true && (await admin('GET', '/admin/testimonials')).body.total === 3);

  /* ------------------------------------------------------------- careers */
  section('Careers');
  const job = await admin('POST', '/admin/jobs', {
    title: 'Senior Backend Engineer', department: 'Engineering', location: 'Bangalore (Hybrid)', type: 'full-time', experience: '4–7 yrs',
    tags: ['Node.js', 'PostgreSQL', 'Redis', 'AWS'], description: 'Own the services behind consultations.', responsibilities: ['Ship services'],
    requirements: ['4–7 years'], salary: '₹28–40 LPA', openings: 2,
  });
  check('creates a job posting', job.status === 201 && job.body.job.slug === 'senior-backend-engineer' && job.body.job.department === 'engineering' && job.body.job.status === 'open', job.body);
  hasFields('job row', job.body.job, ['id', 'slug', 'title', 'department', 'departmentLabel', 'location', 'type', 'experience', 'tags', 'openings', 'status', 'postedAt']);
  const J = job.body.job.id;
  const job2 = await content('POST', '/admin/jobs', { title: 'Product Designer', department: 'design', type: 'full-time', experience: '3–5 yrs', tags: 'Figma, Prototyping' });
  check('content manager can post a job; comma tags parsed', job2.status === 201 && job2.body.job.tags.length === 2, job2.body);
  const intern = await admin('POST', '/admin/jobs', { title: 'Product Design Intern', department: 'internship', type: 'internship', stipend: '₹25,000/mo' });
  const draftJob = await admin('POST', '/admin/jobs', { title: 'Secret Role', department: 'engineering', status: 'draft' });
  const badJob = await admin('POST', '/admin/jobs', { title: 'x', department: 'Bad Dept!', type: 'gig' });
  check('validation 422', badJob.status === 422 && badJob.body.fields?.department && badJob.body.fields?.type, badJob.body);
  const financeJobs = await finance('GET', '/admin/jobs');
  check('finance cannot see careers', financeJobs.status === 403);
  const editedJob = await admin('PUT', `/admin/jobs/${J}`, { title: 'Senior Backend Engineer (Node.js)' });
  check('renamed job gets a fresh slug', editedJob.body.job?.slug === 'senior-backend-engineer-node-js', editedJob.body);

  const publicJobs = await anon('GET', '/careers/jobs');
  check('public list: open only, with departments', publicJobs.body.total === 3 && publicJobs.body.departments.some((d) => d.key === 'engineering' && d.label === 'Engineering' && d.count === 1)
    && publicJobs.body.departments.some((d) => d.key === 'internship' && d.count === 1), publicJobs.body);
  check('no admin fields leak', publicJobs.body.items[0].status === undefined && publicJobs.body.items[0].createdBy === undefined);
  const byDept = await anon('GET', '/careers/jobs?department=design');
  check('department filter', byDept.body.total === 1 && byDept.body.items[0].title === 'Product Designer');
  const jobDetail = await anon('GET', '/careers/jobs/senior-backend-engineer-node-js');
  check('job by slug', jobDetail.status === 200 && jobDetail.body.job.id === J && jobDetail.body.job.responsibilities.length === 1, jobDetail.body);
  check('draft job is 404', (await anon('GET', '/careers/jobs/secret-role')).status === 404);

  const appForm = new FormData();
  appForm.append('jobId', J);
  appForm.append('fullName', 'Rahul Gupta');
  appForm.append('email', 'rahul@example.com');
  appForm.append('phone', '9876543211');
  appForm.append('experience', '5 years');
  appForm.append('linkedin', 'https://linkedin.com/in/rahul');
  appForm.append('message', 'I would love to work on the billing engine.');
  appForm.append('resume', new Blob([PDF], { type: 'application/pdf' }), 'rahul-cv.pdf');
  const application = await anon('POST', '/careers/applications', appForm);
  check('applies with a resume (multipart, anonymous)', application.status === 201 && /^APP-[A-Z0-9]{6}$/.test(application.body.application?.reference || '')
    && application.body.application.roleTitle === 'Senior Backend Engineer (Node.js)' && application.body.application.status === 'received' && application.body.application.kind === 'job', application.body);
  const APP = application.body.application.id;
  const astroApp = await anon('POST', '/careers/applications', { kind: 'astrologer', fullName: 'Guruji Agarwal', email: 'guru@example.com', phone: '9876543212', experience: '12 years' });
  check('astrologer application (JSON, no resume)', astroApp.status === 201 && astroApp.body.application.roleTitle === 'Astrologer Application', astroApp.body);
  const internApp = await anon('POST', '/careers/applications', { kind: 'internship', fullName: 'Ananya S', email: 'ananya@example.com', phone: '9876543213' });
  check('internship application', internApp.body.application?.roleTitle === 'Internship Program');
  const noKind = await anon('POST', '/careers/applications', { fullName: 'X Y', email: 'x@example.com', phone: '9876543214' });
  check('neither jobId nor kind is 422', noKind.status === 422 && noKind.body.fields?.kind, noKind.body);
  const closedApp = await anon('POST', '/careers/applications', { jobId: draftJob.body.job.id, fullName: 'X Y', email: 'x@example.com', phone: '9876543214' });
  check('applying to a draft job is 422', closedApp.status === 422 && closedApp.body.fields?.jobId, closedApp.body);
  const badResume = new FormData();
  badResume.append('kind', 'job');
  badResume.append('roleTitle', 'Anything');
  badResume.append('fullName', 'Bad File');
  badResume.append('email', 'bad@example.com');
  badResume.append('phone', '9876543215');
  badResume.append('resume', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'virus.exe');
  const rejected = await anon('POST', '/careers/applications', badResume);
  check('a non-document resume is refused (400)', rejected.status === 400, rejected.body);

  const apps = await admin('GET', '/admin/applications');
  check('admin lists applications, newest first, with the job', apps.body.total === 3 && apps.body.items.at(-1).id === APP && apps.body.items.at(-1).job?.title === 'Senior Backend Engineer (Node.js)', apps.body);
  hasFields('application row', apps.body.items.at(-1), ['id', 'reference', 'roleTitle', 'kind', 'fullName', 'email', 'phone', 'experience', 'linkedin', 'message', 'resume.url', 'resume.fileName', 'resume.mimeType', 'resume.sizeBytes', 'status', 'createdAt']);
  const appRow = apps.body.items.at(-1);
  check('resume stored under uploads/resumes', /\/uploads\/resumes\//.test(appRow.resume.url) && appRow.resume.fileName === 'rahul-cv.pdf' && appRow.resume.mimeType === 'application/pdf', appRow.resume);
  rememberUpload(appRow.resume.url);
  const byKind = await admin('GET', '/admin/applications?kind=astrologer');
  check('filter by kind', byKind.body.total === 1);
  const byJob = await admin('GET', `/admin/applications?job=${J}`);
  check('filter by job', byJob.body.total === 1);
  const bySearch = await admin('GET', '/admin/applications?search=rahul');
  check('search', bySearch.body.total === 1);
  const appDetail = await admin('GET', `/admin/applications/${APP}`);
  check('application detail', appDetail.body.application?.id === APP);
  const shortlisted = await content('PATCH', `/admin/applications/${APP}`, { status: 'shortlisted', adminNote: 'Strong Node background' });
  check('status change with a note', shortlisted.status === 200 && shortlisted.body.application.status === 'shortlisted' && shortlisted.body.application.adminNote === 'Strong Node background', shortlisted.body);
  const badStatus = await admin('PATCH', `/admin/applications/${APP}`, { status: 'maybe' });
  check('unknown status is 422', badStatus.status === 422);
  const byStatus = await admin('GET', '/admin/applications?status=shortlisted');
  check('filter by status', byStatus.body.total === 1);
  const adminNotes = await admin('GET', '/notifications?limit=50');
  check('admins were notified of the application', adminNotes.body.items.some((n) => n.type === 'application' && /Rahul Gupta/.test(n.body)), adminNotes.body.items.filter((n) => n.type === 'application').length);

  const closed = await admin('PATCH', `/admin/jobs/${J}/status`, { status: 'closed' });
  check('close a job', closed.body.job?.status === 'closed' && (await anon('GET', '/careers/jobs')).body.total === 2);
  const goneJob = await admin('DELETE', `/admin/jobs/${J}`);
  check('delete a job', goneJob.body.deleted === true);
  const orphan = await admin('GET', `/admin/applications/${APP}`);
  check('its application keeps the role title with no job link', orphan.body.application?.job === null && orphan.body.application.roleTitle === 'Senior Backend Engineer (Node.js)', orphan.body.application);
  const adminJobs = await admin('GET', '/admin/jobs?status=draft');
  check('admin job list by status', adminJobs.body.total === 1);

  /* ---------------------------------------------------- permissions/areas */
  section('Permissions and audit areas');
  check('role maps', ['offers.view', 'offers.manage'].every((p) => Admin.ROLE_PERMISSIONS.finance.includes(p))
    && ['reviews.view', 'reviews.manage', 'careers.view', 'careers.manage'].every((p) => Admin.ROLE_PERMISSIONS.content_manager.includes(p))
    && !Admin.ROLE_PERMISSIONS.content_manager.includes('offers.view') && !Admin.ROLE_PERMISSIONS.finance.includes('careers.view')
    && ['offers.view', 'offers.manage', 'reviews.view', 'reviews.manage', 'careers.view', 'careers.manage'].every((p) => Admin.ROLE_PERMISSIONS.admin.includes(p)));
  const AuditLog = require('../models/AuditLog');
  check('audit areas', ['Offers', 'Reviews', 'Careers'].every((a) => AuditLog.AREAS.includes(a)));
  const logs = await admin('GET', '/admin/audit-logs?limit=200');
  const areas = new Set(logs.body.items.map((r) => r.area));
  check('audit rows in Offers, Reviews and Careers', areas.has('Offers') && areas.has('Reviews') && areas.has('Careers'), [...areas]);
  const offerLogs = await admin('GET', '/admin/audit-logs?area=Offers');
  check('audit filter by area', offerLogs.body.items.length > 0 && offerLogs.body.items.every((r) => r.area === 'Offers'));
  const Notification = require('../models/Notification');
  const WalletTransaction = require('../models/WalletTransaction');
  check('new enum values', Notification.NOTIFICATION_TYPES.includes('reward') && Notification.NOTIFICATION_TYPES.includes('referral')
    && WalletTransaction.TRANSACTION_TYPES.includes('cashback') && WalletTransaction.TRANSACTION_TYPES.includes('referral_bonus'));
  const contentFestival = await content('POST', '/admin/festival-offers', { title: 'Nope' });
  check('content manager cannot manage offers', contentFestival.status === 403);
  const financeTestimonial = await finance('POST', '/admin/testimonials', { kind: 'story', title: 'Nope', name: 'x' });
  check('finance cannot manage reviews', financeTestimonial.status === 403);
  const referralsPerm = await content('GET', '/admin/referrals');
  check('referrals need users.view', referralsPerm.status === 403 && (await admin('GET', '/admin/referrals')).status === 200);
  const userDoc = await User.findById(arjunId).select('loyalty referralCode');
  check('user document carries loyalty + code', userDoc.loyalty.tier === 'gold' && userDoc.referralCode === CODE, userDoc);

  astrologyApiClient.request = originalAstrologyRequest;
  for (const file of uploadedFiles) fs.rmSync(file, { force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await redis.quit();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  astrologyApiClient.request = originalAstrologyRequest;
  for (const file of uploadedFiles) fs.rmSync(file, { force: true });
  console.error('CRASHED:', e);
  process.exit(1);
});
