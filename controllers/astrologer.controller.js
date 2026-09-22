/**
 * Astrologers over HTTP.
 *
 * Two groups of handlers, and the difference matters:
 *
 *   the directory  read by seekers, about other people   (open to any user)
 *   "own" handlers read and written by one astrologer, about themselves
 *
 * The "own" handlers always take the id from the token, never from the URL.
 */

const astrologerService = require('../services/astrologer.service');
const chatService = require('../services/chat.service');
const supportService = require('../services/support.service');
const asyncHandler = require('../utils/asyncHandler');

/** Query strings arrive as "vedic,tarot"; the service wants an array. */
const asList = value =>
  value === undefined ? undefined : String(value).split(',').map(part => part.trim()).filter(Boolean);

/* --------------------------------------------------------------- directory */

/** GET /api/v1/astrologers */
const list = asyncHandler(async (req, res) => {
  const result = await astrologerService.listAstrologers({
    search: req.query.search,
    expertise: asList(req.query.expertise),
    languages: asList(req.query.languages),
    topics: asList(req.query.topics),
    badges: asList(req.query.badges),
    online: req.query.online === 'true' ? true : undefined,
    minExperience: req.query.minExperience,
    maxRate: req.query.maxRate,
    minRating: req.query.minRating,
    gender: req.query.gender,
    sort: req.query.sort,
    page: req.query.page,
    limit: req.query.limit,
  });
  return res.json(result);
});

/** GET /api/v1/astrologers/:astrologerId */
const detail = asyncHandler(async (req, res) => {
  return res.json({
    astrologer: await astrologerService.getAstrologerProfile(req.params.astrologerId),
  });
});

/** GET /api/v1/astrologers/:astrologerId/reviews */
const reviews = asyncHandler(async (req, res) => {
  const items = await astrologerService.recentReviews(req.params.astrologerId, Number(req.query.limit) || 20, {
    page: req.query.page,
  });
  return res.json({ items });
});

/* ----------------------------------------------------------- own account */

/** GET /api/v1/astrologer/me */
const getOwn = asyncHandler(async (req, res) => {
  return res.json({ astrologer: await astrologerService.getOwnProfile(req.account.accountId) });
});

/** PATCH /api/v1/astrologer/me */
const updateOwn = asyncHandler(async (req, res) => {
  const astrologer = await astrologerService.updateOwnProfile(req.account.accountId, {
    ...req.body,
    /**
     * Only when a file actually came with the request. Spreading it in
     * unconditionally would overwrite a photoUrl sent in the body with
     * undefined on every JSON request.
     */
    ...(req.uploadedPhotoUrl ? { photoUrl: req.uploadedPhotoUrl } : {}),
  });
  return res.json({ astrologer });
});

/** PATCH /api/v1/astrologer/me/presence — the dashboard's online toggle. */
const setOnline = asyncHandler(async (req, res) => {
  const presence = await astrologerService.setOnline(req.account.accountId, req.body.isOnline);
  return res.json({ presence });
});

/** PATCH /api/v1/astrologer/me/services — switch a service on or off. */
const setService = asyncHandler(async (req, res) => {
  const services = await astrologerService.setService(req.account.accountId, req.body);
  return res.json({ services });
});

/** GET /api/v1/astrologer/me/service-rates */
const listServiceRates = asyncHandler(async (req, res) => {
  return res.json({ items: await astrologerService.listServiceRates(req.account.accountId) });
});

/** POST /api/v1/astrologer/me/price-changes */
const requestPriceChange = asyncHandler(async (req, res) => {
  const request = await astrologerService.requestPriceChange(req.account.accountId, req.body);
  return res.status(201).json({ request });
});

/**
 * PUT /api/v1/astrologer/me/rates — the opening rates.
 *
 * Works once, while the profile is still being set up. After that a rate change
 * has to be approved, which is what POST /me/price-changes is for.
 */
const setOwnRates = asyncHandler(async (req, res) => {
  const services = await astrologerService.setOwnRates(
    req.account.accountId,
    req.body.services || [],
  );
  return res.json({ services });
});

/** GET /api/v1/astrologer/me/dashboard — the whole dashboard in one call. */
const dashboard = asyncHandler(async (req, res) => {
  return res.json(await astrologerService.getDashboard(req.account.accountId));
});

/* ------------------------------------------------------ documents and bank */

/** GET /api/v1/astrologer/me/documents */
const listDocuments = asyncHandler(async (req, res) => {
  return res.json({ items: await astrologerService.listDocuments(req.account.accountId) });
});

/** POST /api/v1/astrologer/me/documents */
const addDocument = asyncHandler(async (req, res) => {
  const items = await astrologerService.addDocument(req.account.accountId, {
    type: req.body.type,
    idNumber: req.body.idNumber,
    file: req.uploadedFile,
  });
  return res.status(201).json({ items });
});

/**
 * PUT /api/v1/astrologer/me/documents/:documentId — send a new scan.
 *
 * Replacing the file resets the document to pending; it has to be checked
 * again, exactly as a newly filed one would be.
 */
const replaceDocument = asyncHandler(async (req, res) => {
  const document = await astrologerService.replaceDocument(
    req.account.accountId,
    req.params.documentId,
    req.uploadedFile,
  );
  return res.json({ document });
});

/** DELETE /api/v1/astrologer/me/documents/:documentId */
const deleteDocument = asyncHandler(async (req, res) => {
  const items = await astrologerService.deleteDocument(req.account.accountId, req.params.documentId);
  return res.json({ items });
});

/** GET /api/v1/astrologer/me/gallery */
const listGallery = asyncHandler(async (req, res) => {
  return res.json({ items: await astrologerService.listGalleryImages(req.account.accountId) });
});

/** POST /api/v1/astrologer/me/gallery */
const addGalleryImage = asyncHandler(async (req, res) => {
  const items = await astrologerService.addGalleryImage(req.account.accountId, req.uploadedFile);
  return res.status(201).json({ items });
});

/** DELETE /api/v1/astrologer/me/gallery/:imageId */
const deleteGalleryImage = asyncHandler(async (req, res) => {
  const items = await astrologerService.deleteGalleryImage(req.account.accountId, req.params.imageId);
  return res.json({ items });
});

/** GET /api/v1/astrologer/me/bank-accounts */
const listBankAccounts = asyncHandler(async (req, res) => {
  return res.json({ items: await astrologerService.listBankAccounts(req.account.accountId) });
});

/** POST /api/v1/astrologer/me/bank-accounts */
const addBankAccount = asyncHandler(async (req, res) => {
  const items = await astrologerService.addBankAccount(req.account.accountId, {
    holderName: req.body.holderName,
    bankName: req.body.bankName,
    accountNumber: req.body.accountNumber,
    ifsc: req.body.ifsc,
    upiId: req.body.upiId,
    proof: req.uploadedFile,
  });
  return res.status(201).json({ items });
});

/** POST /api/v1/astrologer/me/submit — hand the application to the admins. */
const submitApplication = asyncHandler(async (req, res) => {
  return res.json(await astrologerService.submitApplication(req.account.accountId));
});

/* ------------------------------------------------------------------ work */

/** GET /api/v1/astrologer/me/reviews */
const listOwnReviews = asyncHandler(async (req, res) => {
  const result = await astrologerService.listOwnReviews(req.account.accountId, req.query);
  return res.json(result);
});

/** POST /api/v1/astrologer/me/reviews/:chatId/reply */
const replyToReview = asyncHandler(async (req, res) => {
  const result = await astrologerService.replyToReview(
    req.account.accountId,
    req.params.chatId,
    req.body.message,
  );
  return res.json(result);
});

/** POST /api/v1/astrologer/me/reviews/:chatId/flag — toggles. */
const flagReview = asyncHandler(async (req, res) => {
  return res.json(
    await astrologerService.toggleReviewFlag(
      req.account.accountId,
      req.params.chatId,
      req.body.reason,
    ),
  );
});

/** POST /api/v1/astrologer/me/reviews/:chatId/pin — toggles. */
const pinReview = asyncHandler(async (req, res) => {
  return res.json(
    await astrologerService.toggleReviewPin(req.account.accountId, req.params.chatId),
  );
});

/** GET /api/v1/astrologer/me/requests — the incoming-request queue. */
const pendingRequests = asyncHandler(async (req, res) => {
  return res.json({ items: await chatService.pendingRequests(req.account.accountId) });
});

module.exports = {
  list,
  setOwnRates,
  dashboard,
  replaceDocument,
  flagReview,
  pinReview,
  detail,
  reviews,
  getOwn,
  updateOwn,
  setOnline,
  setService,
  listServiceRates,
  requestPriceChange,
  listDocuments,
  addDocument,
  deleteDocument,
  listGallery,
  addGalleryImage,
  deleteGalleryImage,
  listBankAccounts,
  addBankAccount,
  submitApplication,
  listOwnReviews,
  replyToReview,
  pendingRequests,
};
