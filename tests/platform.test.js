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

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await connectRedis();
  const stale = await redis.keys('*');
  if (stale.length) await redis.del(...stale.map(k => k.replace('shreeastro-test:', '')));

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
    freeTrialMinutes: 5, payoutCycle: 'monthly',
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
  check('free minutes follow the new setting', chat.body.freeMinutes === 5, chat.body);

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
  const home = await GET('/users/me/home', { token: userToken });
  check('the home screen comes back in one call', home.status === 200, Object.keys(home.body));
  check('it carries the wallet', home.body.wallet?.balance !== undefined);
  check('and the planet positions', home.body.planetPositions?.planets?.length === 6);
  check('and the recent consultation', home.body.recentConsultations?.length === 1, home.body.recentConsultations);

  const horoscope = await GET('/horoscope?sign=Leo');
  check('a horoscope reads without a token', horoscope.status === 200, horoscope.body);
  check('it has a reading and a lucky number', !!horoscope.body.horoscope?.reading && !!horoscope.body.horoscope?.luckyNumber);
  const again = await GET('/horoscope?sign=Leo');
  check('the same sign gets the same reading all day', again.body.horoscope.reading === horoscope.body.horoscope.reading);
  const all = await GET('/horoscope');
  check('all twelve signs come back at once', all.body.items?.length === 12);

  const ai = await GET('/chats/ai', { token: userToken });
  check('the AI thread opens with a greeting', ai.body.items?.[0]?.content?.text?.includes('Namaste'), ai.body.items?.[0]);
  const asked = await POST('/chats/ai/messages', { token: userToken, body: { text: 'What does my Jupiter placement mean?' } });
  check('asking returns both turns', asked.status === 201 && !!asked.body.question && !!asked.body.answer, asked.body);
  check('the answer is from the assistant', asked.body.answer?.senderRole === 'ai');
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

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await redis.quit();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
