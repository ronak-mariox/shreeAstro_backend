/**
 * The contract between the two apps and the API.
 *
 * Every endpoint astro_app's services/api.ts and user_app's services call,
 * checked for the fields the screens actually read.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_apps';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test:';
process.env.NODE_ENV = 'development';
process.env.OTP_MASTER_CODE = '123456';

const mongoose = require('mongoose');
const { connectRedis, redis } = require('../config/redis');
const { createApp } = require('../app');
const { hashPassword } = require('../utils/password');
const astrologyApiClient = require('../services/astrologyApi.client');
const llm = require('../services/llm');

const PORT = 5089;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
let pass = 0, fail = 0;

const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

/**
 * Registering a user fires enrichZodiacFromBirthDetails in the background
 * (see controllers/auth.controller.js), and this file also reads the real
 * GET /horoscope directly — both would otherwise hit the live AstrologyAPI
 * transport. geo_details resolving to no results makes the enrichment a
 * silent, free no-op; sun_sign_prediction still needs a realistic shape,
 * since /horoscope's response fields are asserted below.
 */
const originalAstrologyRequest = astrologyApiClient.request;
/** POST /chats/ai/messages now calls services/assistant.service.js's generateReply for real, which calls this for real — stubbed for the same reason as astrologyApiClient.request above. */
const originalLlmChat = llm.chat;

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

const call = (token) => async (method, p, body) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await connectRedis();
  const stale = await redis.keys('*');
  if (stale.length) await redis.del(...stale.map((k) => k.replace('shreeastro-test:', '')));

  astrologyApiClient.request = async path => {
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
    return { geonames: [] };
  };

  const server = createApp().listen(PORT);
  const Admin = require('../models/Admin');
  await Admin.create({
    name: 'Admin', email: 'admin@shreeastro.com',
    passwordHash: await hashPassword('admin@123'), role: 'super_admin', status: 'active',
  });

  const anon = call(null);
  const login = await anon('POST', '/auth/admin/login', { email: 'admin@shreeastro.com', password: 'admin@123' });
  const adminSession = await anon('POST', '/auth/admin/login/verify', {
    email: 'admin@shreeastro.com', code: login.body.devCode,
  });
  const admin = call(adminSession.body.accessToken);

  /* --------------------------------------------------------- astro_app */
  section('astro_app — signing in');
  const created = await admin('POST', '/admin/astrologers', {
    email: 'rajesh@example.com', commissionPercent: 30, availability: 'Mon–Sat · 9–9',
  });
  const astrologerId = created.body.astrologer.id;

  const otp = await anon('POST', '/auth/login/otp/request', {
    role: 'astrologer', channel: 'email', email: 'rajesh@example.com',
  });
  hasFields('the OTP request the login screen reads', otp.body, [
    'channel', 'destination', 'expiresInSeconds', 'resendInSeconds',
  ]);

  const session = await anon('POST', '/auth/login/otp/verify', {
    role: 'astrologer', channel: 'email', email: 'rajesh@example.com', code: otp.body.devCode,
  });
  hasFields('the session the app stores', session.body, [
    'accessToken', 'refreshToken',
    'astrologer.id', 'astrologer.name', 'astrologer.applicationStatus', 'astrologer.onboardingStep',
  ]);
  const astro = call(session.body.accessToken);

  section('astro_app — profile and rates');
  const me = await astro('GET', '/astrologer/me');
  hasFields('what fetchProfile maps from', me.body.astrologer, [
    'astroCode', 'name', 'email', 'applicationStatus',
    'languages', 'expertise', 'experienceYears',
    'missing', 'canSetOwnRates', 'createdVia',
  ]);

  await astro('PATCH', '/astrologer/me', {
    name: 'Pt. Rajesh Sharma', phone: '9811111111', gender: 'male',
    languages: ['hindi', 'english'], expertise: ['vedic'], experienceYears: 18,
    about: 'Vedic astrologer.', photoUrl: 'http://x/p.jpg',
  });
  const rates = await astro('PUT', '/astrologer/me/rates', {
    services: [{ type: 'chat', ratePerMinute: 20, isEnabled: true },
               { type: 'call', ratePerMinute: 30, isEnabled: true }],
  });
  check('setting the opening rates answers the service list', Array.isArray(rates.body.services), rates.body);

  const table = await astro('GET', '/astrologer/me/service-rates');
  hasFields('what the Price Change table maps from', table.body.items[0], [
    'service', 'ratePerMinute', 'effectiveRate', 'offerPercent', 'isEnabled',
  ]);

  section('astro_app — dashboard');
  await astro('PATCH', '/astrologer/me/presence', { isOnline: true });
  const dash = await astro('GET', '/astrologer/me/dashboard');
  hasFields('the dashboard screen', dash.body, [
    'name', 'isOnline',
    'earnings.today', 'earnings.balance', 'earnings.thisMonth', 'earnings.lifetime',
    'performance.consultationsToday', 'performance.rating', 'performance.acceptance',
    'services', 'pendingRequests', 'missing', 'applicationStatus',
  ]);

  /* ---------------------------------------------------------- user_app */
  section('user_app — register and home');
  const user = await anon('POST', '/auth/register', {
    fullName: 'Arjun Sharma', email: 'arjun@example.com', phone: '9876543210',
    gender: 'male', dateOfBirth: '15/08/1995', timeOfBirth: '04:20 AM',
    placeOfBirth: 'Jaipur, Rajasthan',
  });
  hasFields('the session the app stores', user.body, [
    'accessToken', 'refreshToken', 'user.id', 'user.name', 'user.email', 'user.phone',
  ]);
  const seeker = call(user.body.accessToken);

  const home = await seeker('GET', '/users/me/home');
  hasFields('the home screen', home.body, [
    'profile.name', 'wallet.balance', 'planetPositions.planets',
    'unreadNotifications', 'recentConsultations',
  ]);

  const horoscope = await anon('GET', '/horoscope?sign=Leo');
  hasFields('the horoscope card', horoscope.body.consultation ?? horoscope.body.horoscope, [
    'sign', 'reading', 'luckyNumber', 'colour', 'energy',
  ]);

  section('user_app — the directory');
  const directory = await seeker('GET', '/astrologers');
  hasFields('a directory card', directory.body.items[0], [
    'id', 'name', 'online', 'expertise', 'languages', 'experienceYears',
    'rating', 'ratingCount', 'consultations', 'rates',
  ]);
  check('rates carry both the list price and the payable one',
    directory.body.items[0].rates.chat.was === 20 && directory.body.items[0].rates.chat.now === 20,
    directory.body.items[0].rates);

  const detail = await seeker('GET', `/astrologers/${astrologerId}`);
  hasFields('the astrologer detail screen', detail.body.astrologer, [
    'id', 'name', 'about', 'specializations', 'gallery',
    'ratingBreakdown', 'chatMinutes', 'callMinutes', 'reviews',
  ]);

  section('user_app — wallet and consultation');
  const order = await seeker('POST', '/wallet/topup', { amount: 1000 });
  hasFields('the top-up order', order.body, ['transactionId', 'reference', 'orderId', 'amount']);
  await seeker('POST', '/wallet/topup/confirm', { transactionId: order.body.transactionId });

  const wallet = await seeker('GET', '/wallet');
  hasFields('the wallet header', wallet.body.wallet, ['balance', 'totalAdded', 'totalSpent']);

  const ledger = await seeker('GET', '/wallet/transactions?filter=all');
  hasFields('a ledger row', ledger.body.items[0], [
    '_id', 'reference', 'direction', 'type', 'amount', 'balanceAfter', 'createdAt',
  ]);

  const chat = await seeker('POST', '/chats', {
    astrologerId, channel: 'chat',
    intake: { topic: 'career-job', question: 'Job change?', minutes: 10 },
  });
  hasFields('the chat request', chat.body, ['chatId', 'status', 'ratePerMinute']);

  const queue = await astro('GET', '/astrologer/me/requests');
  hasFields('the incoming-request card', queue.body.items[0], [
    'chatId', 'channel', 'user.name', 'intake.topic', 'ratePerMinute', 'requestedAt',
  ]);

  await astro('POST', `/chats/${chat.body.chatId}/accept`);
  const sent = await seeker('POST', `/chats/${chat.body.chatId}/messages`, {
    content: { text: 'Namaste' },
  });
  hasFields('a message bubble', sent.body.message, [
    'id', 'senderRole', 'type', 'content', 'seq', 'status', 'createdAt',
  ]);

  const transcript = await seeker('GET', `/chats/${chat.body.chatId}/messages`);
  check('the transcript reads oldest first',
    transcript.body.items[0].seq < transcript.body.items[transcript.body.items.length - 1].seq);

  const { ChatSession } = require('../models/Chat');
  await ChatSession.updateOne({ _id: chat.body.chatId }, {
    startedAt: new Date(Date.now() - 900000),
  });
  const ended = await seeker('POST', `/chats/${chat.body.chatId}/end`);
  hasFields('the end-of-session receipt', ended.body, [
    'chatId', 'status', 'durationSeconds', 'amountCharged', 'astrologerEarning',
  ]);

  await seeker('POST', `/chats/${chat.body.chatId}/rate`, { rating: 5, comment: 'Great.' });

  const history = await seeker('GET', '/chats?status=ended');
  hasFields('a consultation-history row', history.body.items[0], [
    'id', 'channel', 'status', 'with', 'durationSeconds', 'amountCharged', 'rating',
  ]);

  section('astro_app — earnings, reviews and history');
  const earnings = await astro('GET', '/wallet');
  hasFields('the earnings header', earnings.body.earnings, [
    'balance', 'today', 'thisMonth', 'lifetime', 'pendingWithdrawal', 'totalWithdrawn',
  ]);

  const reviews = await astro('GET', '/astrologer/me/reviews');
  hasFields('a review row', reviews.body.items[0], [
    'id', 'reviewer', 'rating', 'comment', 'channel', 'durationSeconds', 'at',
  ]);

  const flagged = await astro('POST', `/astrologer/me/reviews/${chat.body.chatId}/flag`, {
    reason: 'Unfair',
  });
  hasFields('flagging answers the allowance', flagged.body, ['id', 'flagged', 'flagsRemaining']);

  const astroHistory = await astro('GET', '/chats?status=ended');
  check('the astrologer sees their side of the same session',
    astroHistory.body.items[0]?.astrologerEarning > 0, astroHistory.body.items[0]);

  section('both apps — notifications and support');
  const notifications = await seeker('GET', '/notifications');
  hasFields('the notifications screen', notifications.body, ['items', 'total', 'unread']);
  if (notifications.body.items.length) {
    hasFields('a notification row', notifications.body.items[0], [
      '_id', 'type', 'title', 'createdAt',
    ]);
  }

  const ticket = await astro('POST', '/support/tickets', {
    issueType: 'payment', description: 'My payout has not arrived after five days.',
  });
  hasFields('a filed ticket', ticket.body.ticket, ['id', 'reference', 'status', 'createdAt']);

  const settings = await anon('GET', '/settings');
  hasFields('what the apps read on launch', settings.body.settings, [
    'minRecharge', 'maxRecharge', 'minPayout',
    'features.aiAssistant', 'features.maintenanceMode', 'appVersions.minimumSupported',
  ]);

  section('user_app — the AI assistant');
  const ai = await seeker('GET', '/chats/ai');
  hasFields('the AI thread', ai.body, ['chatId', 'items']);
  llm.chat = async () => ({ type: 'text', text: 'A held-out fake reply, so this contract check never needs a real LLM_PROVIDER or a real network call.' });
  const asked = await seeker('POST', '/chats/ai/messages', { text: 'What does my Jupiter mean?' });
  hasFields('asking answers both turns', asked.body, [
    'chatId', 'question.content', 'answer.content', 'answer.senderRole',
  ]);
  llm.chat = originalLlmChat;

  astrologyApiClient.request = originalAstrologyRequest;

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await redis.quit();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  astrologyApiClient.request = originalAstrologyRequest;
  llm.chat = originalLlmChat;
  console.error('CRASHED:', e);
  process.exit(1);
});
