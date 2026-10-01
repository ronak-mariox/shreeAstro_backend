/**
 * What the device endpoints accept — the same express-validator + `validate`
 * pattern as the rest, so a bad body is a 422 with a message per field.
 *
 * A token is only checked for being a plausible one here: a non-empty string
 * no longer than FCM allows. Whether it is *genuine* is something only
 * Firebase can say, and it says so on the first send
 * (services/push.service.js → `invalid_token`).
 */

const { body } = require('express-validator');

const { validate } = require('../middlewares/validate.middleware');
const { PLATFORMS, MAX_TOKEN_LENGTH } = require('../services/device.service');

const fcmToken = () =>
  body('fcmToken')
    .isString()
    .withMessage('Invalid device token.')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('Invalid device token.')
    .isLength({ max: MAX_TOKEN_LENGTH })
    .withMessage('Invalid device token.');

/** POST /devices */
const registerDevice = [
  fcmToken(),
  body('platform').isIn(PLATFORMS).withMessage('Unknown platform.'),
  body('appVersion')
    .optional({ values: 'falsy' })
    .isString()
    .isLength({ max: 40 })
    .withMessage('Invalid app version.'),
  validate,
];

/** DELETE /devices */
const unregisterDevice = [fcmToken(), validate];

module.exports = { registerDevice, unregisterDevice };
