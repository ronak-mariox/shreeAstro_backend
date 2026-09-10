/**
 * The geo-lookup choke point, proven against a fake provider seeded with the
 * REAL captured response shape (tests/fixtures/astrologyapi/geo_details.json
 * and timezone_with_dst.json) — no real AstrologyAPI call happens in this
 * file itself.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_geo_cache';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const env = require('../config/env');
const GeoCache = require('../models/GeoCache');
const ApiUsage = require('../models/ApiUsage');
const geoService = require('../services/geo.service');
const { getMonthlyUsageCount } = require('../services/kundliCache.service');
const mumbaiFixture = require('./fixtures/astrologyapi/geo_details.json');
const timezoneFixture = require('./fixtures/astrologyapi/timezone_with_dst.json');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

function fakeProvider(response) {
  const calls = [];
  const fn = async (endpoint, params) => {
    calls.push({ endpoint, params });
    return response ?? mumbaiFixture;
  };
  fn.calls = calls;
  return fn;
}

const delhiFixture = {
  geonames: [{ place_name: 'Delhi', latitude: '28.65195', longitude: '77.23149', country_code: 'IN', timezone_id: 'Asia/Kolkata' }],
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  /* --------------------------------------------------------------- search */
  section('searchPlaces — cache miss then hit');
  const provider1 = fakeProvider();
  const first = await geoService.searchPlaces('  Mumbai,  Maharashtra ', provider1);
  check('a miss calls the provider once', provider1.calls.length === 1);
  check(
    'only the text before the comma is sent — a bare state suffix returned zero real results',
    provider1.calls[0].params.place === 'Mumbai' && provider1.calls[0].params.maxRows === 10,
  );
  check(
    'returns a normalised list built from the real field names (place_name/country_code/timezone_id), not the raw shape',
    Array.isArray(first) &&
      first[0].city === 'Mumbai' &&
      first[0].country === 'IN' &&
      first[0].latitude === 19.07283 &&
      first[0].timezone === 'Asia/Kolkata' &&
      first[0].formatted === 'Mumbai, IN',
  );

  const second = await geoService.searchPlaces('mumbai', provider1);
  check('different case for the same city is still a cache hit', provider1.calls.length === 1);
  check('the hit returns the same normalised result', JSON.stringify(second) === JSON.stringify(first));

  const third = await geoService.searchPlaces('Mumbai, Maharashtra', provider1);
  check('a "City, State" query for the same city also lands on the same cache row', provider1.calls.length === 1 && JSON.stringify(third) === JSON.stringify(first));

  const provider2 = fakeProvider(delhiFixture);
  const delhi = await geoService.searchPlaces('Delhi', provider2);
  check('a different city is a fresh miss', provider2.calls.length === 1);
  check('cities are cached independently', delhi[0].city === 'Delhi');

  section('searchPlaces — refuses before touching the provider on an unusably short query');
  const shortProvider = fakeProvider();
  const empty = await geoService.searchPlaces('m', shortProvider);
  check('a 1-character query short-circuits to an empty list', Array.isArray(empty) && empty.length === 0);
  check('no credit is spent on a query too short to search', shortProvider.calls.length === 0);

  /** Not a guess — a real 2-character query 405'd against the live provider: "place length must be at least 3 characters long". */
  const twoCharProvider = fakeProvider();
  const twoChar = await geoService.searchPlaces('Mu', twoCharProvider);
  check('a 2-character query also short-circuits — the provider itself refuses under 3', Array.isArray(twoChar) && twoChar.length === 0 && twoCharProvider.calls.length === 0);

  const commaOnlyProvider = fakeProvider();
  const commaOnly = await geoService.searchPlaces('m, Maharashtra', commaOnlyProvider);
  check('a query whose pre-comma text is itself too short also short-circuits', Array.isArray(commaOnly) && commaOnly.length === 0 && commaOnlyProvider.calls.length === 0);

  section('searchPlaces — an empty result from the provider (a real, observed response) is handled cleanly');
  const noMatchProvider = fakeProvider({ geonames: [] });
  const noMatch = await geoService.searchPlaces('Nonexistentville', noMatchProvider);
  check('returns an empty array, not a crash', Array.isArray(noMatch) && noMatch.length === 0);

  /* ---------------------------------------------------------------- usage */
  section('searchPlaces — usage is logged once per real call, never on a hit');
  const usageBefore = await getMonthlyUsageCount();
  await geoService.searchPlaces('Mumbai', fakeProvider()); // same cache key as the very first search above -> hit
  const usageAfter = await getMonthlyUsageCount();
  check('a cache hit logs no usage', usageAfter === usageBefore);

  /* ---------------------------------------------------------- timezone */
  section('getTimezoneForDate — cached per (lat, lon, date), not per place');
  const tzProvider = fakeProvider(timezoneFixture);
  const tz1 = await geoService.getTimezoneForDate(19.07283, 72.88261, '1995-08-15', tzProvider);
  check('normalises the real { timezone: 5.5, ... } shape to { tzone: 5.5 }', tz1.tzone === 5.5);
  check(
    'a miss calls the provider with latitude/longitude/date',
    tzProvider.calls[0].params.latitude === 19.07283 && tzProvider.calls[0].params.date === '1995-08-15',
  );

  const tz2 = await geoService.getTimezoneForDate(19.07283, 72.88261, '1995-08-15', tzProvider);
  check('the identical (lat, lon, date) is a cache hit', tzProvider.calls.length === 1 && tz2.tzone === 5.5);

  const historicalTzProvider = fakeProvider({ status: true, timezone: 5.53, timezone_in_ms: 19908000, date: '1950-01-01T12:00:00.000Z' });
  const tz3 = await geoService.getTimezoneForDate(19.07283, 72.88261, '1950-01-01', historicalTzProvider);
  check('a different DATE at the same coordinates is a fresh lookup (historical offsets can differ)', historicalTzProvider.calls.length === 1 && tz3.tzone === 5.53);

  /* ------------------------------------------------------ shared credit guard */
  section('the geo choke point shares the same credit guard as kundli calls');
  const realLimit = env.astrologyApi.monthlyCreditLimit;
  const usedSoFar = await getMonthlyUsageCount();
  env.astrologyApi.monthlyCreditLimit = usedSoFar;

  const overBudgetProvider = fakeProvider();
  let threw = null;
  try {
    await geoService.searchPlaces('Chennai', overBudgetProvider);
  } catch (error) {
    threw = error;
  }
  check('over budget, a geo lookup refuses too, before calling the provider', threw?.code === 'astrology_credit_limit_reached');
  check('the provider is never called once the shared budget is exhausted', overBudgetProvider.calls.length === 0);

  env.astrologyApi.monthlyCreditLimit = realLimit;

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
