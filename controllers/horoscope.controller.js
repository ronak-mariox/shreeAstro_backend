/**
 * Sun-sign horoscope, over HTTP. Open like /horoscope and /places/search —
 * a reading is the same for everyone with that sign, nothing account-specific.
 */

const asyncHandler = require('../utils/asyncHandler');
const horoscopeReadService = require('../services/horoscopeRead.service');
const zodiacCompatibilityService = require('../services/zodiacCompatibility.service');

/** GET /horoscope/daily?sign=leo&day=next|previous */
const getDaily = asyncHandler(async (req, res) => {
  const result = await horoscopeReadService.getDailyHoroscope(req.query.sign, req.query.day);
  return res.json(result);
});

/** GET /horoscope/compatibility?sign=leo — this sign against the other eleven, best match first. */
const getCompatibility = asyncHandler(async (req, res) => {
  const result = await zodiacCompatibilityService.getCompatibilityFor(req.query.sign);
  return res.json(result);
});

module.exports = { getDaily, getCompatibility };
