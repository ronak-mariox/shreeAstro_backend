/**
 * The only file that ever sends an HTTP request to AstrologyAPI.com.
 *
 * Everything about talking to this specific provider lives here: HTTP Basic
 * auth, an x-www-form-urlencoded body (it does not accept JSON), a timeout,
 * and a small bounded retry for failures actually worth retrying. Nothing
 * else in the codebase should call `fetch` against astrologyapi.com directly.
 *
 * `callProvider` is what services/kundliCache.service.js calls by default on
 * a cache miss — never call it from anywhere else; go through
 * `getKundliSection` so the cache and the credit guard stay the single door.
 * Geocoding (/geo_details, /timezone_with_dst) has a different param shape
 * entirely — no birth details at all — so it calls `request()` directly from
 * its own service instead of through `callProvider`.
 */

const env = require('../config/env');

const TIMEOUT_MS = 20000;
/** 1 try + 2 retries — credits are too scarce to retry aggressively. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];

/**
 * The chart SVG's colours. AstrologyAPI wants these on every /horo_chart_image
 * call; there's nothing to compute here, so they're a fixed style rather than
 * something a caller passes in. Tweak the values here, not per call-site.
 */
const CHART_IMAGE_STYLE = {
  chartType: 'north',
  image_type: 'svg',
  planetColor: '#000000',
  signColor: '#000000',
  lineColor: '#000000',
};

/** Endpoints that need params beyond the shared birth-detail set. */
const EXTRA_PARAMS_BY_ENDPOINT = {
  'horo_chart_image/D1': CHART_IMAGE_STYLE,
};

/** Endpoints that error if sent `ayanamsha` at all — /shadbala is the one confirmed case. */
const ENDPOINTS_WITHOUT_AYANAMSHA = new Set(['shadbala']);

function authHeader() {
  const token = Buffer.from(`${env.astrologyApi.userId}:${env.astrologyApi.apiKey}`).toString('base64');
  return `Basic ${token}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Worth another attempt — a timeout or a network-level failure (DNS,
 * connection reset, no `status` at all) might succeed next time, and so might
 * the provider's own 5xx. A 4xx never will; retrying it only spends a second
 * credit failing the same way, so it is not retried.
 */
function isRetryable(error) {
  if (error.name === 'AbortError') return true;
  if (!error.status) return true;
  return error.status >= 500;
}

/**
 * One authenticated, form-encoded POST to AstrologyAPI, with a timeout and a
 * bounded retry.
 *
 * @param {string} path Relative to env.astrologyApi.baseUrl, e.g.
 *   "astro_details" or "sub_vdasha/Jupiter" — no leading slash needed.
 * @param {Record<string, string|number>} params
 */
async function request(path, params) {
  const url = `${env.astrologyApi.baseUrl.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
  const definedParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
  );
  const body = new URLSearchParams(definedParams).toString();

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
          /** Required by the horoscope endpoints (services/horoscopeCache.service.js); harmless for every other call, which is English regardless. */
          'Accept-Language': 'en',
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new Error(`AstrologyAPI ${path} responded ${response.status}: ${text.slice(0, 500)}`);
        error.status = response.status;
        throw error;
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS && isRetryable(error)) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable — the loop above always either returns or throws — but keeps the function's return type honest.
  throw lastError;
}

/**
 * dateOfBirth's time-of-day is arbitrary/unused (timeOfBirth carries the real
 * time separately) — but its calendar date must be read with UTC getters, or
 * the server's own local timezone could shift it a day either way.
 */
function dateParts(dateOfBirth) {
  const date = new Date(dateOfBirth);
  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    year: date.getUTCFullYear(),
  };
}

/** "06:30" -> { hour: 6, min: 30 } — birthDetailsSchema already validates this shape. */
function timeParts(timeOfBirth) {
  const [hour, min] = String(timeOfBirth).split(':').map(Number);
  return { hour, min };
}

/** The params every kundli-section call shares, built from one BirthProfile. */
function birthParams(birthProfile) {
  const { birthDetails, tzone, ayanamsha } = birthProfile;
  return {
    ...dateParts(birthDetails.dateOfBirth),
    ...timeParts(birthDetails.timeOfBirth),
    lat: birthDetails.place.latitude,
    lon: birthDetails.place.longitude,
    tzone,
    ayanamsha,
  };
}

/**
 * What services/kundliCache.service.js calls on a cache miss.
 *
 * @param {object} birthProfile A BirthProfile-shaped object (birthDetails, tzone, ayanamsha).
 * @param {string} endpoint The provider path exactly as kundli_cache keys it —
 *   "astro_details", "planets/extended", "horo_chart_image/D1", "sub_vdasha", ...
 * @param {string|null} [pathParam] Only for "sub_vdasha" — the mahadasha lord, appended as the path segment.
 */
async function callProvider(birthProfile, endpoint, pathParam) {
  const path = pathParam ? `${endpoint}/${pathParam}` : endpoint;
  const params = { ...birthParams(birthProfile), ...(EXTRA_PARAMS_BY_ENDPOINT[endpoint] || {}) };
  if (ENDPOINTS_WITHOUT_AYANAMSHA.has(endpoint)) {
    delete params.ayanamsha;
  }
  /**
   * Through `module.exports.request`, not the bare local `request` — several
   * tests (zodiac-enrichment.test.js among them) monkey-patch `client.request`
   * to fake the transport; calling the local binding directly would silently
   * keep hitting the real (unmocked) implementation regardless of that.
   */
  return module.exports.request(path, params);
}

module.exports = { request, callProvider };
