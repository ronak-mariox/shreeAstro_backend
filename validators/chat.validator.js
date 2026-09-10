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

/** GET /chats/:chatId */
const chatIdParam = [
  param('chatId').isMongoId().withMessage('Unknown chat.'),
  validate,
];

module.exports = { precheck, chatIdParam };
