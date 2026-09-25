/**
 * What the offers, loyalty, referral, reviews and careers endpoints accept.
 *
 * Admin forms for festival offers and testimonials may be multipart (an image
 * alongside the fields), where every value arrives as a string — `toList`,
 * `toBoolean()` and `toInt()` normalise that, the same as the shop's forms.
 */

const { body, param, query } = require('express-validator');

const { KINDS: COUPON_KINDS, CONTEXTS, STATUSES: COUPON_STATUSES, TONES } = require('../models/Coupon');
const { STATUSES: FESTIVAL_STATUSES } = require('../models/FestivalOffer');
const { KINDS: TESTIMONIAL_KINDS, STATUSES: TESTIMONIAL_STATUSES } = require('../models/Testimonial');
const { TYPES: JOB_TYPES, STATUSES: JOB_STATUSES } = require('../models/JobPosting');
const { KINDS: APPLICATION_KINDS, STATUSES: APPLICATION_STATUSES } = require('../models/JobApplication');
const { validate } = require('../middlewares/validate.middleware');
const { toList } = require('./commerce.validator');

const REVIEW_KINDS = ['consultation', 'puja', 'product'];

const optionalText = (field, max) =>
  body(field).optional({ values: 'null' }).trim().isLength({ max }).withMessage(`Keep this under ${max} characters.`);

/** `null`, `''` and `'null'` all mean "none". */
const toNullableInt = value =>
  value === null || value === undefined || value === '' || value === 'null' ? null : Number(value);

const toNullableDate = value =>
  value === null || value === undefined || value === '' || value === 'null' ? null : new Date(value);

const nullableInt = (field, { min = 0 } = {}) =>
  body(field)
    .optional()
    .customSanitizer(toNullableInt)
    .custom(value => {
      if (value === null) return true;
      if (!Number.isInteger(value) || value < min) throw new Error(`Enter a whole number${min ? ` of at least ${min}` : ''}.`);
      return true;
    });

const nullableDate = field =>
  body(field)
    .optional()
    .customSanitizer(toNullableDate)
    .custom(value => {
      if (value === null) return true;
      if (Number.isNaN(value.getTime())) throw new Error('Enter a valid date.');
      return true;
    });

const pageQuery = [
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Page is 1 or more.').toInt(),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }).withMessage('Limit is 1–100.').toInt(),
];

/* --------------------------------------------------------------- coupons */

const validateCoupon = [
  body('code').trim().toUpperCase().isLength({ min: 3, max: 20 }).withMessage('Enter a coupon code.'),
  body('context').isIn(CONTEXTS).withMessage('Say where the coupon is being used.'),
  body('amount').isInt({ min: 0 }).withMessage('Enter the amount.').toInt(),
  validate,
];

const couponFields = isUpdate => {
  const maybe = chain => (isUpdate ? chain.optional() : chain);
  return [
    maybe(
      body('code')
        .trim()
        .toUpperCase()
        .matches(/^[A-Z0-9]{3,20}$/)
        .withMessage('A code is 3–20 letters and digits.'),
    ),
    maybe(body('title').trim().isLength({ min: 2, max: 80 }).withMessage('Enter a title.')),
    optionalText('description', 300),
    maybe(body('kind').isIn(COUPON_KINDS).withMessage('Kind is percent or flat.')),
    maybe(body('value').isInt({ min: 1 }).withMessage('Enter the discount value.').toInt()),
    nullableInt('maxDiscount'),
    body('minAmount').optional().isInt({ min: 0 }).withMessage('Minimum amount is 0 or more.').toInt(),
    maybe(
      body('appliesTo')
        .customSanitizer(toList)
        .custom(list => {
          if (!Array.isArray(list) || !list.length) throw new Error('Pick where the coupon applies.');
          if (!list.every(entry => CONTEXTS.includes(entry))) throw new Error('Applies to: order, puja or topup.');
          return true;
        }),
    ),
    nullableDate('validFrom'),
    nullableDate('validTo'),
    nullableInt('usageLimit', { min: 1 }),
    body('perUserLimit').optional().isInt({ min: 1 }).withMessage('Per-user limit is 1 or more.').toInt(),
    body('status').optional().isIn(COUPON_STATUSES).withMessage('Unknown status.'),
    body('isPublic').optional().isBoolean().withMessage('Public is yes or no.').toBoolean(),
    optionalText('tag', 30),
    body('tone').optional({ values: 'falsy' }).isIn(TONES).withMessage('Unknown tone.'),
    validate,
  ];
};

const createCoupon = couponFields(false);
const updateCoupon = [param('couponId').isMongoId().withMessage('Unknown coupon.'), ...couponFields(true)];
const couponStatus = [
  param('couponId').isMongoId().withMessage('Unknown coupon.'),
  body('status').isIn(COUPON_STATUSES).withMessage('Unknown status.'),
  validate,
];
const couponId = [param('couponId').isMongoId().withMessage('Unknown coupon.'), ...pageQuery, validate];

/* ------------------------------------------------------- festival offers */

const festivalFields = isUpdate => {
  const maybe = chain => (isUpdate ? chain.optional() : chain);
  return [
    maybe(body('title').trim().isLength({ min: 2, max: 100 }).withMessage('Enter a title.')),
    optionalText('subtitle', 200),
    optionalText('badge', 30),
    body('imageUrl').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
    nullableDate('startsAt'),
    nullableDate('endsAt'),
    body('linkTo').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
    body('couponCode')
      .optional({ values: 'null' })
      .customSanitizer(value => (value === '' || value === 'null' ? null : value))
      .custom(value => {
        if (value === null) return true;
        if (!/^[A-Za-z0-9]{3,20}$/.test(String(value))) throw new Error('A code is 3–20 letters and digits.');
        return true;
      })
      .customSanitizer(value => (value === null ? null : String(value).toUpperCase())),
    body('status').optional().isIn(FESTIVAL_STATUSES).withMessage('Unknown status.'),
    body('sortOrder').optional().isInt().withMessage('Sort order is a number.').toInt(),
    validate,
  ];
};

const createFestival = festivalFields(false);
const updateFestival = [param('offerId').isMongoId().withMessage('Unknown offer.'), ...festivalFields(true)];
const festivalStatus = [
  param('offerId').isMongoId().withMessage('Unknown offer.'),
  body('status').isIn(FESTIVAL_STATUSES).withMessage('Unknown status.'),
  validate,
];

/* --------------------------------------------------------------- loyalty */

const loyaltyHistory = [...pageQuery, validate];

const loyaltyAdjust = [
  body('userId').isMongoId().withMessage('Pick a user.'),
  body('points')
    .isInt()
    .withMessage('Points are a whole number.')
    .toInt()
    .custom(value => {
      if (value === 0) throw new Error('Points cannot be zero.');
      return true;
    }),
  body('reason').trim().isLength({ min: 3, max: 200 }).withMessage('Say why.'),
  validate,
];

/* --------------------------------------------------------------- reviews */

const reviewsQuery = [
  query('rating').optional({ values: 'falsy' }).isInt({ min: 1, max: 5 }).withMessage('Rating is 1–5.').toInt(),
  query('min').optional({ values: 'falsy' }).isInt({ min: 1, max: 5 }).withMessage('Minimum rating is 1–5.').toInt(),
  query('kind').optional({ values: 'falsy' }).isIn(REVIEW_KINDS).withMessage('Kind is consultation, puja or product.'),
  ...pageQuery,
  validate,
];

const reviewPatch = [
  param('kind').isIn(REVIEW_KINDS).withMessage('Kind is consultation, puja or product.'),
  param('id').isMongoId().withMessage('Unknown review.'),
  body('hidden').optional().isBoolean().withMessage('Hidden is yes or no.').toBoolean(),
  body('pinned').optional().isBoolean().withMessage('Pinned is yes or no.').toBoolean(),
  body('flagged').optional().isBoolean().withMessage('Flagged is yes or no.').toBoolean(),
  optionalText('flagReason', 300),
  optionalText('reply', 1000),
  validate,
];

/* ---------------------------------------------------------- testimonials */

const testimonialsQuery = [
  query('kind').optional({ values: 'falsy' }).isIn(TESTIMONIAL_KINDS).withMessage('Kind is video or story.'),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }).toInt(),
  validate,
];

const testimonialFields = isUpdate => {
  const maybe = chain => (isUpdate ? chain.optional() : chain);
  return [
    maybe(body('kind').isIn(TESTIMONIAL_KINDS).withMessage('Kind is video or story.')),
    maybe(body('title').trim().isLength({ min: 2, max: 120 }).withMessage('Enter a title.')),
    optionalText('quote', 1000),
    maybe(body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Enter the name.')),
    optionalText('city', 60),
    optionalText('tag', 60),
    optionalText('outcome', 120),
    optionalText('duration', 40),
    body('avatarUrl').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
    body('thumbnailUrl').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
    body('videoUrl').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
    body('views').optional().isInt({ min: 0 }).withMessage('Views is 0 or more.').toInt(),
    body('status').optional().isIn(TESTIMONIAL_STATUSES).withMessage('Unknown status.'),
    body('sortOrder').optional().isInt().withMessage('Sort order is a number.').toInt(),
    validate,
  ];
};

const createTestimonial = testimonialFields(false);
const updateTestimonial = [
  param('testimonialId').isMongoId().withMessage('Unknown testimonial.'),
  ...testimonialFields(true),
];
const testimonialStatus = [
  param('testimonialId').isMongoId().withMessage('Unknown testimonial.'),
  body('status').isIn(TESTIMONIAL_STATUSES).withMessage('Unknown status.'),
  validate,
];

/* --------------------------------------------------------------- careers */

const jobsQuery = [...pageQuery, validate];

const jobFields = isUpdate => {
  const maybe = chain => (isUpdate ? chain.optional() : chain);
  return [
    maybe(body('title').trim().isLength({ min: 2, max: 120 }).withMessage('Enter a title.')),
    body('slug').optional({ values: 'falsy' }).trim().isLength({ max: 80 }),
    maybe(
      body('department')
        .trim()
        .toLowerCase()
        .matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        .withMessage('Department is lowercase-kebab, e.g. engineering.'),
    ),
    optionalText('location', 80),
    body('type').optional({ values: 'falsy' }).isIn(JOB_TYPES).withMessage('Unknown job type.'),
    optionalText('experience', 40),
    body('tags').optional().customSanitizer(toList),
    optionalText('description', 5000),
    body('responsibilities').optional().customSanitizer(toList),
    body('requirements').optional().customSanitizer(toList),
    optionalText('stipend', 40),
    optionalText('salary', 40),
    body('openings').optional().isInt({ min: 1 }).withMessage('Openings is 1 or more.').toInt(),
    body('status').optional().isIn(JOB_STATUSES).withMessage('Unknown status.'),
    nullableDate('postedAt'),
    validate,
  ];
};

const createJob = jobFields(false);
const updateJob = [param('jobId').isMongoId().withMessage('Unknown job.'), ...jobFields(true)];
const jobStatus = [
  param('jobId').isMongoId().withMessage('Unknown job.'),
  body('status').isIn(JOB_STATUSES).withMessage('Unknown status.'),
  validate,
];

const createApplication = [
  body('jobId').optional({ values: 'falsy' }).trim().isLength({ max: 80 }),
  /** Required unless a job is named — `optional()` would skip the check entirely, so it is one custom rule. */
  body('kind').custom((value, { req }) => {
    if (!value) {
      if (!req.body.jobId) throw new Error('Say what you are applying for.');
      return true;
    }
    if (!APPLICATION_KINDS.includes(value)) throw new Error('Kind is job, astrologer or internship.');
    return true;
  }),
  optionalText('roleTitle', 120),
  body('fullName').trim().isLength({ min: 2, max: 80 }).withMessage('Enter your full name.'),
  body('email').trim().isEmail().withMessage('Enter a valid email address.'),
  body('phone').trim().matches(/^\+?\d{10,14}$/).withMessage('Enter a valid phone number.'),
  optionalText('experience', 120),
  optionalText('linkedin', 300),
  optionalText('message', 3000),
  validate,
];

const applicationPatch = [
  param('applicationId').isMongoId().withMessage('Unknown application.'),
  body('status').optional({ values: 'falsy' }).isIn(APPLICATION_STATUSES).withMessage('Unknown status.'),
  optionalText('adminNote', 1000),
  validate,
];

module.exports = {
  validateCoupon,
  createCoupon,
  updateCoupon,
  couponStatus,
  couponId,
  createFestival,
  updateFestival,
  festivalStatus,
  loyaltyHistory,
  loyaltyAdjust,
  reviewsQuery,
  reviewPatch,
  testimonialsQuery,
  createTestimonial,
  updateTestimonial,
  testimonialStatus,
  jobsQuery,
  createJob,
  updateJob,
  jobStatus,
  createApplication,
  applicationPatch,
  pageQuery,
};
