/**
 * The daily panchang, over HTTP. Open like /horoscope/daily — it is the same
 * for everyone (one configured place), nothing account-specific.
 */

const asyncHandler = require('../utils/asyncHandler');
const panchangService = require('../services/panchang.service');

/** GET /panchang?date=YYYY-MM-DD */
const getPanchang = asyncHandler(async (req, res) => {
  const result = await panchangService.getPanchang(req.query.date);
  return res.json(result);
});

module.exports = { getPanchang };
