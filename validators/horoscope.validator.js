/**
 * What GET /horoscope/daily accepts. Rejects an unknown sign or day before
 * the controller (and therefore the provider, on a cache miss) ever sees it.
 */

const { query } = require('express-validator');

const { ZODIAC_SIGNS } = require('../utils/zodiac');
const { validate } = require('../middlewares/validate.middleware');

/** GET /horoscope/daily?sign=leo&day=next|previous */
const dailyHoroscope = [
  query('sign')
    .trim()
    .toLowerCase()
    .isIn(ZODIAC_SIGNS)
    .withMessage('Unknown zodiac sign.'),
  query('day')
    .optional()
    .trim()
    .toLowerCase()
    .isIn(['next', 'previous'])
    .withMessage('day must be "next" or "previous".'),
  validate,
];

/** GET /horoscope/compatibility?sign=leo */
const compatibility = [
  query('sign')
    .trim()
    .toLowerCase()
    .isIn(ZODIAC_SIGNS)
    .withMessage('Unknown zodiac sign.'),
  validate,
];

module.exports = { dailyHoroscope, compatibility };
