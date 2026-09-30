/**
 * getHoroscope, proven against a fake provider — no real AstrologyAPI call
 * happens anywhere in this file. Same reasoning as kundli-cache.test.js: with
 * a shared 150-credit plan, this has to be correct and tested *before* a real
 * client exists to spend any of them.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_horoscope_cache';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const env = require('../config/env');
const HoroscopeCache = require('../models/HoroscopeCache');
const ApiUsage = require('../models/ApiUsage');
const { getHoroscope, dailyEndpointFor } = require('../services/horoscopeCache.service');
const { getMonthlyUsageCount } = require('../services/kundliCache.service');
const { istDateString, dateOffset } = require('../utils/istDate');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

/** A fake provider that counts its own calls and answers with a distinct payload per call. */
function fakeProvider() {
  const calls = [];
  const fn = async (endpoint, zodiacSign) => {
    calls.push({ endpoint, zodiacSign });
    return { fromProvider: true, endpoint, zodiacSign, callNumber: calls.length };
  };
  fn.calls = calls;
  return fn;
}

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
  await HoroscopeCache.init();

  const today = istDateString();
  const tomorrow = dateOffset(today, 1);
  const yesterday = dateOffset(today, -1);

  /* ------------------------------------------------------------ endpoint mapping */
  section('dailyEndpointFor');
  check('today -> the plain daily endpoint', dailyEndpointFor(today, today) === 'sun_sign_prediction/daily');
  check('tomorrow -> the next endpoint', dailyEndpointFor(tomorrow, today) === 'sun_sign_prediction/daily/next');
  check('yesterday -> the previous endpoint', dailyEndpointFor(yesterday, today) === 'sun_sign_prediction/daily/previous');
  check('two days out has no endpoint at all', dailyEndpointFor(dateOffset(today, 2), today) === null);

  /* --------------------------------------------------------------- cache hit/miss */
  section('getHoroscope — cache miss then hit');
  const provider1 = fakeProvider();
  const first = await getHoroscope('leo', 'daily', today, provider1);
  check('a miss calls the provider once', provider1.calls.length === 1);
  check('a miss calls the plain daily endpoint for today', provider1.calls[0].endpoint === 'sun_sign_prediction/daily' && provider1.calls[0].zodiacSign === 'leo');
  check('a miss returns the provider payload', first.payload.fromProvider === true);
  check('a miss also returns derived values, computed once', typeof first.derived.luckyNumber === 'number' && typeof first.derived.luckyColor === 'string' && typeof first.derived.energy === 'string');
  check('a miss writes exactly one cache row', await HoroscopeCache.countDocuments({ zodiacSign: 'leo', period: 'daily', targetDate: today }) === 1);
  check('a miss logs exactly one usage row', await ApiUsage.countDocuments({ endpoint: 'sun_sign_prediction/daily' }) === 1);

  const second = await getHoroscope('leo', 'daily', today, provider1);
  check('a hit does not call the provider again', provider1.calls.length === 1);
  check('a hit returns the exact cached payload and derived values', JSON.stringify(second) === JSON.stringify(first));
  check('a hit logs no additional usage (free)', await ApiUsage.countDocuments({ endpoint: 'sun_sign_prediction/daily' }) === 1);

  /* --------------------------------------------------------------- cache key shape */
  section('getHoroscope — cached per (sign, period, date), independently');
  const providerAries = fakeProvider();
  await getHoroscope('aries', 'daily', today, providerAries);
  check('a different sign, same date, is a fresh miss', providerAries.calls.length === 1);
  check('signs are cached independently', await HoroscopeCache.countDocuments({ targetDate: today }) === 2);

  /* ---------------------------------------------------- next/previous share the cache */
  section('getHoroscope — a "next" call for tomorrow already satisfies tomorrow\'s own "today" request');
  const providerNext = fakeProvider();
  const viaNext = await getHoroscope('leo', 'daily', tomorrow, providerNext);
  check('fetching tomorrow calls the "next" endpoint', providerNext.calls[0].endpoint === 'sun_sign_prediction/daily/next');
  check('exactly one call was made', providerNext.calls.length === 1);

  const providerShouldNotBeCalled = fakeProvider();
  const asIfTomorrowWereToday = await getHoroscope('leo', 'daily', tomorrow, providerShouldNotBeCalled);
  check('re-asking for the exact same date is a cache hit regardless of which endpoint originally filled it', providerShouldNotBeCalled.calls.length === 0);
  check('same payload either way', JSON.stringify(asIfTomorrowWereToday) === JSON.stringify(viaNext));

  /* ------------------------------------------------------------- partial failure */
  section('getHoroscope — a failed call is never cached or billed');
  const usageBeforeFailure = await ApiUsage.countDocuments({});
  const badProvider = failingProvider('astrologyapi is down');
  let threw = null;
  try {
    await getHoroscope('cancer', 'daily', today, badProvider);
  } catch (error) {
    threw = error;
  }
  check('the rejection propagates to the caller', threw?.message === 'astrologyapi is down');
  check('nothing is cached for a failed call', await HoroscopeCache.countDocuments({ zodiacSign: 'cancer', targetDate: today }) === 0);
  check('no credit is logged for a failed call', await ApiUsage.countDocuments({}) === usageBeforeFailure);

  const retryProvider = fakeProvider();
  await getHoroscope('cancer', 'daily', today, retryProvider);
  check('retrying the same sign succeeds and caches independently of the earlier failure', retryProvider.calls.length === 1 && await HoroscopeCache.countDocuments({ zodiacSign: 'cancer', targetDate: today }) === 1);

  /* ------------------------------------------------------------------- race */
  section('getHoroscope — two simultaneous misses for the identical key');
  const raceProvider = fakeProvider();
  const [raceA, raceB] = await Promise.all([
    getHoroscope('libra', 'daily', today, raceProvider),
    getHoroscope('libra', 'daily', today, raceProvider),
  ]);
  check('neither concurrent call throws', raceA !== undefined && raceB !== undefined);
  check('the race still leaves exactly one cache row (the unique index wins, not a crash)', await HoroscopeCache.countDocuments({ zodiacSign: 'libra', targetDate: today }) === 1);

  /* --------------------------------------------------------------- out of range */
  section('getHoroscope — a date more than one day from today has no provider endpoint');
  let rangeThrew = null;
  try {
    await getHoroscope('leo', 'daily', dateOffset(today, 5), fakeProvider());
  } catch (error) {
    rangeThrew = error;
  }
  check('refuses with a 400, not a crash', rangeThrew?.status === 400);

  /* ------------------------------------------------------------------- monthly */
  section('getHoroscope — monthly has no provider call wired up yet, on purpose');
  let monthlyThrew = null;
  try {
    await getHoroscope('leo', 'monthly', today, fakeProvider());
  } catch (error) {
    monthlyThrew = error;
  }
  check('refuses rather than silently hitting a daily endpoint for a monthly request', monthlyThrew instanceof Error);

  /* ------------------------------------------------------------- credit guard */
  section('getHoroscope — its own separate horoscope credit budget, not the kundli one');
  const realHoroscopeLimit = env.astrologyApi.horoscopeMonthlyCreditLimit;
  const realGeneralLimit = env.astrologyApi.monthlyCreditLimit;
  const horoscopeUsedSoFar = await getMonthlyUsageCount(undefined, undefined, 'horoscope');
  env.astrologyApi.horoscopeMonthlyCreditLimit = horoscopeUsedSoFar;

  const shouldNotBeCalled = fakeProvider();
  let guardThrew = null;
  try {
    await getHoroscope('virgo', 'daily', today, shouldNotBeCalled);
  } catch (error) {
    guardThrew = error;
  }
  check('over its own budget, getHoroscope refuses before touching the provider', guardThrew?.code === 'astrology_credit_limit_reached');
  check('the provider is never called once the horoscope budget is exhausted', shouldNotBeCalled.calls.length === 0);
  check('nothing is cached for a refused call', await HoroscopeCache.countDocuments({ zodiacSign: 'virgo', targetDate: today }) === 0);

  const generalCountBeforeRestore = await getMonthlyUsageCount(undefined, undefined, 'general');
  env.astrologyApi.monthlyCreditLimit = realGeneralLimit;
  env.astrologyApi.horoscopeMonthlyCreditLimit = realHoroscopeLimit;
  check(
    'the general (kundli) pool never moved while the horoscope pool was being exhausted',
    (await getMonthlyUsageCount(undefined, undefined, 'general')) === generalCountBeforeRestore,
  );

  const providerAfterBudgetRestored = fakeProvider();
  await getHoroscope('virgo', 'daily', today, providerAfterBudgetRestored);
  check('restoring the horoscope budget lets the very next call through', providerAfterBudgetRestored.calls.length === 1);

  /* -------------------------------------------------------- stale-on-failure */
  section('getHoroscope — a provider failure for today serves the most recent stale reading instead of erroring');
  const stalePisces = await getHoroscope('pisces', 'daily', yesterday, fakeProvider());
  check('seeding: pisces has a cached reading for yesterday', stalePisces.payload.fromProvider === true);

  const usageBeforeStaleFallback = await ApiUsage.countDocuments({});
  const staleServed = await getHoroscope('pisces', 'daily', today, failingProvider('astrologyapi is down'));
  check('today\'s fetch failed but yesterday\'s cached reading is served instead of an error', staleServed.payload.fromProvider === true);
  check('the served reading really is the stale one, not a fresh one', JSON.stringify(staleServed.payload) === JSON.stringify(stalePisces.payload) && JSON.stringify(staleServed.derived) === JSON.stringify(stalePisces.derived));
  check('a stale fallback is labelled: stale=true and targetDate is the older reading\'s own date', staleServed.stale === true && staleServed.targetDate === yesterday);
  check('a normal hit/miss is labelled stale=false with the requested date', stalePisces.stale === false && stalePisces.targetDate === yesterday);
  check('nothing new was billed for a stale-served fallback', await ApiUsage.countDocuments({}) === usageBeforeStaleFallback);
  check('today itself is still not cached — the fallback never pretends the fetch succeeded', await HoroscopeCache.countDocuments({ zodiacSign: 'pisces', targetDate: today }) === 0);

  let noStaleThrew = null;
  try {
    await getHoroscope('scorpio', 'daily', today, failingProvider('astrologyapi is down'));
  } catch (error) {
    noStaleThrew = error;
  }
  check('a sign with no cached reading at all still surfaces the real error — nothing to fall back to', noStaleThrew?.message === 'astrologyapi is down');

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
