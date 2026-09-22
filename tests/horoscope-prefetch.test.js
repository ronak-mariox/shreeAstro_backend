/**
 * runHoroscopePrefetch — proven against a stubbed transport, no real
 * AstrologyAPI call. Idempotency and partial-failure tolerance are the two
 * properties this exists to guarantee: a re-run must cost nothing once
 * everything is cached, and one sign failing must never take the other
 * eleven down with it.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_horoscope_prefetch';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const HoroscopeCache = require('../models/HoroscopeCache');
const client = require('../services/astrologyApi.client');
const { runHoroscopePrefetch } = require('../jobs/horoscopePrefetch.job');
const { istDateString, dateOffset } = require('../utils/istDate');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

const originalRequest = client.request;
/** Relative to whenever this actually runs, not a hardcoded date that "expires" once real time moves far enough past it — dailyEndpointFor only covers today +/- 1 day. */
const TARGET_DATE = istDateString();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  /* ------------------------------------------------------------- happy path */
  section('runHoroscopePrefetch — all 12 signs succeed');
  const calls = [];
  client.request = async path => {
    calls.push(path);
    return { status: true, sun_sign: path.split('/').pop(), prediction: { personal_life: 'x', profession: 'x', health: 'x', emotions: 'x', travel: 'x', luck: 'x' } };
  };

  const result = await runHoroscopePrefetch(TARGET_DATE);
  check('reports all 12 succeeded, none failed', result.succeeded === 12 && result.failed.length === 0);
  check('fired exactly 12 provider calls, one per sign', calls.length === 12);
  check('every sign is now cached for this date', await HoroscopeCache.countDocuments({ period: 'daily', targetDate: TARGET_DATE }) === 12);

  /* --------------------------------------------------------------- idempotent */
  section('runHoroscopePrefetch — re-running the same date is free');
  const secondRunCalls = [];
  client.request = async path => { secondRunCalls.push(path); throw new Error('should never be called — everything is cached'); };

  const secondResult = await runHoroscopePrefetch(TARGET_DATE);
  check('still reports all 12 as succeeded (from cache)', secondResult.succeeded === 12 && secondResult.failed.length === 0);
  check('made zero provider calls the second time', secondRunCalls.length === 0);

  /* ------------------------------------------------------------- partial failure */
  section('runHoroscopePrefetch — one sign failing never blocks the other eleven');
  const otherDate = dateOffset(TARGET_DATE, -1);
  client.request = async path => {
    if (path.includes('/leo')) {
      throw new Error('astrologyapi is down for leo');
    }
    return { status: true, prediction: { personal_life: 'x', profession: 'x', health: 'x', emotions: 'x', travel: 'x', luck: 'x' } };
  };

  const partial = await runHoroscopePrefetch(otherDate);
  check('11 succeeded, leo failed', partial.succeeded === 11 && JSON.stringify(partial.failed) === JSON.stringify(['leo']));
  check('the 11 healthy signs are cached', await HoroscopeCache.countDocuments({ targetDate: otherDate }) === 11);
  check('leo is not cached for this date', await HoroscopeCache.countDocuments({ zodiacSign: 'leo', targetDate: otherDate }) === 0);

  section('runHoroscopePrefetch — re-running after the outage only retries the failed sign');
  const retryCalls = [];
  client.request = async path => {
    retryCalls.push(path);
    return { status: true, prediction: { personal_life: 'x', profession: 'x', health: 'x', emotions: 'x', travel: 'x', luck: 'x' } };
  };

  const recovered = await runHoroscopePrefetch(otherDate);
  check('all 12 now succeed', recovered.succeeded === 12 && recovered.failed.length === 0);
  check('only the previously-failed sign (leo) was actually re-fetched', retryCalls.length === 1 && retryCalls[0].endsWith('/leo'));
  check('all 12 are now cached for that date', await HoroscopeCache.countDocuments({ targetDate: otherDate }) === 12);

  client.request = originalRequest;

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  client.request = originalRequest;
  console.error('CRASHED:', e);
  process.exit(1);
});
