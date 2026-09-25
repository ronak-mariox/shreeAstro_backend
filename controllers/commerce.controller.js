/**
 * The store, pujas and articles over HTTP — the website and the seeker app.
 *
 * Product, puja and article reads are open (`optionalAuthenticate` on the
 * article routes, so a signed-in reader also sees members-only pieces).
 * Orders and bookings belong to the seeker in `req.account`.
 */

const commerceService = require('../services/commerce.service');
const asyncHandler = require('../utils/asyncHandler');
const { removeFile } = require('../services/storage.service');

/* -------------------------------------------------------------- products */

/** GET /api/v1/products */
const listProducts = asyncHandler(async (req, res) => {
  return res.json(await commerceService.listProducts(req.query));
});

/** GET /api/v1/products/:slug */
const getProduct = asyncHandler(async (req, res) => {
  return res.json(await commerceService.getProduct(req.params.slug));
});

/** GET /api/v1/products/:slug/reviews */
const listProductReviews = asyncHandler(async (req, res) => {
  return res.json(
    await commerceService.listProductReviews({ slugOrId: req.params.slug, ...req.query }),
  );
});

/** POST /api/v1/products/:slug/reviews — after a delivered order of it. */
const createProductReview = asyncHandler(async (req, res) => {
  let result;
  try {
    result = await commerceService.createProductReview({
      userId: req.account.accountId,
      slugOrId: req.params.slug,
      orderId: req.body.orderId,
      rating: req.body.rating,
      title: req.body.title,
      comment: req.body.comment,
      images: req.uploadedImageUrls || [],
    });
  } catch (error) {
    /** A refused review must not leave its photos behind. */
    for (const file of req.uploadedFiles || []) {
      removeFile(file);
    }
    throw error;
  }
  return res.status(201).json(result);
});

/* ---------------------------------------------------------------- orders */

/** POST /api/v1/orders */
const createOrder = asyncHandler(async (req, res) => {
  const order = await commerceService.createOrder({
    userId: req.account.accountId,
    items: req.body.items,
    shipping: req.body.shipping,
    couponCode: req.body.couponCode,
  });
  return res.status(201).json({ order });
});

/** GET /api/v1/orders */
const listOrders = asyncHandler(async (req, res) => {
  return res.json(
    await commerceService.listOrders({ userId: req.account.accountId, ...req.query }),
  );
});

/** GET /api/v1/orders/:orderId */
const getOrder = asyncHandler(async (req, res) => {
  const order = await commerceService.getOrder({
    userId: req.account.accountId,
    orderId: req.params.orderId,
  });
  return res.json({ order });
});

/** POST /api/v1/orders/:orderId/cancel */
const cancelOrder = asyncHandler(async (req, res) => {
  const order = await commerceService.cancelOrder({
    userId: req.account.accountId,
    orderId: req.params.orderId,
  });
  return res.json({ order });
});

/* ----------------------------------------------------------------- pujas */

/** GET /api/v1/pujas */
const listPujas = asyncHandler(async (req, res) => {
  return res.json(await commerceService.listPujas(req.query));
});

/** GET /api/v1/pujas/:slug */
const getPuja = asyncHandler(async (req, res) => {
  return res.json(await commerceService.getPuja(req.params.slug));
});

/** GET /api/v1/pujas/:slug/slots?date= */
const getSlots = asyncHandler(async (req, res) => {
  return res.json(
    await commerceService.getSlots({ slugOrId: req.params.slug, date: req.query.date }),
  );
});

/* -------------------------------------------------------------- bookings */

/** POST /api/v1/puja-bookings */
const createBooking = asyncHandler(async (req, res) => {
  const booking = await commerceService.createBooking({
    userId: req.account.accountId,
    pujaId: req.body.pujaId,
    date: req.body.date,
    time: req.body.time,
    contact: req.body.contact,
    notes: req.body.notes,
    couponCode: req.body.couponCode,
  });
  return res.status(201).json({ booking });
});

/** GET /api/v1/puja-bookings */
const listBookings = asyncHandler(async (req, res) => {
  return res.json(
    await commerceService.listBookings({ userId: req.account.accountId, ...req.query }),
  );
});

/** GET /api/v1/puja-bookings/:bookingId */
const getBooking = asyncHandler(async (req, res) => {
  const booking = await commerceService.getBooking({
    userId: req.account.accountId,
    bookingId: req.params.bookingId,
  });
  return res.json({ booking });
});

/** POST /api/v1/puja-bookings/:bookingId/cancel */
const cancelBooking = asyncHandler(async (req, res) => {
  const booking = await commerceService.cancelBooking({
    userId: req.account.accountId,
    bookingId: req.params.bookingId,
  });
  return res.json({ booking });
});

/** POST /api/v1/puja-bookings/:bookingId/rate */
const rateBooking = asyncHandler(async (req, res) => {
  const booking = await commerceService.rateBooking({
    userId: req.account.accountId,
    bookingId: req.params.bookingId,
    rating: req.body.rating,
    comment: req.body.comment,
  });
  return res.json({ booking });
});

/* -------------------------------------------------------------- articles */

/** GET /api/v1/articles */
const listArticles = asyncHandler(async (req, res) => {
  return res.json(
    await commerceService.listPublicArticles({ ...req.query, signedIn: Boolean(req.account) }),
  );
});

/** GET /api/v1/articles/:slug */
const getArticle = asyncHandler(async (req, res) => {
  const article = await commerceService.getPublicArticle({
    slug: req.params.slug,
    signedIn: Boolean(req.account),
  });
  return res.json({ article });
});

module.exports = {
  listProducts,
  getProduct,
  listProductReviews,
  createProductReview,
  createOrder,
  listOrders,
  getOrder,
  cancelOrder,
  listPujas,
  getPuja,
  getSlots,
  createBooking,
  listBookings,
  getBooking,
  cancelBooking,
  rateBooking,
  listArticles,
  getArticle,
};
