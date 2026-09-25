/**
 * Reviews, site-wide — and the curated testimonials beside them.
 *
 * A consultation's review lives on its ChatSession (`review`), a puja's on
 * its PujaBooking (`rating`/`review`), and a product's is its own
 * ProductReview document. The public reviews page wants consultations and
 * pujas in one list, so they are read through a single aggregation — the
 * consultation side, `$unionWith` the puja side, both projected onto one
 * shape — which is what lets Mongo sort and paginate across the two without
 * either being loaded whole. Product reviews are projected onto the same
 * shape, asked for by `kind=product`; the admin queue sees all three.
 *
 * Moderation writes go back to whichever document the review lives on.
 */

const mongoose = require('mongoose');

const { ChatSession } = require('../models/Chat');
const PujaBooking = require('../models/PujaBooking');
const ProductReview = require('../models/ProductReview');
const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const Puja = require('../models/Puja');
const Product = require('../models/Product');
const Testimonial = require('../models/Testimonial');
const ApiError = require('../utils/ApiError');
const { maskedName } = require('./referral.service');

const KINDS = ['consultation', 'puja', 'product'];

function paging({ page = 1, limit = 20 }) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  return { skip: (current - 1) * size, limit: size, page: current };
}

const escapeRegex = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const objectId = value => new mongoose.Types.ObjectId(String(value));

/* -------------------------------------------------------------------------- */
/* The union                                                                  */
/* -------------------------------------------------------------------------- */

/** The one shape both sides are projected onto. */
const consultationStages = () => [
  { $match: { type: 'consultation', status: 'ended', 'review.rating': { $gte: 1 } } },
  {
    $project: {
      _id: 1,
      kind: { $literal: 'consultation' },
      rating: '$review.rating',
      comment: '$review.comment',
      reply: '$review.reply',
      pinned: { $ifNull: ['$review.pinned', false] },
      hidden: { $ifNull: ['$review.hidden', false] },
      flagged: { $ifNull: ['$review.flagged', false] },
      flagReason: '$review.flagReason',
      createdAt: { $ifNull: ['$review.ratedAt', '$endedAt'] },
      user: 1,
      astrologer: 1,
      puja: { $literal: null },
      product: { $literal: null },
      title: { $literal: null },
      channel: 1,
      durationSeconds: 1,
    },
  },
];

const pujaStages = () => [
  { $match: { rating: { $gte: 1 } } },
  {
    $project: {
      _id: 1,
      kind: { $literal: 'puja' },
      rating: 1,
      comment: '$review',
      reply: '$reviewReply',
      pinned: { $ifNull: ['$reviewPinned', false] },
      hidden: { $ifNull: ['$reviewHidden', false] },
      flagged: { $ifNull: ['$reviewFlagged', false] },
      flagReason: '$reviewFlagReason',
      createdAt: { $ifNull: ['$ratedAt', '$completedAt'] },
      user: 1,
      astrologer: { $literal: null },
      puja: 1,
      product: { $literal: null },
      title: { $literal: null },
      channel: { $literal: null },
      durationSeconds: { $literal: null },
    },
  },
];

const productStages = () => [
  { $match: { rating: { $gte: 1 } } },
  {
    $project: {
      _id: 1,
      kind: { $literal: 'product' },
      rating: 1,
      comment: 1,
      reply: 1,
      pinned: { $ifNull: ['$pinned', false] },
      hidden: { $ifNull: ['$hidden', false] },
      flagged: { $ifNull: ['$flagged', false] },
      flagReason: 1,
      createdAt: 1,
      user: 1,
      astrologer: { $literal: null },
      puja: { $literal: null },
      product: 1,
      title: 1,
      images: { $ifNull: ['$images', []] },
      channel: { $literal: null },
      durationSeconds: { $literal: null },
    },
  },
];

/**
 * Which model to run on, and the stages that produce the unified rows.
 * No kind is the site's reviews page — consultations and pujas; `'all'` is
 * the admin queue, which adds products.
 */
function unionFor(kind) {
  if (kind === 'puja') {
    return { Model: PujaBooking, stages: pujaStages() };
  }
  if (kind === 'product') {
    return { Model: ProductReview, stages: productStages() };
  }
  const stages = consultationStages();
  if (kind !== 'consultation') {
    stages.push({ $unionWith: { coll: PujaBooking.collection.name, pipeline: pujaStages() } });
  }
  if (kind === 'all') {
    stages.push({ $unionWith: { coll: ProductReview.collection.name, pipeline: productStages() } });
  }
  return { Model: ChatSession, stages };
}

const LOOKUPS = [
  { $lookup: { from: User.collection.name, localField: 'user', foreignField: '_id', as: 'userDoc' } },
  { $lookup: { from: Astrologer.collection.name, localField: 'astrologer', foreignField: '_id', as: 'astrologerDoc' } },
  { $lookup: { from: Puja.collection.name, localField: 'puja', foreignField: '_id', as: 'pujaDoc' } },
  { $lookup: { from: Product.collection.name, localField: 'product', foreignField: '_id', as: 'productDoc' } },
];

/** One unified row → what the page prints. `full` adds what only an admin sees. */
function toItem(row, { full = false } = {}) {
  const user = row.userDoc?.[0];
  const astrologer = row.astrologerDoc?.[0];
  const puja = row.pujaDoc?.[0];
  const product = row.productDoc?.[0];
  const item = {
    id: String(row._id),
    kind: row.kind,
    rating: row.rating,
    comment: row.comment ?? null,
    reply: row.reply ?? null,
    pinned: Boolean(row.pinned),
    createdAt: row.createdAt ?? null,
    reviewer: {
      name: full ? user?.name || 'Anonymous' : maskedName(user?.name),
      avatarUrl: user?.avatarUrl ?? null,
    },
  };
  if (row.kind === 'consultation') {
    item.astrologer = astrologer
      ? { id: String(astrologer._id), name: astrologer.name, photo: astrologer.photoUrl ?? null }
      : null;
    item.channel = row.channel ?? null;
    item.durationSeconds = row.durationSeconds ?? null;
  } else if (row.kind === 'product') {
    item.title = row.title ?? null;
    item.images = Array.isArray(row.images) ? row.images : [];
    item.product = product ? { id: String(product._id), name: product.name, slug: product.slug } : null;
  } else {
    item.puja = puja ? { id: String(puja._id), name: puja.name, slug: puja.slug } : null;
  }
  if (full) {
    item.hidden = Boolean(row.hidden);
    item.flagged = Boolean(row.flagged);
    item.flagReason = row.flagReason ?? null;
    item.user = user ? { id: String(user._id), name: user.name, phone: user.phone?.number, email: user.email } : null;
  }
  return item;
}

/** The core read: unified rows matching `match`, sorted pinned-first, paginated. */
async function find({ kind, match = {}, page, limit, full = false }) {
  const { Model, stages } = unionFor(kind);
  const { skip, limit: size, page: current } = paging({ page, limit });

  const [result] = await Model.aggregate([
    ...stages,
    { $match: match },
    { $sort: { pinned: -1, createdAt: -1, _id: -1 } },
    {
      $facet: {
        items: [{ $skip: skip }, { $limit: size }, ...LOOKUPS],
        total: [{ $count: 'n' }],
      },
    },
  ]);

  return {
    items: (result?.items || []).map(row => toItem(row, { full })),
    total: result?.total?.[0]?.n || 0,
    page: current,
    limit: size,
  };
}

const PUBLIC_MATCH = { hidden: { $ne: true }, flagged: { $ne: true } };

function ratingMatch({ rating, min }) {
  const exact = Number(rating);
  if (exact >= 1 && exact <= 5) return { rating: exact };
  const floor = Number(min);
  if (floor >= 1 && floor <= 5) return { rating: { $gte: floor } };
  return {};
}

/** The numbers above the list: average, count, per-star breakdown, per-kind averages. */
async function summary() {
  const { Model, stages } = unionFor();
  const [result] = await Model.aggregate([
    ...stages,
    { $match: PUBLIC_MATCH },
    {
      $facet: {
        overall: [{ $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }],
        breakdown: [{ $group: { _id: '$rating', count: { $sum: 1 } } }],
        categories: [{ $group: { _id: '$kind', average: { $avg: '$rating' } } }],
      },
    },
  ]);

  const overall = result?.overall?.[0];
  const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const row of result?.breakdown || []) {
    breakdown[row._id] = row.count;
  }
  const categories = { consultation: null, puja: null };
  for (const row of result?.categories || []) {
    categories[row._id] = Math.round(row.average * 10) / 10;
  }
  return {
    average: overall ? Math.round(overall.average * 10) / 10 : 0,
    count: overall?.count || 0,
    breakdown,
    categories,
  };
}

/** GET /reviews */
async function listPublic({ rating, min, kind, page, limit }) {
  const [list, numbers] = await Promise.all([
    find({
      kind: KINDS.includes(kind) ? kind : undefined,
      match: { ...PUBLIC_MATCH, ...ratingMatch({ rating, min }) },
      page,
      limit,
    }),
    summary(),
  ]);
  return { ...list, summary: numbers };
}

/* -------------------------------------------------------------------------- */
/* Moderation                                                                 */
/* -------------------------------------------------------------------------- */

const flag = value => (value === undefined ? undefined : value === true || value === 'true');

/** GET /admin/reviews */
async function adminList({ kind, rating, flagged, hidden, search, page, limit }) {
  const match = { ...ratingMatch({ rating }) };
  if (flag(flagged) !== undefined) match.flagged = flag(flagged);
  if (flag(hidden) !== undefined) match.hidden = flag(hidden);
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const [users, astrologers, pujas, products] = await Promise.all([
      User.find({ $or: [{ name: pattern }, { 'phone.number': pattern }, { email: pattern }] }).select('_id'),
      Astrologer.find({ name: pattern }).select('_id'),
      Puja.find({ name: pattern }).select('_id'),
      Product.find({ name: pattern }).select('_id'),
    ]);
    match.$or = [
      { comment: pattern },
      { title: pattern },
      { user: { $in: users.map(row => row._id) } },
      { astrologer: { $in: astrologers.map(row => row._id) } },
      { puja: { $in: pujas.map(row => row._id) } },
      { product: { $in: products.map(row => row._id) } },
    ];
  }
  return find({ kind: KINDS.includes(kind) ? kind : 'all', match, page, limit, full: true });
}

/** One review, in the admin list's shape. */
async function adminGet({ kind, id }) {
  const { items } = await find({ kind, match: { _id: objectId(id) }, limit: 1, full: true });
  if (!items.length) {
    throw ApiError.notFound('Review not found.');
  }
  return items[0];
}

/** PATCH /admin/reviews/:kind/:id */
async function adminUpdate({ kind, id, hidden, pinned, flagged, flagReason, reply }) {
  if (!KINDS.includes(kind) || !mongoose.isValidObjectId(id)) {
    throw ApiError.notFound('Review not found.');
  }

  if (kind === 'consultation') {
    const chat = await ChatSession.findById(id);
    if (!chat || !chat.review?.rating) {
      throw ApiError.notFound('Review not found.');
    }
    if (hidden !== undefined) chat.review.hidden = hidden;
    if (pinned !== undefined) chat.review.pinned = pinned;
    if (flagged !== undefined) chat.review.flagged = flagged;
    if (flagReason !== undefined) chat.review.flagReason = flagReason || undefined;
    if (reply !== undefined) chat.review.reply = reply || undefined;
    await chat.save();
  } else if (kind === 'product') {
    const review = await ProductReview.findById(id);
    if (!review) {
      throw ApiError.notFound('Review not found.');
    }
    const wasHidden = Boolean(review.hidden);
    if (hidden !== undefined) review.hidden = hidden;
    if (pinned !== undefined) review.pinned = pinned;
    if (flagged !== undefined) review.flagged = flagged;
    if (flagReason !== undefined) review.flagReason = flagReason || undefined;
    if (reply !== undefined) {
      review.reply = reply || undefined;
      review.repliedAt = reply ? new Date() : undefined;
    }
    await review.save();
    /** Hiding or unhiding changes what the product's rating is made of. */
    if (Boolean(review.hidden) !== wasHidden) {
      await ProductReview.recomputeProductRating(review.product);
    }
  } else {
    const booking = await PujaBooking.findById(id);
    if (!booking || !booking.rating) {
      throw ApiError.notFound('Review not found.');
    }
    if (hidden !== undefined) booking.reviewHidden = hidden;
    if (pinned !== undefined) booking.reviewPinned = pinned;
    if (flagged !== undefined) booking.reviewFlagged = flagged;
    if (flagReason !== undefined) booking.reviewFlagReason = flagReason || undefined;
    if (reply !== undefined) booking.reviewReply = reply || undefined;
    await booking.save();
  }

  return adminGet({ kind, id });
}

/* -------------------------------------------------------------------------- */
/* Testimonials                                                               */
/* -------------------------------------------------------------------------- */

/** GET /testimonials */
async function listTestimonials({ kind, limit }) {
  const query = { status: 'published' };
  if (Testimonial.KINDS.includes(kind)) query.kind = kind;
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const rows = await Testimonial.find(query).sort({ sortOrder: 1, createdAt: -1 }).limit(size);
  return { items: rows.map(row => row.toPublicJSON()), total: rows.length };
}

async function adminListTestimonials({ kind, status, page, limit }) {
  const query = {};
  if (kind) query.kind = kind;
  if (status) query.status = status;
  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total] = await Promise.all([
    Testimonial.find(query).sort({ sortOrder: 1, createdAt: -1 }).skip(skip).limit(size),
    Testimonial.countDocuments(query),
  ]);
  return { items, total, page: current, limit: size };
}

async function findTestimonial(testimonialId) {
  const row = mongoose.isValidObjectId(testimonialId) ? await Testimonial.findById(testimonialId) : null;
  if (!row) {
    throw ApiError.notFound('Testimonial not found.');
  }
  return row;
}

/** `uploads` is `{ avatar?, thumbnail? }` — the URLs of files that came with the form. */
async function createTestimonial({ changes, uploads = {}, admin }) {
  const row = new Testimonial({
    ...changes,
    ...(uploads.avatar ? { avatarUrl: uploads.avatar } : {}),
    ...(uploads.thumbnail ? { thumbnailUrl: uploads.thumbnail } : {}),
    createdBy: admin._id,
    updatedBy: admin._id,
  });
  await row.save();
  return row;
}

async function updateTestimonial({ testimonialId, changes, uploads = {}, admin }) {
  const row = await findTestimonial(testimonialId);
  row.set({
    ...changes,
    ...(uploads.avatar ? { avatarUrl: uploads.avatar } : {}),
    ...(uploads.thumbnail ? { thumbnailUrl: uploads.thumbnail } : {}),
    updatedBy: admin._id,
  });
  await row.save();
  return row;
}

async function setTestimonialStatus({ testimonialId, status, admin }) {
  const row = await findTestimonial(testimonialId);
  row.status = status;
  row.updatedBy = admin._id;
  await row.save();
  return row;
}

async function deleteTestimonial({ testimonialId }) {
  const row = await findTestimonial(testimonialId);
  await row.deleteOne();
  return { deleted: true };
}

module.exports = {
  listPublic,
  summary,
  adminList,
  adminGet,
  adminUpdate,
  listTestimonials,
  adminListTestimonials,
  createTestimonial,
  updateTestimonial,
  setTestimonialStatus,
  deleteTestimonial,
  KINDS,
};
