/**
 * GET /kundli/me — which generated chart belongs to the seeker's CURRENT
 * birth details, and what happens when those details change:
 *
 *   details unchanged  ->  the same stored chart, every time, from the
 *                          database; nothing fetched, nothing spent.
 *   details changed    ->  no stored chart matches, so the Kundli tab offers
 *                          to generate; generating casts a NEW chart (real
 *                          provider calls) and caches it.
 *
 * The provider transport is faked, and every call through it is counted — so
 * "served from the database" is proved, not assumed.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_kundli_current';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const User = require('../models/User');
const UserProfile = require('../models/UserProfile');
const BirthProfile = require('../models/BirthProfile');
const GeoCache = require('../models/GeoCache');
const client = require('../services/astrologyApi.client');
const kundliService = require('../services/kundli.service');
const kundliReadService = require('../services/kundliRead.service');
const { CHART_ENDPOINT } = require('../services/chartStorage.service');
const geoDetailsFixture = require('./fixtures/astrologyapi/geo_details.json');
const timezoneFixture = require('./fixtures/astrologyapi/timezone_with_dst.json');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

/** Every provider call is counted here, so "from the database" can be asserted. */
let kundliCalls = [];
let geoCalls = [];
client.callProvider = async (birthProfile, endpoint) => {
  kundliCalls.push(endpoint);
  return endpoint === CHART_ENDPOINT ? { svg: '<svg>fake chart</svg>' } : { ok: true, endpoint };
};
client.request = async endpoint => {
  geoCalls.push(endpoint);
  return endpoint === 'timezone_with_dst' ? timezoneFixture : geoDetailsFixture;
};
const resetCounts = () => { kundliCalls = []; geoCalls = []; };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const user = await User.create({ name: 'Arjun Sharma', email: 'arjun@x.com', phone: { number: '9800000001' } });
  const profile = await UserProfile.create({ user: user._id, fullName: 'Arjun Sharma' });
  /** As a prior /places/search would have cached it. */
  await GeoCache.create({ _id: 'place:mumbai', payload: geoDetailsFixture, fetchedAt: new Date() });
  await GeoCache.create({ _id: 'place:delhi', payload: geoDetailsFixture, fetchedAt: new Date() });
  const mumbai = 'place:mumbai#0';
  const delhi = 'place:delhi#0';
  const birth = { fullName: 'Arjun Sharma', gender: 'male', dateOfBirth: '15/08/1995', timeOfBirth: '06:30 AM' };

  /** What the app saves on the account when the seeker fills in birth details. */
  const setProfileBirth = async (dateOfBirth, timeOfBirth, placeFormatted) => {
    await UserProfile.updateOne(
      { user: user._id },
      { $set: { 'birthDetails.dateOfBirth': dateOfBirth, 'birthDetails.timeOfBirth': timeOfBirth, 'birthDetails.place.formatted': placeFormatted } },
    );
  };
  const current = () => kundliReadService.getCurrentKundli(user._id);

  section('nothing on file yet');
  check('no birth details → the app asks for them first', (await current()).reason === 'birth_details_missing');
  await setProfileBirth(new Date('1995-08-15T00:00:00.000Z'), '06:30', 'Mumbai, Maharashtra, India');
  const beforeGenerating = await current();
  check('details on file but never generated → "not_generated"', beforeGenerating.found === false && beforeGenerating.reason === 'not_generated');

  section('generating once');
  resetCounts();
  const first = await kundliService.createBirthProfile(user._id, { ...birth, placeId: mumbai });
  check('the chart is cast — the provider was called', kundliCalls.length > 0 && first.status === 'ready', kundliCalls.length);
  /** The account's place text is whatever the place search labelled it, the same label the chart was cast with. */
  const firstDoc = await BirthProfile.findById(first.id).lean();
  await setProfileBirth(firstDoc.birthDetails.dateOfBirth, firstDoc.birthDetails.timeOfBirth, firstDoc.birthDetails.place.formatted);

  resetCounts();
  const found = await current();
  check('GET /kundli/me now resolves to it', found.found === true && found.profileId === first.id && found.status === 'ready');
  check('...as a database read: no provider call', kundliCalls.length === 0 && geoCalls.length === 0);

  section('refreshing again and again reads the database, never the provider');
  resetCounts();
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await kundliReadService.getKundliOverview(first.id, user._id, 'http://localhost');
    // eslint-disable-next-line no-await-in-loop
    await kundliReadService.getKundliDasha(first.id, user._id);
    // eslint-disable-next-line no-await-in-loop
    await current();
  }
  check('5 rounds of opening the kundli spent nothing', kundliCalls.length === 0, kundliCalls);

  section('a changed detail means a new chart');
  resetCounts();
  await setProfileBirth(new Date('1995-08-16T00:00:00.000Z'), '06:30', firstDoc.birthDetails.place.formatted);
  const afterDateChange = await current();
  check('date of birth changed → no stored chart matches ("not_generated")', afterDateChange.found === false && afterDateChange.reason === 'not_generated');
  check('and the old chart is NOT offered in its place', afterDateChange.profileId === undefined);

  const second = await kundliService.createBirthProfile(user._id, { ...birth, dateOfBirth: '16/08/1995', placeId: mumbai });
  check('generating casts a genuinely new chart (fresh provider calls)', kundliCalls.length > 0 && second.id !== first.id, kundliCalls.length);
  const secondDoc = await BirthProfile.findById(second.id).lean();
  check('a different birth is a different cache key', secondDoc.birthHash !== firstDoc.birthHash);
  await setProfileBirth(secondDoc.birthDetails.dateOfBirth, secondDoc.birthDetails.timeOfBirth, secondDoc.birthDetails.place.formatted);
  resetCounts();
  const nowSecond = await current();
  check('the tab now resolves to the new chart, from the database', nowSecond.profileId === second.id && kundliCalls.length === 0);

  section('time of birth, and place, count as changes too');
  await setProfileBirth(secondDoc.birthDetails.dateOfBirth, '07:45', secondDoc.birthDetails.place.formatted);
  check('a different minute needs its own chart', (await current()).found === false);
  await setProfileBirth(secondDoc.birthDetails.dateOfBirth, secondDoc.birthDetails.timeOfBirth, 'Delhi, Delhi, India');
  check('a different place needs its own chart', (await current()).found === false);
  await setProfileBirth(secondDoc.birthDetails.dateOfBirth, secondDoc.birthDetails.timeOfBirth, secondDoc.birthDetails.place.formatted);
  check('put back, it resolves to the same chart again', (await current()).profileId === second.id);

  section('generating the same birth twice costs nothing and makes no duplicate');
  resetCounts();
  const again = await kundliService.createBirthProfile(user._id, { ...birth, dateOfBirth: '16/08/1995', placeId: mumbai });
  check('the existing chart is reused', again.id === second.id && again.reused === true);
  check('no provider call, no geo call', kundliCalls.length === 0 && geoCalls.length === 0);
  check('still one BirthProfile per birth for this seeker', await BirthProfile.countDocuments({ user: user._id }) === 2);

  section('HTTP');
  const { createApp } = require('../app');
  const { signAccessToken } = require('../utils/token');
  const server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/kundli/me`, {
    headers: { Authorization: `Bearer ${signAccessToken(String(user._id), 'user')}` },
  });
  const body = await res.json();
  check('GET /kundli/me answers the app', res.status === 200 && body.found === true && body.profileId === second.id, body);
  const anon = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/kundli/me`);
  check('and needs a signed-in seeker', anon.status === 401);
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
