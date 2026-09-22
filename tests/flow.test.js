/** End-to-end walk through the whole platform: astro_app, user_app, admin_panel. */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_flow';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test:';
process.env.NODE_ENV = 'development';
process.env.OTP_MASTER_CODE = '123456';

const mongoose = require('mongoose');
const { connectRedis, redis } = require('../config/redis');
const { createApp } = require('../app');
const { hashPassword } = require('../utils/password');
const astrologyApiClient = require('../services/astrologyApi.client');

const PORT = 5099;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

let pass = 0;
let fail = 0;

function check(label, condition, extra) {
  if (condition) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}
const section = title => console.log(`\n=== ${title} ===`);

/**
 * Registering a user now fires services/user.service.js's
 * enrichZodiacFromBirthDetails in the background (see
 * controllers/auth.controller.js), which would otherwise hit the real
 * AstrologyAPI transport. This file doesn't assert on Moon sign / horoscope
 * content, so an empty geo_details response is enough to make it a silent,
 * free no-op (no place found -> nothing further is ever fetched).
 */
const originalAstrologyRequest = astrologyApiClient.request;

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const GET = (p, o) => call('GET', p, o);
const POST = (p, o) => call('POST', p, o);
const PATCH = (p, o) => call('PATCH', p, o);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await connectRedis();
  const keys = await redis.keys('*');
  if (keys.length) await redis.del(...keys.map(k => k.replace('shreeastro-test:', '')));

  astrologyApiClient.request = async () => ({ geonames: [] });

  const server = createApp().listen(PORT);

  const Admin = require('../models/Admin');
  await Admin.create({
    name: 'Vaibhav Mehra', email: 'admin@shreeastro.com',
    passwordHash: await hashPassword('SuperSecret123'), role: 'super_admin', status: 'active',
  });

  /* ---------------------------------------------------------------- admin */
  section('admin_panel — password login');
  const badLogin = await POST('/auth/admin/login', { body: { email: 'admin@shreeastro.com', password: 'wrongpass1' } });
  check('wrong password is refused', badLogin.status === 401, badLogin.body);

  /** Two-factor is on by default, so signing in takes two calls. */
  const step1 = await POST('/auth/admin/login', { body: { email: 'admin@shreeastro.com', password: 'SuperSecret123' } });
  check('the password alone is not a session', step1.body.requiresOtp === true && !step1.body.accessToken, step1.body);

  const adminLogin = await POST('/auth/admin/login/verify', {
    body: { email: 'admin@shreeastro.com', code: step1.body.devCode },
  });
  check('admin signs in', adminLogin.status === 200 && !!adminLogin.body.accessToken, adminLogin.body);
  check('admin gets permissions', adminLogin.body.admin?.permissions?.includes('astrologers.approve'));
  const adminToken = adminLogin.body.accessToken;

  /* ---------------------------------------------------------- astrologer */
  section('astro_app — registration wizard');
  const astroReg = await POST('/auth/astrologer/register', {
    body: {
      fullName: 'Pt. Rajesh Sharma', phone: '9811111111', email: 'rajesh@example.com',
      gender: 'male', dateOfBirth: '10/04/1985',
      languages: ['hindi', 'english'], expertise: ['vedic', 'numerology'],
      experienceYears: 18, about: 'Vedic astrologer with 18 years of practice.',
    },
  });
  check('astrologer registers', astroReg.status === 201, astroReg.body);
  check('application starts as professional_submitted', astroReg.body.astrologer?.applicationStatus === 'professional_submitted');
  let astroToken = astroReg.body.accessToken;
  const astrologerId = astroReg.body.astrologer.id;

  const dupe = await POST('/auth/astrologer/register', { body: { fullName: 'Someone Else', phone: '9811111111' } });
  check('the same number cannot register twice', dupe.status === 409, dupe.body);

  const earlySubmit = await POST('/astrologer/me/submit', { token: astroToken });
  check('cannot submit with no documents', earlySubmit.status === 400, earlySubmit.body);

  // Documents and bank arrive as multipart; post them straight to the service.
  const astrologerService = require('../services/astrologer.service');
  await astrologerService.addDocument(astrologerId, {
    type: 'aadhaar_front', idNumber: '1234 5678 9012',
    file: { url: 'http://localhost/uploads/documents/aadhaar.jpg', fileName: 'aadhaar.jpg', mimeType: 'image/jpeg', sizeBytes: 12345 },
  });
  await astrologerService.addBankAccount(astrologerId, {
    holderName: 'Rajesh Sharma', bankName: 'State Bank of India',
    accountNumber: '30123456789', ifsc: 'SBIN0001234',
  });
  const submitted = await POST('/astrologer/me/submit', { token: astroToken });
  check('application submits once complete', submitted.body.applicationStatus === 'under_review', submitted.body);

  section('astro_app — cannot work before approval');
  const goOnlineEarly = await PATCH('/astrologer/me/presence', { token: astroToken, body: { isOnline: true } });
  check('can go online (but is not listable yet)', goOnlineEarly.status === 200);

  /* ------------------------------------------------------ admin approves */
  section('admin_panel — reviewing the application');
  const pendingList = await GET('/admin/astrologers?applicationStatus=under_review', { token: adminToken });
  check('application shows in the queue', pendingList.body.items?.length === 1, pendingList.body);

  const detail = await GET(`/admin/astrologers/${astrologerId}`, { token: adminToken });
  check('admin sees the filed document', detail.body.documents?.length === 1);
  check('admin sees the bank account', detail.body.bankAccounts?.length === 1);

  await PATCH(`/admin/astrologers/${astrologerId}/documents/${detail.body.documents[0]._id}`, {
    token: adminToken, body: { status: 'approved' },
  });
  await PATCH(`/admin/astrologers/${astrologerId}/bank-accounts/${detail.body.bankAccounts[0]._id}`, {
    token: adminToken, body: { status: 'approved' },
  });

  const approved = await POST(`/admin/astrologers/${astrologerId}/approve`, {
    token: adminToken,
    body: {
      commissionPercent: 25,
      services: [
        { type: 'chat', ratePerMinute: 20, offerPercent: 0, isEnabled: true },
        { type: 'call', ratePerMinute: 30, isEnabled: true },
      ],
    },
  });
  check('admin approves the application', approved.body.applicationStatus === 'approved', approved.body);
  check('an astro code is minted', !!approved.body.astroCode);

  /* ------------------------------------------------------------ the user */
  section('user_app — register and sign in');
  const userReg = await POST('/auth/register', {
    body: {
      fullName: 'Arjun Sharma', email: 'arjun@example.com', phone: '9876543210',
      gender: 'male', dateOfBirth: '15/08/1995', timeOfBirth: '04:20 AM',
      placeOfBirth: 'Jaipur, Rajasthan',
    },
  });
  check('user registers', userReg.status === 201, userReg.body);
  const userId = userReg.body.user.id;

  const otpSend = await POST('/auth/login/otp/request', { body: { role: 'user', channel: 'phone', phone: '9876543210' } });
  check('OTP is sent', otpSend.status === 200 && !!otpSend.body.devCode, otpSend.body);
  check('OTP has a TTL the app can count down', otpSend.body.expiresInSeconds === 300);

  const ttl = await redis.ttl('otp:login:phone:9876543210');
  check('the code is in Redis with a TTL', ttl > 0 && ttl <= 300, { ttl });

  const cooldown = await POST('/auth/login/otp/request', { body: { role: 'user', channel: 'phone', phone: '9876543210' } });
  check('resend inside the cooldown is refused', cooldown.status === 429, cooldown.body);

  const wrong = await POST('/auth/login/otp/verify', { body: { role: 'user', channel: 'phone', phone: '9876543210', code: '999999' } });
  check('a wrong code is refused', wrong.status === 400, wrong.body);

  const master = await POST('/auth/login/otp/verify', { body: { role: 'user', channel: 'phone', phone: '9876543210', code: '123456' } });
  check('the master OTP signs the user in', master.status === 200 && !!master.body.accessToken, master.body);
  let userToken = master.body.accessToken;

  const gone = await redis.get('otp:login:phone:9876543210');
  check('the code is removed after use', gone === null);

  const astroOtp = await POST('/auth/login/otp/request', { body: { role: 'astrologer', channel: 'phone', phone: '9811111111' } });
  const astroLogin = await POST('/auth/login/otp/verify', { body: { role: 'astrologer', channel: 'phone', phone: '9811111111', code: astroOtp.body.devCode } });
  check('astrologer signs in with the real generated code', astroLogin.status === 200, astroLogin.body);
  astroToken = astroLogin.body.accessToken;

  /* ---------------------------------------------------------- directory */
  section('user_app — the directory');
  await PATCH('/astrologer/me/presence', { token: astroToken, body: { isOnline: true } });

  const directory = await GET('/astrologers', { token: userToken });
  check('the approved astrologer is listed', directory.body.items?.length === 1, directory.body);
  check('rates come through', directory.body.items?.[0]?.rates?.chat?.now === 20);
  check('online shows', directory.body.items?.[0]?.online === true);

  const filtered = await GET('/astrologers?expertise=tarot', { token: userToken });
  check('a filter that matches nobody returns nothing', filtered.body.items?.length === 0);

  const matched = await GET('/astrologers?expertise=vedic&languages=hindi&online=true', { token: userToken });
  check('a filter that matches returns the row', matched.body.items?.length === 1);

  const profile = await GET(`/astrologers/${astrologerId}`, { token: userToken });
  check('the detail screen gets the about text', profile.body.astrologer?.about?.includes('18 years'), profile.body);

  /* ------------------------------------------------------------- wallet */
  section('user_app — wallet — every consultation is paid from minute 1');
  const noMoney = await POST('/chats', { token: userToken, body: { astrologerId, channel: 'chat' } });
  check('a first-timer with ₹0 is refused', noMoney.status === 400, noMoney.body);

  const order = await POST('/wallet/topup', { token: userToken, body: { amount: 500 } });
  check('a top-up starts', order.status === 201, order.body);
  const paid = await POST('/wallet/topup/confirm', { token: userToken, body: { transactionId: order.body.transactionId, paymentId: 'pay_test_1' } });
  check('the top-up credits the wallet', paid.body.transaction?.balanceAfter === 500, paid.body);

  const replay = await POST('/wallet/topup/confirm', { token: userToken, body: { transactionId: order.body.transactionId } });
  const walletAfter = await GET('/wallet', { token: userToken });
  check('confirming twice does not double-credit', walletAfter.body.wallet?.balance === 500, walletAfter.body);

  const tooSmall = await POST('/wallet/topup', { token: userToken, body: { amount: 5 } });
  check('a tiny top-up is refused', tooSmall.status === 400);

  /* --------------------------------------------------------- the chat */
  section('both apps — a consultation, start to finish');
  const requested = await POST('/chats', {
    token: userToken,
    body: {
      astrologerId, channel: 'chat',
      intake: { topic: 'career-job', question: 'When will I change jobs?', minutes: 10 },
    },
  });
  check('the chat request is made', requested.status === 201, requested.body);
  const chatId = requested.body.chatId;
  check('the rate is fixed at request time', requested.body.ratePerMinute === 20);

  const queue = await GET('/astrologer/me/requests', { token: astroToken });
  check('the request reaches the astrologer queue', queue.body.items?.length === 1, queue.body);
  check('the intake travels with it', queue.body.items?.[0]?.intake?.topic === 'career-job');

  const beforeAccept = await POST(`/chats/${chatId}/messages`, { token: userToken, body: { content: { text: 'hi' } } });
  check('no messages before it is accepted', beforeAccept.status === 400, beforeAccept.body);

  const accepted = await POST(`/chats/${chatId}/accept`, { token: astroToken });
  check('the astrologer accepts', accepted.body.status === 'active', accepted.body);

  const m1 = await POST(`/chats/${chatId}/messages`, { token: userToken, body: { content: { text: 'Namaste, when will I change jobs?' } } });
  check('the user sends a text message', m1.status === 201 && m1.body.message.type === 'text', m1.body);
  const m2 = await POST(`/chats/${chatId}/messages`, { token: astroToken, body: { content: { text: 'Let me look at your chart.' } } });
  check('the astrologer replies', m2.status === 201);
  check('messages are numbered in order', m2.body.message.seq > m1.body.message.seq);

  const dupeMsg = await POST(`/chats/${chatId}/messages`, { token: userToken, body: { content: { text: 'retry' }, clientMessageId: 'abc-1' } });
  const dupeMsg2 = await POST(`/chats/${chatId}/messages`, { token: userToken, body: { content: { text: 'retry' }, clientMessageId: 'abc-1' } });
  check('a retried send is not duplicated', dupeMsg.body.message.id === dupeMsg2.body.message.id);

  const imageTry = await POST(`/chats/${chatId}/messages`, { token: userToken, body: { type: 'image', content: { url: 'http://x/y.jpg' } } });
  check('non-text types are refused for now', imageTry.status === 400, imageTry.body);

  const badContent = await POST(`/chats/${chatId}/messages`, { token: userToken, body: { type: 'text', content: { url: 'http://x' } } });
  check('a text message must carry text', badContent.status === 400, badContent.body);

  const outsider = await POST('/auth/register', { body: { fullName: 'Nosy Person', email: 'nosy@example.com', phone: '9700000000', dateOfBirth: '01/01/1990', timeOfBirth: '10:00 AM', placeOfBirth: 'Pune, Maharashtra' } });
  const peek = await GET(`/chats/${chatId}/messages`, { token: outsider.body.accessToken });
  check('a stranger cannot read the transcript', peek.status === 403, peek.body);

  const transcript = await GET(`/chats/${chatId}/messages`, { token: userToken });
  check('the transcript reads back oldest first', transcript.body.items[0].type === 'system', transcript.body.items?.[0]);
  check('the transcript holds every turn', transcript.body.items.length === 4, { count: transcript.body.items.length });

  /* -------------------------------------------------------------- billing */
  section('billing — the meter, the wallet and the payout');
  const { ChatSession } = require('../models/Chat');
  // Pretend the chat has been running for nine and a half minutes.
  await ChatSession.updateOne({ _id: chatId }, { startedAt: new Date(Date.now() - 570000) });

  const ended = await POST(`/chats/${chatId}/end`, { token: userToken });
  check('the chat ends', ended.body.status === 'ended', ended.body);
  check('9m30s bills as 10 minutes at ₹20', ended.body.amountCharged === 200, ended.body);
  check('the astrologer keeps 75% of it', ended.body.astrologerEarning === 150, ended.body);

  const walletNow = await GET('/wallet', { token: userToken });
  check('the wallet is debited', walletNow.body.wallet.balance === 300, walletNow.body);

  const earnings = await GET('/wallet', { token: astroToken });
  check('the astrologer is credited', earnings.body.earnings.balance === 150, earnings.body);

  const ledger = await GET('/wallet/transactions?filter=spent', { token: userToken });
  // Per-minute billing writes one ₹20 debit per minute (minute 1 at accept, minutes 2-10 trued up at end) — not one lump-sum ₹200 entry.
  check('10 separate per-minute charges appear in the ledger', ledger.body.items?.length === 10, ledger.body.items);
  check('they sum to the full ₹200 charged', ledger.body.items?.reduce((sum, item) => sum + item.amount, 0) === 200, ledger.body.items);

  const endAgain = await POST(`/chats/${chatId}/end`, { token: userToken });
  check('a chat cannot be ended twice', endAgain.status === 400, endAgain.body);

  /* --------------------------------------------------------------- rating */
  section('user_app — rating it');
  const rated = await POST(`/chats/${chatId}/rate`, { token: userToken, body: { rating: 5, comment: 'Very accurate reading.' } });
  check('the user rates the consultation', rated.body.review?.rating === 5, rated.body);

  const rateTwice = await POST(`/chats/${chatId}/rate`, { token: userToken, body: { rating: 1 } });
  check('a chat cannot be rated twice', rateTwice.status === 409, rateTwice.body);

  const astroReviews = await GET('/astrologer/me/reviews', { token: astroToken });
  check('the review reaches the astrologer', astroReviews.body.items?.[0]?.rating === 5, astroReviews.body);

  await POST(`/astrologer/me/reviews/${chatId}/reply`, { token: astroToken, body: { message: 'Thank you!' } });
  const publicProfile = await GET(`/astrologers/${astrologerId}`, { token: userToken });
  check('the rating updates the public profile', publicProfile.body.astrologer.rating === 5, publicProfile.body.astrologer?.rating);
  check('the reply shows publicly', publicProfile.body.astrologer.reviews?.[0]?.reply === 'Thank you!');

  /* ------------------------------------------------------------- payouts */
  section('astro_app + admin_panel — getting paid');
  const tooMuch = await POST('/wallet/withdrawals', { token: astroToken, body: { amount: 5000 } });
  check('cannot withdraw more than the balance', tooMuch.status === 400, tooMuch.body);

  const wdl = await POST('/wallet/withdrawals', { token: astroToken, body: { amount: 150 } });
  check('a withdrawal is requested', wdl.status === 201, wdl.body);

  const afterRequest = await GET('/wallet', { token: astroToken });
  check('the money leaves the balance while pending', afterRequest.body.earnings.balance === 0 && afterRequest.body.earnings.pendingWithdrawal === 150, afterRequest.body.earnings);

  const adminWdl = await GET('/admin/withdrawals?status=pending', { token: adminToken });
  check('the request reaches the admin', adminWdl.body.items?.length === 1);

  const paidOut = await PATCH(`/admin/withdrawals/${wdl.body.withdrawal.id}`, { token: adminToken, body: { status: 'approved', payoutReference: 'NEFT-991' } });
  check('the admin pays it out', paidOut.body.withdrawal?.status === 'paid', paidOut.body);

  const settled = await GET('/wallet', { token: astroToken });
  check('pending clears once paid', settled.body.earnings.pendingWithdrawal === 0 && settled.body.earnings.totalWithdrawn === 150, settled.body.earnings);

  /* --------------------------------------------------- admin oversight */
  section('admin_panel — oversight');
  const dash = await GET('/admin/dashboard', { token: adminToken });
  check('the dashboard counts users', dash.body.users?.total === 2, dash.body.users);
  check('the dashboard counts astrologers', dash.body.astrologers?.active === 1);
  check('the dashboard shows the platform cut', dash.body.revenue?.platformThisMonth === 50, dash.body.revenue);

  const consultations = await GET('/admin/consultations', { token: adminToken });
  check('the consultation is listed', consultations.body.items?.[0]?.amount === 200, consultations.body.items?.[0]);

  const logs = await GET('/admin/audit-logs', { token: adminToken });
  check('admin actions were logged', logs.body.items?.length >= 4, { count: logs.body.items?.length });
  check('the approval was logged', logs.body.items?.some(l => l.action === 'Approved astrologer application'));

  const blocked = await PATCH(`/admin/users/${userId}/status`, { token: adminToken, body: { status: 'blocked', reason: 'Payment dispute' } });
  check('the admin blocks a user', blocked.body.status === 'blocked', blocked.body);

  const blockedLogin = await POST('/auth/login/otp/request', { body: { role: 'user', channel: 'phone', phone: '9876543210' } });
  check('a blocked user cannot sign in', blockedLogin.status === 403, blockedLogin.body);

  /* ------------------------------------------------------- permissions */
  section('admin_panel — permissions');
  const Admin2 = require('../models/Admin');
  await Admin2.create({ name: 'Karan Doshi', email: 'finance@shreeastro.com', passwordHash: await hashPassword('FinancePass1'), role: 'finance', status: 'active' });
  const financeStep1 = await POST('/auth/admin/login', { body: { email: 'finance@shreeastro.com', password: 'FinancePass1' } });
  const finance = await POST('/auth/admin/login/verify', {
    body: { email: 'finance@shreeastro.com', code: financeStep1.body.devCode },
  });
  const financeToken = finance.body.accessToken;

  const financeCanSee = await GET('/admin/transactions', { token: financeToken });
  check('finance can read payments', financeCanSee.status === 200);
  const financeCannot = await POST(`/admin/astrologers/${astrologerId}/approve`, { token: financeToken, body: {} });
  check('finance cannot approve astrologers', financeCannot.status === 403, financeCannot.body);

  const noToken = await GET('/admin/dashboard');
  check('the panel is closed without a token', noToken.status === 401);
  const userAsAdmin = await GET('/admin/dashboard', { token: userToken });
  check('a user token cannot reach the panel', userAsAdmin.status === 403, userAsAdmin.body);

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
