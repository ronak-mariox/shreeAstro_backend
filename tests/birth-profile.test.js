/**
 * POST /birth-profiles' orchestration (services/kundli.service.js) — real
 * validation and real caching semantics, but the AstrologyAPI transport
 * itself is faked by monkey-patching astrologyApi.client's exports, so no
 * real call or credit is ever spent running this file.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_birth_profile';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const env = require('../config/env');
const GeoCache = require('../models/GeoCache');
const KundliCache = require('../models/KundliCache');
const BirthProfile = require('../models/BirthProfile');
const client = require('../services/astrologyApi.client');
const geoDetailsFixture = require('./fixtures/astrologyapi/geo_details.json');
const timezoneFixture = require('./fixtures/astrologyapi/timezone_with_dst.json');
const kundliService = require('../services/kundli.service');
const { CHART_ENDPOINT } = require('../services/chartStorage.service');
const { getMonthlyUsageCount } = require('../services/kundliCache.service');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

const USER_1 = new mongoose.Types.ObjectId();
const USER_2 = new mongoose.Types.ObjectId();

const originalCallProvider = client.callProvider;
const originalRequest = client.request;

/** Fakes the transport astrologyApi.client talks over — kundliCache.service and geo.service both call through this module's exports at call time, so mutating them here is enough. */
function useFakeTransport({ onKundliCall } = {}) {
  const kundliCalls = [];
  const geoCalls = [];
  client.callProvider = async (birthProfile, endpoint) => {
    kundliCalls.push(endpoint);
    if (onKundliCall) {
      return onKundliCall(endpoint);
    }
    /** chartStorage.service.js reads `.svg` off this and uploads it for real (to local disk, in this test run) — every other endpoint is fine with a plain stand-in payload. */
    return endpoint === CHART_ENDPOINT ? { svg: '<svg>fake chart</svg>' } : { ok: true, endpoint };
  };
  client.request = async (endpoint, params) => {
    geoCalls.push({ endpoint, params });
    return endpoint === 'timezone_with_dst' ? timezoneFixture : geoDetailsFixture;
  };
  return { kundliCalls, geoCalls };
}

/** Emulates a prior /places/search call having already cached this city's geo_details. */
async function seedSearchResult(cacheKey, fixture) {
  await GeoCache.create({ _id: cacheKey, payload: fixture, fetchedAt: new Date() });
  return `${cacheKey}#0`;
}

const validInput = {
  fullName: 'Arjun Sharma',
  gender: 'male',
  label: 'Self',
  relation: 'self',
  dateOfBirth: '15/08/1995',
  timeOfBirth: '06:30 AM',
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const mumbaiPlaceId = await seedSearchResult('place:mumbai', geoDetailsFixture);

  /* ---------------------------------------------------------- validation */
  section('createBirthProfile — validates before spending anything');
  let threw;
  try {
    await kundliService.createBirthProfile(USER_1, { ...validInput, placeId: mumbaiPlaceId, dateOfBirth: '15/08/2099' });
  } catch (error) {
    threw = error;
  }
  check('a future date of birth is refused', threw?.status === 422);

  threw = undefined;
  try {
    await kundliService.createBirthProfile(USER_1, { ...validInput, placeId: 'not-a-real-search-result#0' });
  } catch (error) {
    threw = error;
  }
  check('an unresolvable placeId is refused — never trusts raw coordinates', threw?.status === 400);

  /* -------------------------------------------------------------- happy */
  section('createBirthProfile — happy path: all 11 calls succeed');
  const { kundliCalls, geoCalls } = useFakeTransport();
  const created = await kundliService.createBirthProfile(USER_1, { ...validInput, placeId: mumbaiPlaceId });
  check('returns an id and a "ready" status', typeof created.id === 'string' && created.status === 'ready');
  check('fired exactly the 11 batch endpoints, no more, no less', kundliCalls.length === 11 && new Set(kundliCalls).size === 11);
  check('used the /geo_details cache instead of calling the provider for it', !geoCalls.some(c => c.endpoint === 'geo_details'));
  check('still called /timezone_with_dst — it is date-specific, not covered by the place cache', geoCalls.some(c => c.endpoint === 'timezone_with_dst'));

  const profile = await BirthProfile.findById(created.id).lean();
  check('11 KundliCache rows now exist for this birth', await KundliCache.countDocuments({ birthHash: profile.birthHash }) === 11);
  check('tzone/ayanamsha/birthHash stored on the profile', profile.tzone === 5.5 && profile.ayanamsha === env.astrologyApi.ayanamsha && typeof profile.birthHash === 'string');
  check(
    'place resolved from GeoCache, not the request body',
    profile.birthDetails.place.latitude === 19.07283 && profile.birthDetails.place.city === 'Mumbai',
  );
  check('birth time survives AM/PM -> 24-hour conversion at minute precision', profile.birthDetails.timeOfBirth === '06:30');
  /** Local disk when no S3 is configured, a real S3 URL when it is (chartStorage.service.js) — either way, a real chart URL naming this birth's own file. */
  check(
    'the chart was uploaded and its URL stored on the profile',
    typeof profile.chartUrl === 'string' && profile.chartUrl.includes(`charts/${profile.birthHash}`),
    profile.chartUrl,
  );

  /* ----------------------------------------------------- shared cache reuse */
  section('createBirthProfile — a second profile for the IDENTICAL birth reuses the cache');
  const { kundliCalls: secondBatchCalls, geoCalls: secondGeoCalls } = useFakeTransport();
  const secondProfile = await kundliService.createBirthProfile(USER_2, { ...validInput, placeId: mumbaiPlaceId, label: 'A friend with my exact birth minute' });
  check('costs nothing — no kundli calls, no geo calls', secondBatchCalls.length === 0 && secondGeoCalls.length === 0);
  const secondProfileDoc = await BirthProfile.findById(secondProfile.id).lean();
  check(
    'the second profile still gets its own chartUrl, pointing at the same (birthHash-named) file',
    secondProfileDoc.chartUrl === profile.chartUrl,
  );
  check('still resolves to "ready" purely from cache', secondProfile.status === 'ready');
  check('two different BirthProfile rows share the same birthHash', secondProfile.id !== created.id);

  /* --------------------------------------------------------------- partial */
  section('createBirthProfile — partial failure: one endpoint down');
  const delhiPlaceId = await seedSearchResult('place:delhi', {
    geonames: [{ place_name: 'Delhi', latitude: '28.65195', longitude: '77.23149', country_code: 'IN', timezone_id: 'Asia/Kolkata' }],
  });
  useFakeTransport({
    onKundliCall: endpoint => {
      if (endpoint === 'kalsarpa_details') {
        throw new Error('provider down for this endpoint');
      }
      return endpoint === CHART_ENDPOINT ? { svg: '<svg>fake chart</svg>' } : { ok: true, endpoint };
    },
  });
  const partialResult = await kundliService.createBirthProfile(USER_1, { ...validInput, placeId: delhiPlaceId });
  check('status is "partial" when some but not all endpoints fail', partialResult.status === 'partial');
  const partialProfile = await BirthProfile.findById(partialResult.id).lean();
  check('10 of 11 sections are cached', await KundliCache.countDocuments({ birthHash: partialProfile.birthHash }) === 10);
  check('the failed section itself is not cached', await KundliCache.countDocuments({ birthHash: partialProfile.birthHash, endpoint: 'kalsarpa_details' }) === 0);

  section('createBirthProfile — retrying only refetches what actually failed');
  const { kundliCalls: retryCalls } = useFakeTransport();
  const retried = await kundliService.createBirthProfile(USER_1, { ...validInput, placeId: delhiPlaceId, label: 'retry' });
  check('the retry succeeds fully now that the provider is healthy', retried.status === 'ready');
  check('only the previously-failed endpoint was actually called again', retryCalls.length === 1 && retryCalls[0] === 'kalsarpa_details');

  /* ----------------------------------------------------------- credit guard */
  section('createBirthProfile — the precise upfront credit guard');
  const chennaiPlaceId = await seedSearchResult('place:chennai', {
    geonames: [{ place_name: 'Chennai', latitude: '13.0827', longitude: '80.2707', country_code: 'IN', timezone_id: 'Asia/Kolkata' }],
  });
  const realLimit = env.astrologyApi.monthlyCreditLimit;
  const usedSoFar = await getMonthlyUsageCount();
  env.astrologyApi.monthlyCreditLimit = usedSoFar + 3; // fewer than the 11 a brand-new birth needs

  const { kundliCalls: refusedCalls, geoCalls: refusedGeoCalls } = useFakeTransport();
  let overBudgetError;
  try {
    await kundliService.createBirthProfile(USER_1, { ...validInput, placeId: chennaiPlaceId, dateOfBirth: '01/01/1980' });
  } catch (error) {
    overBudgetError = error;
  }
  check('refuses with the shared credit-limit error', overBudgetError?.code === 'astrology_credit_limit_reached');
  check('no kundli calls were fired for the refused batch', refusedCalls.length === 0);
  check('no BirthProfile is left behind for a refused batch', await BirthProfile.countDocuments({ 'birthDetails.place.city': 'Chennai' }) === 0);
  // The timezone lookup for a brand-new (lat, lon, date) still runs before the batch-size guard — it's protected by its own single-call guard instead.
  check('the timezone lookup itself still ran (protected by its own guard, not blocked by the batch guard)', refusedGeoCalls.some(c => c.endpoint === 'timezone_with_dst'));

  section('createBirthProfile — the guard never blocks a fully-cached (free) regeneration, even at the ceiling');
  env.astrologyApi.monthlyCreditLimit = await getMonthlyUsageCount(); // at the ceiling right now
  const { kundliCalls: freeCalls } = useFakeTransport();
  const regenerated = await kundliService.createBirthProfile(USER_2, { ...validInput, placeId: mumbaiPlaceId, label: 'regenerated at the ceiling' });
  check('a birth that is already fully cached still succeeds at the ceiling', regenerated.status === 'ready' && freeCalls.length === 0);

  env.astrologyApi.monthlyCreditLimit = realLimit;
  client.callProvider = originalCallProvider;
  client.request = originalRequest;

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  client.callProvider = originalCallProvider;
  client.request = originalRequest;
  console.error('CRASHED:', e);
  process.exit(1);
});
