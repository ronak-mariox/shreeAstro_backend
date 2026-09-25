/**
 * Product images (cover + gallery) and product reviews — end to end over HTTP.
 *
 * Needs a MongoDB *replica set* (orders run in transactions, and the admin
 * reviews queue uses $unionWith), so point TEST_MONGODB_URI at one, e.g.
 *   mongodb://127.0.0.1:27117/shree_astro_test_product_reviews?replicaSet=rs0
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_product_reviews';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test:';
process.env.NODE_ENV = 'development';
process.env.OTP_MASTER_CODE = '123456';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connectRedis, redis } = require('../config/redis');
const { createApp } = require('../app');
const { hashPassword } = require('../utils/password');
const astrologyApiClient = require('../services/astrologyApi.client');
const s3Service = require('../services/s3.service');

const PORT = 5095;
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
const png = (name) => new Blob([PNG], { type: 'image/png' });
const PRODUCTS_DIR = path.join(__dirname, '..', 'uploads', 'products');
const uploadedFiles = [];
const rememberUpload = (url) => {
  const relative = (url || '').split('/uploads/')[1];
  if (relative) uploadedFiles.push(path.join(__dirname, '..', 'uploads', relative));
};
/** Whatever landed under uploads/products during the run that no response named (a refused write). */
const listProductsDir = () => (fs.existsSync(PRODUCTS_DIR) ? fs.readdirSync(PRODUCTS_DIR) : []);
const filesBefore = new Set(listProductsDir());
const cleanupUploads = () => {
  for (const file of uploadedFiles) fs.rmSync(file, { force: true });
  for (const name of listProductsDir()) {
    if (!filesBefore.has(name)) fs.rmSync(path.join(PRODUCTS_DIR, name), { force: true });
  }
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

async function register({ fullName, email, phone }) {
  const res = await fetch(`${BASE}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName, email, phone, gender: 'male', dateOfBirth: '15/08/1995', timeOfBirth: '04:20 AM',
      placeOfBirth: 'Jaipur, Rajasthan',
    }),
  });
  return { status: res.status, body: await res.json() };
}

const SHIPPING = {
  fullName: 'Arjun Sharma', phone: '9876543210', email: 'arjun@example.com',
  address: '12 MG Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001',
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  /** The drop took the indexes with it; the one-review-per-order rule is a unique index. */
  await Promise.all(Object.values(mongoose.models).map((Model) => Model.syncIndexes()));
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
  ]);
  const admin = api(await adminLogin('admin@shreeastro.com', 'admin@123'));
  const finance = api(await adminLogin('finance@shreeastro.com', 'admin@123'));
  const anon = api();

  const arjunReg = await register({ fullName: 'Arjun Sharma', email: 'arjun@example.com', phone: '9876543210' });
  const arjun = api(arjunReg.body.accessToken);
  const priyaReg = await register({ fullName: 'Priya Sharma', email: 'priya@example.com', phone: '9876500001' });
  const priya = api(priyaReg.body.accessToken);
  for (const caller of [arjun, priya]) {
    // eslint-disable-next-line no-await-in-loop
    const topup = await caller('POST', '/wallet/topup', { amount: 20000 });
    // eslint-disable-next-line no-await-in-loop
    await caller('POST', '/wallet/topup/confirm', { transactionId: topup.body.transactionId });
  }

  /* ------------------------------------------------- admin: product images */
  section('Admin: product images (cover + gallery)');
  const form = new FormData();
  form.append('name', 'Shri Yantra — Silver Plated');
  form.append('category', 'yantra');
  form.append('price', '2500');
  form.append('stock', '10');
  form.append('image', png(), 'cover.png');
  form.append('images', png(), 'g1.png');
  form.append('images', png(), 'g2.png');
  form.append('images', png(), 'g3.png');
  const created = await admin('POST', '/admin/products', form);
  check('creates a product with a cover and 3 gallery files', created.status === 201, created.body);
  const product = created.body.product || {};
  check('cover stored under uploads/products', /\/uploads\/products\//.test(product.imageUrl || ''), product.imageUrl);
  check('gallery has 3 URLs under uploads/products',
    Array.isArray(product.images) && product.images.length === 3 && product.images.every((u) => /\/uploads\/products\//.test(u)), product.images);
  check('cover is not one of the gallery URLs', !(product.images || []).includes(product.imageUrl));
  rememberUpload(product.imageUrl);
  (product.images || []).forEach(rememberUpload);
  const A = product.id;
  const SLUG = product.slug;
  const [g1, g2, g3] = product.images;

  const noCover = await admin('POST', '/admin/products', {
    name: 'Sandalwood Incense', category: 'incense', price: 299, stock: 10,
    images: ['https://cdn.example.com/incense-1.jpg', 'https://cdn.example.com/incense-2.jpg'],
  });
  check('JSON create with a gallery but no cover: cover becomes the first gallery image',
    noCover.status === 201 && noCover.body.product.imageUrl === 'https://cdn.example.com/incense-1.jpg' && noCover.body.product.images.length === 2, noCover.body);
  const B = noCover.body.product.id;

  const keepForm = new FormData();
  keepForm.append('keepImages', JSON.stringify([g3, g1]));
  keepForm.append('images', png(), 'g4.png');
  const kept = await admin('PUT', `/admin/products/${A}`, keepForm);
  check('update with keepImages drops one and appends the upload, in order',
    kept.status === 200 && kept.body.product.images.length === 3
      && kept.body.product.images[0] === g3 && kept.body.product.images[1] === g1 && !kept.body.product.images.includes(g2)
      && /\/uploads\/products\//.test(kept.body.product.images[2]), kept.body);
  rememberUpload(kept.body.product?.images?.[2]);
  check('the cover is untouched by a gallery edit', kept.body.product?.imageUrl === product.imageUrl);
  const g4 = kept.body.product.images[2];

  const promoted = await admin('PUT', `/admin/products/${A}`, { imageUrl: g3 });
  check('a gallery URL can be promoted to cover', promoted.body.product?.imageUrl === g3 && promoted.body.product.images.length === 3, promoted.body);
  const dropCover = await admin('PUT', `/admin/products/${A}`, { keepImages: [g1, g4] });
  check('removing the cover URL from the gallery keeps the cover as it is',
    dropCover.body.product?.imageUrl === g3 && dropCover.body.product.images.length === 2 && !dropCover.body.product.images.includes(g3), dropCover.body);

  const untouched = await admin('PUT', `/admin/products/${A}`, { stock: 9 });
  check('an update without keepImages leaves the gallery alone', untouched.body.product?.images?.length === 2 && untouched.body.product.stock === 9, untouched.body);

  const appendForm = new FormData();
  appendForm.append('images', png(), 'g5.png');
  appendForm.append('images', png(), 'g6.png');
  appendForm.append('images', png(), 'g7.png');
  appendForm.append('images', png(), 'g8.png');
  appendForm.append('images', png(), 'g9.png');
  appendForm.append('images', png(), 'g10.png');
  const appended = await admin('PUT', `/admin/products/${A}`, appendForm);
  check('uploads without keepImages are appended (2 + 6 = 8)', appended.status === 200 && appended.body.product.images.length === 8, appended.body);
  (appended.body.product?.images || []).forEach(rememberUpload);

  const ninthForm = new FormData();
  ninthForm.append('images', png(), 'g11.png');
  const ninth = await admin('PUT', `/admin/products/${A}`, ninthForm);
  check('a 9th image is a 422 on images', ninth.status === 422 && /Up to 8 images/.test(ninth.body.fields?.images || ''), ninth.body);
  const stillEight = await admin('GET', '/admin/products?limit=100');
  const adminRow = stillEight.body.items.find((p) => p.id === A);
  check('admin list carries images and the refusal changed nothing', adminRow?.images?.length === 8 && adminRow.imageUrl === g3, adminRow);
  const tooMany = new FormData();
  for (let i = 0; i < 7; i += 1) tooMany.append('images', png(), `x${i}.png`);
  const rejected = await admin('PUT', `/admin/products/${A}`, tooMany);
  check('more than 6 gallery files in one request is refused', rejected.status === 400, rejected.body);

  const publicDetail = await anon('GET', `/products/${SLUG}`);
  check('public product carries the gallery', publicDetail.body.product?.images?.length === 8 && publicDetail.body.product.imageUrl === g3, publicDetail.body.product);

  /* ---------------------------------------------------------------- orders */
  section('Orders for the reviews');
  const o1 = await arjun('POST', '/orders', { items: [{ productId: A, qty: 1 }, { productId: B, qty: 2 }], shipping: SHIPPING });
  const o2 = await arjun('POST', '/orders', { items: [{ productId: B, qty: 1 }], shipping: SHIPPING });
  const o3 = await priya('POST', '/orders', { items: [{ productId: A, qty: 1 }], shipping: SHIPPING });
  check('three orders placed', o1.status === 201 && o2.status === 201 && o3.status === 201, [o1.body, o2.body, o3.body]);
  const O1 = o1.body.order.id, O2 = o2.body.order.id, O3 = o3.body.order.id;

  /* --------------------------------------------------------- write reviews */
  section('POST /products/:slug/reviews');
  const early = await arjun('POST', `/products/${SLUG}/reviews`, { orderId: O1, rating: 5, comment: 'Beautiful finish.' });
  check('refused before delivery (400 not_delivered)', early.status === 400 && early.body.code === 'not_delivered' && /delivered/.test(early.body.error), early.body);
  const pending = await arjun('GET', `/orders/${O1}`);
  check('undelivered order items: canReview false, review null',
    pending.body.order?.items.every((i) => i.canReview === false && i.review === null), pending.body.order?.items);

  for (const id of [O1, O2, O3]) {
    // eslint-disable-next-line no-await-in-loop
    await admin('PATCH', `/admin/orders/${id}/status`, { status: 'delivered' });
  }
  const notInOrder = await arjun('POST', `/products/${SLUG}/reviews`, { orderId: O2, rating: 5, comment: 'Lovely.' });
  check('refused for an order not containing the product (400 not_in_order)', notInOrder.status === 400 && notInOrder.body.code === 'not_in_order', notInOrder.body);
  const someoneElses = await arjun('POST', `/products/${SLUG}/reviews`, { orderId: O3, rating: 5, comment: 'Lovely.' });
  check("someone else's order is a 404", someoneElses.status === 404, someoneElses.body);
  const badBody = await arjun('POST', `/products/${SLUG}/reviews`, { orderId: 'nope', rating: 9, comment: 'x' });
  check('validation is a 422 with fields', badBody.status === 422 && badBody.body.fields?.orderId && badBody.body.fields?.rating && badBody.body.fields?.comment, badBody.body);
  const anonReview = await anon('POST', `/products/${SLUG}/reviews`, { orderId: O1, rating: 5, comment: 'Lovely.' });
  check('anonymous cannot review', anonReview.status === 401);
  const unknownProduct = await arjun('POST', '/products/no-such-thing/reviews', { orderId: O1, rating: 5, comment: 'Lovely.' });
  check('unknown product is a 404', unknownProduct.status === 404);

  const r1 = await arjun('POST', `/products/${SLUG}/reviews`, { orderId: O1, rating: 5, title: 'Stunning', comment: 'Beautiful finish, arrived well packed.' });
  check('creates a review (201)', r1.status === 201, r1.body);
  hasFields('review + product numbers', r1.body, ['review.id', 'review.rating', 'review.title', 'review.comment', 'review.pinned', 'review.createdAt', 'review.reviewer.name', 'review.verified', 'product.rating', 'product.ratingCount']);
  check('reviewer name is masked, verified purchase', r1.body.review?.reviewer.name === 'Arjun S.' && r1.body.review.verified === true, r1.body.review);
  check('product rating moves to 5.0 / 1', r1.body.product?.rating === 5 && r1.body.product.ratingCount === 1, r1.body.product);
  const afterOne = await anon('GET', `/products/${SLUG}`);
  check('public product shows the new rating', afterOne.body.product.rating === 5 && afterOne.body.product.ratingCount === 1, afterOne.body.product);
  const again = await arjun('POST', `/products/${SLUG}/reviews`, { orderId: O1, rating: 4, comment: 'Second thoughts.' });
  check('same order again is a 409 already_reviewed', again.status === 409 && again.body.code === 'already_reviewed', again.body);

  /* Photos: multipart with `images` (≤3). A refused multipart review must not leave files behind. */
  const reviewUploadsDir = path.join(__dirname, '..', 'uploads', 'reviews');
  const countReviewUploads = () => (fs.existsSync(reviewUploadsDir) ? fs.readdirSync(reviewUploadsDir).length : 0);
  const uploadsBefore = countReviewUploads();
  const refusedForm = new FormData();
  refusedForm.append('orderId', O1); refusedForm.append('rating', '4'); refusedForm.append('comment', 'With a photo, but already reviewed.');
  refusedForm.append('images', png(), 'dup.png');
  const refused = await arjun('POST', `/products/${SLUG}/reviews`, refusedForm);
  check('a refused multipart review is still a 409', refused.status === 409, refused.body);
  check('…and its photo was discarded', countReviewUploads() === uploadsBefore, { before: uploadsBefore, after: countReviewUploads() });
  const tooManyPhotos = new FormData();
  tooManyPhotos.append('orderId', O3); tooManyPhotos.append('rating', '3'); tooManyPhotos.append('comment', 'Four photos.');
  for (let i = 0; i < 4; i += 1) tooManyPhotos.append('images', png(), `p${i}.png`);
  const overLimit = await priya('POST', `/products/${SLUG}/reviews`, tooManyPhotos);
  check('a 4th photo is refused (400)', overLimit.status === 400, overLimit.body);

  const r2Form = new FormData();
  r2Form.append('orderId', O3); r2Form.append('rating', '3'); r2Form.append('comment', 'Smaller than I expected.');
  r2Form.append('images', png(), 'a.png'); r2Form.append('images', png(), 'b.png');
  const r2 = await priya('POST', `/products/${SLUG}/reviews`, r2Form);
  check('a second buyer reviews from their own order — multipart with 2 photos', r2.status === 201 && r2.body.product.rating === 4 && r2.body.product.ratingCount === 2, r2.body);
  (r2.body.review?.images || []).forEach((url) => rememberUpload(url));
  check('the review carries both photo URLs', Array.isArray(r2.body.review?.images) && r2.body.review.images.length === 2 && r2.body.review.images.every((u) => /\/reviews\//.test(u)), r2.body.review?.images);
  check('the JSON review has an empty images list', Array.isArray(r1.body.review?.images) && r1.body.review.images.length === 0, r1.body.review?.images);
  const R1 = r1.body.review.id, R2 = r2.body.review.id;

  const detail = await arjun('GET', `/orders/${O1}`);
  const lineA = detail.body.order?.items.find((i) => i.product?.id === A);
  const lineB = detail.body.order?.items.find((i) => i.product?.id === B);
  check('delivered order: reviewed item carries review { id, rating } and canReview false',
    lineA?.review?.id === R1 && lineA.review.rating === 5 && lineA.canReview === false, lineA);
  check('delivered order: unreviewed item has review null and canReview true', lineB?.review === null && lineB.canReview === true, lineB);
  const list = await arjun('GET', '/orders');
  check('the orders list is unchanged (no review fields)', list.body.items[0].items[0].canReview === undefined);

  /* ----------------------------------------------------------- public list */
  section('GET /products/:slug/reviews');
  const pub = await anon('GET', `/products/${SLUG}/reviews`);
  check('public list loads', pub.status === 200 && pub.body.total === 2, pub.body);
  hasFields('list shape', pub.body, ['items', 'total', 'page', 'limit', 'summary.average', 'summary.count', 'summary.distribution']);
  hasFields('item shape', pub.body.items[0], ['id', 'rating', 'comment', 'images', 'pinned', 'createdAt', 'reviewer.name', 'verified']);
  check('public list shows the photos on the multipart review', pub.body.items.find((r) => r.id === R2)?.images.length === 2, pub.body.items.map((r) => r.images));
  check('newest first', pub.body.items[0].id === R2 && pub.body.items[1].id === R1, pub.body.items.map((r) => r.id));
  check('no moderation or identity fields leak', pub.body.items.every((r) => r.hidden === undefined && r.user === undefined && r.flagged === undefined));
  check('summary: 4.0 of 2, distribution', pub.body.summary.average === 4 && pub.body.summary.count === 2
    && pub.body.summary.distribution[5] === 1 && pub.body.summary.distribution[3] === 1 && pub.body.summary.distribution[1] === 0, pub.body.summary);
  const fives = await anon('GET', `/products/${SLUG}/reviews?rating=5`);
  check('rating filter narrows the items, not the summary', fives.body.total === 1 && fives.body.items[0].rating === 5 && fives.body.summary.count === 2, fives.body);
  const badFilter = await anon('GET', `/products/${SLUG}/reviews?rating=7`);
  check('bad rating filter is a 422', badFilter.status === 422);
  const byId = await anon('GET', `/products/${A}/reviews?limit=1`);
  check('by id, paginated', byId.body.total === 2 && byId.body.items.length === 1 && byId.body.limit === 1, byId.body);
  check('unknown product is a 404', (await anon('GET', '/products/nope/reviews')).status === 404);

  /* ------------------------------------------------------------ moderation */
  section('Admin moderation: /admin/reviews kind=product');
  const queue = await admin('GET', '/admin/reviews?kind=product');
  check('admin lists product reviews', queue.status === 200 && queue.body.total === 2, queue.body);
  check('admin rows carry the photos', queue.body.items.find((r) => r.id === R2)?.images?.length === 2, queue.body.items.map((r) => r.images));
  const row = queue.body.items.find((r) => r.id === R1);
  hasFields('admin product review row', row, ['id', 'kind', 'rating', 'title', 'comment', 'pinned', 'hidden', 'flagged', 'createdAt', 'reviewer.name', 'product.id', 'product.name', 'product.slug', 'user.id']);
  check('row names the product and the full reviewer', row?.kind === 'product' && row.product.slug === SLUG && row.reviewer.name === 'Arjun Sharma' && row.title === 'Stunning', row);
  const all = await admin('GET', '/admin/reviews');
  check('the admin queue without a kind includes product reviews', all.body.total === 2 && all.body.items.every((r) => r.kind === 'product'), all.body);
  const searched = await admin('GET', '/admin/reviews?search=yantra');
  check('admin search matches the product name', searched.body.total === 2, searched.body);
  const searchedTitle = await admin('GET', '/admin/reviews?search=stunning');
  check('admin search matches the title', searchedTitle.body.total === 1 && searchedTitle.body.items[0].id === R1, searchedTitle.body);

  const pinned = await admin('PATCH', `/admin/reviews/product/${R2}`, { pinned: true, reply: 'Thank you — do write to us about the size.' });
  check('pin + reply', pinned.status === 200 && pinned.body.review.pinned === true && pinned.body.review.reply && pinned.body.review.kind === 'product', pinned.body);
  const afterPin = await anon('GET', `/products/${SLUG}/reviews`);
  check('pinned first on the product page, with the reply', afterPin.body.items[0].id === R2 && afterPin.body.items[0].pinned === true && /size/.test(afterPin.body.items[0].reply), afterPin.body.items);

  const hidden = await admin('PATCH', `/admin/reviews/product/${R1}`, { hidden: true });
  check('hide', hidden.body.review?.hidden === true, hidden.body);
  const afterHide = await anon('GET', `/products/${SLUG}/reviews`);
  check('hidden review leaves the public list and the summary', afterHide.body.total === 1 && afterHide.body.items[0].id === R2 && afterHide.body.summary.count === 1 && afterHide.body.summary.average === 3, afterHide.body);
  const ratingAfterHide = await anon('GET', `/products/${SLUG}`);
  check('product rating recomputed from the visible reviews (3.0 / 1)', ratingAfterHide.body.product.rating === 3 && ratingAfterHide.body.product.ratingCount === 1, ratingAfterHide.body.product);
  const hiddenQueue = await admin('GET', '/admin/reviews?kind=product&hidden=true');
  check('admin hidden filter', hiddenQueue.body.total === 1 && hiddenQueue.body.items[0].id === R1);
  const unhidden = await admin('PATCH', `/admin/reviews/product/${R1}`, { hidden: false });
  check('unhide restores the rating', unhidden.body.review?.hidden === false && (await anon('GET', `/products/${SLUG}`)).body.product.rating === 4);
  const flagged = await admin('PATCH', `/admin/reviews/product/${R1}`, { flagged: true, flagReason: 'Check the photo' });
  check('flag', flagged.body.review?.flagged === true && flagged.body.review.flagReason === 'Check the photo');
  check('a flagged product review still shows on the product page', (await anon('GET', `/products/${SLUG}/reviews`)).body.total === 2);
  const flaggedQueue = await admin('GET', '/admin/reviews?kind=product&flagged=true');
  check('admin flagged filter', flaggedQueue.body.total === 1 && flaggedQueue.body.items[0].id === R1);

  const siteReviews = await anon('GET', '/reviews');
  check('the site reviews page still defaults to consultations + pujas (no products)', siteReviews.status === 200 && siteReviews.body.total === 0, siteReviews.body);
  const siteProducts = await anon('GET', '/reviews?kind=product');
  check('GET /reviews?kind=product lists the visible, unflagged product reviews', siteProducts.body.total === 1 && siteProducts.body.items[0].kind === 'product' && siteProducts.body.items[0].product?.name === 'Shri Yantra — Silver Plated' && siteProducts.body.items[0].reviewer.name === 'Priya S.', siteProducts.body);

  const unknownId = await admin('PATCH', `/admin/reviews/product/${new mongoose.Types.ObjectId()}`, { hidden: true });
  check('unknown review is a 404', unknownId.status === 404);
  const badKind = await admin('PATCH', `/admin/reviews/article/${R1}`, { hidden: true });
  check('unknown kind is a 422', badKind.status === 422);
  const noPerm = await finance('PATCH', `/admin/reviews/product/${R1}`, { pinned: true });
  check('finance does not hold reviews.manage', noPerm.status === 403);
  const logs = await admin('GET', '/admin/audit-logs?area=Reviews');
  check('moderation is audited', logs.body.items.some((r) => /product review/i.test(r.action)), logs.body.items.map((r) => r.action));

  astrologyApiClient.request = originalAstrologyRequest;
  cleanupUploads();

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await redis.quit();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  astrologyApiClient.request = originalAstrologyRequest;
  cleanupUploads();
  console.error('CRASHED:', e);
  process.exit(1);
});
