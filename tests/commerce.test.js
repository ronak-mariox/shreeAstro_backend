/**
 * The store, pujas and public articles — end to end over HTTP.
 *
 * Needs a MongoDB *replica set* (orders and bookings run in transactions), so
 * point TEST_MONGODB_URI at one, e.g.
 *   mongodb://127.0.0.1:27117/shree_astro_test_commerce?replicaSet=rs0
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_commerce';
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

const PORT = 5093;
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

/** A 1x1 PNG, for the multipart uploads. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const uploadedFiles = [];
const rememberUpload = (url) => {
  const relative = url.split('/uploads/')[1];
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

const SHIPPING = {
  fullName: 'Arjun Sharma', phone: '9876543210', email: 'arjun@example.com',
  address: '12 MG Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001',
};
const CONTACT = { fullName: 'Arjun Sharma', phone: '9876543210', email: 'arjun@example.com', gotra: 'Kashyap' };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await connectRedis();
  const stale = await redis.keys('*');
  if (stale.length) await redis.del(...stale.map((k) => k.replace('shreeastro-test:', '')));

  astrologyApiClient.request = async () => ({ geonames: [] });
  /** Uploads must land on local disk here, never on a real bucket the .env may point at. */
  s3Service.isConfigured = async () => false;

  const server = createApp().listen(PORT);
  const Admin = require('../models/Admin');
  await Admin.create([
    { name: 'Vaibhav Mehra', email: 'admin@shreeastro.com', passwordHash: await hashPassword('admin@123'), role: 'super_admin', status: 'active' },
    { name: 'Karan Doshi', email: 'finance@shreeastro.com', passwordHash: await hashPassword('admin@123'), role: 'finance', status: 'active' },
    { name: 'Meera Nair', email: 'content@shreeastro.com', passwordHash: await hashPassword('admin@123'), role: 'content_manager', status: 'active' },
  ]);

  const admin = api(await adminLogin('admin@shreeastro.com', 'admin@123'));
  const finance = api(await adminLogin('finance@shreeastro.com', 'admin@123'));
  const content = api(await adminLogin('content@shreeastro.com', 'admin@123'));

  const registered = await fetch(`${BASE}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Arjun Sharma', email: 'arjun@example.com', phone: '9876543210',
      gender: 'male', dateOfBirth: '15/08/1995', timeOfBirth: '04:20 AM', placeOfBirth: 'Jaipur, Rajasthan',
    }),
  }).then((r) => r.json());
  const user = api(registered.accessToken);
  const anon = api();

  const balance = async () => (await user('GET', '/wallet')).body.wallet.balance;

  /* ------------------------------------------------------- admin: products */
  section('Admin: products');
  const productA = await admin('POST', '/admin/products', {
    name: '5 Mukhi Rudraksha Mala', category: 'rudraksha', price: 850, oldPrice: 1200, stock: 5,
    badge: 'Bestseller', highlights: ['Lab certified', '108 beads'], isFeatured: true,
    description: 'Five-faced rudraksha beads strung on a cotton thread.',
  });
  check('creates a product (JSON)', productA.status === 201, productA.body);
  hasFields('the product row', productA.body.product, [
    'id', 'slug', 'name', 'category', 'badge', 'price', 'oldPrice', 'discountPercent', 'stock', 'inStock',
    'rating', 'ratingCount', 'isFeatured', 'status', 'highlights', 'createdAt',
  ]);
  check('slug from name', productA.body.product.slug === '5-mukhi-rudraksha-mala', productA.body.product.slug);
  check('discount is computed', productA.body.product.discountPercent === 29, productA.body.product.discountPercent);
  const A = productA.body.product.id;

  const productB = await admin('POST', '/admin/products', { name: 'Sandalwood Incense Sticks', category: 'incense', price: 299, stock: 2 });
  const B = productB.body.product.id;
  check('oldPrice defaults to null', productB.body.product.oldPrice === null, productB.body.product.oldPrice);

  const clash = await admin('POST', '/admin/products', { name: '5 Mukhi Rudraksha Mala', category: 'rudraksha', price: 900, stock: 1 });
  check('a clashing name gets a numbered slug', clash.body.product?.slug === '5-mukhi-rudraksha-mala-2', clash.body);
  const archived = await admin('DELETE', `/admin/products/${clash.body.product.id}`);
  check('delete archives', archived.body.deleted === true, archived.body);

  const badOld = await admin('POST', '/admin/products', { name: 'Bad', category: 'yantra', price: 100, oldPrice: 90 });
  check('oldPrice must beat price (422)', badOld.status === 422 && badOld.body.fields?.oldPrice, badOld.body);

  const form = new FormData();
  form.append('name', 'Shri Yantra — Silver Plated');
  form.append('category', 'yantra');
  form.append('price', '2500');
  form.append('oldPrice', '3500');
  form.append('stock', '3');
  form.append('isFeatured', 'true');
  form.append('highlights', 'Silver plated\nEnergised by pandits');
  form.append('image', new Blob([PNG], { type: 'image/png' }), 'yantra.png');
  const multipart = await admin('POST', '/admin/products', form);
  check('creates a product (multipart with image)',
    multipart.status === 201 && /\/uploads\/products\//.test(multipart.body.product?.imageUrl || ''), multipart.body);
  check('multipart lists and booleans are typed',
    multipart.body.product?.highlights?.length === 2 && multipart.body.product?.isFeatured === true, multipart.body.product);
  if (multipart.body.product?.imageUrl) rememberUpload(multipart.body.product.imageUrl);
  const C = multipart.body.product.id;

  const edited = await admin('PUT', `/admin/products/${C}`, { name: 'Shri Yantra (Silver)', stock: 4 });
  check('a renamed product gets a fresh slug', edited.body.product?.slug === 'shri-yantra-silver', edited.body);
  const hidden = await admin('PATCH', `/admin/products/${C}/status`, { status: 'hidden' });
  check('status patch', hidden.body.product?.status === 'hidden', hidden.body);

  const adminList = await admin('GET', '/admin/products?limit=100');
  check('admin list shows every status', adminList.body.total === 4, adminList.body.total);
  const forbidden = await finance('GET', '/admin/products');
  check('finance cannot see the shop (403)', forbidden.status === 403, forbidden);
  const contentOk = await content('GET', '/admin/products');
  check('content manager can see the shop', contentOk.status === 200, contentOk.status);

  /* ---------------------------------------------------------- admin: pujas */
  section('Admin: pujas');
  const pujaRes = await admin('POST', '/admin/pujas', {
    name: 'Rudrabhishek', tagline: 'Supreme Shiva Worship', category: 'shiva', categoryLabel: 'Shiva Puja',
    badge: 'Most Powerful', deity: 'Lord Shiva', price: 500, oldPrice: 800, maxPerSlot: 2,
    panditName: 'Pt. Shivkumar Joshi', durationText: '5 hours', benefits: ['Removal of obstacles', 'Peace'],
    isFeatured: true,
  });
  check('creates a puja', pujaRes.status === 201, pujaRes.body);
  hasFields('the puja row', pujaRes.body.puja, [
    'id', 'slug', 'name', 'tagline', 'category', 'categoryLabel', 'badge', 'price', 'oldPrice', 'discountPercent',
    'durationText', 'panditName', 'timeSlots', 'maxPerSlot', 'rating', 'ratingCount', 'status',
  ]);
  check('default time slots', pujaRes.body.puja.timeSlots.length === 14, pujaRes.body.puja.timeSlots);
  const P = pujaRes.body.puja.id;
  const expensive = await admin('POST', '/admin/pujas', { name: 'Grand Yagya', category: 'custom', price: 100000 });
  const E = expensive.body.puja.id;

  /* ------------------------------------------------------- public: catalog */
  section('Public: products and pujas');
  const list = await anon('GET', '/products');
  check('public list is active-only', list.status === 200 && list.body.total === 2, list.body);
  hasFields('list shape', list.body, ['items', 'total', 'page', 'limit', 'categories']);
  hasFields('public product shape', list.body.items[0], [
    'id', 'slug', 'name', 'category', 'imageUrl', 'images', 'price', 'discountPercent', 'rating',
    'ratingCount', 'stock', 'inStock', 'highlights', 'isFeatured',
  ]);
  check('no admin fields leak', list.body.items[0].status === undefined && list.body.items[0].createdBy === undefined);
  check('categories carry counts',
    list.body.categories.some((c) => c.key === 'rudraksha' && c.count === 1 && c.label === 'Rudraksha'), list.body.categories);
  const byCat = await anon('GET', '/products?category=incense');
  check('filter by category', byCat.body.total === 1 && byCat.body.items[0].category === 'incense');
  const cheap = await anon('GET', '/products?sort=price_low');
  check('sort price_low', cheap.body.items[0].id === B);
  const searched = await anon('GET', '/products?search=rudraksha');
  check('search', searched.body.total === 1 && searched.body.items[0].id === A);
  const featured = await anon('GET', '/products?featured=true');
  check('featured filter', featured.body.total === 1);

  const detail = await anon('GET', '/products/5-mukhi-rudraksha-mala');
  check('detail by slug', detail.status === 200 && detail.body.product.id === A && Array.isArray(detail.body.related), detail.body);
  const detailById = await anon('GET', `/products/${A}`);
  check('detail by id', detailById.body.product?.slug === '5-mukhi-rudraksha-mala');
  const hiddenDetail = await anon('GET', '/products/shri-yantra-silver');
  check('hidden product is 404', hiddenDetail.status === 404);

  const pujas = await anon('GET', '/pujas');
  check('public pujas', pujas.body.total === 2 && pujas.body.categories.some((c) => c.key === 'shiva' && c.label === 'Shiva Puja'), pujas.body);
  const pujaDetail = await anon('GET', '/pujas/rudrabhishek');
  hasFields('public puja shape', pujaDetail.body.puja, [
    'id', 'slug', 'name', 'tagline', 'category', 'categoryLabel', 'badge', 'deity', 'benefits', 'price',
    'oldPrice', 'discountPercent', 'durationText', 'panditName', 'rating', 'ratingCount', 'timeSlots',
  ]);

  /* --------------------------------------------------------------- orders */
  section('Orders');
  const topup = await user('POST', '/wallet/topup', { amount: 5000 });
  await user('POST', '/wallet/topup/confirm', { transactionId: topup.body.transactionId });
  check('wallet funded', (await balance()) === 5000);

  const order = await user('POST', '/orders', { items: [{ productId: A, qty: 2 }, { productId: B, qty: 1 }], shipping: SHIPPING });
  check('places an order', order.status === 201, order.body);
  const o = order.body.order;
  hasFields('order shape', o, [
    'id', 'reference', 'user', 'items', 'subtotal', 'tax', 'shippingFee', 'total', 'status',
    'payment.method', 'payment.status', 'payment.walletTransaction', 'shipping.fullName', 'tracking', 'createdAt',
  ]);
  check('reference format', /^ORD-[A-Z0-9]{6}$/.test(o.reference), o.reference);
  check('totals: 1999 + 18% tax, free shipping over 999',
    o.subtotal === 1999 && o.tax === 360 && o.shippingFee === 0 && o.total === 2359, o);
  check('line items carry the product ref', o.items[0].product?.slug === '5-mukhi-rudraksha-mala' && o.items[0].lineTotal === 1700, o.items[0]);
  check('first tracking entry is placed', o.tracking[0]?.status === 'placed' && o.status === 'placed');
  check('wallet debited', (await balance()) === 5000 - 2359);
  const afterA = await anon('GET', `/products/${A}`);
  const afterB = await anon('GET', `/products/${B}`);
  check('stock decremented', afterA.body.product.stock === 3 && afterB.body.product.stock === 1, [afterA.body.product.stock, afterB.body.product.stock]);
  const ledger = await user('GET', '/wallet/transactions?limit=50');
  const debit = ledger.body.items.find((t) => t.type === 'order_payment');
  check('ledger row is order_payment linked to the order',
    debit && debit.direction === 'debit' && debit.amount === 2359 && String(debit.order) === o.id && /Store order ORD-/.test(debit.title), debit);

  const noStock = await user('POST', '/orders', { items: [{ productId: B, qty: 2 }], shipping: SHIPPING });
  check('out_of_stock is a 409 with what is left',
    noStock.status === 409 && noStock.body.code === 'out_of_stock' && noStock.body.details?.available === 1, noStock.body);
  const smallOrder = await user('POST', '/orders', { items: [{ productId: B, qty: 1 }], shipping: SHIPPING });
  check('shipping fee under 999', smallOrder.body.order?.shippingFee === 49 && smallOrder.body.order?.total === 299 + 54 + 49, smallOrder.body.order);
  const broke = await user('POST', '/orders', { items: [{ productId: A, qty: 3 }], shipping: SHIPPING });
  check('insufficient_balance is a 400 with the shortfall',
    broke.status === 400 && broke.body.code === 'insufficient_balance'
      && broke.body.details?.total === 3009 && broke.body.details?.shortfallAmount === 3009 - (5000 - 2359 - 402), broke.body);
  const bad = await user('POST', '/orders', { items: [], shipping: {} });
  check('validation is a 422 with fields', bad.status === 422 && bad.body.fields?.items && bad.body.fields?.['shipping.pincode'], bad.body);
  const anonOrder = await anon('POST', '/orders', { items: [{ productId: A, qty: 1 }], shipping: SHIPPING });
  check('anonymous cannot order', anonOrder.status === 401);

  const mine = await user('GET', '/orders');
  check('lists my orders', mine.body.total === 2 && mine.body.items[0].id === smallOrder.body.order.id, mine.body);
  const active = await user('GET', '/orders?status=active');
  check('active filter', active.body.total === 2);
  const one = await user('GET', `/orders/${o.id}`);
  check('order detail', one.body.order?.id === o.id);
  const nope = await user('GET', '/orders/not-an-id');
  check('unknown order is 404', nope.status === 404);

  const cancelled = await user('POST', `/orders/${o.id}/cancel`);
  check('cancel refunds and restocks', cancelled.status === 200 && cancelled.body.order.status === 'cancelled'
    && cancelled.body.order.payment.status === 'refunded' && cancelled.body.order.payment.refundTransaction
    && cancelled.body.order.tracking.at(-1).status === 'cancelled', cancelled.body);
  check('wallet refunded', (await balance()) === 5000 - 402);
  check('stock restored', (await anon('GET', `/products/${A}`)).body.product.stock === 5);
  const refundRow = (await user('GET', '/wallet/transactions?limit=50')).body.items.find((t) => t.type === 'refund');
  check('refund row links the order', refundRow && refundRow.amount === 2359 && String(refundRow.order) === o.id, refundRow);
  const again = await user('POST', `/orders/${o.id}/cancel`);
  check('cancelling twice is a 409', again.status === 409 && again.body.code === 'not_cancellable', again.body);
  const cancelledList = await user('GET', '/orders?status=cancelled');
  check('cancelled filter', cancelledList.body.total === 1);

  /* --------------------------------------------------- admin: order status */
  section('Admin: order status');
  const S = smallOrder.body.order.id;
  const packed = await admin('PATCH', `/admin/orders/${S}/status`, { status: 'packed' });
  check('placed → packed', packed.body.order?.status === 'packed' && packed.body.order.tracking.length === 2, packed.body);
  const shipped = await admin('PATCH', `/admin/orders/${S}/status`, { status: 'shipped', note: 'BlueDart 123' });
  check('packed → shipped with a note', shipped.body.order?.tracking.at(-1).note === 'BlueDart 123', shipped.body);
  const backwards = await admin('PATCH', `/admin/orders/${S}/status`, { status: 'packed' });
  check('backward move is a 409', backwards.status === 409 && backwards.body.code === 'invalid_transition', backwards.body);
  const same = await admin('PATCH', `/admin/orders/${S}/status`, { status: 'shipped' });
  check('same status is a 409', same.status === 409);
  const userCancelShipped = await user('POST', `/orders/${S}/cancel`);
  check('seeker cannot cancel once shipped', userCancelShipped.status === 409);
  const delivered = await admin('PATCH', `/admin/orders/${S}/status`, { status: 'delivered' });
  check('shipped → delivered sets deliveredAt', delivered.body.order?.status === 'delivered' && delivered.body.order.deliveredAt, delivered.body);
  const cancelDelivered = await admin('PATCH', `/admin/orders/${S}/status`, { status: 'cancelled' });
  check('delivered cannot be cancelled', cancelDelivered.status === 409);

  const third = await user('POST', '/orders', { items: [{ productId: A, qty: 1 }], shipping: SHIPPING });
  const T = third.body.order.id;
  await admin('PATCH', `/admin/orders/${T}/status`, { status: 'shipped' });
  const adminCancel = await admin('PATCH', `/admin/orders/${T}/status`, { status: 'cancelled', note: 'Courier lost it' });
  check('admin cancel refunds and restocks', adminCancel.body.order?.status === 'cancelled' && adminCancel.body.order.payment.status === 'refunded', adminCancel.body);
  check('wallet back after admin cancel', (await balance()) === 5000 - 402);
  check('stock back after admin cancel', (await anon('GET', `/products/${A}`)).body.product.stock === 5);

  const adminOrders = await admin('GET', '/admin/orders?limit=50');
  check('admin order list carries the user', adminOrders.body.total === 3 && adminOrders.body.items[0].user?.name === 'Arjun Sharma', adminOrders.body.items[0]);
  const bySearch = await admin('GET', `/admin/orders?search=${o.reference}`);
  check('admin order search by reference', bySearch.body.total === 1);
  const byName = await admin('GET', '/admin/orders?search=Arjun');
  check('admin order search by name', byName.body.total === 3);
  const adminOne = await admin('GET', `/admin/orders/${S}`);
  hasFields('admin order detail', adminOne.body.order, ['id', 'reference', 'user.name', 'items', 'total', 'status', 'tracking']);
  const noPerm = await finance('PATCH', `/admin/orders/${S}/status`, { status: 'packed' });
  check('finance cannot change orders', noPerm.status === 403);

  /* -------------------------------------------------------------- bookings */
  section('Puja bookings');
  const today = istDateString();
  const tomorrow = dateOffset(today, 1);
  const slots = await anon('GET', `/pujas/rudrabhishek/slots?date=${tomorrow}`);
  check('slots for tomorrow all open', slots.body.date === tomorrow && slots.body.slots.length === 14
    && slots.body.slots.every((s) => s.available && s.left === 2), slots.body);
  const yesterday = await anon('GET', `/pujas/rudrabhishek/slots?date=${dateOffset(today, -1)}`);
  check('a past date is a 422', yesterday.status === 422 && yesterday.body.fields?.date, yesterday.body);

  const b1 = await user('POST', '/puja-bookings', { pujaId: P, date: tomorrow, time: '8:00 AM', contact: CONTACT, notes: 'For my father' });
  check('books a slot', b1.status === 201, b1.body);
  hasFields('booking shape', b1.body.booking, [
    'id', 'reference', 'user', 'puja.slug', 'puja.name', 'pujaSnapshot.name', 'pujaSnapshot.price', 'date', 'time',
    'amount', 'status', 'payment.status', 'payment.walletTransaction', 'contact.fullName', 'notes', 'createdAt',
  ]);
  check('reference format', /^PJB-[A-Z0-9]{6}$/.test(b1.body.booking.reference));
  check('wallet debited for the puja', (await balance()) === 5000 - 402 - 500);
  const bookingRow = (await user('GET', '/wallet/transactions?limit=50')).body.items.find((t) => t.type === 'puja_booking');
  check('ledger row is puja_booking linked to the booking',
    bookingRow && String(bookingRow.pujaBooking) === b1.body.booking.id && /Puja booking PJB-/.test(bookingRow.title), bookingRow);

  const b2 = await user('POST', '/puja-bookings', { pujaId: P, date: tomorrow, time: '8:00 AM', contact: CONTACT });
  check('second booking fills the slot', b2.status === 201);
  const b3 = await user('POST', '/puja-bookings', { pujaId: P, date: tomorrow, time: '8:00 AM', contact: CONTACT });
  check('slot_full at maxPerSlot', b3.status === 409 && b3.body.code === 'slot_full', b3.body);
  check('no charge when the slot was full', (await balance()) === 5000 - 402 - 1000);
  const slotsAfter = await anon('GET', `/pujas/rudrabhishek/slots?date=${tomorrow}`);
  const eight = slotsAfter.body.slots.find((s) => s.time === '8:00 AM');
  const nine = slotsAfter.body.slots.find((s) => s.time === '9:00 AM');
  check('slot counting', eight.left === 0 && eight.available === false && nine.left === 2, slotsAfter.body.slots);
  const badTime = await user('POST', '/puja-bookings', { pujaId: P, date: tomorrow, time: '8:30 AM', contact: CONTACT });
  check('a time not on offer is a 422', badTime.status === 422 && badTime.body.fields?.time, badTime.body);
  const pastDate = await user('POST', '/puja-bookings', { pujaId: P, date: dateOffset(today, -1), time: '8:00 AM', contact: CONTACT });
  check('a past date is a 422', pastDate.status === 422 && pastDate.body.fields?.date, pastDate.body);
  const tooDear = await user('POST', '/puja-bookings', { pujaId: E, date: tomorrow, time: '9:00 AM', contact: CONTACT });
  check('insufficient_balance on a booking', tooDear.status === 400 && tooDear.body.code === 'insufficient_balance' && tooDear.body.details?.shortfallAmount > 0, tooDear.body);
  const bySlug = await user('POST', '/puja-bookings', { pujaId: 'rudrabhishek', date: dateOffset(today, 2), time: '6:00 PM', contact: CONTACT });
  check('pujaId may be the slug', bySlug.status === 201, bySlug.body);

  const upcoming = await user('GET', '/puja-bookings?status=upcoming');
  check('upcoming list, date ascending', upcoming.body.total === 3 && upcoming.body.items[0].date === tomorrow && upcoming.body.items.at(-1).date === dateOffset(today, 2), upcoming.body);
  const bookingDetail = await user('GET', `/puja-bookings/${b1.body.booking.id}`);
  check('booking detail', bookingDetail.body.booking?.id === b1.body.booking.id);

  const cancelB1 = await user('POST', `/puja-bookings/${b1.body.booking.id}/cancel`);
  check('cancel refunds', cancelB1.status === 200 && cancelB1.body.booking.status === 'cancelled'
    && cancelB1.body.booking.payment.status === 'refunded' && cancelB1.body.booking.payment.refundTransaction, cancelB1.body);
  check('wallet refunded for the puja', (await balance()) === 5000 - 402 - 1000);
  check('slot freed', (await anon('GET', `/pujas/rudrabhishek/slots?date=${tomorrow}`)).body.slots.find((s) => s.time === '8:00 AM').left === 1);
  const cancelAgain = await user('POST', `/puja-bookings/${b1.body.booking.id}/cancel`);
  check('cancelling twice is a 409', cancelAgain.status === 409 && cancelAgain.body.code === 'not_cancellable');

  const earlyRate = await user('POST', `/puja-bookings/${b2.body.booking.id}/rate`, { rating: 5 });
  check('cannot rate before completion', earlyRate.status === 409, earlyRate.body);
  const completed = await admin('PATCH', `/admin/puja-bookings/${b2.body.booking.id}`, { status: 'completed', streamUrl: 'https://youtube.com/live/x' });
  check('admin marks completed', completed.body.booking?.status === 'completed' && completed.body.booking.completedAt && completed.body.booking.streamUrl, completed.body);
  const rated = await user('POST', `/puja-bookings/${b2.body.booking.id}/rate`, { rating: 5, comment: 'Divine.' });
  check('rates once completed', rated.status === 200 && rated.body.booking.rating === 5 && rated.body.booking.ratedAt, rated.body);
  const pujaRated = await anon('GET', '/pujas/rudrabhishek');
  check('puja rating moves', pujaRated.body.puja.rating === 5 && pujaRated.body.puja.ratingCount === 1, pujaRated.body.puja);
  const rateAgain = await user('POST', `/puja-bookings/${b2.body.booking.id}/rate`, { rating: 4 });
  check('rating twice is a 409', rateAgain.status === 409 && rateAgain.body.code === 'already_rated');
  const cancelCompleted = await user('POST', `/puja-bookings/${b2.body.booking.id}/cancel`);
  check('a completed booking cannot be cancelled', cancelCompleted.status === 409);
  const completedList = await user('GET', '/puja-bookings?status=completed');
  check('completed filter', completedList.body.total === 1);

  const adminCancel2 = await admin('PATCH', `/admin/puja-bookings/${bySlug.body.booking.id}`, { status: 'cancelled', adminNote: 'Pandit unavailable' });
  check('admin cancel refunds', adminCancel2.body.booking?.status === 'cancelled' && adminCancel2.body.booking.payment.status === 'refunded', adminCancel2.body);
  check('wallet refunded by admin', (await balance()) === 5000 - 402 - 500);
  const adminBookings = await admin('GET', `/admin/puja-bookings?date=${tomorrow}`);
  check('admin bookings by date, with the user', adminBookings.body.total === 2 && adminBookings.body.items[0].user?.name === 'Arjun Sharma', adminBookings.body);
  const adminBookingSearch = await admin('GET', '/admin/puja-bookings?search=Rudrabhishek');
  check('admin bookings search', adminBookingSearch.body.total === 3);
  const adminBooking = await admin('GET', `/admin/puja-bookings/${b2.body.booking.id}`);
  hasFields('admin booking detail', adminBooking.body.booking, ['id', 'reference', 'user.name', 'puja.name', 'date', 'time', 'amount', 'status', 'rating', 'streamUrl']);
  const pujaHidden = await admin('PATCH', `/admin/pujas/${E}/status`, { status: 'hidden' });
  check('puja status patch', pujaHidden.body.puja?.status === 'hidden');
  const pujaGone = await admin('DELETE', `/admin/pujas/${E}`);
  check('puja delete archives', pujaGone.body.deleted === true);
  check('archived puja leaves the public list', (await anon('GET', '/pujas')).body.total === 1);

  /* -------------------------------------------------------------- articles */
  section('Articles');
  const words = Array.from({ length: 420 }, (_, i) => `word${i}`).join(' ');
  const a1 = await admin('POST', '/admin/articles', {
    title: 'Mercury Retrograde August 2026', category: 'Astrology Tips', author: 'Pandit Ramesh Sharma',
    excerpt: 'What every sign needs to know.', body: words, status: 'published', visibility: 'everyone',
    tags: ['astrology', 'retrograde'],
  });
  check('published article with readMinutes and tags', a1.status === 201 && a1.body.article.readMinutes === 2
    && a1.body.article.tags.length === 2 && a1.body.article.id && a1.body.article.publishedAt, a1.body);
  const a2 = await admin('POST', '/admin/articles', {
    title: 'Members Only: Your Saturn Return', category: 'Astrology Tips', author: 'Guruji S. Agarwal',
    excerpt: 'For signed-in readers.', body: 'Short body.', status: 'published', visibility: 'users',
  });
  await admin('POST', '/admin/articles', { title: 'A Draft', category: 'Vastu Tips', body: 'Not yet.', status: 'draft' });

  const coverForm = new FormData();
  coverForm.append('title', 'Vastu for Your Home Office');
  coverForm.append('category', 'Vastu Tips');
  coverForm.append('body', 'Seven simple changes.');
  coverForm.append('status', 'published');
  coverForm.append('tags', 'vastu, office');
  coverForm.append('coverImage', new Blob([PNG], { type: 'image/png' }), 'cover.png');
  const a3 = await admin('POST', '/admin/articles', coverForm);
  check('multipart article with a cover image', a3.status === 201 && /\/uploads\/articles\//.test(a3.body.article?.coverImageUrl || '')
    && a3.body.article.tags.length === 2, a3.body);
  if (a3.body.article?.coverImageUrl) rememberUpload(a3.body.article.coverImageUrl);

  const publicList = await anon('GET', '/articles');
  check('anonymous sees only public published pieces', publicList.body.total === 2, publicList.body);
  hasFields('article list item', publicList.body.items[0], ['id', 'slug', 'title', 'category', 'excerpt', 'publishedAt', 'readMinutes', 'views', 'tags']);
  check('list items carry no body', publicList.body.items.every((a) => a.body === undefined));
  check('categories are label + count', publicList.body.categories.some((c) => c.key === 'Astrology Tips' && c.count === 1), publicList.body.categories);
  const memberList = await user('GET', '/articles');
  check('a signed-in reader also sees members-only pieces', memberList.body.total === 3, memberList.body.total);
  const byCategory = await anon('GET', '/articles?category=Vastu%20Tips');
  check('category filter', byCategory.body.total === 1);
  const bySearchA = await anon('GET', '/articles?search=mercury');
  check('search', bySearchA.body.total === 1);

  const read1 = await anon('GET', `/articles/${a1.body.article.slug}`);
  check('detail carries the body and counts a view', read1.status === 200 && read1.body.article.body === words && read1.body.article.views === 1, read1.body);
  const read2 = await anon('GET', `/articles/${a1.body.article.slug}`);
  check('views increment', read2.body.article.views === 2);
  const memberAnon = await anon('GET', `/articles/${a2.body.article.slug}`);
  check('members-only is 404 anonymously', memberAnon.status === 404);
  const memberAuth = await user('GET', `/articles/${a2.body.article.slug}`);
  check('members-only opens when signed in', memberAuth.status === 200);
  const draft = await anon('GET', '/articles/a-draft');
  check('a draft is 404', draft.status === 404);

  const renamed = await admin('PUT', `/admin/articles/${a1.body.article.id}`, { title: 'Mercury Retrograde: A Survival Guide' });
  check('slug follows a changed title', renamed.body.article?.slug === 'mercury-retrograde-a-survival-guide', renamed.body);
  const customSlug = await admin('PUT', `/admin/articles/${a1.body.article.id}`, { title: 'Another Title', slug: 'my-custom-slug' });
  check('an explicit slug wins', customSlug.body.article?.slug === 'my-custom-slug', customSlug.body);
  const slugClash = await admin('POST', '/admin/articles', { title: 'Another Title', body: 'x', status: 'draft' });
  check('article slug clash gets a suffix', slugClash.body.article?.slug === 'another-title', slugClash.body);
  const slugClash2 = await admin('POST', '/admin/articles', { title: 'Another Title', body: 'x', status: 'draft' });
  check('…and the next one -2', slugClash2.body.article?.slug === 'another-title-2', slugClash2.body);
  const adminArticle = await admin('GET', `/admin/articles/${a1.body.article.id}`);
  check('admin reads one article', adminArticle.body.article?.id === a1.body.article.id && adminArticle.body.article.body === words);

  /* ----------------------------------------------------- dashboard + audit */
  section('Dashboard, audit, notifications');
  const dash = await admin('GET', '/admin/dashboard');
  hasFields('dashboard tiles', dash.body, ['shop.ordersToday', 'shop.pendingOrders', 'shop.revenue30d', 'pujas.bookingsToday', 'pujas.upcoming', 'users.total']);
  check('dashboard numbers', dash.body.shop.ordersToday === 3 && dash.body.shop.revenue30d === 402 && dash.body.pujas.bookingsToday === 3 && dash.body.pujas.upcoming === 0, dash.body);
  const logs = await admin('GET', '/admin/audit-logs?limit=200');
  const areas = new Set(logs.body.items.map((r) => r.area));
  check('audit rows in Shop, Pujas and Content', areas.has('Shop') && areas.has('Pujas') && areas.has('Content'), [...areas]);
  const shopLogs = await admin('GET', '/admin/audit-logs?area=Shop');
  check('audit filter by area', shopLogs.body.items.length > 0 && shopLogs.body.items.every((r) => r.area === 'Shop'));
  const notes = await user('GET', '/notifications?limit=50');
  const types = new Set(notes.body.items.map((n) => n.type));
  check('seeker got order and booking notifications', types.has('order') && types.has('booking'), [...types]);
  const orderNote = notes.body.items.find((n) => n.type === 'order');
  check('notification action points at the order', orderNote.action?.screen === 'order' && orderNote.action?.id, orderNote);
  const Admin2 = require('../models/Admin');
  check('content_manager holds the shop and puja permissions',
    ['shop.view', 'shop.manage', 'pujas.view', 'pujas.manage'].every((p) => Admin2.ROLE_PERMISSIONS.content_manager.includes(p)));

  /* ----------------------------------------------------------- races */
  section('Races: the last unit, the last place');
  const before = await balance();
  const scarce = await admin('POST', '/admin/products', { name: 'Last One', category: 'yantra', price: 100, stock: 1 });
  const rush = await Promise.all(Array.from({ length: 4 }, () =>
    user('POST', '/orders', { items: [{ productId: scarce.body.product.id, qty: 1 }], shipping: SHIPPING })));
  const wins = rush.filter((r) => r.status === 201);
  check('four parallel orders for one unit: exactly one wins',
    wins.length === 1 && rush.filter((r) => r.status === 409 && r.body.code === 'out_of_stock').length === 3,
    rush.map((r) => `${r.status} ${r.body.code || ''}`));
  check('and only one was charged', (await balance()) === before - 167);
  check('stock is exactly zero', (await anon('GET', `/products/${scarce.body.product.id}`)).body.product.stock === 0);

  const tight = await admin('POST', '/admin/pujas', { name: 'Tight Slot', category: 'custom', price: 100, maxPerSlot: 2 });
  const crowd = await Promise.all(Array.from({ length: 5 }, () =>
    user('POST', '/puja-bookings', { pujaId: tight.body.puja.id, date: tomorrow, time: '10:00 AM', contact: CONTACT })));
  check('five parallel bookings for two places: exactly two win',
    crowd.filter((r) => r.status === 201).length === 2
      && crowd.filter((r) => r.status === 409 && r.body.code === 'slot_full').length === 3,
    crowd.map((r) => `${r.status} ${r.body.code || ''}`));
  check('and exactly two were charged', (await balance()) === before - 167 - 200);
  const tightSlots = await anon('GET', `/pujas/${tight.body.puja.slug}/slots?date=${tomorrow}`);
  check('the slot reads full', tightSlots.body.slots.find((s) => s.time === '10:00 AM').left === 0);

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
