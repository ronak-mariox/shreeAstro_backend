/**
 * /api/v1/admin — the admin panel.
 *
 * `adminOnly` runs first for everything: a valid token, the admin role, and the
 * account loaded onto `req.admin`. `requirePermission` then narrows individual
 * routes, so a Finance admin can see payments but cannot approve astrologers.
 */

const express = require('express');

const adminController = require('../controllers/admin.controller');
const adminCommerceController = require('../controllers/adminCommerce.controller');
const adminGrowthController = require('../controllers/adminGrowth.controller');
const commerceValidator = require('../validators/commerce.validator');
const growthValidator = require('../validators/growth.validator');
const { adminOnly, requirePermission } = require('../middlewares/auth.middleware');
const {
  uploadProfilePhoto,
  singleImage,
  multipleImages,
  productImages,
  attachUploadedUrl,
  attachUploadedCoverUrl,
  attachUploadedUrls,
  attachUploadedProductImages,
} = require('../middlewares/upload.middleware');

/**
 * A product form may carry a cover (`image`) and up to six gallery files
 * (`images`); a puja form one image; an article form, a cover. All optional.
 */
const uploadProductImages = [productImages(), attachUploadedProductImages];
const uploadPujaImage = [singleImage('image', 'pujas'), attachUploadedUrl];
const uploadArticleCover = [singleImage('coverImage', 'articles'), attachUploadedCoverUrl];
/** A festival card carries one image; a testimonial an avatar and a thumbnail. */
const uploadOfferImage = [singleImage('image', 'offers'), attachUploadedUrl];
const uploadTestimonialImages = [multipleImages(['avatar', 'thumbnail'], 'testimonials'), attachUploadedUrls];

const router = express.Router();

router.use(adminOnly);

/* -------------------------------------------------------------------- me */

/** Every signed-in admin, regardless of role, may change their own name/photo. */
router.patch('/me', uploadProfilePhoto, adminController.updateOwnProfile);

/* ------------------------------------------------------------- dashboard */

router.get('/dashboard', requirePermission('dashboard.view'), adminController.dashboard);

/* ----------------------------------------------------------------- users */

router.get('/users', requirePermission('users.view'), adminController.listUsers);
router.get('/users/:userId', requirePermission('users.view'), adminController.userDetail);
router.patch(
  '/users/:userId/status',
  requirePermission('users.manage'),
  adminController.setUserStatus,
);

/* ----------------------------------------------------------- astrologers */

router.get('/astrologers', requirePermission('astrologers.view'), adminController.listAstrologers);
/**
 * Creating an astrologer from the panel: email, commission, availability and
 * status. The astrologer fills in everything else from their own profile.
 */
router.post(
  '/astrologers',
  requirePermission('astrologers.manage'),
  adminController.createAstrologer,
);
router.get(
  '/astrologers/:astrologerId',
  requirePermission('astrologers.view'),
  adminController.astrologerDetail,
);
router.post(
  '/astrologers/:astrologerId/approve',
  requirePermission('astrologers.approve'),
  adminController.approveAstrologer,
);
router.post(
  '/astrologers/:astrologerId/reject',
  requirePermission('astrologers.approve'),
  adminController.rejectAstrologer,
);
router.patch(
  '/astrologers/:astrologerId/status',
  requirePermission('astrologers.manage'),
  adminController.setAstrologerStatus,
);
router.patch(
  '/astrologers/:astrologerId/documents/:documentId',
  requirePermission('astrologers.approve'),
  adminController.reviewDocument,
);
router.patch(
  '/astrologers/:astrologerId/bank-accounts/:accountId',
  requirePermission('astrologers.approve'),
  adminController.reviewBankAccount,
);
router.patch(
  '/astrologers/:astrologerId/price-changes/:requestId',
  requirePermission('astrologers.approve'),
  adminController.reviewPriceChange,
);

/* --------------------------------------------------------- consultations */

router.get(
  '/consultations',
  requirePermission('consultations.view'),
  adminController.listConsultations,
);
router.get(
  '/consultations/:chatId',
  requirePermission('consultations.view'),
  adminController.consultationDetail,
);
router.post(
  '/consultations/:chatId/end',
  requirePermission('consultations.manage'),
  adminController.endConsultation,
);

/* ---------------------------------------------------- payments and wallets */

router.get('/transactions', requirePermission('payments.view'), adminController.listTransactions);
router.post(
  '/transactions/:transactionId/refund',
  requirePermission('payments.refund'),
  adminController.refund,
);

router.get('/wallets', requirePermission('wallets.view'), adminController.listWallets);
router.post('/wallets/adjust', requirePermission('wallets.adjust'), adminController.adjustWallet);

router.get('/withdrawals', requirePermission('wallets.view'), adminController.listWithdrawals);
router.patch(
  '/withdrawals/:withdrawalId',
  requirePermission('payouts.approve'),
  adminController.reviewWithdrawal,
);

/* --------------------------------------------------------------- content */

router.get('/articles', requirePermission('content.view'), adminController.listArticles);
router.get('/articles/:articleId', requirePermission('content.view'), adminController.getArticle);
router.post(
  '/articles',
  requirePermission('content.manage'),
  uploadArticleCover,
  commerceValidator.articleBody,
  adminController.saveArticle,
);
router.put(
  '/articles/:articleId',
  requirePermission('content.manage'),
  uploadArticleCover,
  commerceValidator.articleBody,
  adminController.saveArticle,
);
router.delete(
  '/articles/:articleId',
  requirePermission('content.manage'),
  adminController.deleteArticle,
);

/* -------------------------------------------------------------- reports */

router.get('/reports', requirePermission('reports.view'), adminController.reports);

/* ------------------------------------------------------------- settings */

router.get('/settings', requirePermission('settings.view'), adminController.getSettings);
router.patch('/settings', requirePermission('settings.manage'), adminController.updateSettings);

/* ------------------------------------------------------ third parties */

router.get('/integrations', requirePermission('settings.view'), adminController.listIntegrations);
router.put(
  '/integrations/:provider',
  requirePermission('settings.manage'),
  adminController.saveIntegration,
);
router.patch(
  '/integrations/:provider/enabled',
  requirePermission('settings.manage'),
  adminController.setIntegrationEnabled,
);

/** The "Other" list — anything not one of the six fixed providers above. */
router.get('/third-parties', requirePermission('settings.view'), adminController.listThirdParties);
router.post('/third-parties', requirePermission('settings.manage'), adminController.saveThirdParty);
router.put(
  '/third-parties/:thirdPartyId',
  requirePermission('settings.manage'),
  adminController.saveThirdParty,
);
router.delete(
  '/third-parties/:thirdPartyId',
  requirePermission('settings.manage'),
  adminController.deleteThirdParty,
);

/* ----------------------------------------------------------- admin team */

router.get('/team', requirePermission('admins.manage'), adminController.listAdmins);
router.post('/team', requirePermission('admins.manage'), adminController.createAdmin);
router.patch('/team/:adminId', requirePermission('admins.manage'), adminController.updateAdmin);
router.delete('/team/:adminId', requirePermission('admins.manage'), adminController.revokeAdmin);

/* -------------------------------------------------------------- support */

router.get(
  '/support-tickets',
  requirePermission('consultations.view'),
  adminController.listTickets,
);
router.patch(
  '/support-tickets/:ticketId',
  requirePermission('consultations.manage'),
  adminController.resolveTicket,
);

/* ------------------------------------------------------------------ shop */

router.get('/products', requirePermission('shop.view'), adminCommerceController.listProducts);
router.post(
  '/products',
  requirePermission('shop.manage'),
  uploadProductImages,
  commerceValidator.createProduct,
  adminCommerceController.createProduct,
);
router.put(
  '/products/:productId',
  requirePermission('shop.manage'),
  uploadProductImages,
  commerceValidator.updateProduct,
  adminCommerceController.updateProduct,
);
router.patch(
  '/products/:productId/status',
  requirePermission('shop.manage'),
  commerceValidator.productStatus,
  adminCommerceController.setProductStatus,
);
router.delete(
  '/products/:productId',
  requirePermission('shop.manage'),
  adminCommerceController.deleteProduct,
);

router.get('/orders', requirePermission('shop.view'), adminCommerceController.listOrders);
router.get('/orders/:orderId', requirePermission('shop.view'), adminCommerceController.orderDetail);
router.patch(
  '/orders/:orderId/status',
  requirePermission('shop.manage'),
  commerceValidator.orderStatus,
  adminCommerceController.setOrderStatus,
);

/* ----------------------------------------------------------------- pujas */

router.get('/pujas', requirePermission('pujas.view'), adminCommerceController.listPujas);
router.post(
  '/pujas',
  requirePermission('pujas.manage'),
  uploadPujaImage,
  commerceValidator.createPuja,
  adminCommerceController.createPuja,
);
router.put(
  '/pujas/:pujaId',
  requirePermission('pujas.manage'),
  uploadPujaImage,
  commerceValidator.updatePuja,
  adminCommerceController.updatePuja,
);
router.patch(
  '/pujas/:pujaId/status',
  requirePermission('pujas.manage'),
  commerceValidator.pujaStatus,
  adminCommerceController.setPujaStatus,
);
router.delete('/pujas/:pujaId', requirePermission('pujas.manage'), adminCommerceController.deletePuja);

router.get(
  '/puja-bookings',
  requirePermission('pujas.view'),
  commerceValidator.bookingsListQuery,
  adminCommerceController.listBookings,
);
router.get(
  '/puja-bookings/:bookingId',
  requirePermission('pujas.view'),
  adminCommerceController.bookingDetail,
);
router.patch(
  '/puja-bookings/:bookingId',
  requirePermission('pujas.manage'),
  commerceValidator.bookingPatch,
  adminCommerceController.updateBooking,
);

/* ----------------------------------------------------------------- offers */

router.get('/coupons', requirePermission('offers.view'), adminGrowthController.listCoupons);
router.post(
  '/coupons',
  requirePermission('offers.manage'),
  growthValidator.createCoupon,
  adminGrowthController.createCoupon,
);
router.put(
  '/coupons/:couponId',
  requirePermission('offers.manage'),
  growthValidator.updateCoupon,
  adminGrowthController.updateCoupon,
);
router.patch(
  '/coupons/:couponId/status',
  requirePermission('offers.manage'),
  growthValidator.couponStatus,
  adminGrowthController.setCouponStatus,
);
router.delete('/coupons/:couponId', requirePermission('offers.manage'), adminGrowthController.deleteCoupon);
router.get(
  '/coupons/:couponId/redemptions',
  requirePermission('offers.view'),
  growthValidator.couponId,
  adminGrowthController.listRedemptions,
);

router.get('/festival-offers', requirePermission('offers.view'), adminGrowthController.listFestivals);
router.post(
  '/festival-offers',
  requirePermission('offers.manage'),
  uploadOfferImage,
  growthValidator.createFestival,
  adminGrowthController.createFestival,
);
router.put(
  '/festival-offers/:offerId',
  requirePermission('offers.manage'),
  uploadOfferImage,
  growthValidator.updateFestival,
  adminGrowthController.updateFestival,
);
router.patch(
  '/festival-offers/:offerId/status',
  requirePermission('offers.manage'),
  growthValidator.festivalStatus,
  adminGrowthController.setFestivalStatus,
);
router.delete(
  '/festival-offers/:offerId',
  requirePermission('offers.manage'),
  adminGrowthController.deleteFestival,
);

/* ------------------------------------------------------ loyalty, referrals */

router.post(
  '/loyalty/adjust',
  requirePermission('wallets.adjust'),
  growthValidator.loyaltyAdjust,
  adminGrowthController.adjustLoyalty,
);
router.get('/referrals', requirePermission('users.view'), adminGrowthController.listReferrals);

/* ---------------------------------------------------------------- reviews */

router.get('/reviews', requirePermission('reviews.view'), adminGrowthController.listReviews);
router.patch(
  '/reviews/:kind/:id',
  requirePermission('reviews.manage'),
  growthValidator.reviewPatch,
  adminGrowthController.updateReview,
);

router.get('/testimonials', requirePermission('reviews.view'), adminGrowthController.listTestimonials);
router.post(
  '/testimonials',
  requirePermission('reviews.manage'),
  uploadTestimonialImages,
  growthValidator.createTestimonial,
  adminGrowthController.createTestimonial,
);
router.put(
  '/testimonials/:testimonialId',
  requirePermission('reviews.manage'),
  uploadTestimonialImages,
  growthValidator.updateTestimonial,
  adminGrowthController.updateTestimonial,
);
router.patch(
  '/testimonials/:testimonialId/status',
  requirePermission('reviews.manage'),
  growthValidator.testimonialStatus,
  adminGrowthController.setTestimonialStatus,
);
router.delete(
  '/testimonials/:testimonialId',
  requirePermission('reviews.manage'),
  adminGrowthController.deleteTestimonial,
);

/* ---------------------------------------------------------------- careers */

router.get('/jobs', requirePermission('careers.view'), adminGrowthController.listJobs);
router.post(
  '/jobs',
  requirePermission('careers.manage'),
  growthValidator.createJob,
  adminGrowthController.createJob,
);
router.put(
  '/jobs/:jobId',
  requirePermission('careers.manage'),
  growthValidator.updateJob,
  adminGrowthController.updateJob,
);
router.patch(
  '/jobs/:jobId/status',
  requirePermission('careers.manage'),
  growthValidator.jobStatus,
  adminGrowthController.setJobStatus,
);
router.delete('/jobs/:jobId', requirePermission('careers.manage'), adminGrowthController.deleteJob);

router.get('/applications', requirePermission('careers.view'), adminGrowthController.listApplications);
router.get(
  '/applications/:applicationId',
  requirePermission('careers.view'),
  adminGrowthController.applicationDetail,
);
router.patch(
  '/applications/:applicationId',
  requirePermission('careers.manage'),
  growthValidator.applicationPatch,
  adminGrowthController.updateApplication,
);

/* ------------------------------------------------------------------ audit */

router.get('/audit-logs', requirePermission('audit.view'), adminController.listAuditLogs);

module.exports = router;
