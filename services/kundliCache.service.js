/**
 * The single choke point every AstrologyAPI call goes through.
 *
 * No other file in this codebase is allowed to call the provider directly —
 * everything (the 12-call batch, the lazy antardasha lookup, anything added
 * later) comes through `getKundliSection`, so caching and credit-tracking
 * cannot be bypassed by a new call site forgetting to check the cache first.
 * With 150 total credits on the plan, that single door is what keeps a
 * caching bug from being an expensive one.
 */

const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { ASTROLOGY_API_PROVIDER } = require('../config/constants');
const KundliCache = require('../models/KundliCache');
const ApiUsage = require('../models/ApiUsage');

const MONGO_DUPLICATE_KEY = 11000;

/** Lazy-required so this module (and its tests) load fine before the real client exists. */
function defaultCallProvider(birthProfile, endpoint, pathParam) {
  // eslint-disable-next-line global-require
  return require('./astrologyApi.client').callProvider(birthProfile, endpoint, pathParam);
}

/**
 * The budget categories that have a ceiling of their own, apart from the
 * general (kundli) pool — each maps to its env limit. Anything not listed
 * here counts as 'general'.
 */
const DEDICATED_CATEGORY_LIMITS = {
  horoscope: () => env.astrologyApi.horoscopeMonthlyCreditLimit,
  panchang: () => env.astrologyApi.panchangMonthlyCreditLimit,
};
const DEDICATED_CATEGORIES = Object.keys(DEDICATED_CATEGORY_LIMITS);

/** The ceiling one category is measured against — read at call time so a test (or a config reload) can change it. */
function monthlyLimitFor(category) {
  const dedicated = DEDICATED_CATEGORY_LIMITS[category];
  return dedicated ? dedicated() : env.astrologyApi.monthlyCreditLimit;
}

/**
 * How many real calls this provider has answered since the start of this
 * calendar month, within one budget category. 'horoscope' and 'panchang' are
 * their own separate pools (see config/env.js's horoscopeMonthlyCreditLimit
 * and panchangMonthlyCreditLimit) so the daily prefetch job and the website's
 * panchang page can never starve kundli generation of credits; every other
 * caller stays on 'general'. A row written before `category` existed has no
 * such field at all, not 'general' — `{ $nin: [...] }` is what makes those
 * still count towards the general pool.
 */
async function getMonthlyUsageCount(provider = ASTROLOGY_API_PROVIDER, now = new Date(), category = 'general') {
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const categoryFilter = DEDICATED_CATEGORIES.includes(category) ? category : { $nin: DEDICATED_CATEGORIES };
  return ApiUsage.countDocuments({ provider, calledAt: { $gte: startOfMonth }, category: categoryFilter });
}

/**
 * Refuses before a credit would be spent, once this month's usage has already
 * reached (or, given `additionalCalls`, would exceed) the plan's ceiling.
 * Never called on a cache hit — hits are free.
 *
 * @param {string} [provider]
 * @param {number} [additionalCalls] How many calls the caller is about to
 *   attempt — 1 for a single getKundliSection/getGeoSection call (the
 *   default), or the full batch size for an upfront check before firing
 *   several in parallel (see services/kundli.service.js), so a doomed batch
 *   is refused as one clear error instead of failing call-by-call at the edge.
 * @param {'general'|'horoscope'|'panchang'} [category]
 */
async function assertCreditBudget(provider = ASTROLOGY_API_PROVIDER, additionalCalls = 1, category = 'general') {
  const used = await getMonthlyUsageCount(provider, new Date(), category);
  const limit = monthlyLimitFor(category);
  if (used + additionalCalls > limit) {
    throw ApiError.tooManyRequests(
      `The AstrologyAPI monthly ${category} credit limit (${limit}) would be exceeded by this request (${used} calls already made this month).`,
      'astrology_credit_limit_reached',
    );
  }
}

/** Past its TTL means due for a refresh attempt — never means "delete it." A row with no ttlSeconds (the common case) is never stale. */
function isStale(cached) {
  if (!cached.ttlSeconds) {
    return false;
  }
  return Date.now() - new Date(cached.fetchedAt).getTime() >= cached.ttlSeconds * 1000;
}

/**
 * Returns one provider section for one birth, from cache whenever possible.
 *
 * @param {{ birthHash: string }} birthProfile Anything carrying the birth's
 *   permanent cache key — a BirthProfile document or a plain object.
 * @param {string} endpoint The provider path this section answers, e.g.
 *   "astro_details", "planets/extended", "sub_vdasha".
 * @param {string|null} [pathParam] Only for the lazy antardasha call — the
 *   mahadasha lord path segment, e.g. "Jupiter". Omitted for every batch
 *   endpoint, which is one row per birth regardless of path.
 * @param {(birthProfile, endpoint, pathParam) => Promise<unknown>} [callProvider]
 *   Overrides the real client — this is the seam tests use to run against a
 *   fake provider instead of the network.
 * @param {{ ttlSeconds?: number }} [options] Only sadhesati_current_status
 *   passes `ttlSeconds` today (30 days) — everything else stays permanent.
 * @returns {Promise<unknown>} The section's payload — from cache on a hit,
 *   freshly fetched (and now cached) on a miss, or a stale cached payload if
 *   a due refresh attempt fails (the provider being down must not turn an
 *   already-answered question into an error).
 */
async function getKundliSection(birthProfile, endpoint, pathParam, callProvider, options = {}) {
  if (!birthProfile || !birthProfile.birthHash) {
    throw new Error('getKundliSection requires a birthProfile with a birthHash.');
  }
  if (!endpoint) {
    throw new Error('getKundliSection requires an endpoint.');
  }

  const { birthHash } = birthProfile;
  const normalizedPathParam = pathParam || null;
  const provider = callProvider || defaultCallProvider;
  const { ttlSeconds = null } = options;

  const cached = await KundliCache.findOne({ birthHash, endpoint, pathParam: normalizedPathParam }).lean();

  if (cached && !isStale(cached)) {
    console.log(`[astrologyCache] hit endpoint=${endpoint} birthHash=${birthHash.slice(0, 8)}`);
    return cached.payload;
  }

  if (cached) {
    /** Due for a refresh, not missing — a failed attempt below (budget or provider) falls back to this same payload rather than erroring. */
    console.log(`[astrologyCache] stale endpoint=${endpoint} birthHash=${birthHash.slice(0, 8)} — attempting refresh`);
  } else {
    console.log(`[astrologyCache] miss endpoint=${endpoint} birthHash=${birthHash.slice(0, 8)} — calling provider`);
  }

  let payload;
  try {
    await assertCreditBudget();
    payload = await provider(birthProfile, endpoint, normalizedPathParam);
  } catch (error) {
    if (cached) {
      console.warn(`[astrologyCache] refresh failed for endpoint=${endpoint} birthHash=${birthHash.slice(0, 8)}, serving stale payload:`, error.message);
      return cached.payload;
    }
    throw error;
  }

  try {
    await KundliCache.findOneAndUpdate(
      { birthHash, endpoint, pathParam: normalizedPathParam },
      {
        $set: {
          payload,
          provider: ASTROLOGY_API_PROVIDER,
          fetchedAt: new Date(),
          cachePolicy: ttlSeconds ? 'ttl' : 'permanent',
          ttlSeconds,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    /**
     * Two callers raced for the same (birthHash, endpoint, pathParam) — the
     * unique index caught it. The credit is already spent either way; keep
     * the payload this call just paid for rather than throwing it away.
     */
    if (error?.code !== MONGO_DUPLICATE_KEY) {
      throw error;
    }
  }

  await ApiUsage.create({
    provider: ASTROLOGY_API_PROVIDER,
    endpoint,
    birthHash,
    calledAt: new Date(),
  });

  return payload;
}

/**
 * The cache-only counterpart to `getKundliSection` above — a look, never a
 * call. Used anywhere a live provider fallback on a miss would be wrong (see
 * services/assistant.service.js's `buildChartSummary`): the AI assistant must
 * never spend one of the plan's credits just because a screen hasn't
 * generated a particular section yet. A miss here is reported back as a
 * plain, distinguishable "not cached" error — `assertCreditBudget`,
 * `callProvider` and `ApiUsage` are never reached, by construction, not by a
 * flag that could be passed wrong.
 *
 * @param {{ birthHash: string }} birthProfile
 * @param {string} endpoint
 * @param {string|null} [pathParam]
 * @returns {Promise<unknown>} The cached payload.
 * @throws {ApiError} 404 `kundli_section_not_cached` on a miss.
 */
async function getCachedKundliSection(birthProfile, endpoint, pathParam) {
  if (!birthProfile || !birthProfile.birthHash) {
    throw new Error('getCachedKundliSection requires a birthProfile with a birthHash.');
  }
  if (!endpoint) {
    throw new Error('getCachedKundliSection requires an endpoint.');
  }

  const cached = await KundliCache.findOne({
    birthHash: birthProfile.birthHash,
    endpoint,
    pathParam: pathParam || null,
  }).lean();

  if (!cached) {
    throw ApiError.notFound(
      `"${endpoint}" has not been generated for this kundli yet.`,
      'kundli_section_not_cached',
    );
  }

  return cached.payload;
}

module.exports = {
  getKundliSection,
  getCachedKundliSection,
  assertCreditBudget,
  getMonthlyUsageCount,
};
