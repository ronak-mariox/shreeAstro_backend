/**
 * The admin panel over HTTP.
 *
 * Every handler here runs behind `adminOnly` (see middlewares/auth.middleware.js),
 * so `req.admin` is always the signed-in admin's document.
 *
 * Anything that changes something also writes an audit row. That is done here,
 * after the service call succeeded, so the log only ever records what actually
 * happened.
 */

const adminService = require('../services/admin.service');
const auditService = require('../services/audit.service');
const settingsService = require('../services/settings.service');
const { packagesWithDiscounts, MAX_PACKAGE_DISCOUNT_PERCENT } = require('../config/packages');
const integrationsService = require('../services/integrations.service');
const supportService = require('../services/support.service');
const commerceService = require('../services/commerce.service');
const asyncHandler = require('../utils/asyncHandler');

/** Writes the audit row for a change that has just succeeded. */
const logChange = (req, { action, area, target, targetId, details }) =>
  auditService.record({ admin: req.admin, action, area, target, targetId, ip: req.ip, details });

/* ------------------------------------------------------------- dashboard */

/** GET /api/v1/admin/dashboard */
const dashboard = asyncHandler(async (req, res) => {
  const [summary, mix, commerce] = await Promise.all([
    adminService.getDashboard(),
    adminService.getConsultationMix(Number(req.query.days) || 7),
    commerceService.dashboardStats(),
  ]);
  return res.json({ ...summary, ...commerce, consultationMix: mix });
});

/* -------------------------------------------------------------------- me */

/**
 * PATCH /api/v1/admin/me — the signed-in admin's own name and photo. Not an
 * audited change: this is personal display info, not a platform action.
 */
const updateOwnProfile = asyncHandler(async (req, res) => {
  const admin = await adminService.updateOwnProfile({
    adminId: req.admin._id,
    name: req.body.name,
    avatarUrl: req.uploadedPhotoUrl,
  });

  return res.json({
    admin: {
      id: String(admin._id),
      name: admin.name,
      email: admin.email,
      role: admin.role,
      permissions: admin.permissions,
      avatarUrl: admin.avatarUrl,
    },
  });
});

/* ----------------------------------------------------------------- users */

/** GET /api/v1/admin/users */
const listUsers = asyncHandler(async (req, res) => {
  return res.json(await adminService.listUsers(req.query));
});

/** GET /api/v1/admin/users/:userId */
const userDetail = asyncHandler(async (req, res) => {
  return res.json({ user: await adminService.getUserDetail(req.params.userId) });
});

/** PATCH /api/v1/admin/users/:userId/status */
const setUserStatus = asyncHandler(async (req, res) => {
  const user = await adminService.setUserStatus({
    userId: req.params.userId,
    status: req.body.status,
    reason: req.body.reason,
    admin: req.admin,
  });

  await logChange(req, {
    action: req.body.status === 'blocked' ? 'Blocked user account' : 'Unblocked user account',
    area: 'Users',
    target: `${user.userCode || user._id} · ${user.name}`,
    targetId: user._id,
    details: { reason: req.body.reason },
  });

  return res.json({ id: String(user._id), status: user.status });
});

/* ----------------------------------------------------------- astrologers */

/** GET /api/v1/admin/astrologers */
const listAstrologers = asyncHandler(async (req, res) => {
  return res.json(await adminService.listAstrologers(req.query));
});

/**
 * POST /api/v1/admin/astrologers — create an astrologer from the panel.
 *
 * The short form: an email address, the platform commission, their availability
 * and whether they are listed or blocked. Everything else — name, phone, photo,
 * languages, expertise, experience, about and rates — the astrologer fills in
 * themselves from their own profile screen.
 */
const createAstrologer = asyncHandler(async (req, res) => {
  const astrologer = await adminService.createAstrologer({
    email: req.body.email,
    commissionPercent: req.body.commissionPercent,
    availability: req.body.availability,
    status: req.body.status,
    admin: req.admin,
  });

  await logChange(req, {
    action: 'Created astrologer account',
    area: 'Astrologers',
    target: `${astrologer.astroCode} · ${astrologer.email}`,
    targetId: astrologer._id,
    details: {
      commissionPercent: astrologer.commissionPercent,
      availability: astrologer.availabilityNote,
      status: astrologer.status,
    },
  });

  return res.status(201).json({
    astrologer: {
      id: String(astrologer._id),
      astroCode: astrologer.astroCode,
      email: astrologer.email,
      name: astrologer.name,
      commissionPercent: astrologer.commissionPercent,
      availability: astrologer.availabilityNote,
      applicationStatus: astrologer.applicationStatus,
      status: astrologer.status,
    },
    /** What the panel should tell the person who was just added. */
    nextStep:
      'They sign in to the astrologer app with this email address and complete ' +
      'their own profile — name, photo, expertise, languages and rates.',
  });
});

/** GET /api/v1/admin/astrologers/:astrologerId */
const astrologerDetail = asyncHandler(async (req, res) => {
  return res.json(await adminService.getAstrologerDetail(req.params.astrologerId));
});

/** POST /api/v1/admin/astrologers/:astrologerId/approve */
const approveAstrologer = asyncHandler(async (req, res) => {
  const astrologer = await adminService.approveAstrologer({
    astrologerId: req.params.astrologerId,
    admin: req.admin,
    services: req.body.services,
    commissionPercent: req.body.commissionPercent,
  });

  await logChange(req, {
    action: 'Approved astrologer application',
    area: 'Astrologers',
    target: `${astrologer.astroCode} · ${astrologer.name}`,
    targetId: astrologer._id,
  });

  return res.json({
    id: String(astrologer._id),
    astroCode: astrologer.astroCode,
    applicationStatus: astrologer.applicationStatus,
    services: astrologer.services,
  });
});

/** POST /api/v1/admin/astrologers/:astrologerId/reject */
const rejectAstrologer = asyncHandler(async (req, res) => {
  const astrologer = await adminService.rejectAstrologer({
    astrologerId: req.params.astrologerId,
    admin: req.admin,
    reason: req.body.reason,
  });

  await logChange(req, {
    action: 'Rejected astrologer application',
    area: 'Astrologers',
    target: astrologer.name,
    targetId: astrologer._id,
    details: { reason: req.body.reason },
  });

  return res.json({ id: String(astrologer._id), applicationStatus: astrologer.applicationStatus });
});

/** PATCH /api/v1/admin/astrologers/:astrologerId/status */
const setAstrologerStatus = asyncHandler(async (req, res) => {
  const astrologer = await adminService.setAstrologerStatus({
    astrologerId: req.params.astrologerId,
    status: req.body.status,
    reason: req.body.reason,
    admin: req.admin,
  });

  await logChange(req, {
    action: req.body.status === 'blocked' ? 'Blocked astrologer' : 'Unblocked astrologer',
    area: 'Astrologers',
    target: astrologer.name,
    targetId: astrologer._id,
    details: { reason: req.body.reason },
  });

  return res.json({ id: String(astrologer._id), status: astrologer.status });
});

/** PATCH /api/v1/admin/astrologers/:astrologerId/documents/:documentId */
const reviewDocument = asyncHandler(async (req, res) => {
  const document = await adminService.reviewDocument({
    astrologerId: req.params.astrologerId,
    documentId: req.params.documentId,
    status: req.body.status,
    reason: req.body.reason,
    admin: req.admin,
  });

  await logChange(req, {
    action: `${req.body.status === 'approved' ? 'Approved' : 'Rejected'} document`,
    area: 'Astrologers',
    target: `${document.type}`,
    targetId: req.params.astrologerId,
  });

  return res.json({ document });
});

/** PATCH /api/v1/admin/astrologers/:astrologerId/bank-accounts/:accountId */
const reviewBankAccount = asyncHandler(async (req, res) => {
  const account = await adminService.reviewBankAccount({
    astrologerId: req.params.astrologerId,
    accountId: req.params.accountId,
    status: req.body.status,
    reason: req.body.reason,
    admin: req.admin,
  });

  await logChange(req, {
    action: `${req.body.status === 'approved' ? 'Approved' : 'Rejected'} bank account`,
    area: 'Astrologers',
    target: account.bankName,
    targetId: req.params.astrologerId,
  });

  return res.json({ account });
});

/** PATCH /api/v1/admin/astrologers/:astrologerId/price-changes/:requestId */
const reviewPriceChange = asyncHandler(async (req, res) => {
  const request = await adminService.reviewPriceChange({
    astrologerId: req.params.astrologerId,
    requestId: req.params.requestId,
    status: req.body.status,
    reason: req.body.reason,
    admin: req.admin,
  });

  await logChange(req, {
    action: `${req.body.status === 'approved' ? 'Approved' : 'Rejected'} price change`,
    area: 'Astrologers',
    target: `${request.service} → ₹${request.requestedRate}/min`,
    targetId: req.params.astrologerId,
  });

  return res.json({ request });
});

/* --------------------------------------------------------- consultations */

/** GET /api/v1/admin/consultations */
const listConsultations = asyncHandler(async (req, res) => {
  return res.json(await adminService.listConsultations(req.query));
});

/** GET /api/v1/admin/consultations/:chatId — with the transcript. */
const consultationDetail = asyncHandler(async (req, res) => {
  const consultation = await adminService.getConsultationDetail(req.params.chatId, {
    messageLimit: req.query.messageLimit,
  });

  await logChange(req, {
    action: 'Opened a consultation transcript',
    area: 'Consultations',
    target: consultation.id,
    targetId: req.params.chatId,
  });

  return res.json({ consultation });
});

/* ---------------------------------------------------- payments and wallets */

/** GET /api/v1/admin/transactions */
const listTransactions = asyncHandler(async (req, res) => {
  return res.json(await adminService.listTransactions(req.query));
});

/** POST /api/v1/admin/transactions/:transactionId/refund */
const refund = asyncHandler(async (req, res) => {
  const transaction = await adminService.refundTransaction({
    transactionId: req.params.transactionId,
    admin: req.admin,
    reason: req.body.reason,
  });

  await logChange(req, {
    action: `Issued refund of ₹${transaction.amount}`,
    area: 'Payments',
    target: transaction.reference,
    targetId: transaction._id,
    details: { reason: req.body.reason },
  });

  return res.json({ transaction });
});

/** GET /api/v1/admin/withdrawals */
const listWithdrawals = asyncHandler(async (req, res) => {
  return res.json(await adminService.listWithdrawals(req.query));
});

/** PATCH /api/v1/admin/withdrawals/:withdrawalId */
const reviewWithdrawal = asyncHandler(async (req, res) => {
  const withdrawal = await adminService.reviewWithdrawal({
    withdrawalId: req.params.withdrawalId,
    status: req.body.status,
    admin: req.admin,
    reason: req.body.reason,
    payoutReference: req.body.payoutReference,
  });

  await logChange(req, {
    action: `${withdrawal.status === 'paid' ? 'Approved' : 'Rejected'} payout of ₹${withdrawal.amount}`,
    area: 'Wallets',
    target: withdrawal.reference,
    targetId: withdrawal._id,
  });

  return res.json({ withdrawal });
});

/* --------------------------------------------------------------- content */

/** GET /api/v1/admin/articles */
const listArticles = asyncHandler(async (req, res) => {
  return res.json(await adminService.listArticles(req.query));
});

/** GET /api/v1/admin/articles/:articleId */
const getArticle = asyncHandler(async (req, res) => {
  return res.json({ article: await adminService.getArticle(req.params.articleId) });
});

/**
 * POST /api/v1/admin/articles and PUT /api/v1/admin/articles/:articleId —
 * JSON, or multipart carrying a `coverImage`.
 */
const saveArticle = asyncHandler(async (req, res) => {
  const article = await adminService.saveArticle({
    articleId: req.params.articleId,
    changes: req.body,
    coverImageUrl: req.uploadedCoverUrl,
    admin: req.admin,
  });

  await logChange(req, {
    action: req.params.articleId ? 'Updated article' : 'Created article',
    area: 'Content',
    target: article.title,
    targetId: article._id,
  });

  return res.status(req.params.articleId ? 200 : 201).json({ article });
});

/** DELETE /api/v1/admin/articles/:articleId */
const deleteArticle = asyncHandler(async (req, res) => {
  const result = await adminService.deleteArticle(req.params.articleId);

  await logChange(req, {
    action: 'Deleted article',
    area: 'Content',
    target: req.params.articleId,
  });

  return res.json(result);
});

/* ---------------------------------------------------------- third parties */

/** GET /api/v1/admin/third-parties */
const listThirdParties = asyncHandler(async (req, res) => {
  return res.json(await adminService.listThirdParties());
});

/** POST /api/v1/admin/third-parties and PUT /api/v1/admin/third-parties/:thirdPartyId */
const saveThirdParty = asyncHandler(async (req, res) => {
  const thirdParty = await adminService.saveThirdParty({
    thirdPartyId: req.params.thirdPartyId,
    changes: req.body,
    admin: req.admin,
  });

  await logChange(req, {
    action: req.params.thirdPartyId ? 'Updated third party' : 'Added third party',
    area: 'Third parties',
    target: thirdParty.name,
    targetId: thirdParty._id,
  });

  return res.status(req.params.thirdPartyId ? 200 : 201).json({ thirdParty });
});

/** DELETE /api/v1/admin/third-parties/:thirdPartyId */
const deleteThirdParty = asyncHandler(async (req, res) => {
  const result = await adminService.deleteThirdParty(req.params.thirdPartyId);

  await logChange(req, {
    action: 'Removed third party',
    area: 'Third parties',
    target: req.params.thirdPartyId,
  });

  return res.json(result);
});

/* ------------------------------------------------------------- wallets */

/** GET /api/v1/admin/wallets */
const listWallets = asyncHandler(async (req, res) => {
  return res.json(await adminService.listWallets(req.query));
});

/** POST /api/v1/admin/wallets/adjust — a manual credit or debit. */
const adjustWallet = asyncHandler(async (req, res) => {
  const transaction = await adminService.adjustWallet({
    ownerRole: req.body.ownerRole,
    ownerId: req.body.ownerId,
    direction: req.body.direction,
    amount: req.body.amount,
    reason: req.body.reason,
    admin: req.admin,
  });

  await logChange(req, {
    action: `Manual ${req.body.direction} of ₹${transaction.amount}`,
    area: 'Wallets',
    target: transaction.reference,
    targetId: transaction._id,
    details: { reason: req.body.reason },
  });

  return res.status(201).json({ transaction });
});

/* -------------------------------------------------------- consultations */

/** POST /api/v1/admin/consultations/:chatId/end */
const endConsultation = asyncHandler(async (req, res) => {
  const chat = await adminService.endConsultation({
    chatId: req.params.chatId,
    admin: req.admin,
    reason: req.body.reason,
  });

  await logChange(req, {
    action: 'Ended a live consultation',
    area: 'Consultations',
    target: String(chat._id),
    targetId: chat._id,
    details: { reason: req.body.reason },
  });

  return res.json({
    chatId: String(chat._id),
    status: chat.status,
    durationSeconds: chat.durationSeconds,
    amountCharged: chat.billing.amountCharged,
  });
});

/* ------------------------------------------------------------- settings */

/**
 * Every offered consultation package with its current discount — the
 * panel's discount table reads this rather than knowing the durations itself.
 */
const consultationPackagesFor = settings => packagesWithDiscounts(settings.packageDiscounts);

/** GET /api/v1/admin/settings */
const getSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.get();
  return res.json({
    settings,
    consultationPackages: consultationPackagesFor(settings),
    maxPackageDiscountPercent: MAX_PACKAGE_DISCOUNT_PERCENT,
  });
});

/** PATCH /api/v1/admin/settings */
const updateSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.update(req.body, req.admin);

  await logChange(req, {
    action: 'Updated platform settings',
    area: 'Settings',
    target: 'Platform',
    details: req.body,
  });

  return res.json({
    settings,
    consultationPackages: consultationPackagesFor(settings),
    maxPackageDiscountPercent: MAX_PACKAGE_DISCOUNT_PERCENT,
  });
});

/* ------------------------------------------------------ third parties */

/** GET /api/v1/admin/integrations */
const listIntegrations = asyncHandler(async (req, res) => {
  return res.json({ integrations: await integrationsService.list() });
});

/** PUT /api/v1/admin/integrations/:provider */
const saveIntegration = asyncHandler(async (req, res) => {
  const integration = await integrationsService.save(req.params.provider, req.body, req.admin);

  await logChange(req, {
    action: `Updated ${req.params.provider} integration`,
    area: 'Third parties',
    target: req.params.provider,
    /** Never log the credential values themselves — only which fields changed. */
    details: { fields: Object.keys(req.body || {}) },
  });

  return res.json({ integration: { provider: integration.provider, enabled: integration.enabled } });
});

/** PATCH /api/v1/admin/integrations/:provider/enabled */
const setIntegrationEnabled = asyncHandler(async (req, res) => {
  const integration = await integrationsService.setEnabled(
    req.params.provider,
    req.body.enabled,
    req.admin,
  );

  await logChange(req, {
    action: `${integration.enabled ? 'Enabled' : 'Disabled'} ${req.params.provider} integration`,
    area: 'Third parties',
    target: req.params.provider,
  });

  return res.json({ integration: { provider: integration.provider, enabled: integration.enabled } });
});

/* ----------------------------------------------------------- admin team */

/** GET /api/v1/admin/team */
const listAdmins = asyncHandler(async (req, res) => {
  return res.json(await adminService.listAdmins(req.query));
});

/** POST /api/v1/admin/team */
const createAdmin = asyncHandler(async (req, res) => {
  const { admin, temporaryPassword } = await adminService.createAdmin({
    name: req.body.name,
    email: req.body.email,
    role: req.body.role,
    admin: req.admin,
  });

  await logChange(req, {
    action: `Added ${admin.role.replace('_', ' ')} to the admin team`,
    area: 'Settings',
    target: admin.email,
    targetId: admin._id,
  });

  return res.status(201).json({
    admin: { id: String(admin._id), name: admin.name, email: admin.email, role: admin.role },
    /** Shown once and never again — it is only stored as a hash. */
    temporaryPassword,
  });
});

/** PATCH /api/v1/admin/team/:adminId */
const updateAdmin = asyncHandler(async (req, res) => {
  const admin = await adminService.updateAdmin({
    adminId: req.params.adminId,
    changes: req.body,
    admin: req.admin,
  });

  await logChange(req, {
    action: 'Updated an admin account',
    area: 'Settings',
    target: admin.email,
    targetId: admin._id,
    details: req.body,
  });

  return res.json({
    admin: { id: String(admin._id), name: admin.name, role: admin.role, status: admin.status },
  });
});

/** DELETE /api/v1/admin/team/:adminId — suspends rather than deletes. */
const revokeAdmin = asyncHandler(async (req, res) => {
  const admin = await adminService.revokeAdmin({
    adminId: req.params.adminId,
    admin: req.admin,
  });

  await logChange(req, {
    action: 'Revoked admin access',
    area: 'Settings',
    target: admin.email,
    targetId: admin._id,
  });

  return res.json({ id: String(admin._id), status: admin.status });
});

/* -------------------------------------------------------------- reports */

/** GET /api/v1/admin/reports */
const reports = asyncHandler(async (req, res) => {
  return res.json(await adminService.getReports({ days: req.query.days || 30 }));
});

/* -------------------------------------------------------------- support */

/** GET /api/v1/admin/support-tickets */
const listTickets = asyncHandler(async (req, res) => {
  return res.json(await supportService.listAll(req.query));
});

/** PATCH /api/v1/admin/support-tickets/:ticketId */
const resolveTicket = asyncHandler(async (req, res) => {
  const ticket = await supportService.resolve({
    ticketId: req.params.ticketId,
    status: req.body.status,
    resolution: req.body.resolution,
    admin: req.admin,
  });

  await logChange(req, {
    action: `Support ticket marked ${ticket.status.replace('_', ' ')}`,
    area: 'Settings',
    target: ticket.reference,
    targetId: ticket._id,
  });

  return res.json({ ticket });
});

/* ------------------------------------------------------------------ audit */

/** GET /api/v1/admin/audit-logs */
const listAuditLogs = asyncHandler(async (req, res) => {
  return res.json(await auditService.list(req.query));
});

module.exports = {
  dashboard,
  updateOwnProfile,
  createAstrologer,
  listWallets,
  adjustWallet,
  endConsultation,
  getSettings,
  updateSettings,
  listIntegrations,
  saveIntegration,
  setIntegrationEnabled,
  listAdmins,
  createAdmin,
  updateAdmin,
  revokeAdmin,
  reports,
  listTickets,
  resolveTicket,
  listUsers,
  userDetail,
  setUserStatus,
  listAstrologers,
  astrologerDetail,
  approveAstrologer,
  rejectAstrologer,
  setAstrologerStatus,
  reviewDocument,
  reviewBankAccount,
  reviewPriceChange,
  listConsultations,
  consultationDetail,
  listTransactions,
  refund,
  listWithdrawals,
  reviewWithdrawal,
  listArticles,
  getArticle,
  saveArticle,
  deleteArticle,
  listThirdParties,
  saveThirdParty,
  deleteThirdParty,
  listAuditLogs,
};
