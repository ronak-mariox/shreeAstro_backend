/**
 * What the kundli-generation endpoints accept.
 *
 * Every wasted provider call is a wasted credit, so these refuse before a
 * controller (and therefore the provider) ever sees a malformed request.
 */

const { body, param, query } = require('express-validator');

const { GENDERS } = require('../models/constants');
const { DOMAIN_NAMES } = require('../config/kundliRules');
const { validate } = require('../middlewares/validate.middleware');

/** The nine classical grahas — what a mahadasha/antardasha lord can ever be. */
const PLANETS = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Rahu', 'Ketu'];

/** GET /places/search?q= — 3 chars is AstrologyAPI's own minimum (verified: it 405s under that), not an arbitrary UX choice. */
const searchPlaces = [
  query('q')
    .trim()
    .isLength({ min: 3, max: 100 })
    .withMessage('Type at least 3 characters.'),
  validate,
];

/** Same formats validators/auth.validator.js accepts, so one birth-details form works for both. */
const DATE_PATTERN = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const TIME_PATTERN = /^(\d{1,2})\s*:\s*(\d{2})(\s*[APap][Mm])?$/;

/**
 * POST /birth-profiles
 *
 * Deliberately takes `placeId` (an id /places/search actually returned), not
 * a free-typed place name or raw lat/lon — services/kundli.service.js
 * resolves it against GeoCache, so a client cannot simply type coordinates
 * in. Minute-precision time is required outright: a 4-minute error can change
 * the ascendant.
 */
const createBirthProfile = [
  body('fullName').trim().isLength({ min: 2 }).withMessage('Enter a full name.'),
  body('gender').optional().isIn(GENDERS).withMessage('Pick a gender.'),
  body('label').optional().trim().isLength({ max: 60 }).withMessage('Keep the label short.'),
  body('relation')
    .optional()
    .isIn(['self', 'partner', 'family', 'friend', 'other'])
    .withMessage('Unknown relation.'),

  body('dateOfBirth')
    .trim()
    .matches(DATE_PATTERN)
    .withMessage('Use the format DD/MM/YYYY.'),

  body('timeOfBirth')
    .trim()
    .matches(TIME_PATTERN)
    .withMessage('Use the format HH:MM AM/PM.'),

  body('placeId')
    .trim()
    .notEmpty()
    .withMessage('Search for and select a place.'),

  validate,
];

/** GET /kundli/:profileId, /kundli/:profileId/dasha, /kundli/:profileId/doshas */
const profileIdParam = [
  param('profileId').isMongoId().withMessage('Unknown kundli.'),
  validate,
];

/** GET /kundli/:profileId/dasha/:lord — lazy antardasha for one mahadasha lord. */
const antardashaParams = [
  param('profileId').isMongoId().withMessage('Unknown kundli.'),
  param('lord').trim().isIn(PLANETS).withMessage('Unknown planet.'),
  validate,
];

/** GET /kundli/:profileId/analysis/:domain — one of the four life areas the rule engine reads (config/kundliRules.js DOMAIN_NAMES). */
const analysisParams = [
  param('profileId').isMongoId().withMessage('Unknown kundli.'),
  param('domain').trim().isIn(DOMAIN_NAMES).withMessage('Unknown analysis area.'),
  validate,
];

module.exports = { searchPlaces, createBirthProfile, profileIdParam, antardashaParams, analysisParams };
