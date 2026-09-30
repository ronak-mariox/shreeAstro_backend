/**
 * /api/v1/products, /orders, /pujas, /puja-bookings — the store and the pujas.
 *
 * Browsing is open; buying and booking need a signed-in seeker.
 */

const express = require('express');
const { reviewImages, attachUploadedReviewImages } = require('../middlewares/upload.middleware');

const commerceController = require('../controllers/commerce.controller');
const commerceValidator = require('../validators/commerce.validator');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = express.Router();

const seekerOnly = [authenticate, authorize('user')];

/* ------------------------------------------------------------- products */

router.get('/products', commerceController.listProducts);
router.get('/products/:slug', commerceController.getProduct);
router.get(
  '/products/:slug/reviews',
  commerceValidator.productReviewsQuery,
  commerceController.listProductReviews,
);
router.post(
  '/products/:slug/reviews',
  seekerOnly,
  /** Multipart (`images`, up to 3 photos) or plain JSON. */
  reviewImages(),
  attachUploadedReviewImages,
  commerceValidator.createProductReview,
  commerceController.createProductReview,
);

/* --------------------------------------------------------------- orders */

router.post('/orders', seekerOnly, commerceValidator.createOrder, commerceController.createOrder);
router.get('/orders', seekerOnly, commerceValidator.listOrders, commerceController.listOrders);
router.get('/orders/:orderId', seekerOnly, commerceController.getOrder);
router.post(
  '/orders/:orderId/cancel',
  seekerOnly,
  commerceValidator.cancelOrder,
  commerceController.cancelOrder,
);

/* ---------------------------------------------------------------- pujas */

router.get('/pujas', commerceController.listPujas);
router.get('/pujas/:slug', commerceController.getPuja);
router.get('/pujas/:slug/slots', commerceValidator.slotsQuery, commerceController.getSlots);

/* ------------------------------------------------------------- bookings */

router.post(
  '/puja-bookings',
  seekerOnly,
  commerceValidator.createBooking,
  commerceController.createBooking,
);
router.get(
  '/puja-bookings',
  seekerOnly,
  commerceValidator.listBookings,
  commerceController.listBookings,
);
router.get('/puja-bookings/:bookingId', seekerOnly, commerceController.getBooking);
router.post(
  '/puja-bookings/:bookingId/cancel',
  seekerOnly,
  commerceValidator.cancelBooking,
  commerceController.cancelBooking,
);
router.post(
  '/puja-bookings/:bookingId/rate',
  seekerOnly,
  commerceValidator.bookingRate,
  commerceController.rateBooking,
);

module.exports = router;
