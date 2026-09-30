/**
 * Sun-sign compatibility — the one place that may call AstrologyAPI's
 * `zodiac_compatibility/:sign/:partner` endpoint (same choke-point shape as
 * horoscopeCache.service.js: cache check, credit guard, provider call, cache
 * write, usage log).
 *
 * A pair's result never changes, so it is cached without a date and without a
 * TTL: the first time a sign's compatibility list is requested the eleven
 * partner pairs are fetched (11 general credits, once ever per sign), and
 * every request after that — from anyone, on any day — reads the cache only.
 * Concurrent first requests for the same sign share one in-flight fetch.
 */

const ZodiacCompatibilityCache = require('../models/ZodiacCompatibilityCache');
const ApiUsage = require('../models/ApiUsage');
const ApiError = require('../utils/ApiError');
const { ASTROLOGY_API_PROVIDER } = require('../config/constants');
const { ZODIAC_SIGNS } = require('../utils/zodiac');
const { assertCreditBudget } = require('./kundliCache.service');

const MONGO_DUPLICATE_KEY = 11000;
const ENDPOINT = 'zodiac_compatibility';

/** Lazy-required so this module loads fine in tests that never touch the network. */
function defaultCallProvider(sign, partnerSign) {
  // eslint-disable-next-line global-require
  return require('./astrologyApi.client').request(`${ENDPOINT}/${sign}/${partnerSign}`, {});
}

/** Provider payload → this API's own row shape; the `percentage` is a number or null, never NaN. */
function normalizePair(partnerSign, payload) {
  const percentage = Number(payload?.compatibility_percentage);
  return {
    partner_sign: partnerSign,
    percentage: Number.isFinite(percentage) ? percentage : null,
    report: typeof payload?.compatibility_report === 'string' ? payload.compatibility_report : '',
  };
}

const inFlight = new Map();

/**
 * One sign against the other eleven, best match first.
 *
 * @param {string} sign Lowercase zodiac sign (validated by the route).
 * @param {(sign: string, partnerSign: string) => Promise<unknown>} [callProvider] Test seam.
 * @returns {Promise<{ sign: string, items: Array<{ partner_sign: string, percentage: number|null, report: string }> }>}
 */
async function getCompatibilityFor(sign, callProvider) {
  const zodiacSign = String(sign || '').trim().toLowerCase();
  if (!ZODIAC_SIGNS.includes(zodiacSign)) {
    throw ApiError.badRequest('Unknown zodiac sign.', { sign: 'Unknown zodiac sign.' });
  }
  const partners = ZODIAC_SIGNS.filter(other => other !== zodiacSign);

  const cached = await ZodiacCompatibilityCache.find({ sign: zodiacSign }).lean();
  const byPartner = new Map(cached.map(row => [row.partnerSign, row.payload]));
  const missing = partners.filter(partner => !byPartner.has(partner));

  if (missing.length) {
    let pending = inFlight.get(zodiacSign);
    if (!pending) {
      pending = fetchMissing(zodiacSign, missing, callProvider || defaultCallProvider).finally(() =>
        inFlight.delete(zodiacSign),
      );
      inFlight.set(zodiacSign, pending);
    }
    const fetched = await pending;
    for (const [partner, payload] of fetched) byPartner.set(partner, payload);
  }

  const items = partners
    .map(partner => normalizePair(partner, byPartner.get(partner)))
    .sort((a, b) => (b.percentage ?? -1) - (a.percentage ?? -1));
  return { sign: zodiacSign, items };
}

/** Provider calls for the pairs not on file — guarded as one batch, so a half-spent budget never yields a half-list. */
async function fetchMissing(sign, partners, callProvider) {
  await assertCreditBudget(ASTROLOGY_API_PROVIDER, partners.length, 'general');
  console.log(`[astrologyCache] miss endpoint=${ENDPOINT} sign=${sign} pairs=${partners.length} — calling provider`);

  const fetched = new Map();
  for (const partner of partners) {
    let payload;
    try {
      payload = await callProvider(sign, partner);
    } catch (error) {
      /** Pairs fetched before the failure are already on file, so a retry only pays for what is still missing. */
      console.error(`[astrologyCache] ${ENDPOINT} ${sign}/${partner} failed:`, error.message);
      throw new ApiError(503, 'Compatibility is temporarily unavailable. Please try again later.', undefined, 'provider_unavailable');
    }
    fetched.set(partner, payload);
    try {
      await ZodiacCompatibilityCache.create({ sign, partnerSign: partner, payload, fetchedAt: new Date() });
    } catch (error) {
      if (error?.code !== MONGO_DUPLICATE_KEY) throw error;
    }
    await ApiUsage.create({ provider: ASTROLOGY_API_PROVIDER, endpoint: ENDPOINT, category: 'general', calledAt: new Date() });
  }
  return fetched;
}

module.exports = { getCompatibilityFor, normalizePair, ENDPOINT };
