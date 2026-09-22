/**
 * Daily horoscope, adapted to the shape this file has always returned
 * (`{ sign, date, reading, luckyNumber, colour, energy }`) so nothing above
 * it — user.controller.js's `/horoscope` route, user.service.js's home
 * summary — needs to change beyond awaiting it, now that it's async.
 *
 * The real work (caching, the shared AstrologyAPI credit guard, lucky
 * number/colour/energy derivation) lives in horoscopeCache.service.js and
 * horoscopeRead.service.js; this is only the adapter between that and the
 * older public contract these two call sites were already built against.
 */

const ApiError = require('../utils/ApiError');
const { ZODIAC_SIGNS } = require('../utils/zodiac');
const { getDailyHoroscope } = require('./horoscopeRead.service');

/** The normalised {sign, date, summary, ..., lucky_number, lucky_color, energy} shape, reshaped into this file's long-standing contract. */
function toCardShape(result) {
  return {
    sign: result.sign,
    date: result.date,
    reading: result.summary,
    luckyNumber: result.lucky_number,
    colour: result.lucky_color,
    energy: result.energy,
  };
}

/** One sign's reading for today — `sign` may arrive in any case (routes/public.routes.js does not lowercase it). */
async function dailyFor(sign) {
  const zodiacSign = String(sign || '').trim().toLowerCase();
  if (!ZODIAC_SIGNS.includes(zodiacSign)) {
    throw ApiError.badRequest('Unknown zodiac sign.', { sign: 'Unknown zodiac sign.' });
  }
  return toCardShape(await getDailyHoroscope(zodiacSign));
}

/** Every sign at once, for a listing screen. Already cache-backed 12x/day (see jobs/horoscopePrefetch.job.js), so this is free once that has run. */
async function dailyForAll() {
  return Promise.all(ZODIAC_SIGNS.map(sign => dailyFor(sign)));
}

module.exports = { dailyFor, dailyForAll };
