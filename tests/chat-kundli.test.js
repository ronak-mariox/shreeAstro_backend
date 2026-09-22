/**
 * GET /chats/:chatId/kundli — the seeker's saved kundli, as the astrologer's
 * chat header and "Generate Kundli" open it. Seeded with the real captured
 * provider fixtures straight into KundliCache, and the provider itself is
 * stubbed to fail, so every check here also proves no credit is spent.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_chat_kundli';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const BirthProfile = require('../models/BirthProfile');
const KundliCache = require('../models/KundliCache');
const { ChatSession } = require('../models/Chat');
const client = require('../services/astrologyApi.client');
const kundliReadService = require('../services/kundliRead.service');
const { computeBirthHash } = require('../utils/birthHash');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);
async function expectError(fn) {
  try { await fn(); return null; } catch (error) { return error; }
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  let providerCalls = 0;
  client.request = async () => { providerCalls += 1; throw new Error('provider must not be called'); };
  client.callProvider = async () => { providerCalls += 1; throw new Error('provider must not be called'); };

  const seeker = await User.create({ name: 'Arjun Sharma', email: 'arjun@x.com', phone: { number: '9876500001' } });
  const astro = await Astrologer.create({
    name: 'Pt. Rajesh', email: 'raj@x.com', phone: { number: '9876500002' }, applicationStatus: 'approved',
    services: [{ type: 'chat', ratePerMinute: 20, isEnabled: true }],
  });
  const stranger = await Astrologer.create({ name: 'Other', email: 'o@x.com', phone: { number: '9876500003' }, applicationStatus: 'approved' });

  const birthHash = computeBirthHash({ dob: '1995-08-15', tob: '06:30', lat: 19.07283, lon: 72.88261, ayanamsha: 'lahiri' });
  const self = await BirthProfile.create({
    user: seeker._id, label: 'Self', relation: 'self',
    birthDetails: {
      fullName: 'Arjun Sharma', gender: 'male', dateOfBirth: new Date('1995-08-15T00:00:00.000Z'), timeOfBirth: '06:30',
      place: { formatted: 'Mumbai, IN', latitude: 19.07283, longitude: 72.88261, timezone: 'Asia/Kolkata' },
    },
    tzone: 5.5, ayanamsha: 'lahiri', birthHash, status: 'ready',
  });
  const seed = [
    ['astro_details', require('./fixtures/astrologyapi/astro_details.json')],
    ['planets/extended', require('./fixtures/astrologyapi/planets_extended.json')],
    ['horo_chart_image/D1', require('./fixtures/astrologyapi/horo_chart_image_D1.json')],
    ['horo_chart/D1', require('./fixtures/astrologyapi/horo_chart_D1.json')],
    ['major_vdasha', require('./fixtures/astrologyapi/major_vdasha.json')],
  ];
  await KundliCache.insertMany(seed.map(([endpoint, payload]) => ({ birthHash, endpoint, pathParam: null, payload, fetchedAt: new Date() })));

  const chatWith = intakeBirth => ChatSession.create({
    type: 'consultation', channel: 'chat', user: seeker._id, astrologer: astro._id, status: 'active', startedAt: new Date(),
    intake: { birthDetails: intakeBirth, topic: 'career-job' },
    billing: { ratePerMinute: 20, commissionPercent: 25 },
  });

  section('the astrologer opens the seeker\'s saved kundli');
  const chat = await chatWith({ fullName: 'Arjun Sharma', gender: 'male', dateOfBirth: new Date('1995-08-15T00:00:00.000Z'), timeOfBirth: '06:30', place: { formatted: 'Mumbai' } });
  const kundli = await kundliReadService.getSeekerKundliForChat({ chatId: chat._id, accountId: astro._id, origin: 'http://localhost' });
  check('found — the profile matching the intake\'s birth date and time', kundli.found === true && kundli.profileId === String(self._id));
  check('who it is for', kundli.birthDetails.fullName === 'Arjun Sharma' && kundli.birthDetails.timeOfBirth === '06:30' && kundli.birthDetails.place === 'Mumbai, IN');
  check('lagna and nakshatra from the stored chart', Boolean(kundli.lagna) && Boolean(kundli.nakshatra), { lagna: kundli.lagna, nakshatra: kundli.nakshatra });
  check('planet table (sign and house per planet)', kundli.planetaryPositions.length >= 9 && kundli.planetaryPositions.every(p => p.planet && p.sign));
  check('mahadasha periods with the running one marked', kundli.mahadasha.length > 0 && kundli.mahadasha.filter(p => p.current).length === 1);
  check('no provider call was made (nothing spent)', providerCalls === 0, providerCalls);

  section('the seeker can read it too; nobody else can');
  const bySeeker = await kundliReadService.getSeekerKundliForChat({ chatId: chat._id, accountId: seeker._id, origin: 'http://localhost' });
  check('seeker: same kundli', bySeeker.profileId === kundli.profileId);
  const denied = await expectError(() => kundliReadService.getSeekerKundliForChat({ chatId: chat._id, accountId: stranger._id }));
  check('an astrologer outside the chat is refused (403)', denied?.status === 403);
  const missing = await expectError(() => kundliReadService.getSeekerKundliForChat({ chatId: new mongoose.Types.ObjectId(), accountId: astro._id }));
  check('an unknown chat is 404', missing?.status === 404);

  section('never someone else\'s chart');
  const other = await chatWith({ fullName: 'Priya', dateOfBirth: new Date('2000-01-01T00:00:00.000Z'), timeOfBirth: '10:00', place: { formatted: 'Delhi' } });
  const none = await kundliReadService.getSeekerKundliForChat({ chatId: other._id, accountId: astro._id });
  check('intake for a person with no saved kundli → found: false (not the seeker\'s own chart)', none.found === false);
  check('...with the intake details, for the form', none.birthDetails.fullName === 'Priya' && none.birthDetails.place === 'Delhi');
  const noDob = await chatWith({ fullName: 'Arjun Sharma' });
  const fallback = await kundliReadService.getSeekerKundliForChat({ chatId: noDob._id, accountId: astro._id, origin: 'http://localhost' });
  check('no birth date on the intake → their own ("self") kundli', fallback.found === true && fallback.profileId === String(self._id));
  const ended = await ChatSession.create({ ...chat.toObject(), _id: undefined, status: 'ended', endedAt: new Date() });
  const past = await kundliReadService.getSeekerKundliForChat({ chatId: ended._id, accountId: astro._id, origin: 'http://localhost' });
  check('also available on a past consultation (opened from history)', past.found === true);

  section('HTTP');
  const { createApp } = require('../app');
  const { signAccessToken } = require('../utils/token');
  const server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  const get = async (path, id, role) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, { headers: { Authorization: `Bearer ${signAccessToken(String(id), role)}` } });
    return { status: res.status, body: await res.json() };
  };
  const ok = await get(`/chats/${chat._id}/kundli`, astro._id, 'astrologer');
  check('GET /chats/:id/kundli as the astrologer → 200 with the chart', ok.status === 200 && ok.body.found === true && ok.body.planetaryPositions.length >= 9, ok.status);
  const forbidden = await get(`/chats/${chat._id}/kundli`, stranger._id, 'astrologer');
  check('as another astrologer → 403', forbidden.status === 403);
  const badId = await get('/chats/not-an-id/kundli', astro._id, 'astrologer');
  check('a malformed chat id is refused by the validator', badId.status >= 400 && badId.status < 500);
  server.close();
  check('still no provider call', providerCalls === 0, providerCalls);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
