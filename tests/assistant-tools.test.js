/**
 * services/assistantTools.js — the four tools the AI assistant can call.
 *
 * Seeded with the same real captured fixtures as tests/kundli-read.test.js
 * and tests/assistant.test.js, so "Saturn in Aquarius, 8th house, own sign"
 * and "Venus mahadasha, Saturn antardasha" are the real reference chart, not
 * invented numbers. Zero AstrologyAPI calls anywhere in this file — every
 * handler goes through the cache-only doors (getCachedKundliSection,
 * getCachedHoroscope), which cannot reach the provider at all.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_assistant_tools';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const BirthProfile = require('../models/BirthProfile');
const KundliCache = require('../models/KundliCache');
const HoroscopeCache = require('../models/HoroscopeCache');
const UserProfile = require('../models/UserProfile');
const client = require('../services/astrologyApi.client');
const { TOOL_DEFINITIONS, runTool } = require('../services/assistantTools');
const { computeBirthHash } = require('../utils/birthHash');
const { istDateString } = require('../utils/istDate');

const planetsExtended = require('./fixtures/astrologyapi/planets_extended.json');
const majorVdasha = require('./fixtures/astrologyapi/major_vdasha.json');
const subVdasha = require('./fixtures/astrologyapi/sub_vdasha.json');
const gemSuggestion = require('./fixtures/astrologyapi/basic_gem_suggestion.json');
const pujaSuggestion = require('./fixtures/astrologyapi/puja_suggestion.json');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

const OWNER = new mongoose.Types.ObjectId();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const originalCallProvider = client.callProvider;
  let providerCalled = false;
  client.callProvider = async () => {
    providerCalled = true;
    throw new Error('should never be called — every tool here is cache-only');
  };

  /* --------------------------------------------------------------- fixtures */
  const birthHash = computeBirthHash({ dob: '1995-08-15', tob: '06:30', lat: 19.07283, lon: 72.88261, ayanamsha: 'lahiri' });
  const birthProfile = await BirthProfile.create({
    user: OWNER,
    label: 'Self',
    relation: 'self',
    birthDetails: {
      fullName: 'Arjun Sharma',
      dateOfBirth: new Date('1995-08-15T00:00:00.000Z'),
      timeOfBirth: '06:30',
      isBirthTimeKnown: true,
      place: { formatted: 'Mumbai, IN', city: 'Mumbai', country: 'IN', latitude: 19.07283, longitude: 72.88261, timezone: 'Asia/Kolkata' },
    },
    tzone: 5.5,
    ayanamsha: 'lahiri',
    birthHash,
    status: 'ready',
  });

  await KundliCache.insertMany([
    { birthHash, endpoint: 'planets/extended', pathParam: null, payload: planetsExtended, fetchedAt: new Date() },
    { birthHash, endpoint: 'major_vdasha', pathParam: null, payload: majorVdasha, fetchedAt: new Date() },
    /** Only the CURRENTLY running mahadasha (Venus) has its sub_vdasha cached — Mars's is deliberately left uncached, to prove a miss is handled cleanly. */
    { birthHash, endpoint: 'sub_vdasha', pathParam: 'Venus', payload: subVdasha, fetchedAt: new Date() },
    { birthHash, endpoint: 'basic_gem_suggestion', pathParam: null, payload: gemSuggestion, fetchedAt: new Date() },
    { birthHash, endpoint: 'puja_suggestion', pathParam: null, payload: pujaSuggestion, fetchedAt: new Date() },
  ]);

  const userProfile = await UserProfile.create({
    user: OWNER,
    fullName: 'Arjun Sharma',
    zodiac: { sunSign: 'Leo' },
  });

  const today = istDateString();
  await HoroscopeCache.create({
    zodiacSign: 'leo',
    period: 'daily',
    targetDate: today,
    payload: { prediction: { luck: 'A steady day for confident, quiet progress.', personal_life: 'x', profession: 'x', health: 'x', emotions: 'x', travel: 'x' } },
    derived: { luckyNumber: 7, luckyColor: 'Gold', energy: 'High ↑' },
    fetchedAt: new Date(),
  });

  const userContext = { userId: String(OWNER), birthProfile };
  const noChartContext = { userId: String(OWNER), birthProfile: null };

  /* -------------------------------------------------------------- schemas */
  section('TOOL_DEFINITIONS — the shape services/llm/index.js\'s chat(messages, tools) expects');
  check('exactly the 4 tools the spec calls for, no more', TOOL_DEFINITIONS.length === 4);
  check('every one is a function tool with a name and a JSON-schema parameters block', TOOL_DEFINITIONS.every(t => t.type === 'function' && typeof t.function.name === 'string' && t.function.parameters?.type === 'object'));
  check('names match exactly', TOOL_DEFINITIONS.map(t => t.function.name).sort().join(',') === 'get_antardasha,get_daily_horoscope,get_planet_detail,get_remedies');

  /* -------------------------------------------------------------- antardasha */
  section('get_antardasha');
  const venusAntardasha = await runTool('get_antardasha', { mahadasha_lord: 'Venus' }, userContext);
  check('the currently-running mahadasha\'s antardasha is cached and comes back', venusAntardasha.available === true);
  check('9 sub-periods, same as the real reference chart', venusAntardasha.antardasha.length === 9);
  check('Saturn is flagged current — the real reference chart\'s current antardasha within the Venus mahadasha', venusAntardasha.antardasha.find(p => p.lord === 'Saturn')?.current === true);

  const marsAntardasha = await runTool('get_antardasha', { mahadasha_lord: 'Mars' }, userContext);
  check('a lord whose sub_vdasha was never cached comes back unavailable, not an error', marsAntardasha.available === false && typeof marsAntardasha.reason === 'string');

  const bogusAntardasha = await runTool('get_antardasha', { mahadasha_lord: 'Pluto' }, userContext);
  check('a planet outside the nine classical grahas is refused before ever touching the cache', bogusAntardasha.available === false);

  const noChartAntardasha = await runTool('get_antardasha', { mahadasha_lord: 'Venus' }, noChartContext);
  check('no birth chart on file is its own clear "unavailable", not a crash', noChartAntardasha.available === false && /No birth chart/.test(noChartAntardasha.reason));

  /* ----------------------------------------------------------- planet detail */
  section('get_planet_detail');
  const saturnDetail = await runTool('get_planet_detail', { planet_name: 'Saturn' }, userContext);
  check('Saturn\'s real placement in the reference chart: Aquarius, 8th house, own sign', saturnDetail.available === true && saturnDetail.sign === 'Aquarius' && saturnDetail.house === 8 && saturnDetail.dignity === 'Own Sign');

  const rahuDetail = await runTool('get_planet_detail', { planet_name: 'Rahu' }, userContext);
  check('a node with no classical dignity rule still comes back available, just without one', rahuDetail.available === true && rahuDetail.dignity === undefined);

  const badPlanet = await runTool('get_planet_detail', { planet_name: 'Alderaan' }, userContext);
  check('a made-up planet name is refused up front', badPlanet.available === false);

  const noChartPlanet = await runTool('get_planet_detail', { planet_name: 'Saturn' }, noChartContext);
  check('no chart on file — unavailable, not a crash', noChartPlanet.available === false);

  /* ---------------------------------------------------------------- remedies */
  section('get_remedies');
  const remedies = await runTool('get_remedies', {}, userContext);
  check('available, and merges gemstone + puja exactly like the kundli screen does', remedies.available === true && remedies.remedies.length === 4 && remedies.remedies[0].type === 'puja');

  const noChartRemedies = await runTool('get_remedies', {}, noChartContext);
  check('no chart on file — unavailable, not a crash', noChartRemedies.available === false);

  /* ---------------------------------------------------------- daily horoscope */
  section('get_daily_horoscope');
  const horoscope = await runTool('get_daily_horoscope', {}, userContext);
  check('reads the user\'s OWN sun sign (Leo) — never asks the model or the caller for one', horoscope.available === true && horoscope.sign === 'leo');
  check('carries the derived extras (lucky number etc.)', horoscope.lucky_number === 7 && horoscope.lucky_color === 'Gold');

  await UserProfile.updateOne({ user: OWNER }, { $unset: { 'zodiac.sunSign': 1 } });
  const noSignHoroscope = await runTool('get_daily_horoscope', {}, userContext);
  check('no sun sign resolved yet — unavailable, not a crash', noSignHoroscope.available === false);
  await UserProfile.updateOne({ user: OWNER }, { $set: { 'zodiac.sunSign': 'Leo' } });

  const otherUser = new mongoose.Types.ObjectId();
  const noCacheHoroscope = await runTool('get_daily_horoscope', {}, { userId: String(otherUser), birthProfile: null });
  check('a user with no UserProfile at all is also just unavailable', noCacheHoroscope.available === false);

  /* ------------------------------------------------------------------- misc */
  section('runTool — an unknown tool name');
  const unknown = await runTool('get_launch_codes', {}, userContext);
  check('refused as unavailable, not thrown — a hallucinated tool name must never crash the turn', unknown.available === false && /Unknown tool/.test(unknown.reason));

  check('nothing in this whole file ever reached the provider', providerCalled === false);
  client.callProvider = originalCallProvider;

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  client.callProvider = require('../services/astrologyApi.client').callProvider;
  console.error('CRASHED:', e);
  process.exit(1);
});
