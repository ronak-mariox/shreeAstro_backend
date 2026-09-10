/**
 * The contract between the admin panel and the API.
 *
 * Every endpoint the panel's services/admin.js calls, checked for the fields the
 * pages actually read. A page that reads `row.rates.chat.now` breaks silently if
 * the API stops sending it, so the fields are asserted by name here.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_panel';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test:';
process.env.NODE_ENV = 'development';
process.env.OTP_MASTER_CODE = '123456';

const mongoose = require('mongoose');
const { connectRedis, redis } = require('../config/redis');
const { createApp } = require('../app');
const { hashPassword } = require('../utils/password');
const astrologyApiClient = require('../services/astrologyApi.client');

const PORT = 5090;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
let pass = 0, fail = 0;

const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

/**
 * Registering a user now fires services/user.service.js's
 * enrichZodiacFromBirthDetails in the background (see
 * controllers/auth.controller.js), which would otherwise hit the real
 * AstrologyAPI transport. This file doesn't assert on Moon sign / horoscope
 * content, so an empty geo_details response is enough to make it a silent,
 * free no-op (no place found -> nothing further is ever fetched).
 */
const originalAstrologyRequest = astrologyApiClient.request;

/** Asserts every named path exists on the object (dots walk into it). */
function hasFields(label, object, fields) {
  const missing = fields.filter((path) => {
    let value = object;
    for (const key of path.split('.')) {
      if (value === undefined || value === null) return true;
      value = value[key];
    }
    return value === undefined;
  });
  check(label, missing.length === 0, missing.length ? { missing } : undefined);
}

let adminToken;
async function call(method, p, body) {
  const headers = { Authorization: `Bearer ${adminToken}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const GET = (p) => call('GET', p);
const POST = (p, b) => call('POST', p, b);
const PATCH = (p, b) => call('PATCH', p, b);
const PUT = (p, b) => call('PUT', p, b);
const DELETE = (p) => call('DELETE', p);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await connectRedis();
  const stale = await redis.keys('*');
  if (stale.length) await redis.del(...stale.map((k) => k.replace('shreeastro-test:', '')));

  astrologyApiClient.request = async () => ({ geonames: [] });

  const server = createApp().listen(PORT);
  const Admin = require('../models/Admin');
  await Admin.create({
    name: 'Vaibhav Mehra', email: 'admin@shreeastro.com',
    passwordHash: await hashPassword('admin@123'), role: 'super_admin', status: 'active',
  });

  /* ------------------------------------------------------------ sign in */
  section('LoginPage');
  const step1 = await fetch(`${BASE}/auth/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@shreeastro.com', password: 'admin@123' }),
  }).then((r) => r.json());
  hasFields('step one answers requiresOtp + destination', step1, [
    'requiresOtp', 'email', 'destination', 'resendInSeconds',
  ]);

  const step2 = await fetch(`${BASE}/auth/admin/login/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@shreeastro.com', code: step1.devCode }),
  }).then((r) => r.json());
  hasFields('step two answers a session the shell reads', step2, [
    'accessToken', 'refreshToken', 'admin.id', 'admin.name', 'admin.email', 'admin.role',
    'admin.permissions',
  ]);
  adminToken = step2.accessToken;

  /* ------------------------------------------------------ seed the world */
  const created = await POST('/admin/astrologers', {
    email: 'rajesh@example.com', commissionPercent: 30, availability: 'Mon–Sat · 9–9',
  });
  const astrologerId = created.body.astrologer.id;

  const otp = await fetch(`${BASE}/auth/login/otp/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'astrologer', channel: 'email', email: 'rajesh@example.com' }),
  }).then((r) => r.json());
  const astroToken = await fetch(`${BASE}/auth/login/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'astrologer', channel: 'email', email: 'rajesh@example.com', code: otp.devCode }),
  }).then((r) => r.json()).then((d) => d.accessToken);

  const astro = (p, m, b) => fetch(BASE + p, {
    method: m, headers: { Authorization: `Bearer ${astroToken}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  }).then((r) => r.json());

  await astro('/astrologer/me', 'PATCH', {
    name: 'Pt. Rajesh Sharma', phone: '9811111111', gender: 'male',
    languages: ['hindi'], expertise: ['vedic'], experienceYears: 18,
    about: 'Vedic astrologer.', photoUrl: 'http://x/p.jpg',
  });
  await astro('/astrologer/me/rates', 'PUT', {
    services: [{ type: 'chat', ratePerMinute: 20, isEnabled: true },
               { type: 'call', ratePerMinute: 30, isEnabled: true }],
  });
  await astro('/astrologer/me/presence', 'PATCH', { isOnline: true });
  await astro('/support/tickets', 'POST', {
    issueType: 'payment', description: 'My payout has not arrived after five days.',
  });

  const user = await fetch(`${BASE}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Arjun Sharma', email: 'arjun@example.com', phone: '9876543210',
      gender: 'male', dateOfBirth: '15/08/1995', timeOfBirth: '04:20 AM',
      placeOfBirth: 'Jaipur, Rajasthan',
    }),
  }).then((r) => r.json());
  const userToken = user.accessToken;
  const userId = user.user.id;

  const asUser = (p, m, b) => fetch(BASE + p, {
    method: m, headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  }).then((r) => r.json());

  const order = await asUser('/wallet/topup', 'POST', { amount: 1000 });
  await asUser('/wallet/topup/confirm', 'POST', { transactionId: order.transactionId });
  const chat = await asUser('/chats', 'POST', {
    astrologerId, channel: 'chat', intake: { topic: 'career-job', question: 'Job change?' },
  });
  await astro(`/chats/${chat.chatId}/accept`, 'POST');
  await asUser(`/chats/${chat.chatId}/messages`, 'POST', { content: { text: 'Namaste' } });

  const { ChatSession } = require('../models/Chat');
  await ChatSession.updateOne({ _id: chat.chatId }, {
    startedAt: new Date(Date.now() - 900000),
  });
  await asUser(`/chats/${chat.chatId}/end`, 'POST');
  await asUser(`/chats/${chat.chatId}/rate`, 'POST', { rating: 5, comment: 'Great.' });
  /** A payout needs an approved bank account on file, so file and approve one. */
  const astrologerService = require('../services/astrologer.service');
  await astrologerService.addBankAccount(astrologerId, {
    holderName: 'Rajesh Sharma', bankName: 'State Bank of India',
    accountNumber: '30123456789', ifsc: 'SBIN0001234',
  });
  const withBank = await GET(`/admin/astrologers/${astrologerId}`);
  await PATCH(
    `/admin/astrologers/${astrologerId}/bank-accounts/${withBank.body.bankAccounts[0]._id}`,
    { status: 'approved' },
  );
  const withdrawal = await astro('/wallet/withdrawals', 'POST', { amount: 150 });
  check('the astrologer can request a payout', !!withdrawal.withdrawal?.id, withdrawal);

  /* -------------------------------------------------------- DashboardPage */
  section('DashboardPage');
  const dash = await GET('/admin/dashboard?days=7');
  hasFields('the four KPI tiles', dash.body, [
    'users.total', 'users.newThisMonth',
    'astrologers.active', 'astrologers.pendingApplications',
    'consultations.today', 'consultations.ongoing',
    'revenue.chargedThisMonth', 'revenue.paidToAstrologers', 'revenue.platformThisMonth',
  ]);
  check('the consultation chart', Array.isArray(dash.body.consultationMix));
  check('chart rows carry a day and a channel',
    dash.body.consultationMix.every((r) => r._id?.day && r._id?.channel),
    dash.body.consultationMix[0]);

  const live = await GET('/admin/consultations?status=active');
  check('the "live now" card', Array.isArray(live.body.items));

  /* ------------------------------------------------------------ UsersPage */
  section('UsersPage');
  const users = await GET('/admin/users?limit=100');
  hasFields('the user table row', users.body.items[0], [
    'id', 'name', 'email', 'phone', 'signup', 'joined', 'lastActive',
    'consults', 'kundlis', 'spent', 'wallet', 'status', 'verified',
  ]);
  const userDetail = await GET(`/admin/users/${userId}`);
  hasFields('the user drawer', userDetail.body.user, [
    'id', 'name', 'email', 'phone', 'signup', 'status', 'verified',
    'wallet.balance', 'wallet.totalSpent', 'stats.consultations',
    'birthDetails.dateOfBirth', 'kundlis', 'consultations',
  ]);
  check('the drawer carries recent consultations',
    userDetail.body.user.consultations.length === 1,
    userDetail.body.user.consultations);
  const blocked = await PATCH(`/admin/users/${userId}/status`, { status: 'blocked', reason: 'Test' });
  check('block answers the new status', blocked.body.status === 'blocked', blocked.body);
  await PATCH(`/admin/users/${userId}/status`, { status: 'active' });

  /* ----------------------------------------------------- AstrologersPage */
  section('AstrologersPage');
  const astros = await GET('/admin/astrologers?limit=100');
  hasFields('the astrologer table row', astros.body.items[0], [
    'id', 'name', 'email', 'expertise', 'languages', 'experienceYears',
    'rating', 'consultations', 'earnings', 'commissionPercent',
    'applicationStatus', 'status', 'online',
  ]);
  const detail = await GET(`/admin/astrologers/${astrologerId}`);
  hasFields('the astrologer drawer', detail.body, [
    'astrologer._id', 'astrologer.name', 'astrologer.email', 'astrologer.services',
    'astrologer.commissionPercent', 'astrologer.metrics.rating', 'astrologer.earnings.lifetime',
    'astrologer.createdVia', 'astrologer.availabilityNote',
    'profile.verification.documentsStatus', 'documents', 'bankAccounts', 'priceChangeRequests',
  ]);
  check('the create form answers what the page reads',
    created.status === 201 && created.body.astrologer.astroCode && created.body.astrologer.email,
    created.body);

  /* --------------------------------------------------- ConsultationsPage */
  section('ConsultationsPage');
  const sessions = await GET('/admin/consultations?limit=100');
  hasFields('the consultation table row', sessions.body.items[0], [
    'id', 'user', 'astrologer', 'channel', 'topic', 'started',
    'durationSeconds', 'rate', 'amount', 'status',
  ]);
  const session = await GET(`/admin/consultations/${chat.chatId}`);
  hasFields('the session drawer', session.body.consultation, [
    'id', 'channel', 'status', 'topic', 'user.name', 'user.walletBalance',
    'astrologer.name', 'billing.ratePerMinute', 'billing.amountCharged',
    'billing.astrologerEarning', 'billing.platformEarning', 'billing.commissionPercent',
    'requestedAt', 'startedAt', 'endedAt', 'durationSeconds', 'messageCount', 'messages',
  ]);
  check('the transcript comes through', session.body.consultation.messages.length >= 2,
    session.body.consultation.messages.length);
  check('the review comes through', session.body.consultation.review?.rating === 5);

  /* -------------------------------------------------------- PaymentsPage */
  section('PaymentsPage');
  const txns = await GET('/admin/transactions?limit=100');
  hasFields('the ledger row', txns.body.items[0], [
    '_id', 'reference', 'ownerRole', 'direction', 'type', 'status',
    'amount', 'balanceAfter', 'createdAt',
  ]);
  const debit = txns.body.items.find((t) => t.direction === 'debit' && t.status === 'success');
  const refunded = await POST(`/admin/transactions/${debit._id}/refund`, { reason: 'Test refund' });
  check('a refund posts a new credit row',
    refunded.status === 200 && refunded.body.transaction.type === 'refund',
    refunded.body);

  /* --------------------------------------------------------- WalletsPage */
  section('WalletsPage');
  const wallets = await GET('/admin/wallets?limit=100');
  hasFields('the wallet row', wallets.body.items[0], [
    'id', 'ownerRole', 'holder', 'balance', 'added', 'spent',
  ]);
  check('both kinds of wallet are listed',
    new Set(wallets.body.items.map((w) => w.ownerRole)).size === 2,
    wallets.body.items.map((w) => w.ownerRole));

  const adjusted = await POST('/admin/wallets/adjust', {
    ownerRole: 'user', ownerId: userId, direction: 'credit', amount: 250,
    reason: 'Goodwill after a dropped session',
  });
  check('a manual adjustment lands', adjusted.status === 201, adjusted.body);

  const payouts = await GET('/admin/withdrawals?limit=100');
  hasFields('the payout row', payouts.body.items[0], [
    '_id', 'reference', 'amount', 'status', 'requestedAt',
    'astrologer.name', 'bankAccount.bankName', 'bankAccount.accountNumber',
  ]);

  /* --------------------------------------------------------- ContentPage */
  section('ContentPage');
  const article = await POST('/admin/articles', {
    title: 'Understanding Your Mahadasha Cycle', category: 'Astrology Basics',
    author: 'Pt. Rajesh Sharma', excerpt: 'A short summary.', body: 'Full text.',
    status: 'published', visibility: 'everyone',
  });
  hasFields('a created article', article.body.article, [
    '_id', 'title', 'slug', 'category', 'author', 'excerpt',
    'status', 'visibility', 'views', 'updatedAt',
  ]);
  const articles = await GET('/admin/articles?limit=100');
  check('the article table', articles.body.items.length === 1);

  /* --------------------------------------------------------- ReportsPage */
  section('ReportsPage');
  const reports = await GET('/admin/reports?days=30');
  hasFields('the reports page', reports.body, [
    'newUsers', 'newAstrologers', 'activityTrend', 'signupSplit',
    'topicSplit', 'topAstrologers',
    'summary.consultations', 'summary.consultationMinutes',
    'summary.grossCollections', 'summary.astrologerPayouts', 'summary.platformRevenue',
  ]);
  check('the activity trend has a date and a count',
    reports.body.activityTrend.every((r) => r.date && r.sessions !== undefined),
    reports.body.activityTrend[0]);
  check('the top astrologers carry a name',
    reports.body.topAstrologers[0]?.name === 'Pt. Rajesh Sharma',
    reports.body.topAstrologers);

  /* -------------------------------------------------------- SettingsPage */
  section('SettingsPage');
  const settings = await GET('/admin/settings');
  hasFields('the settings form', settings.body.settings, [
    'commissionPercent', 'minRecharge', 'maxRecharge', 'minPayout',
    'payoutCycle',
    'features.registrationsOpen', 'features.appleSignIn', 'features.googleSignIn',
    'features.aiAssistant', 'features.voiceConsultations',
    'features.autoApproveAstrologers', 'features.adminTwoFactor', 'features.maintenanceMode',
    'appVersions.userAndroid', 'appVersions.minimumSupported',
  ]);
  const saved = await PATCH('/admin/settings', {
    commissionPercent: 30, minRecharge: 50, features: { aiAssistant: false },
  });
  check('saving keeps the untouched switches',
    saved.body.settings.features.aiAssistant === false &&
    saved.body.settings.features.registrationsOpen === true,
    saved.body.settings.features);

  const team = await GET('/admin/team');
  hasFields('the team row', team.body.items[0], [
    'id', 'name', 'email', 'role', 'status', 'permissions', 'createdAt',
  ]);
  const invited = await POST('/admin/team', {
    name: 'Karan Doshi', email: 'finance@shreeastro.com', role: 'finance',
  });
  hasFields('the created admin, with its one-time password', invited.body, [
    'admin.id', 'admin.email', 'admin.role', 'temporaryPassword',
  ]);

  const tickets = await GET('/admin/support-tickets');
  hasFields('the support ticket row', tickets.body.items[0], [
    '_id', 'reference', 'ownerRole', 'ownerName', 'issueType', 'description',
    'status', 'createdAt',
  ]);

  /** The "Other" third parties — a plain reference record, not a live integration. */
  const thirdParty = await POST('/admin/third-parties', {
    name: 'Cashfree', category: 'payment_gateway', identifier: 'acct_9F2K', notes: 'Backup gateway.',
  });
  hasFields('a created third party', thirdParty.body.thirdParty, [
    '_id', 'name', 'category', 'identifier', 'enabled', 'notes', 'updatedAt',
  ]);
  const thirdParties = await GET('/admin/third-parties');
  check('the third-party table', thirdParties.body.items.length === 1, thirdParties.body);

  const thirdPartyId = thirdParty.body.thirdParty._id;
  const editedThirdParty = await PUT(`/admin/third-parties/${thirdPartyId}`, { enabled: false });
  check('it can be edited', editedThirdParty.body.thirdParty?.enabled === false, editedThirdParty.body);

  const removedThirdParty = await DELETE(`/admin/third-parties/${thirdPartyId}`);
  check('and removed', removedThirdParty.body.deleted === true, removedThirdParty.body);
  const thirdPartiesAfter = await GET('/admin/third-parties');
  check('gone from the table', thirdPartiesAfter.body.items.length === 0, thirdPartiesAfter.body);

  /* ------------------------------------------------------- AuditLogsPage */
  section('AuditLogsPage');
  const logs = await GET('/admin/audit-logs?limit=200');
  hasFields('the audit row', logs.body.items[0], [
    '_id', 'adminName', 'adminRole', 'action', 'area', 'target', 'createdAt',
  ]);
  check('every change made above was logged', logs.body.items.length >= 6, logs.body.total);
  check('the areas match the page filters',
    logs.body.items.every((row) =>
      ['Users', 'Astrologers', 'Consultations', 'Payments', 'Wallets', 'Content', 'Settings', 'Third parties']
        .includes(row.area)),
    [...new Set(logs.body.items.map((r) => r.area))]);

  astrologyApiClient.request = originalAstrologyRequest;

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await redis.quit();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  astrologyApiClient.request = originalAstrologyRequest;
  console.error('CRASHED:', e);
  process.exit(1);
});
