/**
 * What the newer consultation endpoints accept.
 *
 * The rest of /chats (request, accept, messages, ...) has no validator file
 * of its own yet — this covers only what's added alongside live per-minute
 * billing, following the same express-validator + `validate` pattern as
 * kundli/horoscope, without retrofitting the untouched existing routes.
 */

const { body, param } = require('express-validator');

const { CHANNELS } = require('../models/constants');
const { validate } = require('../middlewares/validate.middleware');

/** POST /chats/precheck */
const precheck = [
  body('astrologerId').trim().isMongoId().withMessage('Unknown astrologer.'),
  body('channel').optional().trim().isIn(CHANNELS).withMessage('Unknown channel.'),
  validate,
];

/**
 * POST /chats — only the optional package part is checked here; the rest of
 * the body keeps its existing (service-side) handling. The price itself is
 * always recomputed by the server — `quotedPrice` is only what the seeker
 * was shown, compared against it.
 */
const request = [
  body('billing.mode').optional().isIn(['per_minute', 'package']).withMessage('Unknown consultation type.'),
  body('billing.packageMinutes')
    .if(body('billing.mode').equals('package'))
    .isInt({ min: 1 }).withMessage('Choose a package.'),
  body('billing.quotedPrice').optional({ values: 'null' }).isFloat({ min: 0 }).withMessage('Invalid price.'),
  validate,
];

/** GET /chats/:chatId */
const chatIdParam = [
  param('chatId').isMongoId().withMessage('Unknown chat.'),
  validate,
];

module.exports = { precheck, request, chatIdParam };
