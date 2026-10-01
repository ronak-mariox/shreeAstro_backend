/**
 * /api/v1/devices — where push notifications are sent, for both apps.
 *
 * An app registers its FCM token once it is signed in and takes it back on
 * logout. The role on the token decides whose device it is, so a seeker and
 * an astrologer call exactly the same endpoints. Admins have no app.
 */

const express = require('express');

const deviceController = require('../controllers/device.controller');
const deviceValidator = require('../validators/device.validator');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authenticate, authorize('user', 'astrologer'));

router.post('/', deviceValidator.registerDevice, deviceController.registerDevice);
router.delete('/', deviceValidator.unregisterDevice, deviceController.unregisterDevice);

/** Sends the caller a notification and reports the result per device — for checking a setup. */
router.post('/test', deviceController.sendTestPush);

module.exports = router;
