/**
 * POST /chats/:chatId/kundli — the astrologer generating the seeker's kundli
 * from inside the consultation, when there is no saved chart to show.
 *
 * The point of it: an astrologer in a reading should not be stuck because the
 * seeker never generated their kundli. They type the birth details from the
 * intake into their own form and get the chart — and it is stored against the
 * SEEKER, so it is there for both of them afterwards and never paid for twice.
 *
 * Both caches (geo and kundli) are seeded from the real captured fixtures and
 * the provider is stubbed to fail, so what is already cached costs nothing; a
 * genuinely new birth is served by a counted stub instead, so "it generated"
 * and "it spent credits doing so" are both visible.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_chat_kundli_gen';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');

const User = require('../models/User');
const UserProfile = require('../models/UserProfile');
const Astrologer = require('../models/Astrologer');
const BirthProfile = require('../models/BirthProfile');
const KundliCache = require('../models/KundliCache');
const GeoCache = require('../models/GeoCache');
const { ChatSession } = require('../models/Chat');
const client = require('../services/astrologyApi.client');
const kundliReadService = require('../services/kundliRead.service');

let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);
const errorOf = async fn => {
  try { await fn(); return null; } catch (error) { return error; }
};

const geoFixture = require('./fixtures/astrologyapi/geo_details.json');
const timezoneFixture = require('./fixtures/astrologyapi/timezone_with_dst.json');

/** Whatever a section is asked for, answer with something shaped like it. */
const SECTION_FIXTURES = {
  astro_details: require('./fixtures/astrologyapi/astro_details.json'),
  'planets/extended': require('./fixtures/astrologyapi/planets_extended.json'),
  'horo_chart_image/D1': require('./fixtures/astrologyapi/horo_chart_image_D1.json'),
  'horo_chart/D1': require('./fixtures/astrologyapi/horo_chart_D1.json'),
  major_vdasha: require('./fixtures/astrologyapi/major_vdasha.json'),
  kalsarpa_details: require('./fixtures/astrologyapi/kalsarpa_details.json'),
  sadhesati_current_status: require('./fixtures/astrologyapi/sadhesati_current_status.json'),
  pitra_dosha_report: require('./fixtures/astrologyapi/pitra_dosha_report.json'),
  shadbala: require('./fixtures/astrologyapi/shadbala.json'),
  basic_gem_suggestion: require('./fixtures/astrologyapi/basic_gem_suggestion.json'),
  puja_suggestion: require('./fixtures/astrologyapi/puja_suggestion.json'),
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  /**
   * The place the astrologer types is searched server-side, and the timezone
   * for that birth is looked up — both already cached here, so neither the
   * search nor the lookup spends anything.
   */
  await GeoCache.create({ _id: 'place:noida', payload: geoFixture, fetchedAt: new Date() });
  const firstPlace = geoFixture.geonames[0];
  await GeoCache.create({
    _id: `tz:${Number(firstPlace.latitude).toFixed(4)},${Number(firstPlace.longitude).toFixed(4)},2004-05-13`,
    payload: timezoneFixture,
    fetchedAt: new Date(),
  });

  const providerCalls = [];
  /**
   * geo style: request(endpoint, params). A place search that isn't already
   * cached reaches here, and answers the way the provider answers a name it
   * does not know — no rows — rather than blowing up.
   */
  client.request = async (endpoint, params) => {
    providerCalls.push(endpoint);
    if (endpoint === 'geo_details') return { geonames: [] };
    const fixture = SECTION_FIXTURES[endpoint];
    if (!fixture) throw new Error(`no fixture for ${endpoint} ${JSON.stringify(params)}`);
    return fixture;
  };
  /** kundli sections: callProvider(birthProfile, endpoint, pathParam). */
  client.callProvider = async (birthProfile, endpoint, pathParam) => {
    const key = pathParam ? `${endpoint}/${pathParam}` : endpoint;
    providerCalls.push(key);
    const fixture = SECTION_FIXTURES[key];
    if (!fixture) throw new Error(`no fixture for ${key}`);
    return fixture;
  };

  const seeker = await User.create({ name: 'Ronak', email: 'gen-seeker@x.com', phone: { number: '9876511111' } });
  await UserProfile.create({
    user: seeker._id,
    birthDetails: {
      fullName: 'Ronak', gender: 'male',
      dateOfBirth: new Date('2004-05-13T00:00:00.000Z'), timeOfBirth: '08:00',
      place: { formatted: 'Noida, IN' },
    },
  });
  const astro = await Astrologer.create({
    name: 'Pt. Rajesh', email: 'gen-astro@x.com', phone: { number: '9876522222' },
    applicationStatus: 'approved',
    services: [{ type: 'chat', ratePerMinute: 20, isEnabled: true }],
  });
  const outsider = await Astrologer.create({ name: 'Other', email: 'gen-other@x.com', phone: { number: '9876533333' }, applicationStatus: 'approved' });

  const chat = await ChatSession.create({
    type: 'consultation', channel: 'chat', user: seeker._id, astrologer: astro._id,
    status: 'active', startedAt: new Date(),
    intake: {
      birthDetails: {
        fullName: 'Ronak', gender: 'male',
        dateOfBirth: new Date('2004-05-13T00:00:00.000Z'), timeOfBirth: '08:00',
        place: { formatted: 'Noida sector 62' },
      },
      topic: 'career-job',
    },
    billing: { ratePerMinute: 20, commissionPercent: 25 },
  });

  section('nothing saved yet — the astrologer has an empty sheet to start from');
  const before = await kundliReadService.getSeekerKundliForChat({ chatId: chat._id, accountId: astro._id, origin: 'http://localhost' });
  check('found: false, with the intake details to fill the form', before.found === false && before.birthDetails.fullName === 'Ronak');

  section('the astrologer generates it from the birth details in front of them');
  const generated = await kundliReadService.generateSeekerKundliForChat({
    chatId: chat._id,
    accountId: astro._id,
    details: { fullName: 'Ronak', gender: 'male', dateOfBirth: '13/05/2004', timeOfBirth: '08 : 00 AM', place: 'Noida' },
    origin: 'http://localhost',
  });
  check('a chart comes back, not just an id', generated.found === true && generated.planetaryPositions.length >= 9);
  check('lagna and nakshatra are in it', Boolean(generated.lagna) && Boolean(generated.nakshatra), { lagna: generated.lagna, nakshatra: generated.nakshatra });
  check('mahadasha too, with the running period marked', generated.mahadasha.length > 0 && generated.mahadasha.filter(p => p.current).length === 1);
  check('marked as freshly generated, not as a stand-in for something else', generated.match === 'generated', generated.match);
  /**
   * The cache row for "noida" holds the captured Mumbai response on purpose:
   * the place stored is whatever the provider returned, never the text that was
   * typed — which is what keeps lat/lon out of a caller's hands.
   */
  check('the birth place is the provider\'s, not the typed text',
    generated.birthDetails.place === `${firstPlace.place_name}, ${firstPlace.country_code}`, generated.birthDetails.place);
  check('sections were actually fetched', providerCalls.length > 0, providerCalls.length);

  section('it belongs to the SEEKER, as if they had generated it themselves');
  const stored = await BirthProfile.find({ user: seeker._id }).lean();
  check('one profile, on the seeker', stored.length === 1 && String(stored[0].user) === String(seeker._id));
  check('their own birth date, so it is their "self" chart', stored[0].relation === 'self', stored[0].relation);
  check('and it is ready', stored[0].status === 'ready', stored[0].status);

  section('and the seeker sees it from their own side afterwards');
  const seekerSide = await kundliReadService.getSeekerKundliForChat({ chatId: chat._id, accountId: seeker._id, origin: 'http://localhost' });
  check('same chart, same profile', seekerSide.found === true && seekerSide.profileId === generated.profileId);

  section('generating the same birth again costs nothing and stacks nothing');
  const spentBefore = providerCalls.length;
  const cachedRows = await KundliCache.countDocuments();
  const again = await kundliReadService.generateSeekerKundliForChat({
    chatId: chat._id,
    accountId: astro._id,
    details: { fullName: 'Ronak', gender: 'male', dateOfBirth: '13/05/2004', timeOfBirth: '08 : 00 AM', place: 'Noida' },
    origin: 'http://localhost',
  });
  check('the same profile is reused', again.profileId === generated.profileId);
  check('no second copy', (await BirthProfile.countDocuments({ user: seeker._id })) === 1);
  check('not one more provider call', providerCalls.length === spentBefore, providerCalls.length - spentBefore);
  check('the cache did not grow', (await KundliCache.countDocuments()) === cachedRows);

  section('someone the seeker is asking about is not filed as the seeker themselves');
  await GeoCache.create({
    _id: `tz:${Number(firstPlace.latitude).toFixed(4)},${Number(firstPlace.longitude).toFixed(4)},1970-02-08`,
    payload: timezoneFixture,
    fetchedAt: new Date(),
  });
  const relative = await kundliReadService.generateSeekerKundliForChat({
    chatId: chat._id,
    accountId: astro._id,
    details: { fullName: 'Ronak\'s Father', gender: 'male', dateOfBirth: '08/02/1970', timeOfBirth: '11 : 15 AM', place: 'Noida' },
    origin: 'http://localhost',
  });
  const relativeProfile = await BirthProfile.findById(relative.profileId).lean();
  check('stored as someone else, leaving the seeker\'s own chart alone', relativeProfile.relation === 'other', relativeProfile.relation);
  check('still on the seeker\'s account', String(relativeProfile.user) === String(seeker._id));
  check('the seeker\'s own chart is untouched', (await BirthProfile.countDocuments({ user: seeker._id, relation: 'self' })) === 1);
  check('a chart for that different birth date, marked generated', relative.found === true && relative.match === 'generated', relative.match);
  check('...with the intake alongside it, since it answers a different question', relative.intakeBirthDetails?.timeOfBirth === '08:00', relative.intakeBirthDetails);

  section('who may generate, and what is refused');
  const denied = await errorOf(() => kundliReadService.generateSeekerKundliForChat({
    chatId: chat._id, accountId: outsider._id,
    details: { fullName: 'Ronak', dateOfBirth: '13/05/2004', timeOfBirth: '08 : 00 AM', place: 'Noida' },
  }));
  check('an astrologer outside this consultation → 403', denied?.status === 403, denied?.status);

  const unknownPlace = await errorOf(() => kundliReadService.generateSeekerKundliForChat({
    chatId: chat._id, accountId: astro._id,
    details: { fullName: 'Ronak', dateOfBirth: '13/05/2004', timeOfBirth: '08 : 00 AM', place: 'Zzzzquapolis' },
  }));
  check('a place nobody can find is a readable refusal, not a crash', unknownPlace?.status === 400 && /birth place/i.test(unknownPlace.message), unknownPlace?.message);

  const future = await errorOf(() => kundliReadService.generateSeekerKundliForChat({
    chatId: chat._id, accountId: astro._id,
    details: { fullName: 'Ronak', dateOfBirth: '13/05/2999', timeOfBirth: '08 : 00 AM', place: 'Noida' },
  }));
  check('a birth date in the future is refused', future?.status === 422 || future?.status === 400, future?.status);

  section('over HTTP, the way the app calls it');
  const { createApp } = require('../app');
  const { signAccessToken } = require('../utils/token');
  const server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  const post = async (path, id, role, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signAccessToken(String(id), role)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const http = await post(`/chats/${chat._id}/kundli`, astro._id, 'astrologer', {
    fullName: 'Ronak', gender: 'male', dateOfBirth: '13/05/2004', timeOfBirth: '08 : 00 AM', place: 'Noida',
  });
  check('201 with the chart', http.status === 201 && http.body.found === true && http.body.planetaryPositions.length >= 9, http.status);

  const badForm = await post(`/chats/${chat._id}/kundli`, astro._id, 'astrologer', {
    fullName: 'R', dateOfBirth: '2004-05-13', timeOfBirth: '8am', place: 'No',
  });
  check('a badly filled form comes back as field errors', badForm.status === 422 || badForm.status === 400, badForm.status);
  check('...naming the fields the form can highlight',
    Boolean(badForm.body.fields?.dateOfBirth || badForm.body.fields?.timeOfBirth || badForm.body.fields?.fullName), badForm.body.fields);

  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
