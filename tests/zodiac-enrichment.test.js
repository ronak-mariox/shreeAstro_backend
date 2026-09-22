/**
 * enrichZodiacFromBirthDetails and getHome's use of the real Moon sign it
 * persists — real caching semantics, but the AstrologyAPI transport itself is
 * faked (same technique as birth-profile.test.js), so no real call or credit
 * is ever spent running this file.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_zodiac_enrichment';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const env = require('../config/env');
const User = require('../models/User');
const UserProfile = require('../models/UserProfile');
const GeoCache = require('../models/GeoCache');
const KundliCache = require('../models/KundliCache');
const client = require('../services/astrologyApi.client');
const geoDetailsFixture = require('./fixtures/astrologyapi/geo_details.json');
const timezoneFixture = require('./fixtures/astrologyapi/timezone_with_dst.json');
const astroDetailsFixture = require('./fixtures/astrologyapi/astro_details.json');
const userService = require('../services/user.service');
const { getMonthlyUsageCount } = require('../services/kundliCache.service');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

const originalRequest = client.request;
/** Fakes the transport astrologyApi.client talks over — both geo.service and kundliCache.service call through this module's exports at call time. */
function useFakeTransport() {
  const calls = [];
  client.request = async (path, params) => {
    calls.push({ path, params });
    if (path === 'timezone_with_dst') return timezoneFixture;
    if (path === 'astro_details') return astroDetailsFixture;
    return geoDetailsFixture;
  };
  return calls;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  /* ------------------------------------------------------------------ happy */
  section('enrichZodiacFromBirthDetails — resolves and persists the real Moon sign');
  const user = await User.create({ name: 'Arjun Sharma', email: 'arjun@example.com', phone: { countryCode: '+91', number: '9876543210' } });
  const profile = await UserProfile.create({
    user: user._id,
    fullName: 'Arjun Sharma',
    birthDetails: {
      dateOfBirth: new Date('1995-08-15T00:00:00.000Z'),
      timeOfBirth: '06:30',
      place: { formatted: 'Mumbai, Maharashtra' },
    },
  });

  const calls = useFakeTransport();
  await userService.enrichZodiacFromBirthDetails(user._id);
  check('geocoded the typed place text', calls.some(c => c.path === 'geo_details'));
  check('resolved a timezone for that date', calls.some(c => c.path === 'timezone_with_dst'));
  check('fetched astro_details only — never the full 12-call batch', calls.filter(c => c.path === 'astro_details').length === 1);
  check(
    'only 3 provider calls total for this whole enrichment',
    calls.length === 3,
    calls.map(c => c.path),
  );

  const enriched = await UserProfile.findById(profile._id).lean();
  check('persisted the real Moon sign from astro_details', enriched.zodiac.moonSign === 'Pisces');
  check('persisted the ascendant (lagna)', enriched.zodiac.ascendant === 'Cancer');
  check('persisted the nakshatra', enriched.zodiac.nakshatra === 'Revati');
  check('also persisted the Sun sign from the local DOB utility (Aug 15 -> Leo)', enriched.zodiac.sunSign === 'Leo');
  check('stamped computedAt', enriched.zodiac.computedAt instanceof Date);

  /* -------------------------------------------------------------------- cached */
  section('enrichZodiacFromBirthDetails — a second run for the same birth is free');
  const secondCalls = useFakeTransport();
  const secondUser = await User.create({ name: 'Sameer Kapoor', email: 'sameer@example.com', phone: { countryCode: '+91', number: '9876500000' } });
  const secondProfile = await UserProfile.create({
    user: secondUser._id,
    fullName: 'Sameer Kapoor',
    birthDetails: {
      // Identical birth to the first user — same GeoCache row, same KundliCache row.
      dateOfBirth: new Date('1995-08-15T00:00:00.000Z'),
      timeOfBirth: '06:30',
      place: { formatted: 'Mumbai, Maharashtra' },
    },
  });
  await userService.enrichZodiacFromBirthDetails(secondUser._id);
  check('no provider call at all — everything came from GeoCache/KundliCache', secondCalls.length === 0);
  const secondEnriched = await UserProfile.findById(secondProfile._id).lean();
  check('still gets the correct Moon sign, purely from cache', secondEnriched.zodiac.moonSign === 'Pisces');

  /* -------------------------------------------------------------- getHome wiring */
  section('getHome — the rashi and horoscope both come from the enriched Moon sign');
  const horoscopeCalls = useFakeTransport();
  const home = await userService.getHome(user._id);
  check('profile.moonSign is the real Moon sign, Title Cased already', home.profile.moonSign === 'Pisces');
  check('the daily horoscope reading is fetched for that same sign', home.horoscope !== null && typeof home.horoscope.reading === 'string');
  check('no stale "sunSign" field survives on the response', !('sunSign' in home.profile));
  void horoscopeCalls;

  /* --------------------------------------------------------------- unresolvable */
  section('enrichZodiacFromBirthDetails — a place that cannot be geocoded is a silent no-op');
  const thirdUser = await User.create({ name: 'No Place', email: 'noplace@example.com', phone: { countryCode: '+91', number: '9876511111' } });
  await UserProfile.create({
    user: thirdUser._id,
    fullName: 'No Place',
    birthDetails: {
      dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
      timeOfBirth: '10:00',
      place: { formatted: 'Nowhere Land' },
    },
  });
  const emptyGeoCalls = useFakeTransport();
  client.request = async path => (path === 'geo_details' ? { geonames: [] } : geoDetailsFixture);
  let threw = null;
  try {
    await userService.enrichZodiacFromBirthDetails(thirdUser._id);
  } catch (error) {
    threw = error;
  }
  check('never throws', threw === null);
  const thirdProfile = await UserProfile.findOne({ user: thirdUser._id }).lean();
  check('zodiac stays empty rather than partially written', thirdProfile.zodiac?.moonSign === undefined);
  void emptyGeoCalls;

  /* ---------------------------------------------------------------- home fallback */
  section('getHome — no rashi yet means no horoscope, and no misleading Sun-sign guess');
  const thirdHome = await userService.getHome(thirdUser._id);
  check('profile.moonSign is undefined, not a Sun-sign guess', thirdHome.profile.moonSign === undefined);
  check('horoscope is null, not a wrongly-labelled reading', thirdHome.horoscope === null);

  /* ------------------------------------------------------------- credit sharing */
  section('enrichZodiacFromBirthDetails — shares the same credit budget as kundli generation');
  const realLimit = env.astrologyApi.monthlyCreditLimit;
  const usedSoFar = await getMonthlyUsageCount();
  env.astrologyApi.monthlyCreditLimit = usedSoFar;

  const fourthUser = await User.create({ name: 'Over Budget', email: 'overbudget@example.com', phone: { countryCode: '+91', number: '9876522222' } });
  await UserProfile.create({
    user: fourthUser._id,
    fullName: 'Over Budget',
    birthDetails: {
      dateOfBirth: new Date('1985-05-05T00:00:00.000Z'),
      timeOfBirth: '05:05',
      place: { formatted: 'Chennai, Tamil Nadu' },
    },
  });
  const overBudgetCalls = useFakeTransport();
  let overBudgetThrew = null;
  try {
    await userService.enrichZodiacFromBirthDetails(fourthUser._id);
  } catch (error) {
    overBudgetThrew = error;
  }
  check('never throws even when the shared budget is exhausted', overBudgetThrew === null);
  const fourthProfile = await UserProfile.findOne({ user: fourthUser._id }).lean();
  check('nothing persisted for a refused enrichment', fourthProfile.zodiac?.moonSign === undefined);
  void overBudgetCalls;

  env.astrologyApi.monthlyCreditLimit = realLimit;
  client.request = originalRequest;

  /* ------------------------------------------------------ re-enrichment on edit */
  section('a birth-detail edit naturally busts the cache and re-enriches, with no explicit invalidation step');
  /**
   * Mirrors controllers/user.controller.js's updateProfile handler: after
   * userService.updateProfile saves a changed dob/time/place, it fires
   * enrichZodiacFromBirthDetails again. The new birth details produce a
   * different birthHash (utils/birthHash.js), which is simply a fresh
   * cache-miss under that hash — no KundliCache row is ever deleted.
   */
  const editUser = await User.create({ name: 'Edited Birth', email: 'editedbirth@example.com', phone: { countryCode: '+91', number: '9876533333' } });
  await UserProfile.create({
    user: editUser._id,
    fullName: 'Edited Birth',
    birthDetails: {
      dateOfBirth: new Date('1995-08-15T00:00:00.000Z'),
      timeOfBirth: '06:30',
      place: { formatted: 'Mumbai, Maharashtra' },
    },
  });
  useFakeTransport();
  await userService.enrichZodiacFromBirthDetails(editUser._id);
  const beforeEdit = await UserProfile.findOne({ user: editUser._id }).lean();
  check('starts with the Mumbai birth\'s real Moon sign', beforeEdit.zodiac.moonSign === 'Pisces');
  const kundliRowsBeforeEdit = await KundliCache.countDocuments({});

  await userService.updateProfile(editUser._id, {
    dateOfBirth: '01/01/1990',
    timeOfBirth: '12:00 PM',
    placeOfBirth: 'Delhi, India',
  });

  /** A different sign this time, so the test can actually tell the two enrichments apart. */
  const differentSignCalls = [];
  client.request = async (path, params) => {
    differentSignCalls.push({ path, params });
    if (path === 'timezone_with_dst') return timezoneFixture;
    if (path === 'astro_details') return { ...astroDetailsFixture, ascendant: 'Aries', sign: 'Scorpio' };
    return geoDetailsFixture;
  };
  /** The same fire-and-forget call controllers/user.controller.js's updateProfile handler makes after a birth-detail change. */
  await userService.enrichZodiacFromBirthDetails(editUser._id);

  check('the new birth was geocoded fresh — a different place, a different GeoCache key', differentSignCalls.some(c => c.path === 'geo_details'));
  check('astro_details was fetched again — the new birthHash was a genuine cache miss, not reused from the old birth', differentSignCalls.filter(c => c.path === 'astro_details').length === 1);
  check('a new KundliCache row was added rather than the old one being mutated', await KundliCache.countDocuments({}) === kundliRowsBeforeEdit + 1);

  const afterEdit = await UserProfile.findOne({ user: editUser._id }).lean();
  check('the persisted Moon sign now reflects the NEW birth, not the stale Mumbai one', afterEdit.zodiac.moonSign === 'Scorpio');
  check('ascendant also updated', afterEdit.zodiac.ascendant === 'Aries');
  check('computedAt moved forward', afterEdit.zodiac.computedAt.getTime() > beforeEdit.zodiac.computedAt.getTime());

  client.request = originalRequest;

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  client.request = originalRequest;
  console.error('CRASHED:', e);
  process.exit(1);
});
