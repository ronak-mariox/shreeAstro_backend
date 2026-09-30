/**
 * The store, the pujas, and the public side of the content library.
 *
 * Money only ever moves through services/wallet.service.js's `post()`. What
 * this file adds is the pairing of that debit with the thing it pays for —
 * stock coming off a product, a booking landing in a slot — inside one Mongo
 * transaction, so a crash or a race can never leave a seeker charged for
 * nothing, or two seekers holding the last unit.
 */

const mongoose = require('mongoose');

const Product = require('../models/Product');
const ProductReview = require('../models/ProductReview');
const Order = require('../models/Order');
const Puja = require('../models/Puja');
const PujaBooking = require('../models/PujaBooking');
const Article = require('../models/Article');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { istDateString, dateOffset, startOfIstDay } = require('../utils/istDate');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const couponService = require('./coupon.service');
const growthHooks = require('./growthHooks.service');
const { maskedName } = require('./referral.service');

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Turns `page`/`limit` into what Mongo wants (same rule as admin.service). */
function paging({ page = 1, limit = 20 }) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  return { skip: (current - 1) * size, limit: size, page: current };
}

const escapeRegex = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `{ _id }` for an ObjectId-looking value, `{ slug }` otherwise. */
function bySlugOrId(value) {
  const text = String(value || '').trim().toLowerCase();
  return mongoose.isValidObjectId(text) ? { $or: [{ _id: text }, { slug: text }] } : { slug: text };
}

/** Runs `work(session)` inside one Mongo transaction and returns its result. */
async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * The seeker's balance is checked before the transaction opens so the refusal
 * can carry the exact shortfall. `post()` guards again atomically inside it,
 * so a race between two purchases still cannot overdraw — that second refusal
 * is mapped to the same `insufficient_balance` shape here.
 */
async function assertBalance(userId, total, what) {
  const user = await User.findById(userId).select('wallet.balance');
  if (!user) {
    throw ApiError.notFound('Account not found.');
  }
  const balance = user.wallet?.balance || 0;
  if (balance < total) {
    throw insufficientBalance({ total, balance, what });
  }
  return balance;
}

function insufficientBalance({ total, balance, what }) {
  const shortfallAmount = total - balance;
  return ApiError.badRequest(
    `You need ₹${shortfallAmount} more in your wallet for this ${what} (₹${total}).`,
    undefined,
    'insufficient_balance',
  ).withDetails({ total, balance, shortfallAmount });
}

const isBalanceRefusal = error =>
  error instanceof ApiError && error.status === 400 && /Not enough balance/.test(error.message);

/** Sentence-cases a kebab key: 'crystals-pyrite' → 'Crystals Pyrite'. */
const labelFor = key =>
  String(key || '')
    .split('-')
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ');

/** The store's own spellings, where a plain title-case would read wrong. */
const PRODUCT_CATEGORY_LABELS = {
  'crystals-pyrite': 'Crystals & Pyrite',
  'puja-kits': 'Puja Kits',
  'spiritual-gifts': 'Spiritual Gifts',
};

/* -------------------------------------------------------------------------- */
/* Products                                                                   */
/* -------------------------------------------------------------------------- */

const PRODUCT_SORTS = {
  featured: { isFeatured: -1, rating: -1, createdAt: -1 },
  price_low: { price: 1, _id: 1 },
  price_high: { price: -1, _id: 1 },
  rating: { rating: -1, ratingCount: -1 },
  newest: { createdAt: -1 },
};

async function productCategories() {
  const rows = await Product.aggregate([
    { $match: { status: 'active' } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map(row => ({
    key: row._id,
    label: PRODUCT_CATEGORY_LABELS[row._id] || labelFor(row._id),
    count: row.count,
  }));
}

/** GET /products — the storefront. */
async function listProducts({ category, search, sort, featured, page, limit }) {
  const query = { status: 'active' };
  if (category && category !== 'all') {
    query.category = String(category).toLowerCase();
  }
  if (featured === 'true' || featured === true) {
    query.isFeatured = true;
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ name: pattern }, { description: pattern }, { category: pattern }];
  }

  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total, categories] = await Promise.all([
    Product.find(query).sort(PRODUCT_SORTS[sort] || PRODUCT_SORTS.featured).skip(skip).limit(size),
    Product.countDocuments(query),
    productCategories(),
  ]);

  return {
    items: items.map(product => product.toPublicJSON()),
    total,
    page: current,
    limit: size,
    categories,
  };
}

/** GET /products/:slug — one product plus four more from its shelf. */
async function getProduct(slugOrId) {
  const product = await Product.findOne({ ...bySlugOrId(slugOrId), status: 'active' });
  if (!product) {
    throw ApiError.notFound('Product not found.');
  }
  const related = await Product.find({
    status: 'active',
    category: product.category,
    _id: { $ne: product._id },
  })
    .sort({ isFeatured: -1, rating: -1 })
    .limit(4);

  return { product: product.toPublicJSON(), related: related.map(item => item.toPublicJSON()) };
}

/* ---- admin ---- */

async function adminListProducts({ status, category, search, page, limit }) {
  const query = {};
  if (status) {
    query.status = status;
  }
  if (category && category !== 'all') {
    query.category = String(category).toLowerCase();
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ name: pattern }, { sku: pattern }, { slug: pattern }];
  }

  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total] = await Promise.all([
    Product.find(query).sort({ updatedAt: -1 }).skip(skip).limit(size),
    Product.countDocuments(query),
  ]);
  return { items, total, page: current, limit: size };
}

/** How many gallery images a product may hold, across every upload. */
const MAX_PRODUCT_IMAGES = 8;

/**
 * What the product's images become after an admin write.
 *
 * The gallery starts from `keepImages` when the form sent it (the existing
 * URLs the admin chose to retain, in order), else from a JSON `images` list,
 * else from what is stored; freshly uploaded files are appended. The cover is
 * the uploaded one, else the `imageUrl` the form named (which may be a
 * gallery URL being promoted), else the stored one — and when there is still
 * none but the gallery has something, its first image.
 */
function resolveProductImages({ existing, changes, imageUrl, imageUrls = [] }) {
  const base = changes.keepImages ?? changes.images ?? existing.images ?? [];
  const images = [...new Set([...base, ...imageUrls].map(url => String(url).trim()).filter(Boolean))];
  if (images.length > MAX_PRODUCT_IMAGES) {
    throw ApiError.unprocessable('Please check the form.', {
      images: `Up to ${MAX_PRODUCT_IMAGES} images.`,
    });
  }
  const cover = imageUrl || changes.imageUrl || existing.imageUrl || images[0] || undefined;
  return { images, imageUrl: cover };
}

/** `keepImages` is a form instruction, not a product field. */
const withoutImageFields = ({ keepImages, images, imageUrl, ...rest }) => rest;

async function createProduct({ changes, imageUrl, imageUrls, admin }) {
  const product = new Product({
    ...withoutImageFields(changes),
    ...resolveProductImages({ existing: {}, changes, imageUrl, imageUrls }),
    createdBy: admin._id,
    updatedBy: admin._id,
  });
  await product.save();
  return product;
}

async function updateProduct({ productId, changes, imageUrl, imageUrls, admin }) {
  const product = await Product.findById(productId);
  if (!product) {
    throw ApiError.notFound('Product not found.');
  }
  product.set({
    ...withoutImageFields(changes),
    ...resolveProductImages({ existing: product, changes, imageUrl, imageUrls }),
    updatedBy: admin._id,
  });
  await product.save();
  return product;
}

async function setProductStatus({ productId, status, admin }) {
  const product = await Product.findByIdAndUpdate(
    productId,
    { $set: { status, updatedBy: admin._id } },
    { returnDocument: 'after', runValidators: true },
  );
  if (!product) {
    throw ApiError.notFound('Product not found.');
  }
  return product;
}

/** "Delete" archives: past orders still point at the product. */
async function archiveProduct({ productId, admin }) {
  await setProductStatus({ productId, status: 'archived', admin });
  return { deleted: true };
}

/* -------------------------------------------------------------------------- */
/* Product reviews                                                            */
/* -------------------------------------------------------------------------- */

/** What the product page prints for one review; the reviewer's name is masked. */
function toPublicReview(row, user) {
  return {
    id: String(row._id),
    rating: row.rating,
    title: row.title ?? null,
    comment: row.comment,
    images: Array.isArray(row.images) ? row.images : [],
    reply: row.reply ?? null,
    pinned: Boolean(row.pinned),
    createdAt: row.createdAt,
    reviewer: { name: maskedName(user?.name), avatarUrl: user?.avatarUrl ?? null },
    /** Only a buyer of a delivered order can write one, so every review is. */
    verified: true,
  };
}

/** Average (one decimal), count and per-star distribution of a product's visible reviews. */
async function productReviewSummary(productId) {
  const [result] = await ProductReview.aggregate([
    { $match: { product: productId, hidden: { $ne: true } } },
    {
      $facet: {
        overall: [{ $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }],
        distribution: [{ $group: { _id: '$rating', count: { $sum: 1 } } }],
      },
    },
  ]);
  const overall = result?.overall?.[0];
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of result?.distribution || []) {
    distribution[row._id] = row.count;
  }
  return {
    average: overall ? Math.round(overall.average * 10) / 10 : 0,
    count: overall?.count || 0,
    distribution,
  };
}

/** GET /products/:slug/reviews — visible reviews, pinned first then newest. */
/** Pinned reviews always lead; `sort` orders the rest: recent (default), oldest, top (highest stars), low (lowest stars). */
const REVIEW_SORTS = {
  recent: { pinned: -1, createdAt: -1, _id: -1 },
  oldest: { pinned: -1, createdAt: 1, _id: 1 },
  top: { pinned: -1, rating: -1, createdAt: -1, _id: -1 },
  low: { pinned: -1, rating: 1, createdAt: -1, _id: -1 },
};

async function listProductReviews({ slugOrId, page, limit, rating, sort }) {
  const product = await Product.findOne({ ...bySlugOrId(slugOrId), status: 'active' }).select('_id');
  if (!product) {
    throw ApiError.notFound('Product not found.');
  }

  const query = { product: product._id, hidden: { $ne: true } };
  const stars = Number(rating);
  if (stars >= 1 && stars <= 5) {
    query.rating = stars;
  }

  const { skip, limit: size, page: current } = paging({ page, limit });
  const [rows, total, summary] = await Promise.all([
    ProductReview.find(query)
      .sort(REVIEW_SORTS[sort] || REVIEW_SORTS.recent)
      .skip(skip)
      .limit(size)
      .populate({ path: 'user', select: 'name avatarUrl' }),
    ProductReview.countDocuments(query),
    productReviewSummary(product._id),
  ]);

  return {
    items: rows.map(row => toPublicReview(row, row.user)),
    total,
    page: current,
    limit: size,
    summary,
  };
}

/**
 * POST /products/:slug/reviews — one review per delivered order of the
 * product, by the seeker who placed it.
 */
async function createProductReview({ userId, slugOrId, orderId, rating, title, comment, images = [] }) {
  const product = await Product.findOne({ ...bySlugOrId(slugOrId), status: 'active' });
  if (!product) {
    throw ApiError.notFound('Product not found.');
  }
  const order = mongoose.isValidObjectId(orderId)
    ? await Order.findOne({ _id: orderId, user: userId })
    : null;
  if (!order) {
    throw ApiError.notFound('Order not found.');
  }
  if (order.status !== 'delivered') {
    throw ApiError.badRequest(
      'You can review a product once your order has been delivered.',
      undefined,
      'not_delivered',
    );
  }
  if (!order.items.some(item => String(item.product) === String(product._id))) {
    throw ApiError.badRequest('That order does not include this product.', undefined, 'not_in_order');
  }

  const alreadyReviewed = () =>
    ApiError.conflict('You have already reviewed this product for that order.', undefined, 'already_reviewed');
  const existing = await ProductReview.findOne({ product: product._id, order: order._id, user: userId });
  if (existing) {
    throw alreadyReviewed();
  }

  let review;
  try {
    review = await ProductReview.create({
      product: product._id,
      user: userId,
      order: order._id,
      rating,
      title: title || undefined,
      comment,
      images: (images || []).filter(Boolean).slice(0, 3),
    });
  } catch (error) {
    /** Two submissions racing for the same order: the unique index decides. */
    if (error?.code === 11000) {
      throw alreadyReviewed();
    }
    throw error;
  }

  const [numbers, user] = await Promise.all([
    ProductReview.recomputeProductRating(product._id),
    User.findById(userId).select('name avatarUrl'),
  ]);

  return { review: toPublicReview(review, user), product: numbers };
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                     */
/* -------------------------------------------------------------------------- */

const outOfStock = (productId, available) =>
  ApiError.conflict(
    available > 0
      ? `Only ${available} left in stock.`
      : 'That item is out of stock.',
    undefined,
    'out_of_stock',
  ).withDetails({ productId: String(productId), available });

/** The `$inc` guarded by the filter, so the last unit goes to exactly one order. */
async function takeStock(item, session) {
  const updated = await Product.findOneAndUpdate(
    { _id: item.product, status: 'active', stock: { $gte: item.qty } },
    { $inc: { stock: -item.qty } },
    { session, returnDocument: 'after' },
  );
  if (!updated) {
    const current = await Product.findById(item.product).select('stock status').session(session);
    throw outOfStock(item.product, current?.status === 'active' ? current.stock : 0);
  }
}

async function restock(items, session) {
  await Promise.all(
    items.map(item =>
      Product.updateOne({ _id: item.product }, { $inc: { stock: item.qty } }, { session }),
    ),
  );
}

/**
 * POST /orders
 *
 * A coupon is checked before the transaction (so the refusal is a clean 400
 * `coupon_invalid` before any money moves) and redeemed inside it, alongside
 * the debit — a failed purchase never uses a coupon up.
 */
async function createOrder({ userId, items, shipping, couponCode }) {
  /** Two lines for the same product become one, so stock is taken once. */
  const wanted = new Map();
  for (const line of items) {
    const key = String(line.productId);
    wanted.set(key, (wanted.get(key) || 0) + Number(line.qty));
  }

  const products = await Product.find({ _id: { $in: [...wanted.keys()] } });
  const byId = new Map(products.map(product => [String(product._id), product]));

  const lines = [];
  for (const [productId, qty] of wanted) {
    const product = byId.get(productId);
    if (!product || product.status !== 'active') {
      throw outOfStock(productId, 0);
    }
    if (product.stock < qty) {
      throw outOfStock(productId, product.stock);
    }
    lines.push({
      product: product._id,
      name: product.name,
      imageUrl: product.imageUrl,
      price: product.price,
      qty,
      lineTotal: product.price * qty,
    });
  }

  const totals = Order.totalsFor(lines);

  let coupon = null;
  let discount = 0;
  if (couponCode) {
    ({ coupon, discount } = await couponService.validate({
      code: couponCode,
      context: 'order',
      amount: totals.subtotal,
      userId,
    }));
  }
  const total = Math.max(totals.total - discount, 0);
  await assertBalance(userId, total, 'order');

  const order = new Order({
    user: userId,
    items: lines,
    ...totals,
    discount,
    coupon: coupon?._id,
    couponCode: coupon?.code,
    total,
    shipping,
    tracking: [{ status: 'placed', note: 'Order placed', at: new Date() }],
  });

  try {
    await inTransaction(async session => {
      for (const line of lines) {
        await takeStock(line, session);
      }
      if (coupon) {
        await couponService.redeem({
          coupon,
          userId,
          context: 'order',
          reference: order._id,
          amountBefore: totals.subtotal,
          discount,
          session,
        });
      }
      if (total > 0) {
        const debit = await walletService.post({
          ownerRole: 'user',
          ownerId: userId,
          direction: 'debit',
          type: 'order_payment',
          amount: total,
          title: `Store order ${order.reference}`,
          description: lines.map(line => `${line.name} × ${line.qty}`).join(', '),
          order: order._id,
          session,
        });
        order.payment.walletTransaction = debit._id;
      }
      await order.save({ session });
    });
  } catch (error) {
    if (isBalanceRefusal(error)) {
      const user = await User.findById(userId).select('wallet.balance');
      throw insufficientBalance({ total, balance: user?.wallet?.balance || 0, what: 'order' });
    }
    throw error;
  }

  await Promise.all([
    notificationService.notify({
      ownerRole: 'user',
      ownerId: userId,
      type: 'order',
      title: 'Order placed',
      body: `Your order ${order.reference} of ₹${order.total} has been placed.`,
      action: { screen: 'order', id: String(order._id) },
    }),
    notificationService.notifyAdmins({
      type: 'order',
      title: 'New store order',
      body: `${order.shipping?.fullName || 'A seeker'} placed ${order.reference} for ₹${order.total}.`,
      action: { screen: 'order', id: String(order._id) },
    }),
  ]);

  return populateOrder(order);
}

const ORDER_ITEM_POPULATE = { path: 'items.product', select: 'slug name imageUrl' };

async function populateOrder(order) {
  return order.populate(ORDER_ITEM_POPULATE);
}

/** GET /orders */
async function listOrders({ userId, status, page, limit }) {
  const query = { user: userId };
  if (status === 'active') {
    query.status = { $in: Order.ACTIVE_STATUSES };
  } else if (status === 'delivered' || status === 'cancelled') {
    query.status = status;
  }

  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total] = await Promise.all([
    Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(size).populate(ORDER_ITEM_POPULATE),
    Order.countDocuments(query),
  ]);
  return { items, total, page: current, limit: size };
}

/**
 * GET /orders/:orderId — 404 for someone else's order as much as for none.
 *
 * Each line item also says whether the seeker has reviewed that product from
 * this order (`review: { id, rating } | null`) and whether they can now
 * (`canReview`: delivered, and not yet reviewed).
 */
async function getOrder({ userId, orderId }) {
  if (!mongoose.isValidObjectId(orderId)) {
    throw ApiError.notFound('Order not found.');
  }
  const order = await Order.findOne({ _id: orderId, user: userId }).populate(ORDER_ITEM_POPULATE);
  if (!order) {
    throw ApiError.notFound('Order not found.');
  }

  const reviews = await ProductReview.find({ order: order._id, user: userId }).select('product rating');
  const byProduct = new Map(reviews.map(row => [String(row.product), row]));
  const delivered = order.status === 'delivered';

  const json = order.toJSON();
  json.items = json.items.map((item, index) => {
    const raw = order.items[index]?.product;
    const productId = String(raw?._id ?? raw ?? '');
    const review = byProduct.get(productId);
    return {
      ...item,
      review: review ? { id: String(review._id), rating: review.rating } : null,
      canReview: delivered && !review,
    };
  });
  return json;
}

/**
 * Undoes an order's payment and stock inside the caller's transaction:
 * the refund credit links back to the order, stock goes back on the shelf.
 */
async function reverseOrder(order, { session, reason, createdByAdmin }) {
  await restock(order.items, session);
  /** A fully discounted order took no money, so there is none to give back. */
  if (order.total > 0) {
    const refund = await walletService.post({
      ownerRole: 'user',
      ownerId: order.user,
      direction: 'credit',
      type: 'refund',
      amount: order.total,
      title: `Refund for order ${order.reference}`,
      description: reason,
      order: order._id,
      createdByAdmin,
      session,
    });
    order.payment.refundTransaction = refund._id;
  }
  order.status = 'cancelled';
  order.cancelledAt = new Date();
  order.payment.status = 'refunded';
  order.tracking.push({ status: 'cancelled', note: reason, at: order.cancelledAt });
  await order.save({ session });
}

/** POST /orders/:orderId/cancel */
async function cancelOrder({ userId, orderId }) {
  if (!mongoose.isValidObjectId(orderId)) {
    throw ApiError.notFound('Order not found.');
  }

  const order = await inTransaction(async session => {
    const found = await Order.findOne({ _id: orderId, user: userId }).session(session);
    if (!found) {
      throw ApiError.notFound('Order not found.');
    }
    if (!Order.USER_CANCELLABLE.includes(found.status)) {
      throw ApiError.conflict(
        found.status === 'cancelled'
          ? 'This order is already cancelled.'
          : 'This order has already been shipped and can no longer be cancelled.',
        undefined,
        'not_cancellable',
      );
    }
    await reverseOrder(found, { session, reason: 'Cancelled by customer' });
    return found;
  });

  await notificationService.notify({
    ownerRole: 'user',
    ownerId: userId,
    type: 'order',
    title: 'Order cancelled',
    body: `Order ${order.reference} was cancelled and ₹${order.total} is back in your wallet.`,
    action: { screen: 'order', id: String(order._id) },
  });

  return populateOrder(order);
}

/* ---- admin ---- */

const ADMIN_ORDER_POPULATE = [ORDER_ITEM_POPULATE, { path: 'user', select: 'name phone email' }];

async function adminListOrders({ status, search, page, limit }) {
  const query = {};
  if (status === 'active') {
    query.status = { $in: Order.ACTIVE_STATUSES };
  } else if (status) {
    query.status = status;
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const users = await User.find({
      $or: [{ name: pattern }, { 'phone.number': pattern }, { email: pattern }],
    }).select('_id');
    query.$or = [
      { reference: pattern },
      { 'shipping.fullName': pattern },
      { 'shipping.phone': pattern },
      { user: { $in: users.map(user => user._id) } },
    ];
  }

  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total] = await Promise.all([
    Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(size).populate(ADMIN_ORDER_POPULATE),
    Order.countDocuments(query),
  ]);
  return { items, total, page: current, limit: size };
}

async function adminGetOrder(orderId) {
  const order = mongoose.isValidObjectId(orderId)
    ? await Order.findById(orderId).populate(ADMIN_ORDER_POPULATE)
    : null;
  if (!order) {
    throw ApiError.notFound('Order not found.');
  }
  return order;
}

const ORDER_FLOW = ['placed', 'packed', 'shipped', 'out_for_delivery', 'delivered'];

/**
 * PATCH /admin/orders/:orderId/status — forward along the flow only, or to
 * `cancelled` from anything not yet delivered (which refunds and restocks).
 */
async function setOrderStatus({ orderId, status, note, admin }) {
  if (!mongoose.isValidObjectId(orderId)) {
    throw ApiError.notFound('Order not found.');
  }

  const order = await inTransaction(async session => {
    const found = await Order.findById(orderId).session(session);
    if (!found) {
      throw ApiError.notFound('Order not found.');
    }
    const from = found.status;

    if (status === 'cancelled') {
      if (from === 'delivered' || from === 'cancelled') {
        throw ApiError.conflict(
          `A ${from} order cannot be cancelled.`,
          undefined,
          'invalid_transition',
        );
      }
      await reverseOrder(found, {
        session,
        reason: note || 'Cancelled by Shree Astro',
        createdByAdmin: admin._id,
      });
      return found;
    }

    if (ORDER_FLOW.indexOf(status) <= ORDER_FLOW.indexOf(from) || from === 'cancelled') {
      throw ApiError.conflict(
        `An order cannot move from ${from} to ${status}.`,
        undefined,
        'invalid_transition',
      );
    }
    found.status = status;
    if (status === 'delivered') {
      found.deliveredAt = new Date();
    }
    found.tracking.push({ status, note, at: new Date() });
    await found.save({ session });
    return found;
  });

  /** Delivered is when the purchase counts: loyalty points, and a referral's first spend. */
  if (status === 'delivered') {
    await growthHooks.onOrderDelivered(order);
  }

  const titles = {
    packed: 'Order packed',
    shipped: 'Order shipped',
    out_for_delivery: 'Out for delivery',
    delivered: 'Order delivered',
    cancelled: 'Order cancelled',
  };
  await notificationService.notify({
    ownerRole: 'user',
    ownerId: order.user,
    type: 'order',
    title: titles[status] || 'Order updated',
    body:
      status === 'cancelled'
        ? `Order ${order.reference} was cancelled and ₹${order.total} is back in your wallet.`
        : `Order ${order.reference} is now ${status.replace(/_/g, ' ')}.${note ? ` ${note}` : ''}`,
    action: { screen: 'order', id: String(order._id) },
  });

  return order.populate(ADMIN_ORDER_POPULATE);
}

/* -------------------------------------------------------------------------- */
/* Pujas                                                                      */
/* -------------------------------------------------------------------------- */

async function pujaCategories() {
  const rows = await Puja.aggregate([
    { $match: { status: 'active' } },
    { $group: { _id: '$category', label: { $first: '$categoryLabel' }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return rows
    .filter(row => row._id)
    .map(row => ({ key: row._id, label: row.label || labelFor(row._id), count: row.count }));
}

/** GET /pujas */
async function listPujas({ category, search, featured, page, limit }) {
  const query = { status: 'active' };
  if (category && category !== 'all') {
    query.category = String(category).toLowerCase();
  }
  if (featured === 'true' || featured === true) {
    query.isFeatured = true;
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ name: pattern }, { tagline: pattern }, { deity: pattern }, { categoryLabel: pattern }];
  }

  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total, categories] = await Promise.all([
    Puja.find(query).sort({ isFeatured: -1, rating: -1, createdAt: -1 }).skip(skip).limit(size),
    Puja.countDocuments(query),
    pujaCategories(),
  ]);

  return { items: items.map(puja => puja.toPublicJSON()), total, page: current, limit: size, categories };
}

async function findActivePuja(slugOrId) {
  const puja = await Puja.findOne({ ...bySlugOrId(slugOrId), status: 'active' });
  if (!puja) {
    throw ApiError.notFound('Puja not found.');
  }
  return puja;
}

/** GET /pujas/:slug */
async function getPuja(slugOrId) {
  const puja = await findActivePuja(slugOrId);
  return { puja: puja.toPublicJSON() };
}

/** '8:00 AM' → the instant that slot starts on an IST calendar date. */
function slotInstant(date, time) {
  const match = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(String(time).trim());
  if (!match) {
    return null;
  }
  let hours = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') {
    hours += 12;
  }
  const start = startOfIstDay(date);
  return new Date(start.getTime() + hours * 3600000 + Number(match[2]) * 60000);
}

const isPastDate = date => date < istDateString();

/** How many confirmed bookings sit on each time of one puja on one date. */
async function bookedByTime(pujaId, date, session) {
  const rows = await PujaBooking.aggregate([
    { $match: { puja: pujaId, date, status: 'confirmed' } },
    { $group: { _id: '$time', count: { $sum: 1 } } },
  ]).session(session || null);
  return new Map(rows.map(row => [row._id, row.count]));
}

/** GET /pujas/:slug/slots?date= */
async function getSlots({ slugOrId, date }) {
  if (isPastDate(date)) {
    throw ApiError.unprocessable('Please check the form.', { date: 'Pick today or a later date.' });
  }
  const puja = await findActivePuja(slugOrId);
  const booked = await bookedByTime(puja._id, date);
  const now = Date.now();

  const slots = puja.timeSlots.map(time => {
    const left = Math.max(puja.maxPerSlot - (booked.get(time) || 0), 0);
    const starts = slotInstant(date, time);
    const past = starts ? starts.getTime() <= now : false;
    return { time, available: left > 0 && !past, left };
  });

  return { date, slots };
}

/* ---- bookings ---- */

const slotFull = (date, time, maxPerSlot) =>
  ApiError.conflict('That time slot is fully booked. Please pick another.', undefined, 'slot_full')
    .withDetails({ date, time, maxPerSlot });

/** POST /puja-bookings — a coupon, when given, is checked first and redeemed with the debit. */
async function createBooking({ userId, pujaId, date, time, contact, notes, couponCode }) {
  const puja = await findActivePuja(pujaId);

  if (isPastDate(date)) {
    throw ApiError.unprocessable('Please check the form.', { date: 'Pick today or a later date.' });
  }
  if (!puja.timeSlots.includes(time)) {
    throw ApiError.unprocessable('Please check the form.', { time: 'Pick one of the offered time slots.' });
  }
  const starts = slotInstant(date, time);
  if (starts && starts.getTime() <= Date.now()) {
    throw ApiError.unprocessable('Please check the form.', { time: 'That time has already passed today.' });
  }

  let coupon = null;
  let discount = 0;
  if (couponCode) {
    ({ coupon, discount } = await couponService.validate({
      code: couponCode,
      context: 'puja',
      amount: puja.price,
      userId,
    }));
  }
  const amount = Math.max(puja.price - discount, 0);
  await assertBalance(userId, amount, 'puja booking');

  const booking = new PujaBooking({
    user: userId,
    puja: puja._id,
    pujaSnapshot: {
      name: puja.name,
      imageUrl: puja.imageUrl,
      panditName: puja.panditName,
      price: puja.price,
    },
    date,
    time,
    subtotal: puja.price,
    discount,
    coupon: coupon?._id,
    couponCode: coupon?.code,
    amount,
    contact,
    notes,
  });

  try {
    await inTransaction(async session => {
      /**
       * Every booking of this puja writes the same Puja document first. Two
       * transactions writing one document conflict, and the loser is retried
       * by `withTransaction` on a fresh snapshot — which now includes the
       * winner's booking, so the count below is never stale. Without this
       * write, two counts could both see "2 of 3" and both insert.
       */
      const capacity = await Puja.findOneAndUpdate(
        { _id: puja._id, status: 'active' },
        { $inc: { bookingCount: 1 } },
        { session, returnDocument: 'after' },
      );
      if (!capacity) {
        throw ApiError.notFound('Puja not found.');
      }

      const taken = await PujaBooking.countDocuments({
        puja: puja._id,
        date,
        time,
        status: 'confirmed',
      }).session(session);
      if (taken >= capacity.maxPerSlot) {
        throw slotFull(date, time, capacity.maxPerSlot);
      }

      if (coupon) {
        await couponService.redeem({
          coupon,
          userId,
          context: 'puja',
          reference: booking._id,
          amountBefore: puja.price,
          discount,
          session,
        });
      }
      if (amount > 0) {
        const debit = await walletService.post({
          ownerRole: 'user',
          ownerId: userId,
          direction: 'debit',
          type: 'puja_booking',
          amount,
          title: `Puja booking ${booking.reference}`,
          description: `${puja.name} · ${date} ${time}`,
          pujaBooking: booking._id,
          session,
        });
        booking.payment.walletTransaction = debit._id;
      }
      await booking.save({ session });
    });
  } catch (error) {
    if (isBalanceRefusal(error)) {
      const user = await User.findById(userId).select('wallet.balance');
      throw insufficientBalance({ total: amount, balance: user?.wallet?.balance || 0, what: 'puja booking' });
    }
    throw error;
  }

  await Promise.all([
    notificationService.notify({
      ownerRole: 'user',
      ownerId: userId,
      type: 'booking',
      title: 'Puja booked',
      body: `${puja.name} is booked for ${date} at ${time}.`,
      action: { screen: 'puja_booking', id: String(booking._id) },
    }),
    notificationService.notifyAdmins({
      type: 'booking',
      title: 'New puja booking',
      body: `${contact?.fullName || 'A seeker'} booked ${puja.name} for ${date} at ${time}.`,
      action: { screen: 'puja_booking', id: String(booking._id) },
    }),
  ]);

  return populateBooking(booking);
}

const BOOKING_PUJA_POPULATE = { path: 'puja', select: 'slug name imageUrl panditName' };

async function populateBooking(booking) {
  return booking.populate(BOOKING_PUJA_POPULATE);
}

/** GET /puja-bookings */
async function listBookings({ userId, status, page, limit }) {
  const query = { user: userId };
  let sort = { createdAt: -1 };
  if (status === 'upcoming') {
    query.status = 'confirmed';
    sort = { date: 1, time: 1 };
  } else if (status === 'completed' || status === 'cancelled') {
    query.status = status;
  }

  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total] = await Promise.all([
    PujaBooking.find(query).sort(sort).skip(skip).limit(size).populate(BOOKING_PUJA_POPULATE),
    PujaBooking.countDocuments(query),
  ]);
  return { items, total, page: current, limit: size };
}

/** GET /puja-bookings/:bookingId */
async function getBooking({ userId, bookingId }) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw ApiError.notFound('Booking not found.');
  }
  const booking = await PujaBooking.findOne({ _id: bookingId, user: userId }).populate(
    BOOKING_PUJA_POPULATE,
  );
  if (!booking) {
    throw ApiError.notFound('Booking not found.');
  }
  return booking;
}

/** Refunds a confirmed booking inside the caller's transaction. */
async function reverseBooking(booking, { session, reason, createdByAdmin }) {
  if (booking.amount > 0) {
    const refund = await walletService.post({
      ownerRole: 'user',
      ownerId: booking.user,
      direction: 'credit',
      type: 'refund',
      amount: booking.amount,
      title: `Refund for puja booking ${booking.reference}`,
      description: reason,
      pujaBooking: booking._id,
      createdByAdmin,
      session,
    });
    booking.payment.refundTransaction = refund._id;
  }
  booking.status = 'cancelled';
  booking.cancelledAt = new Date();
  booking.payment.status = 'refunded';
  await booking.save({ session });
}

/** POST /puja-bookings/:bookingId/cancel — confirmed, and not yet started. */
async function cancelBooking({ userId, bookingId }) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw ApiError.notFound('Booking not found.');
  }

  const booking = await inTransaction(async session => {
    const found = await PujaBooking.findOne({ _id: bookingId, user: userId }).session(session);
    if (!found) {
      throw ApiError.notFound('Booking not found.');
    }
    if (found.status !== 'confirmed') {
      throw ApiError.conflict(
        `A ${found.status} booking cannot be cancelled.`,
        undefined,
        'not_cancellable',
      );
    }
    const starts = slotInstant(found.date, found.time);
    if (!starts || starts.getTime() <= Date.now()) {
      throw ApiError.conflict(
        'This puja has already started and can no longer be cancelled.',
        undefined,
        'not_cancellable',
      );
    }
    await reverseBooking(found, { session, reason: 'Cancelled by customer' });
    return found;
  });

  await notificationService.notify({
    ownerRole: 'user',
    ownerId: userId,
    type: 'booking',
    title: 'Puja booking cancelled',
    body: `Booking ${booking.reference} was cancelled and ₹${booking.amount} is back in your wallet.`,
    action: { screen: 'puja_booking', id: String(booking._id) },
  });

  return populateBooking(booking);
}

/** POST /puja-bookings/:bookingId/rate — once, after completion. */
async function rateBooking({ userId, bookingId, rating, comment }) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw ApiError.notFound('Booking not found.');
  }
  const booking = await PujaBooking.findOne({ _id: bookingId, user: userId });
  if (!booking) {
    throw ApiError.notFound('Booking not found.');
  }
  if (booking.status !== 'completed') {
    throw ApiError.conflict('You can rate a puja once it has been performed.', undefined, 'not_completed');
  }
  if (booking.rating) {
    throw ApiError.conflict('You have already rated this puja.', undefined, 'already_rated');
  }

  booking.rating = rating;
  booking.review = comment;
  booking.ratedAt = new Date();
  await booking.save();

  /** A running average, moved with one atomic pipeline update. */
  await Puja.updateOne({ _id: booking.puja }, [
    {
      $set: {
        rating: {
          $round: [
            {
              $divide: [
                { $add: [{ $multiply: ['$rating', '$ratingCount'] }, rating] },
                { $add: ['$ratingCount', 1] },
              ],
            },
            1,
          ],
        },
        ratingCount: { $add: ['$ratingCount', 1] },
      },
    },
  ], { updatePipeline: true });

  return populateBooking(booking);
}

/* ---- admin ---- */

async function adminListPujas({ status, category, search, page, limit }) {
  const query = {};
  if (status) {
    query.status = status;
  }
  if (category && category !== 'all') {
    query.category = String(category).toLowerCase();
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ name: pattern }, { panditName: pattern }, { slug: pattern }];
  }

  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total] = await Promise.all([
    Puja.find(query).sort({ updatedAt: -1 }).skip(skip).limit(size),
    Puja.countDocuments(query),
  ]);
  return { items, total, page: current, limit: size };
}

async function createPuja({ changes, imageUrl, admin }) {
  const puja = new Puja({
    ...changes,
    ...(imageUrl ? { imageUrl } : {}),
    createdBy: admin._id,
    updatedBy: admin._id,
  });
  await puja.save();
  return puja;
}

async function updatePuja({ pujaId, changes, imageUrl, admin }) {
  const puja = await Puja.findById(pujaId);
  if (!puja) {
    throw ApiError.notFound('Puja not found.');
  }
  puja.set({ ...changes, ...(imageUrl ? { imageUrl } : {}), updatedBy: admin._id });
  await puja.save();
  return puja;
}

async function setPujaStatus({ pujaId, status, admin }) {
  const puja = await Puja.findByIdAndUpdate(
    pujaId,
    { $set: { status, updatedBy: admin._id } },
    { returnDocument: 'after', runValidators: true },
  );
  if (!puja) {
    throw ApiError.notFound('Puja not found.');
  }
  return puja;
}

async function archivePuja({ pujaId, admin }) {
  await setPujaStatus({ pujaId, status: 'archived', admin });
  return { deleted: true };
}

const ADMIN_BOOKING_POPULATE = [BOOKING_PUJA_POPULATE, { path: 'user', select: 'name phone email' }];

async function adminListBookings({ status, date, search, page, limit }) {
  const query = {};
  if (status === 'upcoming') {
    query.status = 'confirmed';
  } else if (status) {
    query.status = status;
  }
  if (date) {
    query.date = date;
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const users = await User.find({
      $or: [{ name: pattern }, { 'phone.number': pattern }, { email: pattern }],
    }).select('_id');
    query.$or = [
      { reference: pattern },
      { 'contact.fullName': pattern },
      { 'contact.phone': pattern },
      { 'pujaSnapshot.name': pattern },
      { user: { $in: users.map(user => user._id) } },
    ];
  }

  const { skip, limit: size, page: current } = paging({ page, limit });
  const sort = query.status === 'confirmed' ? { date: 1, time: 1 } : { createdAt: -1 };
  const [items, total] = await Promise.all([
    PujaBooking.find(query).sort(sort).skip(skip).limit(size).populate(ADMIN_BOOKING_POPULATE),
    PujaBooking.countDocuments(query),
  ]);
  return { items, total, page: current, limit: size };
}

async function adminGetBooking(bookingId) {
  const booking = mongoose.isValidObjectId(bookingId)
    ? await PujaBooking.findById(bookingId).populate(ADMIN_BOOKING_POPULATE)
    : null;
  if (!booking) {
    throw ApiError.notFound('Booking not found.');
  }
  return booking;
}

/** PATCH /admin/puja-bookings/:bookingId */
async function adminUpdateBooking({ bookingId, status, streamUrl, adminNote, admin }) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw ApiError.notFound('Booking not found.');
  }

  const booking = await inTransaction(async session => {
    const found = await PujaBooking.findById(bookingId).session(session);
    if (!found) {
      throw ApiError.notFound('Booking not found.');
    }

    if (streamUrl !== undefined) {
      found.streamUrl = streamUrl || undefined;
    }
    if (adminNote !== undefined) {
      found.adminNote = adminNote || undefined;
    }

    if (status && status !== found.status) {
      if (found.status !== 'confirmed') {
        throw ApiError.conflict(
          `A ${found.status} booking cannot be marked ${status}.`,
          undefined,
          'invalid_transition',
        );
      }
      if (status === 'cancelled') {
        await reverseBooking(found, {
          session,
          reason: adminNote || 'Cancelled by Shree Astro',
          createdByAdmin: admin._id,
        });
        return found;
      }
      found.status = 'completed';
      found.completedAt = new Date();
    }

    await found.save({ session });
    return found;
  });

  /** A performed puja is a completed purchase: points, and a referral's first spend. */
  if (status === 'completed' && booking.status === 'completed') {
    await growthHooks.onBookingCompleted(booking);
  }

  if (status === 'cancelled' || status === 'completed') {
    await notificationService.notify({
      ownerRole: 'user',
      ownerId: booking.user,
      type: 'booking',
      title: status === 'cancelled' ? 'Puja booking cancelled' : 'Puja completed',
      body:
        status === 'cancelled'
          ? `Booking ${booking.reference} was cancelled and ₹${booking.amount} is back in your wallet.`
          : `${booking.pujaSnapshot?.name || 'Your puja'} has been performed. You can rate it now.`,
      action: { screen: 'puja_booking', id: String(booking._id) },
    });
  } else if (streamUrl) {
    await notificationService.notify({
      ownerRole: 'user',
      ownerId: booking.user,
      type: 'booking',
      title: 'Live stream link ready',
      body: `Watch ${booking.pujaSnapshot?.name || 'your puja'} live on ${booking.date} at ${booking.time}.`,
      action: { screen: 'puja_booking', id: String(booking._id) },
    });
  }

  return booking.populate(ADMIN_BOOKING_POPULATE);
}

/* -------------------------------------------------------------------------- */
/* Articles (public)                                                          */
/* -------------------------------------------------------------------------- */

const ARTICLE_LIST_FIELDS =
  'slug title category author excerpt coverImageUrl publishedAt readMinutes views tags';

/** Published, and members-only rows only for a signed-in caller. */
function publicArticleQuery(signedIn) {
  const query = { status: 'published' };
  if (!signedIn) {
    query.visibility = 'everyone';
  }
  return query;
}

const articleListItem = article => ({
  id: String(article._id),
  slug: article.slug,
  title: article.title,
  category: article.category ?? null,
  author: article.author ?? null,
  excerpt: article.excerpt ?? null,
  coverImageUrl: article.coverImageUrl ?? null,
  publishedAt: article.publishedAt ?? null,
  readMinutes: article.readMinutes ?? 0,
  views: article.views ?? 0,
  tags: article.tags || [],
});

/** GET /articles */
async function listPublicArticles({ category, search, page, limit, signedIn }) {
  const base = publicArticleQuery(signedIn);
  const query = { ...base };
  if (category && category !== 'All' && category !== 'all') {
    query.category = category;
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ title: pattern }, { excerpt: pattern }, { tags: pattern }, { author: pattern }];
  }

  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total, categories] = await Promise.all([
    Article.find(query).select(ARTICLE_LIST_FIELDS).sort({ publishedAt: -1 }).skip(skip).limit(size),
    Article.countDocuments(query),
    Article.aggregate([
      { $match: base },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  return {
    items: items.map(articleListItem),
    total,
    page: current,
    limit: size,
    categories: categories.filter(row => row._id).map(row => ({ key: row._id, count: row.count })),
  };
}

/** GET /articles/:slug — counts the read. */
async function getPublicArticle({ slug, signedIn }) {
  const article = await Article.findOneAndUpdate(
    { ...publicArticleQuery(signedIn), ...bySlugOrId(slug) },
    { $inc: { views: 1 } },
    { returnDocument: 'after' },
  );
  if (!article) {
    throw ApiError.notFound('Article not found.');
  }
  return { ...articleListItem(article), body: article.body, visibility: article.visibility };
}

/* -------------------------------------------------------------------------- */
/* Dashboard tiles                                                            */
/* -------------------------------------------------------------------------- */

/** The store and puja numbers on GET /admin/dashboard. */
async function dashboardStats() {
  const today = istDateString();
  const startOfToday = startOfIstDay(today);
  const thirtyDaysAgo = startOfIstDay(dateOffset(today, -29));

  const [ordersToday, pendingOrders, revenue, bookingsToday, upcoming] = await Promise.all([
    Order.countDocuments({ createdAt: { $gte: startOfToday } }),
    Order.countDocuments({ status: { $in: ['placed', 'packed'] } }),
    Order.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),
    PujaBooking.countDocuments({ createdAt: { $gte: startOfToday } }),
    PujaBooking.countDocuments({ status: 'confirmed', date: { $gte: today } }),
  ]);

  return {
    shop: { ordersToday, pendingOrders, revenue30d: revenue[0]?.total || 0 },
    pujas: { bookingsToday, upcoming },
  };
}

module.exports = {
  listProducts,
  getProduct,
  listProductReviews,
  createProductReview,
  adminListProducts,
  createProduct,
  updateProduct,
  setProductStatus,
  archiveProduct,
  createOrder,
  listOrders,
  getOrder,
  cancelOrder,
  adminListOrders,
  adminGetOrder,
  setOrderStatus,
  listPujas,
  getPuja,
  getSlots,
  createBooking,
  listBookings,
  getBooking,
  cancelBooking,
  rateBooking,
  adminListPujas,
  createPuja,
  updatePuja,
  setPujaStatus,
  archivePuja,
  adminListBookings,
  adminGetBooking,
  adminUpdateBooking,
  listPublicArticles,
  getPublicArticle,
  dashboardStats,
  slotInstant,
};
