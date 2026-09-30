/**
 * GET /panchang and services/panchang.service.js, proven against a stubbed
 * transport — no real AstrologyAPI call happens anywhere in this file. The
 * one property that matters most: the provider is called EXACTLY twice per
 * (date, place), however many requests ask for that date, however
 * concurrently.
 *
 * The fixtures under tests/fixtures/astrologyapi/panchang/ are hand-written
 * from the provider's docs (see their `_note`), not captured responses like
 * the ones one folder up — so the mapping checks below prove the mapper
 * against the DOCUMENTED shape, and one live call is still owed to confirm
 * the account's real key names.
 *
 * A plain (non-replica-set) local mongod is enough for this test.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_panchang';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test:';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const env = require('../config/env');
const { createApp } = require('../app');
const PanchangCache = require('../models/PanchangCache');
const ApiUsage = require('../models/ApiUsage');
const client = require('../services/astrologyApi.client');
const { getMonthlyUsageCount } = require('../services/kundliCache.service');
const {
  getPanchang,
  mapPanchang,
  mapChoghadiya,
  isWithinWindow,
  isCalendarDate,
  formatTime,
  endTimeOf,
  locationKeyFor,
} = require('../services/panchang.service');
const { istDateString, dateOffset } = require('../utils/istDate');

const advancedFixture = require('./fixtures/astrologyapi/panchang/advanced_panchang.sample.json');
const chaughadiyaFixture = require('./fixtures/astrologyapi/panchang/chaughadiya_muhurta.sample.json');

const PORT = 5093;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

const originalRequest = client.request;

/** Counts every call by endpoint and answers with the fixture for that endpoint, as the real transport would. */
const calls = [];
client.request = async (path, params) => {
  calls.push({ path, params });
  if (path === 'advanced_panchang') return JSON.parse(JSON.stringify(advancedFixture));
  if (path === 'chaughadiya_muhurta') return JSON.parse(JSON.stringify(chaughadiyaFixture));
  throw new Error(`unexpected provider path ${path}`);
};
const callsFor = path => calls.filter(c => c.path === path).length;

async function get(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  /** dropDatabase also drops indexes; the unique and TTL indexes must exist before the race and index checks below. */
  await PanchangCache.init();
  await ApiUsage.init();

  const server = createApp().listen(PORT);

  const today = istDateString();
  const tomorrow = dateOffset(today, 1);
  const yesterday = dateOffset(today, -1);
  const place = { label: 'New Delhi, India', latitude: 28.6139, longitude: 77.209, tzone: 5.5 };

  /* -------------------------------------------------------------- pure mapping */
  section('mapPanchang — the documented advanced_panchang + chaughadiya_muhurta shapes');
  const mapped = mapPanchang(advancedFixture, chaughadiyaFixture, '2026-09-23', place);
  check('date and place come from the caller, not the provider', mapped.date === '2026-09-23' && mapped.place.label === 'New Delhi, India' && mapped.place.tzone === 5.5);
  check('weekday and vaar', mapped.weekday === 'Wednesday' && mapped.vaar === 'Budhavar');
  check('subline is "Vaar · Masa Paksha Paksha · Tithi Tithi"', mapped.subline === 'Budhavar · Bhadrapad Shukla Paksha · Shashthi Tithi', mapped.subline);
  check('sunrise/sunset formatted h:mm AM/PM from "H:MM:SS"', mapped.sun.sunrise === '6:12 AM' && mapped.sun.sunset === '7:08 PM', mapped.sun);
  check('moonrise/moonset', mapped.moon && mapped.moon.moonrise === '10:15 AM' && mapped.moon.moonset === '10:40 PM', mapped.moon);
  check('rahuKaal window', mapped.rahuKaal && mapped.rahuKaal.start === '12:12 PM' && mapped.rahuKaal.end === '1:49 PM', mapped.rahuKaal);
  check('gulikaKaal from guliKaal', mapped.gulikaKaal && mapped.gulikaKaal.start === '10:35 AM' && mapped.gulikaKaal.end === '12:12 PM', mapped.gulikaKaal);
  check('yamaganda from yamghant_kaal', mapped.yamaganda && mapped.yamaganda.start === '7:49 AM' && mapped.yamaganda.end === '9:26 AM', mapped.yamaganda);
  check('abhijitMuhurat', mapped.abhijitMuhurat && mapped.abhijitMuhurat.start === '11:47 AM' && mapped.abhijitMuhurat.end === '12:33 PM', mapped.abhijitMuhurat);
  check('tithi name/number/paksha/endsAt', mapped.tithi.name === 'Shashthi' && mapped.tithi.number === 6 && mapped.tithi.paksha === 'Shukla' && mapped.tithi.endsAt === '8:45 PM' && mapped.tithi.endsNextDay === false, mapped.tithi);
  check('nakshatra name/number/lord; hour 27 -> 3:05 AM next day', mapped.nakshatra.name === 'Chitra' && mapped.nakshatra.number === 14 && mapped.nakshatra.lord === 'Mars' && mapped.nakshatra.endsAt === '3:05 AM' && mapped.nakshatra.endsNextDay === true, mapped.nakshatra);
  check('yoga', mapped.yoga.name === 'Dhruva' && mapped.yoga.endsAt === '2:30 PM' && mapped.yoga.endsNextDay === false, mapped.yoga);
  check('karana', mapped.karana.name === 'Taitila' && mapped.karana.endsAt === '8:45 AM' && mapped.karana.endsNextDay === false, mapped.karana);
  check('masa amanta/purnimanta', mapped.masa.amanta === 'Bhadrapad' && mapped.masa.purnimanta === 'Bhadrapad', mapped.masa);
  check('ritu and samvat', mapped.ritu === 'Sharad' && mapped.samvat.vikram === '2083' && mapped.samvat.shaka === '1948', { ritu: mapped.ritu, samvat: mapped.samvat });
  check('choghadiya has 8 day + 8 night slots', mapped.choghadiya.day.length === 8 && mapped.choghadiya.night.length === 8);
  check('a choghadiya slot splits "HH:MM - HH:MM" and rates by name', JSON.stringify(mapped.choghadiya.day[1]) === JSON.stringify({ start: '7:49 AM', end: '9:26 AM', name: 'Amrit', quality: 'Excellent', desc: 'All auspicious work' }), mapped.choghadiya.day[1]);
  check('every documented muhurta name maps to a non-Neutral quality', [...mapped.choghadiya.day, ...mapped.choghadiya.night].every(s => s.quality !== 'Neutral' && s.desc));
  check('night slots past midnight format as AM', mapped.choghadiya.night[3].start === '11:17 PM' && mapped.choghadiya.night[3].end === '12:40 AM', mapped.choghadiya.night[3]);
  check('no `cache` block in the mapped payload itself', !('cache' in mapped));

  section('mapPanchang — missing/malformed input never throws');
  let emptyMapped = null;
  let mapThrew = null;
  try { emptyMapped = mapPanchang({}, {}, '2026-09-23', place); } catch (e) { mapThrew = e; }
  check('an empty provider response maps without throwing', mapThrew === null, mapThrew?.message);
  check('weekday is derived from the date when the provider omits `day`', emptyMapped?.weekday === 'Wednesday' && emptyMapped?.vaar === 'Budhavar');
  check('every unknown field is null, not undefined or a crash', emptyMapped?.sun.sunrise === null && emptyMapped?.rahuKaal === null && emptyMapped?.moon === null && emptyMapped?.tithi.name === null && emptyMapped?.tithi.endsAt === null && emptyMapped?.samvat === null && emptyMapped?.ritu === null);
  check('choghadiya falls back to empty lists', Array.isArray(emptyMapped?.choghadiya.day) && emptyMapped.choghadiya.day.length === 0 && emptyMapped.choghadiya.night.length === 0);
  let nullThrew = null;
  try { mapPanchang(null, undefined, '2026-09-23', place); } catch (e) { nullThrew = e; }
  check('null/undefined provider responses also map without throwing', nullThrew === null);
  check('an unknown muhurta name rates Neutral', mapChoghadiya({ chaughadiya: { day: [{ time: '06:00 - 07:30', muhurta: 'Mystery' }] } }).day[0].quality === 'Neutral');
  check('an explicit next-day flag is honoured even below hour 24', endTimeOf({ end_time: { hour: 2, minute: 10 }, end_time_next_day: true }).endsNextDay === true);
  check('formatTime handles "HH:MM", "H:MM:SS", 12h strings and {hour,minute}', formatTime('00:05') === '12:05 AM' && formatTime('12:00:00') === '12:00 PM' && formatTime('7:05 pm') === '7:05 PM' && formatTime({ hour: 23, minute: 59 }) === '11:59 PM' && formatTime('nonsense') === null);

  /* ----------------------------------------------------------------- dates */
  section('date window');
  check('isCalendarDate rejects impossible and malformed dates', !isCalendarDate('2026-02-30') && !isCalendarDate('2026-9-1') && !isCalendarDate('tomorrow') && isCalendarDate('2026-02-28'));
  check('yesterday, today and today+30 are inside the window', isWithinWindow(yesterday) && isWithinWindow(today) && isWithinWindow(dateOffset(today, 30)));
  check('two days ago and today+31 are outside', !isWithinWindow(dateOffset(today, -2)) && !isWithinWindow(dateOffset(today, 31)));
  check('locationKey rounds to 4 decimals', locationKeyFor(28.61389, 77.20902) === '28.6139,77.2090');

  /* ---------------------------------------------------------- cache miss/hit */
  section('getPanchang — the first request of a day fetches, every later one is free');
  const first = await getPanchang(today);
  check('a miss makes exactly 2 provider calls', calls.length === 2 && callsFor('advanced_panchang') === 1 && callsFor('chaughadiya_muhurta') === 1, calls.map(c => c.path));
  check('both calls carry the configured place and a 06:00 sunrise-based time', calls.every(c => c.params.lat === env.panchang.latitude && c.params.lon === env.panchang.longitude && c.params.tzone === env.panchang.tzone && c.params.hour === 6 && c.params.min === 0), calls[0].params);
  check('...and the date split into day/month/year', calls[0].params.year === Number(today.slice(0, 4)) && calls[0].params.month === Number(today.slice(5, 7)) && calls[0].params.day === Number(today.slice(8, 10)), calls[0].params);
  check('a miss answers cache.hit=false with fetchedAt/expiresAt a day apart', first.cache.hit === false && new Date(first.cache.expiresAt) - new Date(first.cache.fetchedAt) === 86400000, first.cache);
  check('the mapped fields are present on the response', first.date === today && first.tithi.name === 'Shashthi' && first.nakshatra.name === 'Chitra' && first.rahuKaal.start === '12:12 PM' && first.choghadiya.day.length === 8 && first.choghadiya.night.length === 8);
  check('a miss writes exactly one cache row', await PanchangCache.countDocuments({ date: today }) === 1);
  check('a miss logs two ApiUsage rows, both category panchang', await ApiUsage.countDocuments({ category: 'panchang' }) === 2 && await ApiUsage.countDocuments({ category: 'panchang', endpoint: 'advanced_panchang' }) === 1 && await ApiUsage.countDocuments({ category: 'panchang', endpoint: 'chaughadiya_muhurta' }) === 1);

  const second = await getPanchang(today);
  check('a second request for the same date makes no provider call — still 2 total', calls.length === 2);
  check('the hit answers cache.hit=true with the same fetchedAt', second.cache.hit === true && second.cache.fetchedAt === first.cache.fetchedAt, second.cache);
  const { cache: c1, ...body1 } = first;
  const { cache: c2, ...body2 } = second;
  check('the hit body is identical to the miss body', JSON.stringify(body1) === JSON.stringify(body2));
  check('no additional usage is logged on a hit', await ApiUsage.countDocuments({ category: 'panchang' }) === 2);

  section('getPanchang — another date is its own fetch');
  await getPanchang(tomorrow);
  check('a third request, for tomorrow, makes 2 more calls — 4 total', calls.length === 4);
  check('two cache rows now', await PanchangCache.countDocuments({}) === 2);

  section('getPanchang — 10 concurrent first requests share one fetch');
  const raceDate = dateOffset(today, 2);
  const before = calls.length;
  const results = await Promise.all(Array.from({ length: 10 }, () => getPanchang(raceDate)));
  check('all 10 resolve', results.every(r => r && r.date === raceDate));
  check('only 2 provider calls were made for all 10', calls.length - before === 2, calls.length - before);
  check('exactly one cache row for that date', await PanchangCache.countDocuments({ date: raceDate }) === 1);
  check('exactly two usage rows for that fetch', await ApiUsage.countDocuments({ category: 'panchang' }) === 6);
  check('a request after the race is a plain hit', (await getPanchang(raceDate)).cache.hit === true && calls.length - before === 2);

  section('getPanchang — omitted date means today (IST)');
  const defaulted = await getPanchang();
  check('defaults to today and is served from cache', defaulted.date === today && defaulted.cache.hit === true && calls.length - before === 2);

  /* --------------------------------------------------------------- indexes */
  section('PanchangCache indexes');
  const indexes = await PanchangCache.collection.indexes();
  const ttl = indexes.find(i => i.key && i.key.createdAt === 1 && Object.keys(i.key).length === 1);
  check('TTL index on createdAt with expireAfterSeconds 86400', ttl && ttl.expireAfterSeconds === 86400, ttl);
  const unique = indexes.find(i => i.key && i.key.date === 1 && i.key.locationKey === 1);
  check('unique index on { date, locationKey }', unique && unique.unique === true, unique);

  /* ------------------------------------------------------------ over HTTP */
  section('GET /panchang');
  const ok = await get(`/panchang?date=${today}`);
  check('200 with the full shape', ok.status === 200 && ok.body.date === today && ok.body.subline && ok.body.sun.sunrise && ok.body.rahuKaal && ok.body.tithi.name && ok.body.nakshatra.name && ok.body.yoga.name && ok.body.karana.name && ok.body.choghadiya.day.length === 8 && ok.body.cache.hit === true, ok.body);
  const noDate = await get('/panchang');
  check('no date -> today, 200', noDate.status === 200 && noDate.body.date === today);
  const tooFar = await get(`/panchang?date=${dateOffset(today, 31)}`);
  check('today+31 -> 422 with fields.date', tooFar.status === 422 && typeof tooFar.body.fields?.date === 'string', tooFar.body);
  const tooOld = await get(`/panchang?date=${dateOffset(today, -2)}`);
  check('two days ago -> 422 with fields.date', tooOld.status === 422 && typeof tooOld.body.fields?.date === 'string', tooOld.body);
  const malformed = await get('/panchang?date=23-09-2026');
  check('malformed date -> 422 with fields.date', malformed.status === 422 && typeof malformed.body.fields?.date === 'string', malformed.body);
  const impossible = await get('/panchang?date=2026-02-30');
  check('impossible date -> 422', impossible.status === 422);
  check('no provider call was made by any refused request', calls.length - before === 2);
  const httpMiss = await get(`/panchang?date=${yesterday}`);
  check('yesterday over HTTP is a fresh fetch: 200, cache.hit=false, +2 calls', httpMiss.status === 200 && httpMiss.body.cache.hit === false && calls.length - before === 4, { status: httpMiss.status, cache: httpMiss.body.cache });

  /* ---------------------------------------------------------- credit guard */
  section('credit guard — its own separate panchang budget');
  const realPanchangLimit = env.astrologyApi.panchangMonthlyCreditLimit;
  const realGeneralLimit = env.astrologyApi.monthlyCreditLimit;
  const realHoroscopeLimit = env.astrologyApi.horoscopeMonthlyCreditLimit;
  const panchangUsed = await getMonthlyUsageCount(undefined, undefined, 'panchang');
  check('the panchang pool counts exactly the 8 calls made so far', panchangUsed === 8, panchangUsed);
  check('the general pool never moved', (await getMonthlyUsageCount(undefined, undefined, 'general')) === 0);
  check('the horoscope pool never moved', (await getMonthlyUsageCount(undefined, undefined, 'horoscope')) === 0);

  /** One credit short of the 2 a miss needs. */
  env.astrologyApi.panchangMonthlyCreditLimit = panchangUsed + 1;
  const callsBeforeGuard = calls.length;
  let guardThrew = null;
  try { await getPanchang(dateOffset(today, 5)); } catch (e) { guardThrew = e; }
  check('at the limit, a miss refuses with astrology_credit_limit_reached', guardThrew?.code === 'astrology_credit_limit_reached' && guardThrew?.status === 429, guardThrew?.message);
  check('the provider was never touched', calls.length === callsBeforeGuard);
  check('nothing was cached for the refused date', await PanchangCache.countDocuments({ date: dateOffset(today, 5) }) === 0);
  const guardedHit = await getPanchang(today);
  check('a cache hit still works while the budget is exhausted (hits are free)', guardedHit.cache.hit === true && calls.length === callsBeforeGuard);
  const guardedHttp = await get(`/panchang?date=${dateOffset(today, 6)}`);
  check('over HTTP the refusal is a 429', guardedHttp.status === 429 && guardedHttp.body.code === 'astrology_credit_limit_reached', guardedHttp.body);
  check('the general and horoscope limits were never consulted', env.astrologyApi.monthlyCreditLimit === realGeneralLimit && env.astrologyApi.horoscopeMonthlyCreditLimit === realHoroscopeLimit);

  env.astrologyApi.panchangMonthlyCreditLimit = realPanchangLimit;
  const afterRestore = await getPanchang(dateOffset(today, 5));
  check('restoring the budget lets the very next miss through', afterRestore.cache.hit === false && calls.length === callsBeforeGuard + 2);

  /* ------------------------------------------------------- provider failure */
  section('a failed fetch is never cached, and the next request retries');
  const failDate = dateOffset(today, 7);
  const goodRequest = client.request;
  client.request = async (path, params) => {
    if (path === 'chaughadiya_muhurta') throw new Error('astrologyapi is down');
    return goodRequest(path, params);
  };
  let failThrew = null;
  try { await getPanchang(failDate); } catch (e) { failThrew = e; }
  check('the provider error propagates', failThrew?.message === 'astrologyapi is down');
  check('nothing is cached for the failed date', await PanchangCache.countDocuments({ date: failDate }) === 0);
  check('the call that DID answer is still billed (the credit was spent)', await ApiUsage.countDocuments({ category: 'panchang', endpoint: 'advanced_panchang' }) === 6 && await ApiUsage.countDocuments({ category: 'panchang', endpoint: 'chaughadiya_muhurta' }) === 5);
  client.request = goodRequest;
  const recovered = await getPanchang(failDate);
  check('the next request for that date fetches again rather than being poisoned by the in-flight map', recovered.cache.hit === false && await PanchangCache.countDocuments({ date: failDate }) === 1);

  /* --------------------------------------------------------- upsert on dup */
  section('a row already written by another process is reused, not overwritten twice');
  const dupDate = dateOffset(today, 9);
  const seededAt = new Date(Date.now() - 60000);
  await PanchangCache.create({ date: dupDate, locationKey: locationKeyFor(env.panchang.latitude, env.panchang.longitude), payload: { date: dupDate, seeded: true }, createdAt: seededAt });
  const seeded = await getPanchang(dupDate);
  check('a pre-existing row (e.g. written by another instance) is served as a hit', seeded.cache.hit === true && seeded.seeded === true && seeded.cache.fetchedAt === seededAt.toISOString());

  client.request = originalRequest;
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
