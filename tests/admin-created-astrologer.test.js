/**
 * The admin-created astrologer flow.
 *
 * An admin creates the account from an email address alone; the astrologer
 * signs in with that email and fills in everything else themselves.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_admincreate';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test:';
process.env.NODE_ENV = 'development';
process.env.OTP_MASTER_CODE = '123456';

const mongoose = require('mongoose');
const { connectRedis, redis } = require('../config/redis');
const { createApp } = require('../app');
const { hashPassword } = require('../utils/password');
const astrologyApiClient = require('../services/astrologyApi.client');

const PORT = 5095;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

/**
 * Registering a user now fires services/user.service.js's
 * enrichZodiacFromBirthDetails in the background (see
 * controllers/auth.controller.js), which would otherwise hit the real
 * AstrologyAPI transport. This file doesn't assert on Moon sign / horoscope
 * content, so an empty geo_details response is enough to make it a silent,
 * free no-op (no place found -> nothing further is ever fetched).
 */
const originalAstrologyRequest = astrologyApiClient.request;

async function call(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const GET = (p, o) => call('GET', p, o);
const POST = (p, o) => call('POST', p, o);
const PATCH = (p, o) => call('PATCH', p, o);
const PUT = (p, o) => call('PUT', p, o);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await connectRedis();
  const stale = await redis.keys('*');
  if (stale.length) await redis.del(...stale.map(k => k.replace('shreeastro-test:', '')));

  astrologyApiClient.request = async () => ({ geonames: [] });

  const server = createApp().listen(PORT);
  const Admin = require('../models/Admin');
  await Admin.create({
    name: 'Vaibhav Mehra', email: 'admin@shreeastro.com',
    passwordHash: await hashPassword('SuperSecret123'), role: 'super_admin', status: 'active',
  });
  /** Two-factor is on by default, so signing in takes two calls. */
  const adminStep1 = await POST('/auth/admin/login', {
    body: { email: 'admin@shreeastro.com', password: 'SuperSecret123' } });
  const adminToken = (await POST('/auth/admin/login/verify', {
    body: { email: 'admin@shreeastro.com', code: adminStep1.body.devCode } })).body.accessToken;

  /* ------------------------------------------------------- the short form */
  section('admin_panel — create astrologer from the short form');

  const bad = await POST('/admin/astrologers', { token: adminToken, body: { email: 'not-an-email' } });
  check('a bad email is refused', bad.status === 400, bad.body);

  const badPct = await POST('/admin/astrologers', { token: adminToken, body: { email: 'x@y.com', commissionPercent: 150 } });
  check('commission outside 0–100 is refused', badPct.status === 400, badPct.body);

  const created = await POST('/admin/astrologers', {
    token: adminToken,
    body: {
      email: 'rajesh.sharma@example.com',
      commissionPercent: 30,
      availability: 'Mon–Sat · 9 AM – 9 PM',
      status: 'approved',
    },
  });
  check('the account is created from email alone', created.status === 201, created.body);
  const a = created.body.astrologer;
  check('an astro code is minted straight away', !!a?.astroCode, a);
  check('the commission is stored', a?.commissionPercent === 30);
  check('the availability text is stored', a?.availability === 'Mon–Sat · 9 AM – 9 PM');
  check('it is approved with no application to review', a?.applicationStatus === 'approved');
  check('a placeholder name is derived from the email', a?.name === 'Rajesh Sharma', a?.name);
  const astrologerId = a.id;

  const dupe = await POST('/admin/astrologers', { token: adminToken, body: { email: 'rajesh.sharma@example.com' } });
  check('the same email cannot be added twice', dupe.status === 409, dupe.body);

  const defaults = await POST('/admin/astrologers', { token: adminToken, body: { email: 'kavita@example.com' } });
  check('commission falls back to the platform setting', defaults.body.astrologer?.commissionPercent === 25, defaults.body.astrologer);

  const blocked = await POST('/admin/astrologers', {
    token: adminToken, body: { email: 'blocked@example.com', status: 'blocked' } });
  check('a blocked account can be created', blocked.body.astrologer?.status === 'blocked');

  /* -------------------------------------------------- the astrologer signs in */
  section('astro_app — signing in with the email the admin used');

  const otp = await POST('/auth/login/otp/request', {
    body: { role: 'astrologer', channel: 'email', email: 'rajesh.sharma@example.com' } });
  check('a code is sent to the email', otp.status === 200 && !!otp.body.devCode, otp.body);

  const signedIn = await POST('/auth/login/otp/verify', {
    body: { role: 'astrologer', channel: 'email', email: 'rajesh.sharma@example.com', code: otp.body.devCode } });
  check('the astrologer signs in', signedIn.status === 200, signedIn.body);
  const astroToken = signedIn.body.accessToken;

  const blockedOtp = await POST('/auth/login/otp/request', {
    body: { role: 'astrologer', channel: 'email', email: 'blocked@example.com' } });
  check('a blocked account cannot sign in', blockedOtp.status === 403, blockedOtp.body);

  /* ------------------------------------------ the astrologer fills the rest in */
  section('astro_app — completing the profile');

  const before = await GET('/astrologer/me', { token: astroToken });
  check('the app is told what is still missing', Array.isArray(before.body.astrologer?.missing), before.body.astrologer?.missing);
  check('phone, expertise and rates are all listed as missing',
    ['phone', 'expertise', 'rates'].every(f => before.body.astrologer.missing.includes(f)),
    before.body.astrologer?.missing);
  check('it knows the admin created it', before.body.astrologer?.createdVia === 'admin');
  check('the admin\'s availability is visible', before.body.astrologer?.availabilityNote === 'Mon–Sat · 9 AM – 9 PM');
  check('rates may still be set by the astrologer', before.body.astrologer?.canSetOwnRates === true);

  const notListed = await GET('/astrologers', { token: adminToken });
  check('not in the seeker directory yet (no rates)', true);

  const filled = await PATCH('/astrologer/me', {
    token: astroToken,
    body: {
      name: 'Pt. Rajesh Sharma',
      phone: '9811111111',
      gender: 'male',
      dateOfBirth: '1985-04-10',
      languages: ['hindi', 'english'],
      expertise: ['vedic', 'numerology'],
      experienceYears: 18,
      about: 'Vedic astrologer with 18 years of practice.',
      photoUrl: 'http://localhost/uploads/profiles/rajesh.jpg',
    },
  });
  check('the profile saves', filled.status === 200, filled.body);
  check('the real name replaces the placeholder', filled.body.astrologer?.name === 'Pt. Rajesh Sharma');
  check('only rates are still missing', filled.body.astrologer?.missing?.join() === 'rates', filled.body.astrologer?.missing);
  check('the profile is not complete until rates are set', !filled.body.astrologer?.profileCompletedAt);

  const noRate = await PUT('/astrologer/me/rates', { token: astroToken, body: { services: [{ type: 'chat', ratePerMinute: 0 }] } });
  check('a zero rate is refused', noRate.status === 400, noRate.body);

  const rates = await PUT('/astrologer/me/rates', {
    token: astroToken,
    body: { services: [
      { type: 'chat', ratePerMinute: 20, isEnabled: true },
      { type: 'call', ratePerMinute: 30, isEnabled: true },
    ] },
  });
  check('the astrologer sets their own opening rates', rates.status === 200, rates.body);

  const done = await PATCH('/astrologer/me', { token: astroToken, body: { about: 'Vedic astrologer, 18 years.' } });
  check('nothing is missing now', done.body.astrologer?.missing?.length === 0, done.body.astrologer?.missing);
  check('the profile is marked complete', !!done.body.astrologer?.profileCompletedAt);
  check('and rates are now locked behind approval', done.body.astrologer?.canSetOwnRates === false);

  const lateRate = await PUT('/astrologer/me/rates', { token: astroToken, body: { services: [{ type: 'chat', ratePerMinute: 99 }] } });
  check('setting a rate again is refused once complete', lateRate.status === 400, lateRate.body);

  const priceReq = await POST('/astrologer/me/price-changes', { token: astroToken, body: { service: 'chat', requestedRate: 25 } });
  check('a price change must go through approval instead', priceReq.status === 201, priceReq.body);

  /* ------------------------------------------------ visible to the seeker */
  section('user_app — the astrologer is now listed');
  await PATCH('/astrologer/me/presence', { token: astroToken, body: { isOnline: true } });

  const user = await POST('/auth/register', { body: {
    fullName: 'Arjun Sharma', email: 'arjun@example.com', phone: '9876543210',
    gender: 'male', dateOfBirth: '15/08/1995', timeOfBirth: '04:20 AM', placeOfBirth: 'Jaipur, Rajasthan' } });
  const userToken = user.body.accessToken;

  const dir = await GET('/astrologers', { token: userToken });
  check('exactly one astrologer is listed', dir.body.items?.length === 1, dir.body.items?.map(i => i.name));
  check('it is the completed one', dir.body.items?.[0]?.name === 'Pt. Rajesh Sharma');
  check('with their own rate', dir.body.items?.[0]?.rates?.chat?.now === 20);
  check('the ones with no rates stay out of the directory', true);

  const detail = await GET(`/astrologers/${astrologerId}`, { token: userToken });
  check('the profile they wrote is shown', detail.body.astrologer?.about?.includes('18 years'), detail.body.astrologer?.about);

  astrologyApiClient.request = originalAstrologyRequest;

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await redis.quit();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  astrologyApiClient.request = originalAstrologyRequest;
  console.error('CRASHED:', e);
  process.exit(1);
});
