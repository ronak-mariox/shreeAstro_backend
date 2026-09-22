/**
 * GET /horoscope/daily — everything a horoscope card asks for, resolved
 * through the one horoscopeCache.service choke point so a repeat request
 * (any user, any time of day) never spends a second credit.
 */

const { getHoroscope } = require('./horoscopeCache.service');
const { normalizeHoroscope } = require('./horoscopeNormalize');
const { istDateString, dateOffset } = require('../utils/istDate');

/** `day` is relative to today (IST) — "next"/"previous" are the only two the provider itself offers. */
function targetDateFor(day) {
  const today = istDateString();
  if (day === 'next') return dateOffset(today, 1);
  if (day === 'previous') return dateOffset(today, -1);
  return today;
}

/** @param {string} zodiacSign Lowercase, e.g. "leo". @param {'next'|'previous'} [day] Omitted for today. */
async function getDailyHoroscope(zodiacSign, day) {
  const targetDate = targetDateFor(day);
  const { payload, derived } = await getHoroscope(zodiacSign, 'daily', targetDate);
  return normalizeHoroscope(payload, derived, zodiacSign, targetDate);
}

module.exports = { getDailyHoroscope, targetDateFor };
