/**
 * What GET /panchang accepts. Rejects a malformed or out-of-window date
 * before the controller (and therefore the provider, on a cache miss) ever
 * sees it — the window is what keeps the "one fetch per date" cache honest,
 * since a request for any date a year out would otherwise spend two credits
 * on a row nobody will read again.
 */

const { query } = require('express-validator');

const { validate } = require('../middlewares/validate.middleware');
const { isWithinWindow, isCalendarDate, PAST_DAYS, FUTURE_DAYS } = require('../services/panchang.service');

/** GET /panchang?date=YYYY-MM-DD (optional — today in IST when absent). */
const getPanchang = [
  query('date')
    .optional()
    .trim()
    .custom(value => isCalendarDate(value))
    .withMessage('date must be a real calendar date in YYYY-MM-DD form.')
    .bail()
    .custom(value => isWithinWindow(value))
    .withMessage(`date must be between yesterday and ${FUTURE_DAYS} days from today (IST).`),
  validate,
];

module.exports = { getPanchang, PAST_DAYS, FUTURE_DAYS };
