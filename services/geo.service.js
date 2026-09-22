/**
 * Place lookups — /geo_details and /timezone_with_dst — permanently cached
 * under a query key (see models/GeoCache.js), kept separate from KundliCache
 * because this runs BEFORE a birth profile exists: there is no birthHash yet
 * while someone is still typing a place name into the birth-details form.
 *
 * Still the same 150-credit AstrologyAPI plan, though — so this reuses
 * kundliCache.service's credit guard and logs to the same ApiUsage ledger.
 * GeoCache is only what makes a *repeat* lookup free; the budget itself is
 * shared with every kundli call.
 *
 * normalizeGeoDetails() and normalizeTimezone() are verified against real
 * captured responses — see tests/fixtures/astrologyapi/geo_details.json and
 * timezone_with_dst.json (2 credits spent capturing these, once).
 */

const GeoCache = require('../models/GeoCache');
const ApiUsage = require('../models/ApiUsage');
const { ASTROLOGY_API_PROVIDER } = require('../config/constants');
const { assertCreditBudget } = require('./kundliCache.service');

const MONGO_DUPLICATE_KEY = 11000;

/** Lazy-required so this module loads fine even before the real client is wired for a given environment. */
function defaultCallProvider(endpoint, params) {
  // eslint-disable-next-line global-require
  return require('./astrologyApi.client').request(endpoint, params);
}

/** "  Mumbai,  Maharashtra " -> "mumbai, maharashtra" — so typing noise never splits one city across two cache rows. */
function normalizePlaceQuery(text) {
  return String(text).trim().replace(/\s+/g, ' ').toLowerCase();
}

function placeCacheKey(query) {
  return `place:${normalizePlaceQuery(query)}`;
}

/** Historical Indian offsets were not always +5:30 — the cache key includes the date, not just the place. */
function timezoneCacheKey(lat, lon, dob) {
  return `tz:${Number(lat).toFixed(4)},${Number(lon).toFixed(4)},${dob}`;
}

/**
 * The choke point behind both geo endpoints — same shape as
 * kundliCache.service's getKundliSection, keyed by a cache-key string instead
 * of a birthHash.
 */
async function getGeoSection(cacheKey, endpoint, params, callProvider) {
  const provider = callProvider || defaultCallProvider;

  const cached = await GeoCache.findOne({ _id: cacheKey }).lean();
  if (cached) {
    return cached.payload;
  }

  await assertCreditBudget();

  const payload = await provider(endpoint, params);

  try {
    await GeoCache.create({ _id: cacheKey, payload, fetchedAt: new Date() });
  } catch (error) {
    /** Two concurrent searches for the same place raced — the credit's already spent; keep the payload. */
    if (error?.code !== MONGO_DUPLICATE_KEY) {
      throw error;
    }
  }

  await ApiUsage.create({ provider: ASTROLOGY_API_PROVIDER, endpoint, calledAt: new Date() });

  return payload;
}

/**
 * AstrologyAPI's real /geo_details shape (tests/fixtures/astrologyapi/geo_details.json):
 *   { geonames: [{ place_name, latitude: "19.07283", longitude: "72.88261", country_code: "IN", timezone_id: "Asia/Kolkata" }] }
 * There is no state/region field at all — a UI wanting one would need a
 * separate reverse-geocode, out of scope here. `timezone_id` is the IANA
 * zone, handed straight through onto birthPlaceSchema.timezone; the decimal
 * offset AstrologyAPI's other calls need still comes from /timezone_with_dst
 * below, since that varies by date, not just place.
 */
function normalizeGeoDetails(raw) {
  const rows = Array.isArray(raw?.geonames) ? raw.geonames : [];

  return rows.map(row => ({
    formatted: [row.place_name, row.country_code].filter(Boolean).join(', '),
    city: row.place_name ?? '',
    country: row.country_code ?? '',
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    timezone: row.timezone_id,
  }));
}

/**
 * GET /places/search?q= — geocode suggestions as the user types.
 *
 * Only the text before a comma is actually sent to the provider — verified
 * empirically: the exact string "Mumbai, Maharashtra" came back with zero
 * results, while "Mumbai" alone matched. AstrologyAPI's /geo_details indexes
 * by city name only, not "City, State" text. `maxRows` still asks for
 * several candidates, so a genuinely ambiguous city (multiple "Springfield"s)
 * comes back as a list for the frontend to disambiguate, rather than this
 * function guessing which state the caller meant.
 *
 * The 3-character minimum is the provider's own — also verified empirically:
 * it refuses anything shorter with a 405 ("place length must be at least 3
 * characters long"), so this must match exactly or a 2-character query wastes
 * a round trip on a guaranteed refusal.
 */
async function searchPlaces(query, callProvider) {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 3) {
    return [];
  }

  const searchTerm = trimmed.split(',')[0].trim();
  if (searchTerm.length < 3) {
    return [];
  }

  const cacheKey = placeCacheKey(searchTerm);
  const raw = await getGeoSection(cacheKey, 'geo_details', { place: searchTerm, maxRows: 10 }, callProvider);

  /**
   * `id` is "<cacheKey>#<index into this exact cached list>" — what
   * resolvePlaceById() below reverses. This is the enforcement behind "lat/lon
   * only ever come from /geo_details": POST /birth-profiles takes this id,
   * never raw coordinates, so a client cannot simply type coordinates in.
   */
  return normalizeGeoDetails(raw).map((place, index) => ({ id: `${cacheKey}#${index}`, ...place }));
}

/**
 * Resolves an id /places/search actually returned back to its authoritative
 * place — read from GeoCache, never trusted from the caller directly. Returns
 * null for anything that isn't a real, still-cached search result.
 */
async function resolvePlaceById(placeId) {
  const separator = String(placeId || '').lastIndexOf('#');
  if (separator === -1) {
    return null;
  }

  const cacheKey = placeId.slice(0, separator);
  const index = Number(placeId.slice(separator + 1));
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }

  const cached = await GeoCache.findOne({ _id: cacheKey }).lean();
  if (!cached) {
    return null;
  }

  return normalizeGeoDetails(cached.payload)[index] || null;
}

/** AstrologyAPI's real /timezone_with_dst shape (tests/fixtures/astrologyapi/timezone_with_dst.json): { status, timezone: 5.5, timezone_in_ms, date }. */
function normalizeTimezone(raw) {
  return { tzone: Number(raw?.timezone) };
}

/**
 * The decimal UTC offset for a lat/lon AT a specific date — never today's
 * offset. Called once when a BirthProfile is created (step 5) and the result
 * stored on it permanently, since re-deriving it later would use today's
 * (possibly different, historically) rule instead of the birth date's.
 */
async function getTimezoneForDate(latitude, longitude, dob, callProvider) {
  const raw = await getGeoSection(
    timezoneCacheKey(latitude, longitude, dob),
    'timezone_with_dst',
    { latitude, longitude, date: dob },
    callProvider,
  );
  return normalizeTimezone(raw);
}

module.exports = {
  searchPlaces,
  resolvePlaceById,
  getTimezoneForDate,
  normalizePlaceQuery,
  placeCacheKey,
  timezoneCacheKey,
};
