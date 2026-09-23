/**
 * Birth profiles — the record a kundli is generated for — and the 11-call
 * AstrologyAPI batch that fills one in.
 *
 * Nothing here calls the provider directly; every section goes through
 * kundliCache.service's getKundliSection, so caching, the credit guard and
 * partial-failure tolerance all come from that one choke point for free.
 */

const BirthProfile = require('../models/BirthProfile');
const UserProfile = require('../models/UserProfile');
const KundliCache = require('../models/KundliCache');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { ASTROLOGY_API_PROVIDER } = require('../config/constants');
const { getKundliSection, assertCreditBudget } = require('./kundliCache.service');
const { getChartImageUrl, CHART_ENDPOINT } = require('./chartStorage.service');
const geoService = require('./geo.service');
const { computeBirthHash } = require('../utils/birthHash');
const { parseBirthDate, parseBirthTime } = require('./auth.service');

/**
 * The 11 endpoints every birth profile needs once. None take a pathParam —
 * that's only for the lazy /sub_vdasha/:md antardasha lookup (step 8).
 * shadbala/basic_gem_suggestion/puja_suggestion need no special handling here
 * — the ayanamsha-omission /shadbala requires lives in astrologyApi.client.js,
 * this batch is otherwise endpoint-agnostic.
 *
 * /current_vdasha_all is deliberately not in this list — its only unique
 * value was "which mahadasha is running right now", which
 * kundliRead.service.js's getKundliDasha now works out itself from
 * /major_vdasha (already here) plus today's date, via
 * kundliNormalize.js's findCurrentLord. One live call fewer per birth.
 */
const BATCH_ENDPOINTS = [
  'astro_details',
  'planets/extended',
  CHART_ENDPOINT,
  'horo_chart/D1',
  'major_vdasha',
  'kalsarpa_details',
  'sadhesati_current_status',
  'pitra_dosha_report',
  'shadbala',
  'basic_gem_suggestion',
  'puja_suggestion',
];

/** Sade Sati is Saturn-transit-derived, not fixed for life like the rest of this batch — recheck it monthly-ish rather than caching it forever. */
const SADHESATI_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Per-endpoint getKundliSection options — every endpoint but sadhesati stays the default (permanent, no ttl). */
const BATCH_ENDPOINT_OPTIONS = {
  sadhesati_current_status: { ttlSeconds: SADHESATI_TTL_SECONDS },
};

/** "1995-08-15" — the shape computeBirthHash and every provider param builder wants, from a UTC-midnight Date. */
function isoDateOf(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * dob must be a real, past date; tob must carry minute precision — a few
 * minutes off can change the ascendant, so neither is optional or fuzzy.
 * DD/MM/YYYY and HH:MM[ AM/PM] are the same formats registration already
 * accepts (validators/kundli.validator.js matches them before this ever runs);
 * parseBirthDate/parseBirthTime throw on anything that doesn't fit, so a
 * malformed value is already impossible by the time this executes — this is
 * the semantic check the regex alone can't make.
 */
function parseAndValidateBirthMoment(dateOfBirth, timeOfBirth) {
  const dob = parseBirthDate(dateOfBirth);
  if (dob.getTime() > Date.now()) {
    throw ApiError.unprocessable('Date of birth must be in the past.', { dateOfBirth: 'Must be in the past.' });
  }
  const tob = parseBirthTime(timeOfBirth);
  return { dob, tob };
}

/**
 * How many of the 12 sections this exact birth doesn't have cached yet — the
 * precise number of credits the batch is actually about to risk spending, as
 * opposed to a flat "assume all 12" guess. Regenerating an already-cached
 * birth must never be blocked by the guard, since it wouldn't spend anything.
 */
async function countMissingSections(birthHash) {
  const cached = await KundliCache.find({ birthHash, endpoint: { $in: BATCH_ENDPOINTS } }, 'endpoint').lean();
  const cachedEndpoints = new Set(cached.map(row => row.endpoint));
  return BATCH_ENDPOINTS.filter(endpoint => !cachedEndpoints.has(endpoint)).length;
}

/**
 * Fires the 11-call batch for one birth, in parallel, tolerant of partial
 * failure. A failed section leaves nothing cached or billed for it (see
 * getKundliSection's own guarantee), so calling this again with the same
 * birthProfile only ever retries what's still missing — the successful
 * sections are never re-fetched or re-billed.
 *
 * The chart image goes through getChartImageUrl instead of a bare
 * getKundliSection — it's still fetched (and cached, and billed) exactly the
 * same way, but its SVG is also uploaded to storage right away, matching
 * "upload on the first fetch" rather than deferring that to whenever the
 * profile is first read.
 */
async function runBatch(birthProfile, origin) {
  const results = await Promise.allSettled(
    BATCH_ENDPOINTS.map(endpoint =>
      endpoint === CHART_ENDPOINT
        ? getChartImageUrl(birthProfile, origin)
        : getKundliSection(birthProfile, endpoint, null, undefined, BATCH_ENDPOINT_OPTIONS[endpoint]),
    ),
  );

  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length === 0) {
    return 'ready';
  }
  if (failures.length === results.length) {
    return 'failed';
  }
  return 'partial';
}

/**
 * POST /birth-profiles — creates the profile and generates its kundli in one
 * request.
 *
 * `placeId` must be an id /places/search actually returned; it is resolved
 * against GeoCache here, never trusted as raw coordinates from the request —
 * that is what makes "lat/lon only ever come from /geo_details" an enforced
 * rule. The decimal tzone is looked up fresh for THIS birth date (not
 * today's), since historical Indian offsets were not always +5:30.
 */
/**
 * Throws away the seeker's superseded charts: they generated a new one of their
 * own, so the older ones are for birth details they no longer claim.
 *
 * Only their own — `relation: 'self'`. A chart for someone they asked about (a
 * partner, a parent, whoever an astrologer generated for during a reading) is
 * not superseded by the seeker correcting their own birth time, and deleting it
 * would throw away a reading nobody asked to lose.
 *
 * KundliCache is deliberately left alone. Its rows are keyed by the birth moment
 * rather than by the profile, so they are shared with anyone else born at the
 * same moment and they are the record of credits already spent — deleting them
 * would mean paying AstrologyAPI again, and would also mean a seeker who put
 * their old birth details back paid twice for one chart. The chart SVG is stored
 * under the same birth-moment key for the same reason; only the profile's memory
 * of having uploaded it goes, and rebuilding that reads the cache, not the
 * provider.
 */
async function pruneSupersededSelfCharts(userId, keepId) {
  const { deletedCount } = await BirthProfile.deleteMany({
    user: userId,
    relation: 'self',
    _id: { $ne: keepId },
  });

  if (deletedCount > 0) {
    console.log(`[kundli] replaced ${deletedCount} superseded chart(s) for user ${userId}`);
  }
  return deletedCount;
}

/**
 * Writes the birth details a chart was actually cast from back onto the
 * seeker's own account.
 *
 * The form gives a place as text ("Aligarh"); the provider resolves it to
 * something else ("Aligarh, IN", with coordinates). Leaving the account holding
 * the typed version means the two records describe the same birth in two
 * different ways, and nothing downstream can tell that the chart on file IS the
 * chart for these details — which is exactly what left the Kundli tab offering
 * to generate a chart it had just generated.
 *
 * Only for the seeker's own chart ('self'), only when the seeker is the one who
 * asked (an astrologer generating during a consultation must not rewrite the
 * account's details from something they typed), and only the birth moment and
 * place — never the name or gender, which are the account's to set.
 */
async function syncOwnBirthDetails(userId, { dob, tob, place, timezone }) {
  await UserProfile.updateOne(
    { user: userId },
    {
      $set: {
        'birthDetails.dateOfBirth': dob,
        'birthDetails.timeOfBirth': tob,
        'birthDetails.place.formatted': place.formatted,
        'birthDetails.place.city': place.city,
        'birthDetails.place.country': place.country,
        'birthDetails.place.latitude': place.latitude,
        'birthDetails.place.longitude': place.longitude,
        ...(timezone ? { 'birthDetails.place.timezone': timezone } : {}),
      },
    },
  );
}

async function createBirthProfile(userId, input, origin, { asSeeker = false } = {}) {
  const { fullName, gender, label, relation, dateOfBirth, timeOfBirth, placeId } = input;

  const { dob, tob } = parseAndValidateBirthMoment(dateOfBirth, timeOfBirth);

  const place = await geoService.resolvePlaceById(placeId);
  if (!place) {
    throw ApiError.badRequest('Select a place from search results.', { placeId: 'Search for and select a place.' });
  }

  const isoDob = isoDateOf(dob);
  const { tzone } = await geoService.getTimezoneForDate(place.latitude, place.longitude, isoDob);

  const { ayanamsha } = env.astrologyApi;
  const birthHash = computeBirthHash({ dob: isoDob, tob, lat: place.latitude, lon: place.longitude, ayanamsha });

  /**
   * Upfront, precise check — counts what THIS birth is actually missing, not
   * a flat "assume all 12". A birth that's already fully cached (regenerating
   * an existing profile, or two people sharing a birth) must never be
   * refused here, since it wouldn't spend a credit. The exact spend is still
   * metered call-by-call inside getKundliSection regardless.
   */
  const missingSections = await countMissingSections(birthHash);
  if (missingSections > 0) {
    await assertCreditBudget(ASTROLOGY_API_PROVIDER, missingSections);
  }

  /**
   * The same birth, asked for again (the app re-checking after an edit that
   * turned out to change nothing, two family members sharing a birth moment,
   * a second device): reuse the profile that already exists rather than
   * stacking duplicates. Its sections are cached under the same `birthHash`
   * either way, so nothing is fetched or paid for twice — but a profile left
   * `pending`/`failed` by an earlier partial batch gets another run.
   */
  const isOwnChart = (relation || 'self') === 'self';

  const existing = await BirthProfile.findOne({ user: userId, birthHash, relation: relation || 'self' });
  if (existing) {
    if (existing.status !== 'ready') {
      existing.status = await runBatch(existing, origin);
      await existing.save();
    }
    /** Still worth syncing: this is the chart the account's details now point at. */
    if (asSeeker && isOwnChart) {
      await syncOwnBirthDetails(userId, { dob, tob, place, timezone: place.timezone });
      const replaced = await pruneSupersededSelfCharts(userId, existing._id);
      return { id: String(existing._id), status: existing.status, reused: true, replaced };
    }
    return { id: String(existing._id), status: existing.status, reused: true };
  }

  const profile = await BirthProfile.create({
    user: userId,
    label,
    relation,
    birthDetails: {
      fullName,
      gender,
      dateOfBirth: dob,
      timeOfBirth: tob,
      isBirthTimeKnown: true,
      place: {
        formatted: place.formatted,
        city: place.city,
        country: place.country,
        latitude: place.latitude,
        longitude: place.longitude,
        timezone: place.timezone,
      },
    },
    tzone,
    ayanamsha,
    birthHash,
    status: 'pending',
  });

  profile.status = await runBatch(profile, origin);
  await profile.save();

  if (asSeeker && isOwnChart) {
    await syncOwnBirthDetails(userId, { dob, tob, place, timezone: place.timezone });
    const replaced = await pruneSupersededSelfCharts(userId, profile._id);
    return { id: String(profile._id), status: profile.status, replaced };
  }

  return { id: String(profile._id), status: profile.status };
}

module.exports = {
  createBirthProfile,
  pruneSupersededSelfCharts,
  runBatch,
  countMissingSections,
  /** Exported so a caller can read the same birth moment this would store, rather than parsing it a second way. */
  parseAndValidateBirthMoment,
  BATCH_ENDPOINTS,
  SADHESATI_TTL_SECONDS,
};
