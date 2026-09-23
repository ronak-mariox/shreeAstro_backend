/**
 * What the newer consultation endpoints accept.
 *
 * The rest of /chats (request, accept, messages, ...) has no validator file
 * of its own yet — this covers only what's added alongside live per-minute
 * billing, following the same express-validator + `validate` pattern as
 * kundli/horoscope, without retrofitting the untouched existing routes.
 */

const { body, param } = require('express-validator');

const { CHANNELS, GENDERS } = require('../models/constants');
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

/** POST /chats/:chatId/continue */
const continueAfterPackage = [
  param('chatId').isMongoId().withMessage('Unknown chat.'),
  body('mode').isIn(['per_minute', 'package']).withMessage('Choose per-minute or a package.'),
  body('packageMinutes').if(body('mode').equals('package')).isInt({ min: 1 }).withMessage('Choose a package.'),
  body('quotedPrice').optional({ values: 'null' }).isFloat({ min: 0 }).withMessage('Invalid price.'),
  validate,
];

/** GET /chats/:chatId */
const chatIdParam = [
  param('chatId').isMongoId().withMessage('Unknown chat.'),
  validate,
];

/** Same formats POST /birth-profiles takes, since the same generation runs behind both. */
const DATE_PATTERN = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const TIME_PATTERN = /^(\d{1,2})\s*:\s*(\d{2})(\s*[APap][Mm])?$/;

/**
 * POST /chats/:chatId/kundli — generating the seeker's kundli from inside the
 * consultation.
 *
 * `place` is a typed name here, unlike POST /birth-profiles's `placeId`: the
 * astrologer's form has no place search behind it, so the name is searched
 * server-side and lat/lon still only ever come from the provider. A `placeId`
 * is accepted too, for a caller that does have search.
 */
const generateKundli = [
  param('chatId').isMongoId().withMessage('Unknown chat.'),

  body('fullName').trim().isLength({ min: 2 }).withMessage('Enter a full name.'),
  body('gender').optional({ values: 'falsy' }).isIn(GENDERS).withMessage('Pick a gender.'),

  body('dateOfBirth').trim().matches(DATE_PATTERN).withMessage('Use the format DD/MM/YYYY.'),
  body('timeOfBirth').trim().matches(TIME_PATTERN).withMessage('Use the format HH:MM AM/PM.'),

  body('place')
    .if(body('placeId').not().exists({ values: 'falsy' }))
    .trim()
    .isLength({ min: 3 })
    .withMessage('Enter the birth place (at least 3 letters).'),

  validate,
];

module.exports = { precheck, request, continueAfterPackage, chatIdParam, generateKundli };
