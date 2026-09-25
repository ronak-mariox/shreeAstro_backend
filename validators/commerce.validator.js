/**
 * What the store, puja and article endpoints accept.
 *
 * Admin product/puja forms may arrive as multipart (an image alongside the
 * fields), where every value is a string and a list is either JSON or one
 * entry per line — `toList` and the `toBoolean`/`toInt` sanitizers normalise
 * that so the service only ever sees typed values.
 */

const { body, param, query } = require('express-validator');

const { STATUSES: PRODUCT_STATUSES } = require('../models/Product');
const { STATUSES: PUJA_STATUSES } = require('../models/Puja');
const { STATUSES: ORDER_STATUSES } = require('../models/Order');
const { validate } = require('../middlewares/validate.middleware');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}\s*[AP]M$/i;

/** A list field from JSON (already an array), a JSON string, or newline/comma-separated text. */
function toList(value) {
  if (Array.isArray(value)) {
    return value.map(entry => String(entry).trim()).filter(Boolean);
  }
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const text = String(value).trim();
  if (text.startsWith('[')) {
    try {
      return toList(JSON.parse(text));
    } catch (error) {
      /** Not JSON after all — fall through to splitting. */
    }
  }
  return text
    .split(/\r?\n|,/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

/** `null`, `''` and `'null'` all mean "no old price". */
const toNullableInt = value =>
  value === null || value === undefined || value === '' || value === 'null' ? null : Number(value);

const optionalText = (field, max) =>
  body(field).optional({ values: 'null' }).trim().isLength({ max }).withMessage(`Keep this under ${max} characters.`);

/** An optional coupon on an order or a booking — checked for real by services/coupon.service.js. */
const couponCodeField = body('couponCode')
  .optional({ values: 'falsy' })
  .trim()
  .toUpperCase()
  .isLength({ min: 3, max: 20 })
  .withMessage('Enter a valid coupon code.');

/* ------------------------------------------------------------------ orders */

const createOrder = [
  body('items').isArray({ min: 1 }).withMessage('Add at least one item.'),
  body('items.*.productId').isMongoId().withMessage('Unknown product.'),
  body('items.*.qty').isInt({ min: 1, max: 10 }).withMessage('Quantity must be between 1 and 10.').toInt(),
  body('shipping.fullName').trim().isLength({ min: 2, max: 80 }).withMessage('Enter the full name.'),
  body('shipping.phone').trim().matches(/^\+?\d{10,14}$/).withMessage('Enter a valid phone number.'),
  body('shipping.email').optional({ values: 'falsy' }).trim().isEmail().withMessage('Enter a valid email address.'),
  body('shipping.address').trim().isLength({ min: 5, max: 300 }).withMessage('Enter the address.'),
  body('shipping.city').trim().isLength({ min: 2, max: 80 }).withMessage('Enter the city.'),
  body('shipping.state').trim().isLength({ min: 2, max: 80 }).withMessage('Enter the state.'),
  body('shipping.pincode').trim().matches(/^\d{6}$/).withMessage('Enter a 6-digit pincode.'),
  couponCodeField,
  validate,
];

const cancelOrder = [param('orderId').isMongoId().withMessage('Unknown order.'), validate];

const listOrders = [
  query('status').optional({ values: 'falsy' }).isIn(['active', 'delivered', 'cancelled']).withMessage('Unknown status.'),
  validate,
];

/* ---------------------------------------------------------------- bookings */

const slotsQuery = [
  query('date').matches(DATE_PATTERN).withMessage('Use the format YYYY-MM-DD.'),
  validate,
];

const createBooking = [
  body('pujaId').trim().notEmpty().withMessage('Choose a puja.'),
  body('date').matches(DATE_PATTERN).withMessage('Use the format YYYY-MM-DD.'),
  body('time').trim().matches(TIME_PATTERN).withMessage('Pick a time slot.'),
  body('contact.fullName').trim().isLength({ min: 2, max: 80 }).withMessage('Enter the full name.'),
  body('contact.phone').trim().matches(/^\+?\d{10,14}$/).withMessage('Enter a valid phone number.'),
  body('contact.email').optional({ values: 'falsy' }).trim().isEmail().withMessage('Enter a valid email address.'),
  optionalText('contact.gotra', 80),
  optionalText('contact.address', 300),
  optionalText('notes', 1000),
  couponCodeField,
  validate,
];

const cancelBooking = [param('bookingId').isMongoId().withMessage('Unknown booking.'), validate];

const bookingRate = [
  param('bookingId').isMongoId().withMessage('Unknown booking.'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rate between 1 and 5.').toInt(),
  optionalText('comment', 1000),
  validate,
];

/* --------------------------------------------------------- product reviews */

const productReviewsQuery = [
  query('rating').optional({ values: 'falsy' }).isInt({ min: 1, max: 5 }).withMessage('Rating is 1–5.').toInt(),
  query('sort').optional({ values: 'falsy' }).isIn(['recent', 'oldest', 'top', 'low']).withMessage('Unknown sort.'),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }).toInt(),
  validate,
];

const createProductReview = [
  body('orderId').isMongoId().withMessage('Unknown order.'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rate between 1 and 5.').toInt(),
  optionalText('title', 80),
  body('comment')
    .trim()
    .isLength({ min: 3, max: 1000 })
    .withMessage('Write a few words about the product (3–1000 characters).'),
  validate,
];

const listBookings = [
  query('status').optional({ values: 'falsy' }).isIn(['upcoming', 'completed', 'cancelled']).withMessage('Unknown status.'),
  validate,
];

/* ------------------------------------------------------------ admin: shop */

/** Shared by create (everything required) and update (everything optional). */
const productFields = isUpdate => {
  const maybe = chain => (isUpdate ? chain.optional() : chain);
  return [
    maybe(body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Enter a product name.')),
    body('slug').optional({ values: 'falsy' }).trim().isLength({ max: 80 }),
    maybe(body('category').trim().toLowerCase().matches(/^[a-z0-9]+(-[a-z0-9]+)*$/).withMessage('Category must be lowercase-kebab, e.g. puja-kits.')),
    body('badge').optional({ values: 'null' }).trim().isLength({ max: 40 }).withMessage('Keep the badge short.'),
    optionalText('description', 3000),
    body('highlights').optional().customSanitizer(toList),
    body('images').optional().customSanitizer(toList),
    /** The existing gallery URLs to retain, in order; new uploads are appended after them. */
    body('keepImages').optional().customSanitizer(toList),
    body('imageUrl').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
    maybe(body('price').isInt({ min: 0 }).withMessage('Enter a whole-rupee price.').toInt()),
    body('oldPrice')
      .optional()
      .customSanitizer(toNullableInt)
      .custom((value, { req }) => {
        if (value === null) return true;
        if (!Number.isInteger(value) || value < 0) throw new Error('Enter a whole-rupee old price.');
        if (req.body.price !== undefined && value <= Number(req.body.price)) {
          throw new Error('The old price must be higher than the price.');
        }
        return true;
      }),
    body('stock').optional().isInt({ min: 0 }).withMessage('Stock must be 0 or more.').toInt(),
    body('sku').optional({ values: 'null' }).trim().isLength({ max: 60 }),
    body('rating').optional().isFloat({ min: 0, max: 5 }).withMessage('Rating is 0–5.').toFloat(),
    body('ratingCount').optional().isInt({ min: 0 }).toInt(),
    body('isFeatured').optional().isBoolean().withMessage('Featured is yes or no.').toBoolean(),
    body('status').optional().isIn(PRODUCT_STATUSES).withMessage('Unknown status.'),
    validate,
  ];
};

const createProduct = productFields(false);
const updateProduct = [param('productId').isMongoId().withMessage('Unknown product.'), ...productFields(true)];

const productStatus = [
  param('productId').isMongoId().withMessage('Unknown product.'),
  body('status').isIn(PRODUCT_STATUSES).withMessage('Unknown status.'),
  validate,
];

const orderStatus = [
  param('orderId').isMongoId().withMessage('Unknown order.'),
  body('status').isIn(ORDER_STATUSES).withMessage('Unknown status.'),
  optionalText('note', 300),
  validate,
];

/* ----------------------------------------------------------- admin: pujas */

const pujaFields = isUpdate => {
  const maybe = chain => (isUpdate ? chain.optional() : chain);
  return [
    maybe(body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Enter a puja name.')),
    body('slug').optional({ values: 'falsy' }).trim().isLength({ max: 80 }),
    optionalText('tagline', 200),
    body('category').optional({ values: 'falsy' }).trim().toLowerCase().matches(/^[a-z0-9]+(-[a-z0-9]+)*$/).withMessage('Category must be lowercase-kebab, e.g. home-vastu.'),
    optionalText('categoryLabel', 60),
    body('badge').optional({ values: 'null' }).trim().isLength({ max: 40 }),
    optionalText('deity', 60),
    body('imageUrl').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
    optionalText('description', 5000),
    body('benefits').optional().customSanitizer(toList),
    maybe(body('price').isInt({ min: 0 }).withMessage('Enter a whole-rupee price.').toInt()),
    body('oldPrice')
      .optional()
      .customSanitizer(toNullableInt)
      .custom((value, { req }) => {
        if (value === null) return true;
        if (!Number.isInteger(value) || value < 0) throw new Error('Enter a whole-rupee old price.');
        if (req.body.price !== undefined && value <= Number(req.body.price)) {
          throw new Error('The old price must be higher than the price.');
        }
        return true;
      }),
    optionalText('durationText', 40),
    optionalText('panditName', 80),
    body('timeSlots')
      .optional()
      .customSanitizer(toList)
      .custom(list => {
        if (!Array.isArray(list) || !list.length) throw new Error('Offer at least one time slot.');
        if (!list.every(slot => TIME_PATTERN.test(slot))) throw new Error('Time slots look like "8:00 AM".');
        return true;
      }),
    body('maxPerSlot').optional().isInt({ min: 1, max: 100 }).withMessage('Bookings per slot is 1–100.').toInt(),
    body('rating').optional().isFloat({ min: 0, max: 5 }).toFloat(),
    body('ratingCount').optional().isInt({ min: 0 }).toInt(),
    body('isFeatured').optional().isBoolean().withMessage('Featured is yes or no.').toBoolean(),
    body('status').optional().isIn(PUJA_STATUSES).withMessage('Unknown status.'),
    validate,
  ];
};

const createPuja = pujaFields(false);
const updatePuja = [param('pujaId').isMongoId().withMessage('Unknown puja.'), ...pujaFields(true)];

const pujaStatus = [
  param('pujaId').isMongoId().withMessage('Unknown puja.'),
  body('status').isIn(PUJA_STATUSES).withMessage('Unknown status.'),
  validate,
];

const bookingPatch = [
  param('bookingId').isMongoId().withMessage('Unknown booking.'),
  body('status').optional({ values: 'falsy' }).isIn(['completed', 'cancelled']).withMessage('Unknown status.'),
  body('streamUrl').optional({ values: 'null' }).trim().isLength({ max: 500 }),
  optionalText('adminNote', 1000),
  validate,
];

const bookingsListQuery = [
  query('date').optional({ values: 'falsy' }).matches(DATE_PATTERN).withMessage('Use the format YYYY-MM-DD.'),
  validate,
];

/* --------------------------------------------------------- admin: articles */

/** Only the list-ish fields need normalising; the rest was accepted as-is before. */
const articleBody = [
  body('tags').optional().customSanitizer(toList),
  validate,
];

module.exports = {
  createOrder,
  cancelOrder,
  listOrders,
  slotsQuery,
  createBooking,
  cancelBooking,
  bookingRate,
  listBookings,
  productReviewsQuery,
  createProductReview,
  createProduct,
  updateProduct,
  productStatus,
  orderStatus,
  createPuja,
  updatePuja,
  pujaStatus,
  bookingPatch,
  bookingsListQuery,
  articleBody,
  toList,
};
