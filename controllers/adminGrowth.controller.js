/**
 * The admin panel's Offers, Reviews and Careers pages over HTTP.
 *
 * Same rules as controllers/admin.controller.js: everything runs behind
 * `adminOnly`, and every write logs an audit row after the service succeeded.
 */

const couponService = require('../services/coupon.service');
const loyaltyService = require('../services/loyalty.service');
const referralService = require('../services/referral.service');
const reviewsService = require('../services/reviews.service');
const careersService = require('../services/careers.service');
const auditService = require('../services/audit.service');
const asyncHandler = require('../utils/asyncHandler');

const logChange = (req, { action, area, target, targetId, details }) =>
  auditService.record({ admin: req.admin, action, area, target, targetId, ip: req.ip, details });

/* --------------------------------------------------------------- coupons */

/** GET /api/v1/admin/coupons */
const listCoupons = asyncHandler(async (req, res) => {
  return res.json(await couponService.adminListCoupons(req.query));
});

/** POST /api/v1/admin/coupons */
const createCoupon = asyncHandler(async (req, res) => {
  const coupon = await couponService.createCoupon({ changes: req.body, admin: req.admin });
  await logChange(req, {
    action: 'Added coupon',
    area: 'Offers',
    target: coupon.code,
    targetId: coupon._id,
    details: { kind: coupon.kind, value: coupon.value, appliesTo: coupon.appliesTo },
  });
  return res.status(201).json({ coupon });
});

/** PUT /api/v1/admin/coupons/:couponId */
const updateCoupon = asyncHandler(async (req, res) => {
  const coupon = await couponService.updateCoupon({
    couponId: req.params.couponId,
    changes: req.body,
    admin: req.admin,
  });
  await logChange(req, {
    action: 'Updated coupon',
    area: 'Offers',
    target: coupon.code,
    targetId: coupon._id,
    details: { fields: Object.keys(req.body || {}) },
  });
  return res.json({ coupon });
});

/** PATCH /api/v1/admin/coupons/:couponId/status */
const setCouponStatus = asyncHandler(async (req, res) => {
  const coupon = await couponService.setCouponStatus({
    couponId: req.params.couponId,
    status: req.body.status,
    admin: req.admin,
  });
  await logChange(req, {
    action: `Marked coupon ${coupon.status}`,
    area: 'Offers',
    target: coupon.code,
    targetId: coupon._id,
  });
  return res.json({ coupon });
});

/** DELETE /api/v1/admin/coupons/:couponId — only an unused one. */
const deleteCoupon = asyncHandler(async (req, res) => {
  const result = await couponService.deleteCoupon({ couponId: req.params.couponId });
  await logChange(req, {
    action: 'Deleted coupon',
    area: 'Offers',
    target: req.params.couponId,
    targetId: req.params.couponId,
  });
  return res.json(result);
});

/** GET /api/v1/admin/coupons/:couponId/redemptions */
const listRedemptions = asyncHandler(async (req, res) => {
  const { coupon, ...list } = await couponService.listRedemptions({
    couponId: req.params.couponId,
    ...req.query,
  });
  return res.json({ ...list, coupon: { id: String(coupon._id), code: coupon.code, usedCount: coupon.usedCount } });
});

/* ------------------------------------------------------- festival offers */

/** GET /api/v1/admin/festival-offers */
const listFestivals = asyncHandler(async (req, res) => {
  return res.json(await couponService.adminListFestivals(req.query));
});

/** POST /api/v1/admin/festival-offers — JSON, or multipart with an `image`. */
const createFestival = asyncHandler(async (req, res) => {
  const offer = await couponService.createFestival({
    changes: req.body,
    imageUrl: req.uploadedPhotoUrl,
    admin: req.admin,
  });
  await logChange(req, {
    action: 'Added festival offer',
    area: 'Offers',
    target: offer.title,
    targetId: offer._id,
  });
  return res.status(201).json({ offer });
});

/** PUT /api/v1/admin/festival-offers/:offerId */
const updateFestival = asyncHandler(async (req, res) => {
  const offer = await couponService.updateFestival({
    offerId: req.params.offerId,
    changes: req.body,
    imageUrl: req.uploadedPhotoUrl,
    admin: req.admin,
  });
  await logChange(req, {
    action: 'Updated festival offer',
    area: 'Offers',
    target: offer.title,
    targetId: offer._id,
    details: { fields: Object.keys(req.body || {}) },
  });
  return res.json({ offer });
});

/** PATCH /api/v1/admin/festival-offers/:offerId/status */
const setFestivalStatus = asyncHandler(async (req, res) => {
  const offer = await couponService.setFestivalStatus({
    offerId: req.params.offerId,
    status: req.body.status,
    admin: req.admin,
  });
  await logChange(req, {
    action: `Marked festival offer ${offer.status}`,
    area: 'Offers',
    target: offer.title,
    targetId: offer._id,
  });
  return res.json({ offer });
});

/** DELETE /api/v1/admin/festival-offers/:offerId */
const deleteFestival = asyncHandler(async (req, res) => {
  const result = await couponService.deleteFestival({ offerId: req.params.offerId });
  await logChange(req, {
    action: 'Deleted festival offer',
    area: 'Offers',
    target: req.params.offerId,
    targetId: req.params.offerId,
  });
  return res.json(result);
});

/* --------------------------------------------------------------- loyalty */

/** POST /api/v1/admin/loyalty/adjust */
const adjustLoyalty = asyncHandler(async (req, res) => {
  const result = await loyaltyService.adminAdjust({
    userId: req.body.userId,
    points: req.body.points,
    reason: req.body.reason,
    admin: req.admin,
  });
  await logChange(req, {
    action: `${req.body.points > 0 ? 'Added' : 'Deducted'} ${Math.abs(req.body.points)} loyalty points`,
    area: 'Wallets',
    target: req.body.userId,
    targetId: req.body.userId,
    details: { reason: req.body.reason },
  });
  return res.status(201).json(result);
});

/* ------------------------------------------------------------- referrals */

/** GET /api/v1/admin/referrals */
const listReferrals = asyncHandler(async (req, res) => {
  return res.json(await referralService.adminList(req.query));
});

/* --------------------------------------------------------------- reviews */

/** GET /api/v1/admin/reviews */
const listReviews = asyncHandler(async (req, res) => {
  return res.json(await reviewsService.adminList(req.query));
});

/** PATCH /api/v1/admin/reviews/:kind/:id */
const updateReview = asyncHandler(async (req, res) => {
  const review = await reviewsService.adminUpdate({
    kind: req.params.kind,
    id: req.params.id,
    hidden: req.body.hidden,
    pinned: req.body.pinned,
    flagged: req.body.flagged,
    flagReason: req.body.flagReason,
    reply: req.body.reply,
  });

  const parts = [];
  if (req.body.hidden !== undefined) parts.push(req.body.hidden ? 'hid' : 'unhid');
  if (req.body.pinned !== undefined) parts.push(req.body.pinned ? 'pinned' : 'unpinned');
  if (req.body.flagged !== undefined) parts.push(req.body.flagged ? 'flagged' : 'unflagged');
  if (req.body.reply !== undefined) parts.push('replied to');
  await logChange(req, {
    action: `${parts.length ? parts.join(', ') : 'Updated'} ${req.params.kind} review`.replace(/^./, c => c.toUpperCase()),
    area: 'Reviews',
    target: `${review.reviewer?.name || 'Review'} · ${review.rating}★`,
    targetId: req.params.id,
    details: { flagReason: req.body.flagReason },
  });
  return res.json({ review });
});

/* ---------------------------------------------------------- testimonials */

/** GET /api/v1/admin/testimonials */
const listTestimonials = asyncHandler(async (req, res) => {
  return res.json(await reviewsService.adminListTestimonials(req.query));
});

/** POST /api/v1/admin/testimonials — JSON, or multipart with `avatar` and/or `thumbnail`. */
const createTestimonial = asyncHandler(async (req, res) => {
  const testimonial = await reviewsService.createTestimonial({
    changes: req.body,
    uploads: req.uploadedUrls,
    admin: req.admin,
  });
  await logChange(req, {
    action: `Added ${testimonial.kind} testimonial`,
    area: 'Reviews',
    target: testimonial.title,
    targetId: testimonial._id,
  });
  return res.status(201).json({ testimonial });
});

/** PUT /api/v1/admin/testimonials/:testimonialId */
const updateTestimonial = asyncHandler(async (req, res) => {
  const testimonial = await reviewsService.updateTestimonial({
    testimonialId: req.params.testimonialId,
    changes: req.body,
    uploads: req.uploadedUrls,
    admin: req.admin,
  });
  await logChange(req, {
    action: 'Updated testimonial',
    area: 'Reviews',
    target: testimonial.title,
    targetId: testimonial._id,
    details: { fields: Object.keys(req.body || {}) },
  });
  return res.json({ testimonial });
});

/** PATCH /api/v1/admin/testimonials/:testimonialId/status */
const setTestimonialStatus = asyncHandler(async (req, res) => {
  const testimonial = await reviewsService.setTestimonialStatus({
    testimonialId: req.params.testimonialId,
    status: req.body.status,
    admin: req.admin,
  });
  await logChange(req, {
    action: `Marked testimonial ${testimonial.status}`,
    area: 'Reviews',
    target: testimonial.title,
    targetId: testimonial._id,
  });
  return res.json({ testimonial });
});

/** DELETE /api/v1/admin/testimonials/:testimonialId */
const deleteTestimonial = asyncHandler(async (req, res) => {
  const result = await reviewsService.deleteTestimonial({ testimonialId: req.params.testimonialId });
  await logChange(req, {
    action: 'Deleted testimonial',
    area: 'Reviews',
    target: req.params.testimonialId,
    targetId: req.params.testimonialId,
  });
  return res.json(result);
});

/* ------------------------------------------------------------------ jobs */

/** GET /api/v1/admin/jobs */
const listJobs = asyncHandler(async (req, res) => {
  return res.json(await careersService.adminListJobs(req.query));
});

/** POST /api/v1/admin/jobs */
const createJob = asyncHandler(async (req, res) => {
  const job = await careersService.createJob({ changes: req.body, admin: req.admin });
  await logChange(req, {
    action: 'Added job posting',
    area: 'Careers',
    target: job.title,
    targetId: job._id,
    details: { department: job.department, type: job.type },
  });
  return res.status(201).json({ job });
});

/** PUT /api/v1/admin/jobs/:jobId */
const updateJob = asyncHandler(async (req, res) => {
  const job = await careersService.updateJob({
    jobId: req.params.jobId,
    changes: req.body,
    admin: req.admin,
  });
  await logChange(req, {
    action: 'Updated job posting',
    area: 'Careers',
    target: job.title,
    targetId: job._id,
    details: { fields: Object.keys(req.body || {}) },
  });
  return res.json({ job });
});

/** PATCH /api/v1/admin/jobs/:jobId/status */
const setJobStatus = asyncHandler(async (req, res) => {
  const job = await careersService.setJobStatus({
    jobId: req.params.jobId,
    status: req.body.status,
    admin: req.admin,
  });
  await logChange(req, {
    action: `Marked job posting ${job.status}`,
    area: 'Careers',
    target: job.title,
    targetId: job._id,
  });
  return res.json({ job });
});

/** DELETE /api/v1/admin/jobs/:jobId */
const deleteJob = asyncHandler(async (req, res) => {
  const result = await careersService.deleteJob({ jobId: req.params.jobId });
  await logChange(req, {
    action: 'Deleted job posting',
    area: 'Careers',
    target: req.params.jobId,
    targetId: req.params.jobId,
  });
  return res.json(result);
});

/* ---------------------------------------------------------- applications */

/** GET /api/v1/admin/applications */
const listApplications = asyncHandler(async (req, res) => {
  return res.json(await careersService.adminListApplications(req.query));
});

/** GET /api/v1/admin/applications/:applicationId */
const applicationDetail = asyncHandler(async (req, res) => {
  return res.json({ application: await careersService.adminGetApplication(req.params.applicationId) });
});

/** PATCH /api/v1/admin/applications/:applicationId */
const updateApplication = asyncHandler(async (req, res) => {
  const application = await careersService.adminUpdateApplication({
    applicationId: req.params.applicationId,
    status: req.body.status,
    adminNote: req.body.adminNote,
    admin: req.admin,
  });
  await logChange(req, {
    action: req.body.status ? `Marked application ${req.body.status}` : 'Updated application',
    area: 'Careers',
    target: `${application.reference} · ${application.fullName}`,
    targetId: application._id,
    details: { adminNote: req.body.adminNote },
  });
  return res.json({ application });
});

module.exports = {
  listCoupons,
  createCoupon,
  updateCoupon,
  setCouponStatus,
  deleteCoupon,
  listRedemptions,
  listFestivals,
  createFestival,
  updateFestival,
  setFestivalStatus,
  deleteFestival,
  adjustLoyalty,
  listReferrals,
  listReviews,
  updateReview,
  listTestimonials,
  createTestimonial,
  updateTestimonial,
  setTestimonialStatus,
  deleteTestimonial,
  listJobs,
  createJob,
  updateJob,
  setJobStatus,
  deleteJob,
  listApplications,
  applicationDetail,
  updateApplication,
};
