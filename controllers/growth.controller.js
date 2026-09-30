/**
 * Offers, loyalty, referral, reviews and careers over HTTP — the website and
 * the seeker app.
 *
 * The offers page and the reviews page are open; a signed-in seeker gets their
 * own standing folded into the offers response. Loyalty and referral are the
 * seeker's own. Job applications come from anyone.
 */

const couponService = require('../services/coupon.service');
const loyaltyService = require('../services/loyalty.service');
const referralService = require('../services/referral.service');
const reviewsService = require('../services/reviews.service');
const careersService = require('../services/careers.service');
const settingsService = require('../services/settings.service');
const asyncHandler = require('../utils/asyncHandler');

/* ---------------------------------------------------------------- offers */

/** GET /api/v1/offers — everything the offers page draws in one call. */
const offers = asyncHandler(async (req, res) => {
  const userId = req.account?.role === 'user' ? req.account.accountId : null;
  const [coupons, festivals, settings, me, referral] = await Promise.all([
    couponService.publicCoupons(),
    couponService.publicFestivals(),
    settingsService.get(),
    userId ? loyaltyService.standingFor(userId) : null,
    userId ? referralService.offersBlock(userId) : null,
  ]);

  const loyalty = {
    enabled: settings.loyalty?.enabled !== false,
    tiers: loyaltyService.publicTiers(settings),
    earn: loyaltyService.publicEarn(settings),
  };
  if (me) loyalty.me = me;

  const payload = { coupons, festivals, loyalty };
  if (referral) payload.referral = referral;
  return res.json(payload);
});

/** POST /api/v1/coupons/validate */
const validateCoupon = asyncHandler(async (req, res) => {
  const { coupon, discount, payable } = await couponService.validate({
    code: req.body.code,
    context: req.body.context,
    amount: req.body.amount,
    userId: req.account.accountId,
  });
  return res.json({ valid: true, coupon: coupon.toPublicJSON(), discount, payable });
});

/* --------------------------------------------------------------- loyalty */

/** GET /api/v1/loyalty */
const loyalty = asyncHandler(async (req, res) => {
  return res.json(await loyaltyService.summary(req.account.accountId));
});

/** GET /api/v1/loyalty/history */
const loyaltyHistory = asyncHandler(async (req, res) => {
  return res.json(await loyaltyService.history({ userId: req.account.accountId, ...req.query }));
});

/* -------------------------------------------------------------- referral */

/** GET /api/v1/referral */
const referral = asyncHandler(async (req, res) => {
  return res.json(await referralService.summary(req.account.accountId));
});

/* --------------------------------------------------------------- reviews */

/** GET /api/v1/reviews */
const listReviews = asyncHandler(async (req, res) => {
  return res.json(await reviewsService.listPublic(req.query));
});

/** GET /api/v1/testimonials */
const listTestimonials = asyncHandler(async (req, res) => {
  return res.json(await reviewsService.listTestimonials(req.query));
});

/* --------------------------------------------------------------- careers */

/** GET /api/v1/careers/jobs */
const listJobs = asyncHandler(async (req, res) => {
  return res.json(await careersService.listJobs(req.query));
});

/** GET /api/v1/careers/jobs/:slug */
const getJob = asyncHandler(async (req, res) => {
  return res.json(await careersService.getJob(req.params.slug));
});

/** POST /api/v1/careers/applications — multipart, with an optional `resume`. */
const apply = asyncHandler(async (req, res) => {
  const application = await careersService.apply({
    jobId: req.body.jobId,
    kind: req.body.kind,
    roleTitle: req.body.roleTitle,
    fullName: req.body.fullName,
    email: req.body.email,
    phone: req.body.phone,
    experience: req.body.experience,
    linkedin: req.body.linkedin,
    message: req.body.message,
    resume: req.uploadedFile,
  });
  return res.status(201).json({
    application: {
      id: String(application._id),
      reference: application.reference,
      roleTitle: application.roleTitle,
      kind: application.kind,
      status: application.status,
    },
  });
});

module.exports = {
  offers,
  validateCoupon,
  loyalty,
  loyaltyHistory,
  referral,
  listReviews,
  listTestimonials,
  listJobs,
  getJob,
  apply,
};
