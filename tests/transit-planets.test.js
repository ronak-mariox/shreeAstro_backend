/**
 * "Where the planets are today" (services/transitPlanets.service.js), proven
 * against the REAL /planets/extended fixture already captured for the
 * kundli-generation feature — no real AstrologyAPI call happens in this file,
 * and no new fixture was needed since it's the exact same endpoint.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_transit_planets';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const KundliCache = require('../models/KundliCache');
const { currentPlanetPositions } = require('../services/transitPlanets.service');
const planetsExtended = require('./fixtures/astrologyapi/planets_extended.json');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

function fakeProvider() {
  const calls = [];
  const fn = async (birthProfile, endpoint, pathParam) => {
    calls.push({ birthHash: birthProfile.birthHash, endpoint, pathParam, birthProfile });
    return planetsExtended;
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const today = new Date('2026-09-04T10:15:00.000Z');

  section('currentPlanetPositions — cache miss then hit, same day');
  const provider1 = fakeProvider();
  const first = await currentPlanetPositions(today, provider1);
  check('calls the provider once', provider1.calls.length === 1);
  check('asks for /planets/extended, no pathParam', provider1.calls[0].endpoint === 'planets/extended' && provider1.calls[0].pathParam === null);
  check('uses the New Delhi reference place and +5.5 tzone, not any real user\'s birth', provider1.calls[0].birthProfile.birthDetails.place.latitude === 28.6139 && provider1.calls[0].birthProfile.tzone === 5.5);
  check('the birthHash is date-based, not tied to any birth', provider1.calls[0].birthHash === 'daily-transit:2026-09-04');
  check('date echoes the UTC calendar day requested', first.date === '2026-09-04');
  check('all 9 classical grahas come back, each with a glyph', first.planets.length === 9 && first.planets.every(p => typeof p.glyph === 'string' && p.glyph.length > 0));
  check('Sun\'s real sign from the fixture comes through', first.planets.find(p => p.name === 'Sun')?.sign === 'Cancer');
  check('no house/dignity/nakshatra leak into this simpler shape', first.planets[0].house === undefined && first.planets[0].dignity === undefined);

  const secondCallSameDay = new Date('2026-09-04T22:59:00.000Z');
  const second = await currentPlanetPositions(secondCallSameDay, provider1);
  check('a later call the same UTC day is a cache hit — no new provider call', provider1.calls.length === 1);
  check('returns the identical snapshot', JSON.stringify(second) === JSON.stringify(first));
  check('one KundliCache row total for today, regardless of how many users load Home', await KundliCache.countDocuments({ birthHash: 'daily-transit:2026-09-04' }) === 1);

  section('currentPlanetPositions — a new day is a fresh (and separately cached) call');
  const tomorrow = new Date('2026-09-05T00:05:00.000Z');
  const provider2 = fakeProvider();
  const thirdDay = await currentPlanetPositions(tomorrow, provider2);
  check('calls the provider again for the new day', provider2.calls.length === 1);
  check('the new day gets its own birthHash', provider2.calls[0].birthHash === 'daily-transit:2026-09-05');
  check('yesterday\'s cached snapshot is untouched', await KundliCache.countDocuments({ birthHash: 'daily-transit:2026-09-04' }) === 1);
  check('today and tomorrow are both now cached, independently', await KundliCache.countDocuments({ endpoint: 'planets/extended', birthHash: /^daily-transit:/ }) === 2);
  check('tomorrow\'s data matches the same fixture (same fake provider response)', thirdDay.planets.length === 9);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
