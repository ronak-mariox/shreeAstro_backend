/**
 * The rest of what the three UIs need: settings, the admin team, wallets,
 * reports, support, the astrologer dashboard, the home screen, the horoscope
 * and the AI assistant.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_platform';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test:';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const { connectRedis, redis } = require('../config/redis');
const { createApp } = require('../app');
const { hashPassword } = require('../utils/password');
const UserProfile = require('../models/UserProfile');
const astrologyApiClient = require('../services/astrologyApi.client');
const llm = require('../services/llm');
const geoDetailsFixture = require('./fixtures/astrologyapi/geo_details.json');
const timezoneFixture = require('./fixtures/astrologyapi/timezone_with_dst.json');
const astroDetailsFixture = require('./fixtures/astrologyapi/astro_details.json');
const planetsExtendedFixture = require('./fixtures/astrologyapi/planets_extended.json');

const PORT = 5094;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);
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
const DELETE = (p, o) => call('DELETE', p, o);

/**
 * Registration fires enrichZodiacFromBirthDetails in the background without
 * awaiting it (see controllers/auth.controller.js) — this polls the profile
 * directly rather than assuming the many awaited calls in between give it
 * enough time, so the Home check below can never be a flaky race.
 */
async function waitForZodiac(userId, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    const doc = await UserProfile.findOne({ user: userId }).lean();
    if (doc?.zodiac?.moonSign) {
      return doc;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return UserProfile.findOne({ user: userId }).lean();
}

/**
 * Stubbed for the WHOLE file, from before the very first /auth/register call:
 * registering a user now fires services/user.service.js's
 * enrichZodiacFromBirthDetails in the background (see
 * controllers/auth.controller.js), which geocodes the typed birth place and
 * fetches astro_details through the exact same AstrologyAPI transport this
 * suite would otherwise hit for real. Declared here (not inside the IIFE
 * below) so both it and the top-level .catch can restore it. Restored right
 * before mongoose.disconnect() at the very end.
 */
const originalRequest = astrologyApiClient.request;
/**
 * Stubbed the same way and for the same reason as astrologyApiClient.request
 * above: /chats/ai/messages now calls services/assistant.service.js's
 * generateReply for real, which calls this for real — this suite has no
 * business making an actual Groq/OpenAI call (or needing LLM_PROVIDER
 * configured at all) just to prove the HTTP plumbing around it works.
 */
const originalLlmChat = llm.chat;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await connectRedis();
  const stale = await redis.keys('*');
  if (stale.length) await redis.del(...stale.map(k => k.replace('shreeastro-test:', '')));

  astrologyApiClient.request = async path => {
    if (path === 'timezone_with_dst') return timezoneFixture;
    if (path === 'astro_details') return astroDetailsFixture;
    if (path === 'planets/extended') return planetsExtendedFixture;
    if (path.startsWith('sun_sign_prediction/')) {
      return {
        status: true,
        sun_sign: path.split('/').pop(),
        prediction: {
          personal_life: 'x', profession: 'x', health: 'x', emotions: 'x', travel: 'x',
          luck: 'A steady day for confident, quiet progress.',
        },
      };
    }
    return geoDetailsFixture;
  };

  const server = createApp().listen(PORT);
  const Admin = require('../models/Admin');
  await Admin.create({ name: 'Vaibhav Mehra', email: 'admin@shreeastro.com',
    passwordHash: await hashPassword('SuperSecret123'), role: 'super_admin', status: 'active' });
  /** Two-factor is on by default, so signing in takes two calls. */
  const adminStep1 = await POST('/auth/admin/login', {
    body: { email: 'admin@shreeastro.com', password: 'SuperSecret123' } });
  const adminToken = (await POST('/auth/admin/login/verify', {
    body: { email: 'admin@shreeastro.com', code: adminStep1.body.devCode } })).body.accessToken;

  /* --------------------------------------------------------------- settings */
  section('admin_panel — platform settings');
  const settings = await GET('/admin/settings', { token: adminToken });
  check('settings exist without being seeded', settings.body.settings?.commissionPercent === 25, settings.body.settings);
  check('feature switches are there', settings.body.settings?.features?.registrationsOpen === true);

  const changed = await PATCH('/admin/settings', { token: adminToken, body: {
    commissionPercent: 30, minRecharge: 50, maxRecharge: 50000, minPayout: 500,
    payoutCycle: 'monthly',
    features: { aiAssistant: false } } });
  check('settings save', changed.body.settings?.minRecharge === 50, changed.body.settings);
  check('one switch changes without clearing the others',
    changed.body.settings.features.aiAssistant === false &&
    changed.body.settings.features.registrationsOpen === true,
    changed.body.settings.features);

  const pub = await GET('/settings');
  check('the apps can read the public subset with no token', pub.status === 200, pub.body);
  check('it carries the limits', pub.body.settings?.minRecharge === 50);
  check('but not the commission', pub.body.settings?.commissionPercent === undefined);

  /* ------------------------------------------------ settings actually apply */
  section('the settings actually govern the money paths');
  const user = await POST('/auth/register', { body: {
    fullName: 'Arjun Sharma', email: 'arjun@example.com', phone: '9876543210',
    gender: 'male', dateOfBirth: '15/08/1995', timeOfBirth: '04:20 AM', placeOfBirth: 'Jaipur, Rajasthan' } });
  const userToken = user.body.accessToken;
  const userId = user.body.user.id;

  const tooSmall = await POST('/wallet/topup', { token: userToken, body: { amount: 20 } });
  check('a top-up under the new minimum is refused', tooSmall.status === 400 && /50/.test(tooSmall.body.error), tooSmall.body);
  const ok = await POST('/wallet/topup', { token: userToken, body: { amount: 1000 } });
  check('one above it is accepted', ok.status === 201);
  await POST('/wallet/topup/confirm', { token: userToken, body: { transactionId: ok.body.transactionId } });

  /* ------------------------------------------------------------ admin team */
  section('admin_panel — the admin team');
  const team = await GET('/admin/team', { token: adminToken });
  check('the team lists', team.body.items?.length === 1, team.body);

  const invited = await POST('/admin/team', { token: adminToken, body: {
    name: 'Karan Doshi', email: 'finance@shreeastro.com', role: 'finance' } });
  check('a colleague is added', invited.status === 201, invited.body);
  check('a temporary password comes back once', typeof invited.body.temporaryPassword === 'string');

  const financeStep1 = await POST('/auth/admin/login', { body: {
    email: 'finance@shreeastro.com', password: invited.body.temporaryPassword } });
  check('they can sign in with it', financeStep1.status === 200, financeStep1.body);
  const financeLogin = await POST('/auth/admin/login/verify', { body: {
    email: 'finance@shreeastro.com', code: financeStep1.body.devCode } });
  const financeToken = financeLogin.body.accessToken;

  const financeBlocked = await GET('/admin/team', { token: financeToken });
  check('finance cannot manage the team', financeBlocked.status === 403);

  const badRole = await POST('/admin/team', { token: adminToken, body: { email: 'x@y.com', role: 'wizard' } });
  check('an unknown role is refused', badRole.status === 400, badRole.body);

  const selfSuspend = await PATCH(`/admin/team/${team.body.items[0].id}`, { token: adminToken, body: { status: 'suspended' } });
  check('an admin cannot suspend themselves', selfSuspend.status === 400, selfSuspend.body);

  const promoted = await PATCH(`/admin/team/${invited.body.admin.id}`, { token: adminToken, body: { role: 'support_lead' } });
  check('a role can be changed', promoted.body.admin?.role === 'support_lead');

  const revoked = await DELETE(`/admin/team/${invited.body.admin.id}`, { token: adminToken });
  check('access is revoked by suspending, not deleting', revoked.body.status === 'suspended', revoked.body);
  const afterRevoke = await POST('/auth/admin/login', { body: {
    email: 'finance@shreeastro.com', password: invited.body.temporaryPassword } });
  check('a revoked admin cannot sign in', afterRevoke.status === 403, afterRevoke.body);

  /* ------------------------------------------------------ forgot password */
  section('admin_panel — forgot password');
  const unknownReset = await POST('/auth/admin/forgot-password', { body: { email: 'nobody@shreeastro.com' } });
  check('an unknown email is answered the same shape as a real one — no way to learn who is an admin', unknownReset.status === 200 && unknownReset.body.requested === true, unknownReset.body);
  check('and carries no devCode, since nothing was actually sent', unknownReset.body.devCode === undefined);

  const resetRequest = await POST('/auth/admin/forgot-password', { body: { email: 'admin@shreeastro.com' } });
  check('a real admin gets a code', resetRequest.status === 200 && typeof resetRequest.body.devCode === 'string', resetRequest.body);

  const wrongCode = await POST('/auth/admin/reset-password', {
    body: { email: 'admin@shreeastro.com', code: '000000', password: 'BrandNewPass1' } });
  check('the wrong code is refused', wrongCode.status === 401, wrongCode.body);

  const stillOldPassword = await POST('/auth/admin/login', {
    body: { email: 'admin@shreeastro.com', password: 'SuperSecret123' } });
  check('the old password still works after a refused reset attempt', stillOldPassword.status === 200, stillOldPassword.body);

  const resetDone = await POST('/auth/admin/reset-password', {
    body: { email: 'admin@shreeastro.com', code: resetRequest.body.devCode, password: 'BrandNewPass1' } });
  check('the correct code resets the password', resetDone.status === 200 && resetDone.body.reset === true, resetDone.body);

  const oldPasswordNowFails = await POST('/auth/admin/login', {
    body: { email: 'admin@shreeastro.com', password: 'SuperSecret123' } });
  check('the old password is refused once reset', oldPasswordNowFails.status === 401, oldPasswordNowFails.body);

  const newPasswordWorks = await POST('/auth/admin/login', {
    body: { email: 'admin@shreeastro.com', password: 'BrandNewPass1' } });
  check('the new password signs in', newPasswordWorks.status === 200, newPasswordWorks.body);

  /* --------------------------------------------------------------- wallets */
  section('admin_panel — wallets');
  const wallets = await GET('/admin/wallets', { token: adminToken });
  check('seekers and astrologers appear in one table', wallets.body.items?.length >= 1, wallets.body.total);
  check('the rows say which kind they are', wallets.body.items?.[0]?.ownerRole === 'user');

  const noReason = await POST('/admin/wallets/adjust', { token: adminToken, body: {
    ownerRole: 'user', ownerId: userId, direction: 'credit', amount: 100 } });
  check('an adjustment without a reason is refused', noReason.status === 400, noReason.body);

  const adjusted = await POST('/admin/wallets/adjust', { token: adminToken, body: {
    ownerRole: 'user', ownerId: userId, direction: 'credit', amount: 250,
    reason: 'Goodwill after a dropped session' } });
  check('a manual credit lands', adjusted.status === 201, adjusted.body);
  const walletNow = await GET('/wallet', { token: userToken });
  check('and moves the balance', walletNow.body.wallet?.balance === 1250, walletNow.body.wallet);
  check('the row is traceable to the admin', !!adjusted.body.transaction?.createdByAdmin);

  /* ------------------------------------------- astrologer created and set up */
  section('astro_app — dashboard, support and reviews');
  const created = await POST('/admin/astrologers', { token: adminToken, body: {
    email: 'rajesh@example.com', commissionPercent: 30, availability: 'Mon–Sat · 9–9' } });
  const astrologerId = created.body.astrologer.id;
  const otp = await POST('/auth/login/otp/request', { body: {
    role: 'astrologer', channel: 'email', email: 'rajesh@example.com' } });
  const astroToken = (await POST('/auth/login/otp/verify', { body: {
    role: 'astrologer', channel: 'email', email: 'rajesh@example.com', code: otp.body.devCode } })).body.accessToken;

  await PATCH('/astrologer/me', { token: astroToken, body: {
    name: 'Pt. Rajesh Sharma', phone: '9811111111', gender: 'male',
    languages: ['hindi'], expertise: ['vedic'], experienceYears: 18,
    about: 'Vedic astrologer.', photoUrl: 'http://x/p.jpg' } });
  await PUT('/astrologer/me/rates', { token: astroToken, body: {
    services: [{ type: 'chat', ratePerMinute: 20, isEnabled: true }] } });
  await PATCH('/astrologer/me/presence', { token: astroToken, body: { isOnline: true } });

  const dash = await GET('/astrologer/me/dashboard', { token: astroToken });
  check('the dashboard comes back in one call', dash.status === 200, dash.body);
  check('it carries earnings, performance and services',
    dash.body.earnings !== undefined && dash.body.performance !== undefined && Array.isArray(dash.body.services),
    Object.keys(dash.body));
  check('and how many requests are waiting', dash.body.pendingRequests === 0);

  const ticket = await POST('/support/tickets', { token: astroToken, body: {
    issueType: 'payment', description: 'My payout has not arrived after five days.' } });
  check('a support ticket is filed', ticket.status === 201 && !!ticket.body.ticket?.reference, ticket.body);

  const shortTicket = await POST('/support/tickets', { token: astroToken, body: { issueType: 'payment', description: 'help' } });
  check('a too-short description is refused', shortTicket.status === 400, shortTicket.body);

  const queue = await GET('/admin/support-tickets', { token: adminToken });
  check('the admin sees it', queue.body.items?.length === 1, queue.body);
  const resolved = await PATCH(`/admin/support-tickets/${queue.body.items[0]._id}`, {
    token: adminToken, body: { status: 'resolved', resolution: 'Paid out today.' } });
  check('the admin resolves it', resolved.body.ticket?.status === 'resolved');

  const mine = await GET('/support/tickets', { token: astroToken });
  check('the astrologer sees the answer', mine.body.items?.[0]?.resolution === 'Paid out today.');

  /* ------------------------------------------------- a consultation + review */
  const chat = await POST('/chats', { token: userToken, body: {
    astrologerId, channel: 'chat', intake: { topic: 'career-job', question: 'Job change?' } } });
  await POST(`/chats/${chat.body.chatId}/accept`, { token: astroToken });

  const { ChatSession } = require('../models/Chat');
  await ChatSession.updateOne({ _id: chat.body.chatId }, { startedAt: new Date(Date.now() - 600000) });

  section('admin_panel — ending a live session');
  const live = await GET('/admin/consultations?status=active', { token: adminToken });
  check('a live session is visible', live.body.items?.length === 1);
  const forced = await POST(`/admin/consultations/${chat.body.chatId}/end`, {
    token: adminToken, body: { reason: 'Abusive language reported' } });
  check('an admin can end it', forced.body.status === 'ended', forced.body);
  check('and it still bills for the time used', forced.body.amountCharged > 0, forced.body);

  await POST(`/chats/${chat.body.chatId}/rate`, { token: userToken, body: { rating: 2, comment: 'Too short.' } });

  section('astro_app — flagging and pinning a review');
  const reviews = await GET('/astrologer/me/reviews', { token: astroToken });
  const reviewId = reviews.body.items[0].id;
  const flagged = await POST(`/astrologer/me/reviews/${reviewId}/flag`, {
    token: astroToken, body: { reason: 'The session was ended by an admin, not by me.' } });
  check('a review can be flagged', flagged.body.flagged === true, flagged.body);
  check('the monthly allowance goes down', flagged.body.flagsRemaining === 59, flagged.body);
  const unflagged = await POST(`/astrologer/me/reviews/${reviewId}/flag`, { token: astroToken });
  check('flagging toggles, and gives the allowance back', unflagged.body.flagged === false && unflagged.body.flagsRemaining === 60);
  const pinned = await POST(`/astrologer/me/reviews/${reviewId}/pin`, { token: astroToken });
  check('a review can be pinned', pinned.body.pinned === true);

  /* ---------------------------------------------------------------- user_app */
  section('user_app — home, horoscope and the AI assistant');
  /** Registering above already kicked off the real Moon-sign enrichment in the background — wait for it rather than assuming the calls in between were enough. */
  const enrichedProfile = await waitForZodiac(userId);
  check('the Moon sign was resolved from the DOB+time+place on file (astro_details, faked)', enrichedProfile?.zodiac?.moonSign === 'Pisces');

  const home = await GET('/users/me/home', { token: userToken });
  check('the home screen comes back in one call', home.status === 200, Object.keys(home.body));
  check('it carries the wallet', home.body.wallet?.balance !== undefined);
  /** All 9 classical grahas now — this used to be a 6-planet synthetic placeholder; see services/transitPlanets.service.js. */
  check('and the planet positions', home.body.planetPositions?.planets?.length === 9);
  check('and the recent consultation', home.body.recentConsultations?.length === 1, home.body.recentConsultations);
  /** The real Vedic Moon sign ("rashi") — profile.sunSign used to always be blank; see services/user.service.js. */
  check('the rashi is the real Moon sign, not a Western Sun sign guess', home.body.profile?.moonSign === 'Pisces');
  check('and a real horoscope reading for that Moon sign comes along with it', home.body.horoscope?.reading?.length > 0 && !!home.body.horoscope?.luckyNumber);

  const horoscope = await GET('/horoscope?sign=Leo');
  check('a horoscope reads without a token', horoscope.status === 200, horoscope.body);
  check('it has a reading and a lucky number', !!horoscope.body.horoscope?.reading && !!horoscope.body.horoscope?.luckyNumber);
  const again = await GET('/horoscope?sign=Leo');
  check('the same sign gets the same reading all day', again.body.horoscope.reading === horoscope.body.horoscope.reading);
  const all = await GET('/horoscope');
  check('all twelve signs come back at once', all.body.items?.length === 12);

  const ai = await GET('/chats/ai', { token: userToken });
  check('the AI thread opens with a greeting', ai.body.items?.[0]?.content?.text?.includes('Namaste'), ai.body.items?.[0]);

  llm.chat = async messages => {
    /** This user never generated a kundli (no /birth-profiles call anywhere in this suite) — proving the assistant says so plainly instead of answering as if it had a chart. */
    check('the model is told plainly there is no chart yet, rather than being left to guess', messages[0]?.role === 'system' && messages[0]?.content.includes('No birth chart is on file'));
    check('the user\'s own new question rides along as the newest turn, via getRecentMessages reading it straight back', messages.at(-1)?.role === 'user' && messages.at(-1)?.content === 'What does my Jupiter placement mean?');
    return { type: 'text', text: 'I don\'t have your birth chart on file yet — generate your kundli from the Kundli tab and ask me again!' };
  };
  const asked = await POST('/chats/ai/messages', { token: userToken, body: { text: 'What does my Jupiter placement mean?' } });
  check('asking returns both turns', asked.status === 201 && !!asked.body.question && !!asked.body.answer, asked.body);
  check('the answer is from the assistant', asked.body.answer?.senderRole === 'ai');
  check('and is the (faked) model\'s real reply, not a canned stub', asked.body.answer?.content?.text === 'I don\'t have your birth chart on file yet — generate your kundli from the Kundli tab and ask me again!');
  llm.chat = originalLlmChat;

  const reopened = await GET('/chats/ai', { token: userToken });
  check('the thread is kept, not recreated', reopened.body.chatId === ai.body.chatId && reopened.body.items.length === 3);
  const empty = await POST('/chats/ai/messages', { token: userToken, body: { text: '  ' } });
  check('an empty question is refused', empty.status === 400);

  /* ---------------------------------------------------------------- reports */
  section('admin_panel — reports');
  const reports = await GET('/admin/reports?days=30', { token: adminToken });
  check('reports come back', reports.status === 200, Object.keys(reports.body));
  check('with a business summary', reports.body.summary?.consultations === 1, reports.body.summary);
  check('the platform revenue is the collection minus the payout',
    reports.body.summary.platformRevenue === reports.body.summary.grossCollections - reports.body.summary.astrologerPayouts,
    reports.body.summary);
  check('and a signup split', Array.isArray(reports.body.signupSplit), reports.body.signupSplit);
  check('and the top astrologers', reports.body.topAstrologers?.[0]?.name === 'Pt. Rajesh Sharma', reports.body.topAstrologers);

  astrologyApiClient.request = originalRequest;
  llm.chat = originalLlmChat;

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await redis.quit();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  astrologyApiClient.request = originalRequest;
  llm.chat = originalLlmChat;
  console.error('CRASHED:', e);
  process.exit(1);
});
