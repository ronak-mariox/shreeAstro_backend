/**
 * Astrologers, split by who is asking.
 *
 *   directoryRouter  mounted at /api/v1/astrologers — what seekers browse
 *   selfRouter       mounted at /api/v1/astrologer  — what one manages of their own
 *
 * Two routers rather than one, because the guards are different: the directory
 * is open to any signed-in seeker, and everything under /astrologer requires
 * an astrologer's token.
 */

const express = require('express');

const astrologerController = require('../controllers/astrologer.controller');
const { authenticate, authorize, optionalAuthenticate } = require('../middlewares/auth.middleware');
const {
  uploadProfilePhoto,
  uploadGalleryImage,
  uploadDocument,
} = require('../middlewares/upload.middleware');

/* -------------------------------------------------- what seekers can read */

const directoryRouter = express.Router();

directoryRouter.use(optionalAuthenticate);

directoryRouter.get('/', astrologerController.list);
directoryRouter.get('/:astrologerId', astrologerController.detail);
directoryRouter.get('/:astrologerId/reviews', astrologerController.reviews);

/* ------------------------------------------ what an astrologer manages */

const selfRouter = express.Router();

selfRouter.use(authenticate, authorize('astrologer'));

selfRouter.get('/me', astrologerController.getOwn);
selfRouter.get('/me/dashboard', astrologerController.dashboard);
selfRouter.patch('/me', uploadProfilePhoto, astrologerController.updateOwn);
selfRouter.patch('/me/presence', astrologerController.setOnline);
selfRouter.patch('/me/services', astrologerController.setService);

selfRouter.get('/me/service-rates', astrologerController.listServiceRates);
/** The opening rates — works only while the profile is still being set up. */
selfRouter.put('/me/rates', astrologerController.setOwnRates);
selfRouter.post('/me/price-changes', astrologerController.requestPriceChange);

selfRouter.get('/me/documents', astrologerController.listDocuments);
selfRouter.post('/me/documents', uploadDocument, astrologerController.addDocument);
selfRouter.put('/me/documents/:documentId', uploadDocument, astrologerController.replaceDocument);
selfRouter.delete('/me/documents/:documentId', astrologerController.deleteDocument);

selfRouter.get('/me/gallery', astrologerController.listGallery);
selfRouter.post('/me/gallery', uploadGalleryImage, astrologerController.addGalleryImage);
selfRouter.delete('/me/gallery/:imageId', astrologerController.deleteGalleryImage);

selfRouter.get('/me/bank-accounts', astrologerController.listBankAccounts);
selfRouter.post('/me/bank-accounts', uploadDocument, astrologerController.addBankAccount);

selfRouter.post('/me/submit', astrologerController.submitApplication);

selfRouter.get('/me/reviews', astrologerController.listOwnReviews);
selfRouter.post('/me/reviews/:chatId/reply', astrologerController.replyToReview);
selfRouter.post('/me/reviews/:chatId/flag', astrologerController.flagReview);
selfRouter.post('/me/reviews/:chatId/pin', astrologerController.pinReview);

selfRouter.get('/me/requests', astrologerController.pendingRequests);

module.exports = { directoryRouter, selfRouter };
