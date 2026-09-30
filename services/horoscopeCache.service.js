/**
 * The single choke point for AstrologyAPI's sun-sign horoscope endpoints —
 * same shape as kundliCache.service's getKundliSection and geo.service's
 * getGeoSection: cache check, the credit guard, provider call, cache write,
 * usage log. Nothing else in the codebase may call the horoscope provider
 * endpoints directly.
 *
 * Cached by the ACTUAL calendar date a reading is FOR (targetDate), not by
 * which of the three provider endpoints answered it — so a "next" call made
 * today for tomorrow's date already satisfies tomorrow's own "today" request.
 * At most one real call ever produces a given (sign, date) pair.
 *
 * Same AstrologyAPI account as kundli — same base URL, same credentials —
 * but its own separate monthly credit pool (`category: 'horoscope'` on both
 * the guard and the ApiUsage ledger): the daily prefetch job alone can spend
 * up to 12 calls a day, and sharing kundli's budget would let a busy
 * horoscope month starve new kundlis of credits for the rest of it.
 */

const HoroscopeCache = require('../models/HoroscopeCache');
const ApiUsage = require('../models/ApiUsage');
const ApiError = require('../utils/ApiError');
const { ASTROLOGY_API_PROVIDER } = require('../config/constants');
const { assertCreditBudget } = require('./kundliCache.service');
const { istDateString, dateOffset } = require('../utils/istDate');
const { deriveHoroscopeExtras } = require('../utils/horoscopeDerived');

const MONGO_DUPLICATE_KEY = 11000;

/** Fixed — this app only ever reads horoscopes for the IST audience, same as tzone elsewhere in this codebase. */
const TIMEZONE = 5.5;

/** Lazy-required so this module loads fine before the real client exists. */
function defaultCallProvider(endpoint, zodiacSign) {
  // eslint-disable-next-line global-require
  return require('./astrologyApi.client').request(`${endpoint}/${zodiacSign}`, { timezone: TIMEZONE });
}

/**
 * Which of the three daily provider endpoints answers a given calendar date,
 * relative to today (IST) — the only axis AstrologyAPI actually offers. Null
 * for anything further than one day out in either direction.
 */
function dailyEndpointFor(targetDate, today) {
  if (targetDate === today) return 'sun_sign_prediction/daily';
  if (targetDate === dateOffset(today, 1)) return 'sun_sign_prediction/daily/next';
  if (targetDate === dateOffset(today, -1)) return 'sun_sign_prediction/daily/previous';
  return null;
}

/**
 * Returns one sign's horoscope for one date, from cache whenever possible.
 *
 * @param {string} zodiacSign Lowercase, e.g. "leo" — see utils/zodiac.js.
 * @param {'daily'|'monthly'} period Only "daily" has a provider call wired
 *   up yet; "monthly" is reserved in the schema for later.
 * @param {string} targetDate "YYYY-MM-DD" — the date the reading is FOR, not
 *   necessarily today. The provider endpoint to call (if any) is derived from
 *   how far this is from today.
 * @param {(endpoint: string, zodiacSign: string) => Promise<unknown>} [callProvider]
 *   Overrides the real client — the seam tests use to run against a fake
 *   provider instead of the network.
 * @param {{ allowStaleFallback?: boolean }} [options] `allowStaleFallback`
 *   (default true) is what a live user-facing read wants — never error, serve
 *   whatever's most recently on file for this sign if today's fetch fails.
 *   jobs/horoscopePrefetch.job.js passes `false`: it needs to know whether
 *   TODAY's fetch genuinely succeeded to report and log accurately, so a
 *   stale reading masking a real failure would defeat the one thing this job
 *   exists to guarantee.
 * @returns {Promise<{ payload: unknown, derived: { luckyNumber: number, luckyColor: string, energy: string }, targetDate: string, stale: boolean }>}
 *   `targetDate` is the date the returned reading is actually FOR — it only
 *   differs from the argument when `stale` is true (fallback served).
 */
async function getHoroscope(zodiacSign, period, targetDate, callProvider, options = {}) {
  const { allowStaleFallback = true } = options;
  const cached = await HoroscopeCache.findOne({ zodiacSign, period, targetDate }).lean();
  if (cached) {
    console.log(`[astrologyCache] hit endpoint=sun_sign_prediction/${period} sign=${zodiacSign} date=${targetDate}`);
    return { payload: cached.payload, derived: cached.derived, targetDate, stale: false };
  }
  console.log(`[astrologyCache] miss endpoint=sun_sign_prediction/${period} sign=${zodiacSign} date=${targetDate} — calling provider`);

  if (period !== 'daily') {
    throw new Error(`getHoroscope: no provider call wired up for period "${period}" yet.`);
  }

  const today = istDateString();
  const endpoint = dailyEndpointFor(targetDate, today);
  if (!endpoint) {
    throw ApiError.badRequest(`No horoscope endpoint covers ${targetDate} relative to today (${today}).`);
  }

  let payload;
  try {
    await assertCreditBudget(ASTROLOGY_API_PROVIDER, 1, 'horoscope');
    const provider = callProvider || defaultCallProvider;
    payload = await provider(endpoint, zodiacSign);
  } catch (error) {
    /**
     * The provider is down, or this month's horoscope budget is spent — either
     * way, the most recent reading already on file for this sign beats a hard
     * error, even if it's for a different day. Only reached once a job/other
     * request has genuinely never cached this sign at all does this come back
     * empty, and the caller's own error is what surfaces then.
     */
    const stale = allowStaleFallback
      ? await HoroscopeCache.findOne({ zodiacSign, period }).sort({ targetDate: -1 }).lean()
      : null;
    if (stale) {
      console.warn(`[astrologyCache] fetch failed for sign=${zodiacSign} date=${targetDate}, serving stale reading from ${stale.targetDate}:`, error.message);
      /** `targetDate` is the STALE row's own date and `stale: true` — callers must never present this as today's reading. */
      return { payload: stale.payload, derived: stale.derived, targetDate: stale.targetDate, stale: true };
    }
    throw error;
  }

  const derived = deriveHoroscopeExtras(zodiacSign, targetDate);

  try {
    await HoroscopeCache.create({ zodiacSign, period, targetDate, payload, derived, fetchedAt: new Date() });
  } catch (error) {
    /** Two callers raced for the same (sign, period, date) — the credit's already spent; keep the payload. */
    if (error?.code !== MONGO_DUPLICATE_KEY) {
      throw error;
    }
  }

  await ApiUsage.create({ provider: ASTROLOGY_API_PROVIDER, endpoint, category: 'horoscope', calledAt: new Date() });

  return { payload, derived, targetDate, stale: false };
}

/**
 * The cache-only counterpart to `getHoroscope` above — a look, never a call.
 * Same reasoning and same shape as services/kundliCache.service.js's
 * `getCachedKundliSection`: the AI assistant's `get_daily_horoscope` tool
 * must never spend a credit just because today's reading for this sign
 * hasn't been generated (or prefetched — see jobs/horoscopePrefetch.job.js,
 * currently off) yet. A miss is a plain, distinguishable "not cached" error;
 * `assertCreditBudget` and the provider are never reached, by construction.
 *
 * @param {string} zodiacSign
 * @param {'daily'|'monthly'} period
 * @param {string} targetDate "YYYY-MM-DD"
 * @returns {Promise<{ payload: unknown, derived: unknown }>}
 * @throws {ApiError} 404 `horoscope_not_cached` on a miss.
 */
async function getCachedHoroscope(zodiacSign, period, targetDate) {
  const cached = await HoroscopeCache.findOne({ zodiacSign, period, targetDate }).lean();
  if (!cached) {
    throw ApiError.notFound(
      `No ${period} horoscope cached for ${zodiacSign} on ${targetDate}.`,
      'horoscope_not_cached',
    );
  }
  return { payload: cached.payload, derived: cached.derived };
}

module.exports = { getHoroscope, getCachedHoroscope, dailyEndpointFor, TIMEZONE };
