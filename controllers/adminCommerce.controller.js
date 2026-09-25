/**
 * The admin panel's Shop and Pujas pages over HTTP.
 *
 * Same rules as controllers/admin.controller.js: everything runs behind
 * `adminOnly`, and every write logs an audit row after the service succeeded.
 */

const commerceService = require('../services/commerce.service');
const auditService = require('../services/audit.service');
const { removeFile } = require('../services/storage.service');
const asyncHandler = require('../utils/asyncHandler');

const logChange = (req, { action, area, target, targetId, details }) =>
  auditService.record({ admin: req.admin, action, area, target, targetId, ip: req.ip, details });

/** A refused product write takes the files it uploaded with it. */
const discardUploads = req => {
  for (const file of req.uploadedFiles || []) {
    removeFile(file);
  }
};

/* -------------------------------------------------------------- products */

/** GET /api/v1/admin/products */
const listProducts = asyncHandler(async (req, res) => {
  return res.json(await commerceService.adminListProducts(req.query));
});

/** POST /api/v1/admin/products — JSON, or multipart with a cover `image` and gallery `images`. */
const createProduct = asyncHandler(async (req, res) => {
  let product;
  try {
    product = await commerceService.createProduct({
      changes: req.body,
      imageUrl: req.uploadedPhotoUrl,
      imageUrls: req.uploadedImageUrls,
      admin: req.admin,
    });
  } catch (error) {
    discardUploads(req);
    throw error;
  }

  await logChange(req, {
    action: 'Added product',
    area: 'Shop',
    target: product.name,
    targetId: product._id,
    details: { price: product.price, stock: product.stock },
  });

  return res.status(201).json({ product });
});

/** PUT /api/v1/admin/products/:productId — same form; `keepImages` says which gallery URLs stay. */
const updateProduct = asyncHandler(async (req, res) => {
  let product;
  try {
    product = await commerceService.updateProduct({
      productId: req.params.productId,
      changes: req.body,
      imageUrl: req.uploadedPhotoUrl,
      imageUrls: req.uploadedImageUrls,
      admin: req.admin,
    });
  } catch (error) {
    discardUploads(req);
    throw error;
  }

  await logChange(req, {
    action: 'Updated product',
    area: 'Shop',
    target: product.name,
    targetId: product._id,
    details: { fields: Object.keys(req.body || {}) },
  });

  return res.json({ product });
});

/** PATCH /api/v1/admin/products/:productId/status */
const setProductStatus = asyncHandler(async (req, res) => {
  const product = await commerceService.setProductStatus({
    productId: req.params.productId,
    status: req.body.status,
    admin: req.admin,
  });

  await logChange(req, {
    action: `Marked product ${product.status}`,
    area: 'Shop',
    target: product.name,
    targetId: product._id,
  });

  return res.json({ product });
});

/** DELETE /api/v1/admin/products/:productId — archives, never deletes. */
const deleteProduct = asyncHandler(async (req, res) => {
  const result = await commerceService.archiveProduct({
    productId: req.params.productId,
    admin: req.admin,
  });

  await logChange(req, {
    action: 'Archived product',
    area: 'Shop',
    target: req.params.productId,
    targetId: req.params.productId,
  });

  return res.json(result);
});

/* ---------------------------------------------------------------- orders */

/** GET /api/v1/admin/orders */
const listOrders = asyncHandler(async (req, res) => {
  return res.json(await commerceService.adminListOrders(req.query));
});

/** GET /api/v1/admin/orders/:orderId */
const orderDetail = asyncHandler(async (req, res) => {
  return res.json({ order: await commerceService.adminGetOrder(req.params.orderId) });
});

/** PATCH /api/v1/admin/orders/:orderId/status */
const setOrderStatus = asyncHandler(async (req, res) => {
  const order = await commerceService.setOrderStatus({
    orderId: req.params.orderId,
    status: req.body.status,
    note: req.body.note,
    admin: req.admin,
  });

  await logChange(req, {
    action:
      req.body.status === 'cancelled'
        ? `Cancelled order and refunded ₹${order.total}`
        : `Marked order ${req.body.status.replace(/_/g, ' ')}`,
    area: 'Shop',
    target: order.reference,
    targetId: order._id,
    details: { note: req.body.note },
  });

  return res.json({ order });
});

/* ----------------------------------------------------------------- pujas */

/** GET /api/v1/admin/pujas */
const listPujas = asyncHandler(async (req, res) => {
  return res.json(await commerceService.adminListPujas(req.query));
});

/** POST /api/v1/admin/pujas */
const createPuja = asyncHandler(async (req, res) => {
  const puja = await commerceService.createPuja({
    changes: req.body,
    imageUrl: req.uploadedPhotoUrl,
    admin: req.admin,
  });

  await logChange(req, {
    action: 'Added puja',
    area: 'Pujas',
    target: puja.name,
    targetId: puja._id,
    details: { price: puja.price },
  });

  return res.status(201).json({ puja });
});

/** PUT /api/v1/admin/pujas/:pujaId */
const updatePuja = asyncHandler(async (req, res) => {
  const puja = await commerceService.updatePuja({
    pujaId: req.params.pujaId,
    changes: req.body,
    imageUrl: req.uploadedPhotoUrl,
    admin: req.admin,
  });

  await logChange(req, {
    action: 'Updated puja',
    area: 'Pujas',
    target: puja.name,
    targetId: puja._id,
    details: { fields: Object.keys(req.body || {}) },
  });

  return res.json({ puja });
});

/** PATCH /api/v1/admin/pujas/:pujaId/status */
const setPujaStatus = asyncHandler(async (req, res) => {
  const puja = await commerceService.setPujaStatus({
    pujaId: req.params.pujaId,
    status: req.body.status,
    admin: req.admin,
  });

  await logChange(req, {
    action: `Marked puja ${puja.status}`,
    area: 'Pujas',
    target: puja.name,
    targetId: puja._id,
  });

  return res.json({ puja });
});

/** DELETE /api/v1/admin/pujas/:pujaId — archives. */
const deletePuja = asyncHandler(async (req, res) => {
  const result = await commerceService.archivePuja({
    pujaId: req.params.pujaId,
    admin: req.admin,
  });

  await logChange(req, {
    action: 'Archived puja',
    area: 'Pujas',
    target: req.params.pujaId,
    targetId: req.params.pujaId,
  });

  return res.json(result);
});

/* -------------------------------------------------------------- bookings */

/** GET /api/v1/admin/puja-bookings */
const listBookings = asyncHandler(async (req, res) => {
  return res.json(await commerceService.adminListBookings(req.query));
});

/** GET /api/v1/admin/puja-bookings/:bookingId */
const bookingDetail = asyncHandler(async (req, res) => {
  return res.json({ booking: await commerceService.adminGetBooking(req.params.bookingId) });
});

/** PATCH /api/v1/admin/puja-bookings/:bookingId */
const updateBooking = asyncHandler(async (req, res) => {
  const booking = await commerceService.adminUpdateBooking({
    bookingId: req.params.bookingId,
    status: req.body.status,
    streamUrl: req.body.streamUrl,
    adminNote: req.body.adminNote,
    admin: req.admin,
  });

  const action =
    req.body.status === 'cancelled'
      ? `Cancelled puja booking and refunded ₹${booking.amount}`
      : req.body.status === 'completed'
        ? 'Marked puja booking completed'
        : 'Updated puja booking';

  await logChange(req, {
    action,
    area: 'Pujas',
    target: booking.reference,
    targetId: booking._id,
    details: { streamUrl: req.body.streamUrl, adminNote: req.body.adminNote },
  });

  return res.json({ booking });
});

module.exports = {
  listProducts,
  createProduct,
  updateProduct,
  setProductStatus,
  deleteProduct,
  listOrders,
  orderDetail,
  setOrderStatus,
  listPujas,
  createPuja,
  updatePuja,
  setPujaStatus,
  deletePuja,
  listBookings,
  bookingDetail,
  updateBooking,
};
