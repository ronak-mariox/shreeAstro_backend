/**
 * Coupons — checking one, and spending one.
 *
 * `validate()` answers "would this code work here, for this seeker, on this
 * amount?" and is what POST /coupons/validate returns. `redeem()` is the
 * write, and only ever runs inside the caller's Mongo session — the same
 * transaction that debits the wallet and saves the order — so a coupon can
 * never be used up by a purchase that then failed, nor a purchase saved with
 * a discount the coupon no longer had room for.
 */

const mongoose = require('mongoose');

const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const FestivalOffer = require('../models/FestivalOffer');
const ApiError = require('../utils/ApiError');

const CONTEXT_LABELS = { order: 'store orders', puja: 'puja bookings', topup: 'wallet top-ups' };

const invalid = message => ApiError.badRequest(message, undefined, 'coupon_invalid');

const normaliseCode = code => String(code || '').trim().toUpperCase();

/**
 * The coupon a code names, if it may be used right now in this `context` on
 * this `amount` by this seeker — or a 400 `coupon_invalid` saying why not.
 *
 * `session` is passed when this runs inside a purchase transaction so the
 * per-user count sees rows written earlier in the same transaction.
 */
async function validate({ code, context, amount, userId, session }) {
  const normalised = normaliseCode(code);
  if (!normalised) {
    throw invalid('Enter a coupon code.');
  }

  const query = Coupon.findOne({ code: normalised });
  if (session) query.session(session);
  const coupon = await query;

  if (!coupon || coupon.status === 'expired') {
    throw invalid('That coupon code is not valid.');
  }
  if (coupon.status === 'paused') {
    throw invalid('This coupon is not available right now.');
  }
  const now = new Date();
  if (coupon.validFrom && coupon.validFrom > now) {
    throw invalid('This coupon is not active yet.');
  }
  if (coupon.validTo && coupon.validTo < now) {
    throw invalid('This coupon has expired.');
  }
  if (!coupon.appliesTo.includes(context)) {
    throw invalid(`This coupon cannot be used on ${CONTEXT_LABELS[context] || context}.`);
  }

  const rupees = Math.round(Number(amount)) || 0;
  if (coupon.minAmount && rupees < coupon.minAmount) {
    throw invalid(`This coupon needs a minimum of ₹${coupon.minAmount}.`);
  }
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    throw invalid('This coupon has reached its usage limit.');
  }

  if (userId) {
    const countQuery = CouponRedemption.countDocuments({ coupon: coupon._id, user: userId });
    if (session) countQuery.session(session);
    const used = await countQuery;
    if (used >= coupon.perUserLimit) {
      throw invalid(
        coupon.perUserLimit === 1
          ? 'You have already used this coupon.'
          : `You have already used this coupon ${coupon.perUserLimit} times.`,
      );
    }
  }

  const discount = coupon.discountFor(rupees);
  if (discount <= 0) {
    throw invalid('This coupon gives no discount on this amount.');
  }

  return { coupon, discount, payable: Math.max(rupees - discount, 0) };
}

/**
 * Records one use, inside the caller's transaction.
 *
 * The `$inc` is guarded by the usage limit in its filter, so two purchases
 * racing for the last use of a coupon cannot both take it; the redemption
 * row's unique index refuses the same purchase redeeming twice.
 */
async function redeem({ coupon, userId, context, reference, amountBefore, discount, session }) {
  const filter = { _id: coupon._id, status: 'active' };
  if (coupon.usageLimit) {
    filter.usedCount = { $lt: coupon.usageLimit };
  }
  const claimed = await Coupon.findOneAndUpdate(filter, { $inc: { usedCount: 1 } }, { session });
  if (!claimed) {
    throw invalid('This coupon has reached its usage limit.');
  }

  const [redemption] = await CouponRedemption.create(
    [{ coupon: coupon._id, user: userId, context, reference, amountBefore, discount }],
    { session },
  );
  return redemption;
}

/**
 * Validate + redeem in one go, for a purchase that already has its `reference`
 * id. No code → no discount, and nothing written.
 */
async function apply({ code, context, amount, userId, reference, session }) {
  if (!normaliseCode(code)) {
    return { coupon: null, discount: 0 };
  }
  const { coupon, discount } = await validate({ code, context, amount, userId, session });
  await redeem({ coupon, userId, context, reference, amountBefore: amount, discount, session });
  return { coupon, discount };
}

/* -------------------------------------------------------------------------- */
/* The offers page                                                            */
/* -------------------------------------------------------------------------- */

/** Live, listed coupons — in their window, active, public. */
async function publicCoupons() {
  const now = new Date();
  const coupons = await Coupon.find({
    status: 'active',
    isPublic: true,
    $and: [
      { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
      { $or: [{ validTo: null }, { validTo: { $gte: now } }] },
    ],
  }).sort({ createdAt: 1 });
  return coupons.map(coupon => coupon.toPublicJSON());
}

/** Festival cards showing right now. */
async function publicFestivals() {
  const now = new Date();
  const offers = await FestivalOffer.find({
    status: 'active',
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
    ],
  }).sort({ sortOrder: 1, startsAt: 1, createdAt: 1 });
  return offers.map(offer => offer.toPublicJSON());
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

function paging({ page = 1, limit = 20 }) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  return { skip: (current - 1) * size, limit: size, page: current };
}

const escapeRegex = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function adminListCoupons({ status, search, page, limit }) {
  const query = {};
  if (status) query.status = status;
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ code: pattern }, { title: pattern }, { tag: pattern }];
  }
  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total] = await Promise.all([
    Coupon.find(query).sort({ updatedAt: -1 }).skip(skip).limit(size),
    Coupon.countDocuments(query),
  ]);
  return { items, total, page: current, limit: size };
}

async function findCoupon(couponId) {
  const coupon = mongoose.isValidObjectId(couponId) ? await Coupon.findById(couponId) : null;
  if (!coupon) {
    throw ApiError.notFound('Coupon not found.');
  }
  return coupon;
}

const duplicateCode = error =>
  error && error.code === 11000 && error.keyPattern && error.keyPattern.code;

async function createCoupon({ changes, admin }) {
  const coupon = new Coupon({ ...changes, createdBy: admin._id, updatedBy: admin._id });
  try {
    await coupon.save();
  } catch (error) {
    if (duplicateCode(error)) {
      throw ApiError.conflict('That code is already in use.', { code: 'Already in use.' }, 'duplicate_code');
    }
    throw error;
  }
  return coupon;
}

async function updateCoupon({ couponId, changes, admin }) {
  const coupon = await findCoupon(couponId);
  coupon.set({ ...changes, updatedBy: admin._id });
  try {
    await coupon.save();
  } catch (error) {
    if (duplicateCode(error)) {
      throw ApiError.conflict('That code is already in use.', { code: 'Already in use.' }, 'duplicate_code');
    }
    throw error;
  }
  return coupon;
}

async function setCouponStatus({ couponId, status, admin }) {
  const coupon = await findCoupon(couponId);
  coupon.status = status;
  coupon.updatedBy = admin._id;
  await coupon.save();
  return coupon;
}

/** Only a coupon nobody has used may go; a used one is history and is paused instead. */
async function deleteCoupon({ couponId }) {
  const coupon = await findCoupon(couponId);
  if (coupon.usedCount > 0) {
    throw ApiError.conflict(
      'This coupon has been used and cannot be deleted. Pause it instead.',
      undefined,
      'coupon_used',
    );
  }
  await coupon.deleteOne();
  return { deleted: true };
}

async function listRedemptions({ couponId, page, limit }) {
  const coupon = await findCoupon(couponId);
  const { skip, limit: size, page: current } = paging({ page, limit });
  const [rows, total] = await Promise.all([
    CouponRedemption.find({ coupon: coupon._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(size)
      .populate('user', 'name phone email'),
    CouponRedemption.countDocuments({ coupon: coupon._id }),
  ]);
  const items = rows.map(row => ({
    id: String(row._id),
    user: row.user
      ? {
          id: String(row.user._id),
          name: row.user.name,
          phone: row.user.phone?.number ? `${row.user.phone.countryCode || ''}${row.user.phone.number}` : undefined,
          email: row.user.email,
        }
      : null,
    context: row.context,
    reference: String(row.reference),
    amountBefore: row.amountBefore,
    discount: row.discount,
    createdAt: row.createdAt,
  }));
  return { items, total, page: current, limit: size, coupon };
}

/* ---- festival offers ---- */

async function adminListFestivals({ status, page, limit }) {
  const query = {};
  if (status) query.status = status;
  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total] = await Promise.all([
    FestivalOffer.find(query).sort({ sortOrder: 1, createdAt: -1 }).skip(skip).limit(size),
    FestivalOffer.countDocuments(query),
  ]);
  return { items, total, page: current, limit: size };
}

async function findFestival(offerId) {
  const offer = mongoose.isValidObjectId(offerId) ? await FestivalOffer.findById(offerId) : null;
  if (!offer) {
    throw ApiError.notFound('Offer not found.');
  }
  return offer;
}

async function createFestival({ changes, imageUrl, admin }) {
  const offer = new FestivalOffer({
    ...changes,
    ...(imageUrl ? { imageUrl } : {}),
    createdBy: admin._id,
    updatedBy: admin._id,
  });
  await offer.save();
  return offer;
}

async function updateFestival({ offerId, changes, imageUrl, admin }) {
  const offer = await findFestival(offerId);
  offer.set({ ...changes, ...(imageUrl ? { imageUrl } : {}), updatedBy: admin._id });
  await offer.save();
  return offer;
}

async function setFestivalStatus({ offerId, status, admin }) {
  const offer = await findFestival(offerId);
  offer.status = status;
  offer.updatedBy = admin._id;
  await offer.save();
  return offer;
}

async function deleteFestival({ offerId }) {
  const offer = await findFestival(offerId);
  await offer.deleteOne();
  return { deleted: true };
}

module.exports = {
  validate,
  redeem,
  apply,
  publicCoupons,
  publicFestivals,
  adminListCoupons,
  createCoupon,
  updateCoupon,
  setCouponStatus,
  deleteCoupon,
  listRedemptions,
  adminListFestivals,
  createFestival,
  updateFestival,
  setFestivalStatus,
  deleteFestival,
  normaliseCode,
};
