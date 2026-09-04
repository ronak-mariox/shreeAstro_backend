/**
 * /api/v1/admin — the admin panel.
 *
 * `adminOnly` runs first for everything: a valid token, the admin role, and the
 * account loaded onto `req.admin`. `requirePermission` then narrows individual
 * routes, so a Finance admin can see payments but cannot approve astrologers.
 */

const express = require('express');

const adminController = require('../controllers/admin.controller');
const { adminOnly, requirePermission } = require('../middlewares/auth.middleware');
const { uploadProfilePhoto } = require('../middlewares/upload.middleware');

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
router.post('/articles', requirePermission('content.manage'), adminController.saveArticle);
router.put('/articles/:articleId', requirePermission('content.manage'), adminController.saveArticle);
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

/* ------------------------------------------------------------------ audit */

router.get('/audit-logs', requirePermission('audit.view'), adminController.listAuditLogs);

module.exports = router;
