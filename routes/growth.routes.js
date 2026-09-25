/**
 * /api/v1/offers, /coupons, /loyalty, /referral, /reviews, /testimonials,
 * /careers — the growth side of the website and the seeker app.
 *
 * Offers, reviews, testimonials and job listings are open. Coupon checks,
 * loyalty and referral belong to a signed-in seeker. A job application is
 * open too, but rate-limited per caller — it is an unauthenticated write
 * with a file attached.
 */

const express = require('express');

const growthController = require('../controllers/growth.controller');
const growthValidator = require('../validators/growth.validator');
const { authenticate, authorize, optionalAuthenticate } = require('../middlewares/auth.middleware');
const { uploadResume } = require('../middlewares/upload.middleware');
const { rateLimit } = require('../middlewares/rateLimit.middleware');

const router = express.Router();

const seekerOnly = [authenticate, authorize('user')];

/* --------------------------------------------------------------- offers */

router.get('/offers', optionalAuthenticate, growthController.offers);
router.post(
  '/coupons/validate',
  seekerOnly,
  growthValidator.validateCoupon,
  growthController.validateCoupon,
);

/* -------------------------------------------------------------- loyalty */

router.get('/loyalty', seekerOnly, growthController.loyalty);
router.get('/loyalty/history', seekerOnly, growthValidator.loyaltyHistory, growthController.loyaltyHistory);

/* ------------------------------------------------------------- referral */

router.get('/referral', seekerOnly, growthController.referral);

/* -------------------------------------------------------------- reviews */

router.get('/reviews', growthValidator.reviewsQuery, growthController.listReviews);
router.get('/testimonials', growthValidator.testimonialsQuery, growthController.listTestimonials);

/* -------------------------------------------------------------- careers */

router.get('/careers/jobs', growthValidator.jobsQuery, growthController.listJobs);
router.get('/careers/jobs/:slug', growthController.getJob);
router.post(
  '/careers/applications',
  rateLimit({ name: 'careers-apply', limit: 10, windowSeconds: 3600 }),
  uploadResume,
  growthValidator.createApplication,
  growthController.apply,
);

module.exports = router;
