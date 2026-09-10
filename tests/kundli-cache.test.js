/**
 * The choke point, proven against a fake provider — no real AstrologyAPI call
 * happens anywhere in this file. That's deliberate: with 150 total credits on
 * the plan, caching has to be correct and tested *before* a real client
 * exists to spend any of them.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_kundli_cache';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const env = require('../config/env');
const KundliCache = require('../models/KundliCache');
const ApiUsage = require('../models/ApiUsage');
const { getKundliSection, getCachedKundliSection, assertCreditBudget, getMonthlyUsageCount } = require('../services/kundliCache.service');
const { computeBirthHash } = require('../utils/birthHash');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

/** A fake provider that counts its own calls and answers with a distinct payload per call. */
function fakeProvider() {
  const calls = [];
  const fn = async (birthProfile, endpoint, pathParam) => {
    calls.push({ birthProfile, endpoint, pathParam });
    return { fromProvider: true, endpoint, pathParam: pathParam ?? null, callNumber: calls.length };
  };
  fn.calls = calls;
  return fn;
}

/** A fake provider that always rejects, to prove a failure never gets cached or billed. */
function failingProvider(message = 'provider exploded') {
  const calls = [];
  const fn = async () => {
    calls.push(true);
    throw new Error(message);
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  /** dropDatabase also drops indexes; Mongoose rebuilds them in the background, so the race test below needs this awaited or the unique index isn't there yet to catch the race. */
  await KundliCache.init();

  /* ------------------------------------------------------------- birth hash */
  section('computeBirthHash');
  const hashA = computeBirthHash({ dob: '1995-08-15', tob: '06:30', lat: 19.075983, lon: 72.877655, ayanamsha: 'lahiri' });
  const hashB = computeBirthHash({ dob: '1995-08-15', tob: '06:30', lat: 19.0759831, lon: 72.8776552, ayanamsha: 'lahiri' });
  const hashDifferentPlace = computeBirthHash({ dob: '1995-08-15', tob: '06:30', lat: 28.6139, lon: 77.2090, ayanamsha: 'lahiri' });
  const hashDifferentTime = computeBirthHash({ dob: '1995-08-15', tob: '06:34', lat: 19.075983, lon: 72.877655, ayanamsha: 'lahiri' });
  check('is deterministic', hashA === computeBirthHash({ dob: '1995-08-15', tob: '06:30', lat: 19.075983, lon: 72.877655, ayanamsha: 'lahiri' }));
  check('rounds lat/lon to 4 decimals, so an 8th-decimal geocode drift still hits the same hash', hashA === hashB);
  check('a different place changes the hash', hashA !== hashDifferentPlace);
  check('a 4-minute time difference changes the hash (ascendant-sensitive)', hashA !== hashDifferentTime);

  /* --------------------------------------------------------------- cache hit/miss */
  section('getKundliSection — cache miss then hit');
  const birthArjun = { birthHash: computeBirthHash({ dob: '1995-08-15', tob: '06:30', lat: 19.075983, lon: 72.877655, ayanamsha: 'lahiri' }) };
  const provider1 = fakeProvider();

  const first = await getKundliSection(birthArjun, 'astro_details', null, provider1);
  check('a miss calls the provider', provider1.calls.length === 1);
  check('a miss returns the provider payload', first.fromProvider === true && first.endpoint === 'astro_details');
  check('a miss writes exactly one cache row', await KundliCache.countDocuments({ birthHash: birthArjun.birthHash, endpoint: 'astro_details' }) === 1);
  check('a miss logs exactly one usage row', await ApiUsage.countDocuments({ birthHash: birthArjun.birthHash, endpoint: 'astro_details' }) === 1);

  const second = await getKundliSection(birthArjun, 'astro_details', null, provider1);
  check('a hit does not call the provider again', provider1.calls.length === 1);
  check('a hit returns the exact cached payload', JSON.stringify(second) === JSON.stringify(first));
  check('a hit logs no additional usage (free)', await ApiUsage.countDocuments({ birthHash: birthArjun.birthHash, endpoint: 'astro_details' }) === 1);

  /* --------------------------------------------------------- cache key shape */
  section('getKundliSection — the cache key is (birthHash, endpoint, pathParam)');
  const provider2 = fakeProvider();
  await getKundliSection(birthArjun, 'planets/extended', null, provider2);
  check('a different endpoint, same birth, is a fresh miss', provider2.calls.length === 1);
  check('endpoints are cached independently', await KundliCache.countDocuments({ birthHash: birthArjun.birthHash }) === 2);

  const birthOther = { birthHash: computeBirthHash({ dob: '1990-01-01', tob: '12:00', lat: 28.6139, lon: 77.2090, ayanamsha: 'lahiri' }) };
  const provider3 = fakeProvider();
  await getKundliSection(birthOther, 'astro_details', null, provider3);
  check('a different birth, same endpoint, is a fresh miss', provider3.calls.length === 1);
  check("one birth's cache never answers another birth's request", provider1.calls.length === 1);

  const providerJupiter = fakeProvider();
  const providerSaturn = fakeProvider();
  const jupiterSub = await getKundliSection(birthArjun, 'sub_vdasha', 'Jupiter', providerJupiter);
  const saturnSub = await getKundliSection(birthArjun, 'sub_vdasha', 'Saturn', providerSaturn);
  check('pathParam separates the lazy antardasha cache per mahadasha lord', providerJupiter.calls.length === 1 && providerSaturn.calls.length === 1);
  check('each lord gets its own row', await KundliCache.countDocuments({ birthHash: birthArjun.birthHash, endpoint: 'sub_vdasha' }) === 2);
  check('the two lords do not share a payload', JSON.stringify(jupiterSub) !== JSON.stringify(saturnSub));

  const providerJupiterAgain = fakeProvider();
  await getKundliSection(birthArjun, 'sub_vdasha', 'Jupiter', providerJupiterAgain);
  check('re-asking for the same lord is a cache hit', providerJupiterAgain.calls.length === 0);

  /* ------------------------------------------------------------- partial failure */
  section('getKundliSection — a failed call is never cached or billed');
  const birthFailure = { birthHash: computeBirthHash({ dob: '2000-06-06', tob: '18:45', lat: 12.9716, lon: 77.5946, ayanamsha: 'lahiri' }) };
  const badProvider = failingProvider('astrologyapi is down');
  let threw = null;
  try {
    await getKundliSection(birthFailure, 'kalsarpa_details', null, badProvider);
  } catch (error) {
    threw = error;
  }
  check('the rejection propagates to the caller', threw?.message === 'astrologyapi is down');
  check('nothing is cached for a failed call', await KundliCache.countDocuments({ birthHash: birthFailure.birthHash }) === 0);
  check('no credit is logged for a failed call', await ApiUsage.countDocuments({ birthHash: birthFailure.birthHash }) === 0);

  const goodProvider = fakeProvider();
  await getKundliSection(birthFailure, 'pitra_dosha_report', null, goodProvider);
  check('a sibling endpoint for the same birth still succeeds and caches independently', await KundliCache.countDocuments({ birthHash: birthFailure.birthHash }) === 1);

  const retryProvider = fakeProvider();
  await getKundliSection(birthFailure, 'kalsarpa_details', null, retryProvider);
  check('retrying only the failed endpoint succeeds without touching the sibling', retryProvider.calls.length === 1 && await KundliCache.countDocuments({ birthHash: birthFailure.birthHash }) === 2);

  /* ------------------------------------------------------------------- race */
  section('getKundliSection — two simultaneous misses for the identical key');
  const birthRace = { birthHash: computeBirthHash({ dob: '1988-03-03', tob: '09:09', lat: 22.5726, lon: 88.3639, ayanamsha: 'lahiri' }) };
  const raceProvider = fakeProvider();
  const [raceA, raceB] = await Promise.all([
    getKundliSection(birthRace, 'astro_details', null, raceProvider),
    getKundliSection(birthRace, 'astro_details', null, raceProvider),
  ]);
  check('neither concurrent call throws', raceA !== undefined && raceB !== undefined);
  check('the race still leaves exactly one cache row (the unique index wins, not a crash)', await KundliCache.countDocuments({ birthHash: birthRace.birthHash, endpoint: 'astro_details' }) === 1);

  /* ------------------------------------------------------------- credit guard */
  section('assertCreditBudget / the credit guard inside getKundliSection');
  const realLimit = env.astrologyApi.monthlyCreditLimit;
  const usedSoFar = await getMonthlyUsageCount();
  env.astrologyApi.monthlyCreditLimit = usedSoFar;

  let guardThrew = null;
  try {
    await assertCreditBudget();
  } catch (error) {
    guardThrew = error;
  }
  check('the guard refuses once usage has reached the ceiling', guardThrew?.status === 429 && guardThrew?.code === 'astrology_credit_limit_reached');

  const birthOverBudget = { birthHash: computeBirthHash({ dob: '1975-11-11', tob: '02:02', lat: 13.0827, lon: 80.2707, ayanamsha: 'lahiri' }) };
  const shouldNotBeCalled = fakeProvider();
  let sectionThrew = null;
  try {
    await getKundliSection(birthOverBudget, 'astro_details', null, shouldNotBeCalled);
  } catch (error) {
    sectionThrew = error;
  }
  check('over budget, getKundliSection refuses before touching the provider', sectionThrew?.code === 'astrology_credit_limit_reached');
  check('the provider is never called once the budget is exhausted', shouldNotBeCalled.calls.length === 0);
  check('nothing is cached or billed for a refused call', await KundliCache.countDocuments({ birthHash: birthOverBudget.birthHash }) === 0);

  env.astrologyApi.monthlyCreditLimit = usedSoFar + 1;
  const provider4 = fakeProvider();
  await getKundliSection(birthOverBudget, 'astro_details', null, provider4);
  check('raising the ceiling lets the very next call through', provider4.calls.length === 1);

  env.astrologyApi.monthlyCreditLimit = realLimit;

  /* --------------------------------------------------- cache-only, no fallback */
  section('getCachedKundliSection — a look, never a call (the AI assistant\'s door)');
  const birthAssistant = { birthHash: computeBirthHash({ dob: '1999-02-08', tob: '22:30', lat: 26.8467, lon: 80.9462, ayanamsha: 'lahiri' }) };

  let missThrew = null;
  try {
    await getCachedKundliSection(birthAssistant, 'astro_details');
  } catch (error) {
    missThrew = error;
  }
  check('a miss throws 404 kundli_section_not_cached', missThrew?.status === 404 && missThrew?.code === 'kundli_section_not_cached');
  check('a miss writes no cache row', await KundliCache.countDocuments({ birthHash: birthAssistant.birthHash }) === 0);
  check('a miss logs no usage — this door cannot spend a credit even on a miss', await ApiUsage.countDocuments({ birthHash: birthAssistant.birthHash }) === 0);

  await KundliCache.create({
    birthHash: birthAssistant.birthHash,
    endpoint: 'astro_details',
    pathParam: null,
    payload: { ascendant: 'Aquarius' },
    provider: 'astrologyapi',
    fetchedAt: new Date(),
  });
  const hit = await getCachedKundliSection(birthAssistant, 'astro_details');
  check('a hit returns the cached payload', hit.ascendant === 'Aquarius');
  check('a hit still logs no usage — reading a cache hit was always free', await ApiUsage.countDocuments({ birthHash: birthAssistant.birthHash }) === 0);

  const overLimitAtTheTime = env.astrologyApi.monthlyCreditLimit;
  env.astrologyApi.monthlyCreditLimit = 0;
  let stillThrew = null;
  try {
    await getCachedKundliSection(birthAssistant, 'planets/extended');
  } catch (error) {
    stillThrew = error;
  }
  check('a miss reports plainly as "not cached", not as a credit-limit refusal — the two errors must never be confused', stillThrew?.code === 'kundli_section_not_cached');
  env.astrologyApi.monthlyCreditLimit = overLimitAtTheTime;

  /* --------------------------------------------------------------- TTL cache */
  section('getKundliSection — a ttlSeconds row (sadhesati) refreshes once stale, and stays permanent-hit before then');
  const birthTtl = { birthHash: computeBirthHash({ dob: '1985-05-05', tob: '05:05', lat: 17.385, lon: 78.4867, ayanamsha: 'lahiri' }) };
  const ttlProvider1 = fakeProvider();
  const freshRow = await getKundliSection(birthTtl, 'sadhesati_current_status', null, ttlProvider1, { ttlSeconds: 60 });
  check('first fetch calls the provider and stores it as a ttl row', ttlProvider1.calls.length === 1 && freshRow.fromProvider === true);
  const storedFresh = await KundliCache.findOne({ birthHash: birthTtl.birthHash, endpoint: 'sadhesati_current_status' }).lean();
  check('cachePolicy/ttlSeconds are recorded on the row', storedFresh.cachePolicy === 'ttl' && storedFresh.ttlSeconds === 60);

  const ttlProvider2 = fakeProvider();
  await getKundliSection(birthTtl, 'sadhesati_current_status', null, ttlProvider2, { ttlSeconds: 60 });
  check('well within the 60s ttl, this is a plain hit — no refresh attempted', ttlProvider2.calls.length === 0);

  /** Backdate fetchedAt past the ttl window without touching anything else — simulates 60s having passed. */
  await KundliCache.updateOne(
    { birthHash: birthTtl.birthHash, endpoint: 'sadhesati_current_status' },
    { $set: { fetchedAt: new Date(Date.now() - 61 * 1000) } },
  );
  const ttlProviderRefresh = fakeProvider();
  const refreshed = await getKundliSection(birthTtl, 'sadhesati_current_status', null, ttlProviderRefresh, { ttlSeconds: 60 });
  check('past the ttl, a refresh is attempted', ttlProviderRefresh.calls.length === 1);
  check('the refreshed payload is the new one, not the old', refreshed.callNumber === 1 && refreshed.fromProvider === true);
  check('still exactly one row — the refresh updates in place, never inserts a second', await KundliCache.countDocuments({ birthHash: birthTtl.birthHash, endpoint: 'sadhesati_current_status' }) === 1);
  const usageAfterRefresh = await ApiUsage.countDocuments({ birthHash: birthTtl.birthHash, endpoint: 'sadhesati_current_status' });
  check('the refresh is billed like any other real call (2 total: the first fetch + this refresh)', usageAfterRefresh === 2);

  section('getKundliSection — a failed ttl refresh serves the stale payload instead of erroring');
  await KundliCache.updateOne(
    { birthHash: birthTtl.birthHash, endpoint: 'sadhesati_current_status' },
    { $set: { fetchedAt: new Date(Date.now() - 61 * 1000) } },
  );
  const beforeFailedRefresh = await KundliCache.findOne({ birthHash: birthTtl.birthHash, endpoint: 'sadhesati_current_status' }).lean();
  const failingRefreshProvider = failingProvider('astrologyapi is down');
  const stillServed = await getKundliSection(birthTtl, 'sadhesati_current_status', null, failingRefreshProvider, { ttlSeconds: 60 });
  check('a failed refresh attempt is made (not silently skipped)', failingRefreshProvider.calls.length === 1);
  check('the stale payload is served anyway, not an error', JSON.stringify(stillServed) === JSON.stringify(beforeFailedRefresh.payload));
  check('the stale row itself is untouched — still there for next time', await KundliCache.countDocuments({ birthHash: birthTtl.birthHash, endpoint: 'sadhesati_current_status' }) === 1);
  check('a failed refresh is never billed', await ApiUsage.countDocuments({ birthHash: birthTtl.birthHash, endpoint: 'sadhesati_current_status' }) === 2);

  section('getKundliSection — an endpoint with no ttlSeconds option is never stale, however old fetchedAt gets');
  const permBirth = { birthHash: computeBirthHash({ dob: '1970-07-07', tob: '07:07', lat: 23.0225, lon: 72.5714, ayanamsha: 'lahiri' }) };
  await getKundliSection(permBirth, 'astro_details', null, fakeProvider());
  await KundliCache.updateOne(
    { birthHash: permBirth.birthHash, endpoint: 'astro_details' },
    { $set: { fetchedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) } },
  );
  const stillPermanentProvider = fakeProvider();
  await getKundliSection(permBirth, 'astro_details', null, stillPermanentProvider);
  check('a year-old permanent row is still a plain hit — permanent really means permanent', stillPermanentProvider.calls.length === 0);

  /* ----------------------------------------------------------- category budget */
  section('assertCreditBudget / getMonthlyUsageCount — horoscope and general are separate pools');
  const realGeneralLimit = env.astrologyApi.monthlyCreditLimit;
  const realHoroscopeLimit = env.astrologyApi.horoscopeMonthlyCreditLimit;
  const generalUsedSoFar = await getMonthlyUsageCount(undefined, undefined, 'general');
  const horoscopeUsedSoFar = await getMonthlyUsageCount(undefined, undefined, 'horoscope');
  check('every real call made so far in this file counted as general, none as horoscope yet', horoscopeUsedSoFar === 0 && generalUsedSoFar > 0);

  env.astrologyApi.horoscopeMonthlyCreditLimit = horoscopeUsedSoFar;
  let horoscopeGuardThrew = null;
  try {
    await assertCreditBudget(undefined, 1, 'horoscope');
  } catch (error) {
    horoscopeGuardThrew = error;
  }
  check('the horoscope pool refuses once IT is at its own ceiling', horoscopeGuardThrew?.code === 'astrology_credit_limit_reached');

  let generalStillFine = null;
  try {
    await assertCreditBudget(undefined, 1, 'general');
  } catch (error) {
    generalStillFine = error;
  }
  check('the general pool is completely unaffected by the horoscope pool being exhausted', generalStillFine === null);

  await ApiUsage.create({ provider: 'astrologyapi', endpoint: 'sun_sign_prediction/daily', category: 'horoscope', calledAt: new Date() });
  const horoscopeCountAfter = await getMonthlyUsageCount(undefined, undefined, 'horoscope');
  const generalCountAfter = await getMonthlyUsageCount(undefined, undefined, 'general');
  check('a row explicitly tagged horoscope only counts towards the horoscope pool', horoscopeCountAfter === horoscopeUsedSoFar + 1);
  check('and does not inflate the general count', generalCountAfter === generalUsedSoFar);

  env.astrologyApi.monthlyCreditLimit = realGeneralLimit;
  env.astrologyApi.horoscopeMonthlyCreditLimit = realHoroscopeLimit;

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
