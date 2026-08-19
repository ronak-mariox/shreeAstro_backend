/** /api/v1/users — the seeker's own account. Everything needs a token. */

const express = require('express');

const userController = require('../controllers/user.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { uploadProfilePhoto } = require('../middlewares/upload.middleware');

const router = express.Router();

/** Only seekers use these routes at all. */
router.use(authenticate, authorize('user'));

router.get('/me', userController.getProfile);
router.get('/me/home', userController.getHome);
/** The photo is optional, so the multipart parser runs either way. */
router.patch('/me', uploadProfilePhoto, userController.updateProfile);
router.patch('/me/notification-prefs', userController.updateNotificationPrefs);

router.get('/me/kundlis', userController.listKundlis);
router.post('/me/kundlis', userController.saveKundli);
router.delete('/me/kundlis/:kundliId', userController.deleteKundli);

router.get('/me/favourites', userController.listFavourites);
router.post('/me/favourites/:astrologerId', userController.toggleFavourite);

module.exports = router;
