/**
 * The whole consultation, end to end, over the real HTTP API and real
 * websockets — exactly the calls and events user_app and astro_app make:
 *
 *   precheck → intake → POST /chats → astrologer sees the request (socket +
 *   GET /astrologer/me/requests) → accepts → both join the room → chat →
 *   both headers' clocks agree → low balance → recharge → resume → end.
 *
 * Run once per-minute and once with a (discounted) package. Time is moved
 * by calling the billing sweep with an explicit `now`, the same thing the
 * real 10-second job does with the wall clock.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_consultation_e2e';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test:';
process.env.NODE_ENV = 'development';

const http = require('http');
const mongoose = require('mongoose');
const ioClient = require('socket.io-client');

const { createApp } = require('../app');
const { initSocket } = require('../socket');
const { CHAT_EVENTS } = require('../models/Chat');

let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);
const scenario = {};
const markScenario = (key, label, ok) => { scenario[key] = { label, ok: (scenario[key]?.ok ?? true) && ok }; };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const once = (socket, event, ms = 4000, match = () => true) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`timed out waiting for "${event}"`)); }, ms);
    function handler(payload) {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
const emitAck = (socket, event, payload) => new Promise(resolve => socket.emit(event, payload, resolve));
const seconds = (date, s) => new Date(new Date(date).getTime() + s * 1000);

/** Every event each side received, in order — so "did both sides hear it" is one lookup. */
function recorder(socket) {
  const seen = [];
  socket.onAny((event, payload) => seen.push({ event, payload }));
  return {
    seen,
    has: (event, match = () => true) => seen.some(e => e.event === event && match(e.payload)),
    all: (event, match = () => true) => seen.filter(e => e.event === event && match(e.payload)),
  };
}

/**
 * The header clock each app draws, from the same GET /chats/:id it reads —
 * mirrors user_app's and astro_app's ConsultationChatScreen (server-clock
 * offset from `serverTime`; package countdown while package time lasts,
 * otherwise elapsed since `startedAt`). `deviceSkewMs` simulates a phone
 * whose clock is wrong by that much.
 */
function headerSeconds(state, deviceNowMs, deviceSkewMs) {
  const device = deviceNowMs + deviceSkewMs;
  const offset = new Date(state.serverTime).getTime() - (state.__fetchedAtMs + deviceSkewMs);
  const serverNow = device + offset;
  if (state.package?.phase === 'package' && state.package.endsAt) {
    return { kind: 'left', value: Math.max(0, Math.ceil((new Date(state.package.endsAt).getTime() - serverNow) / 1000)) };
  }
  return { kind: 'elapsed', value: Math.max(0, Math.floor((serverNow - new Date(state.startedAt).getTime()) / 1000)) };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const server = http.createServer(createApp());
  initSocket(server);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const User = require('../models/User');
  const Astrologer = require('../models/Astrologer');
  const { ChatSession } = require('../models/Chat');
  const authService = require('../services/auth.service');
  const chatService = require('../services/chat.service');
  const settingsService = require('../services/settings.service');
  await require('../models/ChatBillingTick').init();
  await require('../models/ChatPackagePurchase').init();

  const call = token => async (method, path, body) => {
    const fetchedAtMs = Date.now();
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (json && typeof json === 'object') Object.defineProperty(json, '__fetchedAtMs', { value: fetchedAtMs, enumerable: false });
    return { status: res.status, body: json };
  };

  let seq = 0;
  async function actors({ balance, chatRate = 20, commissionPercent = 25 }) {
    seq += 1;
    const user = await User.create({
      name: `Seeker ${seq}`, email: `e2e-seeker${seq}@x.com`, phone: { number: `90000000${String(seq).padStart(2, '0')}` },
      wallet: { balance },
    });
    const astrologer = await Astrologer.create({
      name: `Pt. Astro ${seq}`, email: `e2e-astro${seq}@x.com`, phone: { number: `91000000${String(seq).padStart(2, '0')}` },
      applicationStatus: 'approved', status: 'active', commissionPercent,
      services: [{ type: 'chat', isEnabled: true, ratePerMinute: chatRate }, { type: 'call', isEnabled: true, ratePerMinute: 30 }],
      presence: { isOnline: false, maxConcurrentChats: 3 },
    });
    const userToken = (await authService.issueTokens(user._id, 'user')).accessToken;
    const astroToken = (await authService.issueTokens(astrologer._id, 'astrologer')).accessToken;
    const userSocket = ioClient(base, { auth: { token: userToken }, transports: ['websocket'] });
    const astroSocket = ioClient(base, { auth: { token: astroToken }, transports: ['websocket'] });
    await Promise.all([once(userSocket, 'connect'), once(astroSocket, 'connect')]);
    await sleep(150); // presence write on connect
    return {
      user, astrologer, userSocket, astroSocket,
      asUser: call(userToken), asAstro: call(astroToken),
      userEvents: recorder(userSocket), astroEvents: recorder(astroSocket),
    };
  }

  /** user_app's toApiIntake, as App.tsx builds it from the intake form. */
  const intakeFromForm = {
    topic: 'career-job',
    summary: 'Hi\nBelow are my details:\nName: Arjun\nGender: Male\nDOB: 15 August 1999\nTOB: 10 : 30 PM\nPOB: Noida\nTopic: Career & Job',
    birthDetails: { fullName: 'Arjun', gender: 'male', dateOfBirth: '15 August 1999', timeOfBirth: '10 : 30 PM', place: { formatted: 'Noida' } },
  };

  /** The shared first half: precheck, intake submit, the astrologer sees it and accepts, both land in the room. */
  async function requestAndAccept(a, billing) {
    const pre = await a.asUser('POST', '/chats/precheck', { astrologerId: String(a.astrologer._id), channel: 'chat' });
    check('precheck: astrologer online and affordable', pre.status === 200 && pre.body.ok === true && pre.body.astrologerAvailable === true, pre.body);

    const incoming = once(a.astroSocket, 'chat:requested');
    const req = await a.asUser('POST', '/chats', { astrologerId: String(a.astrologer._id), channel: 'chat', intake: intakeFromForm, ...(billing ? { billing } : {}) });
    check('intake submitted → request created (201)', req.status === 201 && req.body.status === 'requested', req.body);
    const chatId = req.body.chatId;

    const pushed = await incoming;
    check('astrologer gets the request live over the socket', pushed.chatId === chatId && pushed.intake?.topic === 'career-job');
    const queue = await a.asAstro('GET', '/astrologer/me/requests');
    const row = queue.body.items?.find(r => r.chatId === chatId);
    check('and it is in their request queue', Boolean(row), queue.body);

    const accepted = once(a.userSocket, 'chat:accepted', 4000, p => p.chatId === chatId);
    const acc = await a.asAstro('POST', `/chats/${chatId}/accept`);
    check('astrologer accepts (200, active)', acc.status === 200 && acc.body.status === 'active', acc.body);
    await accepted;
    check('user app is told it was accepted (opens the chat)', true);

    const userJoin = await emitAck(a.userSocket, CHAT_EVENTS.JOIN, { chatId, lastSeq: 0 });
    const astroJoin = await emitAck(a.astroSocket, CHAT_EVENTS.JOIN, { chatId, lastSeq: 0 });
    check('both join the room', userJoin.status === 'active' && astroJoin.status === 'active', { userJoin: userJoin.error, astroJoin: astroJoin.error });
    check('the intake is the opening message on both sides',
      userJoin.messages.some(m => m.isIntake) && astroJoin.messages.some(m => m.isIntake));
    return { chatId, row };
  }

  /** Both apps read GET /chats/:id on open; their header clocks must agree even with phones whose clocks are off. */
  async function headersAgree(a, chatId, label) {
    const [u, s] = await Promise.all([a.asUser('GET', `/chats/${chatId}`), a.asAstro('GET', `/chats/${chatId}`)]);
    check(`${label}: both read the same startedAt / package end`,
      u.body.startedAt === s.body.startedAt && u.body.package?.endsAt === s.body.package?.endsAt && u.body.billingMode === s.body.billingMode,
      { user: [u.body.startedAt, u.body.package?.endsAt], astro: [s.body.startedAt, s.body.package?.endsAt] });
    const now = Date.now();
    const userHeader = headerSeconds(u.body, now, +90_000); // user's phone 90s fast
    const astroHeader = headerSeconds(s.body, now, -45_000); // astrologer's phone 45s slow
    check(`${label}: header clocks match despite device clock skew (${userHeader.kind} ${userHeader.value}s vs ${astroHeader.value}s)`,
      userHeader.kind === astroHeader.kind && Math.abs(userHeader.value - astroHeader.value) <= 1, { userHeader, astroHeader });
    return { user: u.body, astro: s.body };
  }

  async function chatBothWays(a, chatId) {
    const toAstro = once(a.astroSocket, CHAT_EVENTS.NEW, 4000, m => m.content?.text === 'Namaste');
    const ack = await emitAck(a.userSocket, CHAT_EVENTS.SEND, { chatId, type: 'text', content: { text: 'Namaste' }, clientMessageId: `c-${Date.now()}` });
    await toAstro;
    const toUser = once(a.userSocket, CHAT_EVENTS.NEW, 4000, m => m.content?.text === 'Tell me more');
    await emitAck(a.astroSocket, CHAT_EVENTS.SEND, { chatId, type: 'text', content: { text: 'Tell me more' } });
    await toUser;
    check('messages flow both ways', Boolean(ack.message));
  }

  /* ================================================================ per-minute */
  section('PER-MINUTE: choose → intake → request → accept → chat → low balance → recharge → end');
  {
    const a = await actors({ balance: 50 }); // 2 minutes at ₹20 + ₹10 left
    const { chatId, row } = await requestAndAccept(a, undefined);
    check('astrologer\'s card shows a per-minute request', row.billingMode === 'per_minute' && row.ratePerMinute === 20);
    const bal1 = (await a.asUser('GET', '/wallet')).body.wallet.balance;
    check('minute 1 charged upfront on accept (₹50 → ₹30)', bal1 === 30, bal1);

    await chatBothWays(a, chatId);
    const { user: state } = await headersAgree(a, chatId, 'per-minute, just started');
    check('per-minute session has no package view', state.package === undefined && state.billingMode === 'per_minute');

    // Minute 2 is due 60s after the upfront charge.
    const chat = await ChatSession.findById(chatId);
    const t2 = seconds(chat.lastBilledAt, 61);
    const tickBoth = Promise.all([
      once(a.userSocket, CHAT_EVENTS.TICK, 4000, p => p.chatId === chatId),
      once(a.astroSocket, CHAT_EVENTS.TICK, 4000, p => p.chatId === chatId),
    ]);
    await chatService.runBillingSweep(t2);
    const [userTick] = await tickBoth;
    check('minute 2: both apps get the tick, user sees the new balance (₹10)', userTick.balanceRemaining === 10, userTick);
    check('with ₹10 left the user got the proactive low-balance warning (existing banner)',
      a.userEvents.has(CHAT_EVENTS.LOW_BALANCE, p => p.chatId === chatId && p.exhausted === false));

    // Minute 3 can't be paid → paused for both.
    const after2 = await ChatSession.findById(chatId);
    const pausedBoth = Promise.all([
      once(a.userSocket, CHAT_EVENTS.LOW_BALANCE, 4000, p => p.paused === true),
      once(a.astroSocket, CHAT_EVENTS.LOW_BALANCE, 4000, p => p.paused === true),
    ]);
    await chatService.runBillingSweep(seconds(after2.lastBilledAt, 61));
    await pausedBoth;
    check('minute 3 unaffordable → paused on both sides (user: Low Balance banner + Recharge; astrologer: paused note)', true);
    const pausedState = await a.asUser('GET', `/chats/${chatId}`);
    check('state reports paused (a reopened app recovers it)', pausedState.body.paused === true);
    const blocked = await emitAck(a.userSocket, CHAT_EVENTS.SEND, { chatId, type: 'text', content: { text: 'hello?' } });
    check('server still accepts messages while paused (apps lock the composer themselves)', Boolean(blocked.message) || Boolean(blocked.error));

    // Recharge from the popup: POST /wallet/topup + confirm, exactly as RechargePopup's Pay Now does.
    const resumedBoth = Promise.all([
      once(a.userSocket, CHAT_EVENTS.LOW_BALANCE, 4000, p => p.paused === false),
      once(a.astroSocket, CHAT_EVENTS.LOW_BALANCE, 4000, p => p.paused === false),
    ]);
    const order = await a.asUser('POST', '/wallet/topup', { amount: 150 });
    const confirmed = await a.asUser('POST', '/wallet/topup/confirm', { transactionId: order.body.transactionId });
    check('recharge ₹150 goes through', confirmed.status === 200 && confirmed.body.transaction.balanceAfter === 160, confirmed.body);
    await resumedBoth;
    check('the recharge resumes the chat on both sides', true);
    const resumedChat = await ChatSession.findById(chatId);
    check('resumed: not paused any more', !resumedChat.balanceExhaustedAt);

    await chatService.runBillingSweep(seconds(resumedChat.lastBilledAt, 61));
    const bal3 = (await a.asUser('GET', '/wallet')).body.wallet.balance;
    check('minute 3 billed after the recharge (₹160 → ₹140)', bal3 === 140, bal3);

    const endedBoth = Promise.all([once(a.userSocket, CHAT_EVENTS.ENDED), once(a.astroSocket, CHAT_EVENTS.ENDED)]);
    const end = await a.asUser('POST', `/chats/${chatId}/end`, { reason: 'user_ended' });
    await endedBoth;
    check('user ends → both apps get session:ended', end.status === 200 && end.body.status === 'ended');
    const earned = (await a.asAstro('GET', '/wallet')).body.earnings.balance;
    check('astrologer earned ₹15 (75%) per billed minute', earned === (end.body.amountCharged / 20) * 15, { earned, charged: end.body.amountCharged });
    markScenario('pm', 'Per-minute end to end', end.body.status === 'ended' && bal3 === 140);
    a.userSocket.close(); a.astroSocket.close();
  }

  /* ================================================================ package */
  section('PACKAGE (10% admin discount): choose → intake → request → accept → countdown → pause → recharge → approve → end');
  {
    await settingsService.update({ packageDiscounts: [{ minutes: 3, discountPercent: 10 }] });
    const a = await actors({ balance: 70 }); // 3-min package at ₹54 → ₹16 left: not enough for a ₹20 minute after it

    const pre = await a.asUser('POST', '/chats/precheck', { astrologerId: String(a.astrologer._id), channel: 'chat' });
    const q3 = pre.body.packages.find(p => p.minutes === 3);
    check('intake form gets priced packages: 3 min ₹60 struck → ₹54', q3.originalPrice === 60 && q3.price === 54 && q3.discountPercent === 10, q3);

    const { chatId, row } = await requestAndAccept(a, { mode: 'package', packageMinutes: 3, quotedPrice: q3.price });
    check('astrologer\'s card knows it is a 3-min package at the discounted ₹54',
      row.billingMode === 'package' && row.packageMinutes === 3 && row.packagePrice === 54 && row.packageDiscountPercent === 10, row);
    const bal1 = (await a.asUser('GET', '/wallet')).body.wallet.balance;
    check('package charged once on accept, at the discounted ₹54 (₹70 → ₹16)', bal1 === 16, bal1);

    await chatBothWays(a, chatId);
    const { user: state } = await headersAgree(a, chatId, 'package, just started');
    check('both see the package phase with its end time', state.package?.phase === 'package' && Boolean(state.package.endsAt));

    const chat = await ChatSession.findById(chatId);
    const endsAt = chat.packageState.endsAt;
    await chatService.runBillingSweep(seconds(chat.startedAt, 90));
    check('no per-minute charge during the package', (await a.asUser('GET', '/wallet')).body.wallet.balance === 16);

    // ~30s before the end with ₹16 < ₹20: the ordinary low-balance warning → existing banner/Recharge popup.
    const warned = once(a.userSocket, CHAT_EVENTS.LOW_BALANCE, 4000, p => p.chatId === chatId && p.exhausted === false);
    await chatService.runBillingSweep(seconds(endsAt, -25));
    const w = await warned;
    check('~30s before the end: user gets the existing low-balance warning (needs ₹20, has ₹16)', w.requiredAmount === 20 && w.balanceRemaining === 16, w);

    // Package runs out → paused on both sides, nothing charged, nothing affordable yet.
    const pausedBoth = Promise.all([
      once(a.userSocket, CHAT_EVENTS.PACKAGE_ENDED, 4000, p => p.chatId === chatId),
      once(a.astroSocket, CHAT_EVENTS.PACKAGE_ENDED, 4000, p => p.chatId === chatId),
    ]);
    await chatService.runBillingSweep(seconds(endsAt, 1));
    const [endedForUser] = await pausedBoth;
    check('package over → paused on BOTH sides (no auto per-minute)', true);
    check('the user is told nothing is affordable yet → recharge first', endedForUser.canContinue === false && endedForUser.perMinuteAffordable === false);
    check('nothing charged at the end', (await a.asUser('GET', '/wallet')).body.wallet.balance === 16);
    const blockedSend = await emitAck(a.userSocket, CHAT_EVENTS.SEND, { chatId, type: 'text', content: { text: 'hello?' } });
    check('messages are blocked while paused', /choose how to continue/.test(blockedSend.error || ''), blockedSend);
    const { user: pausedState } = await headersAgree(a, chatId, 'paused after the package');
    check('both apps read the paused phase', pausedState.package?.phase === 'awaiting_choice');

    // Recharge from the existing popup, then the user approves how to continue.
    const order = await a.asUser('POST', '/wallet/topup', { amount: 100 });
    await a.asUser('POST', '/wallet/topup/confirm', { transactionId: order.body.transactionId });
    const afterRecharge = await a.asUser('GET', `/chats/${chatId}`);
    check('after recharging, the options are affordable, still waiting for approval',
      afterRecharge.body.package.phase === 'awaiting_choice' && afterRecharge.body.package.canContinue === true && afterRecharge.body.package.perMinuteAffordable === true);

    const resumedBoth = Promise.all([
      once(a.userSocket, CHAT_EVENTS.PER_MINUTE_STARTED, 4000, p => p.chatId === chatId),
      once(a.astroSocket, CHAT_EVENTS.PER_MINUTE_STARTED, 4000, p => p.chatId === chatId),
    ]);
    const cont = await a.asUser('POST', `/chats/${chatId}/continue`, { mode: 'per_minute' });
    await resumedBoth;
    check('user chooses per-minute → both sides resume, first minute charged (₹116 → ₹96)', cont.status === 200 && cont.body.balanceRemaining === 96, cont.body);
    await chatBothWays(a, chatId);
    await headersAgree(a, chatId, 'per-minute after the choice');
    const bal2 = (await a.asUser('GET', '/wallet')).body.wallet.balance;

    const endedBoth = Promise.all([once(a.userSocket, CHAT_EVENTS.ENDED), once(a.astroSocket, CHAT_EVENTS.ENDED)]);
    const end = await a.asAstro('POST', `/chats/${chatId}/end`, { reason: 'astrologer_ended' });
    await endedBoth;
    check('astrologer ends → both apps get session:ended', end.status === 200);
    const final = await ChatSession.findById(chatId);
    check('record: package 3 min at ₹54 (₹60, 10% off) + per-minute tail',
      final.billing.mode === 'package' && final.billing.packages[0].amount === 54 && final.billing.packages[0].originalAmount === 60
      && final.billing.amountCharged === 54 + 20 * final.minutesBilled, final.billing);
    const earned = (await a.asAstro('GET', '/wallet')).body.earnings.balance;
    const expected = (54 - Math.round(54 * 0.25)) + final.minutesBilled * 15;
    check(`astrologer earnings = package share + per-minute share (₹${expected})`, earned === expected, { earned, expected });
    markScenario('pkg', 'Package end to end (discount, countdown, pause, recharge, approve per-minute, end)', end.status === 200 && bal2 === 96);
    a.userSocket.close(); a.astroSocket.close();
    await settingsService.update({ packageDiscounts: [3, 5, 10, 20].map(minutes => ({ minutes, discountPercent: 0 })) });
  }

  /* ================================================================ package, enough money */
  section('PACKAGE with enough money: warning, pause, choose another package, then per-minute');
  {
    const a = await actors({ balance: 500 });
    const { chatId } = await requestAndAccept(a, { mode: 'package', packageMinutes: 5, quotedPrice: 100 });
    const chat = await ChatSession.findById(chatId);
    const warnBoth = Promise.all([
      once(a.userSocket, CHAT_EVENTS.PACKAGE_WARNING, 4000, p => p.chatId === chatId),
      once(a.astroSocket, CHAT_EVENTS.PACKAGE_WARNING, 4000, p => p.chatId === chatId),
    ]);
    await chatService.runBillingSweep(seconds(chat.packageState.endsAt, -20));
    const [warning] = await warnBoth;
    check('~30s out both get the package-ending notice', warning.secondsLeft === 20, warning);

    const pausedBoth = Promise.all([
      once(a.userSocket, CHAT_EVENTS.PACKAGE_ENDED, 4000, p => p.chatId === chatId),
      once(a.astroSocket, CHAT_EVENTS.PACKAGE_ENDED, 4000, p => p.chatId === chatId),
    ]);
    await chatService.runBillingSweep(seconds(chat.packageState.endsAt, 1));
    const [ended] = await pausedBoth;
    check('at the end: paused on both sides, options offered (enough money)', ended.canContinue === true && ended.packages.length === 4);
    check('nothing auto-charged', (await a.asUser('GET', '/wallet')).body.wallet.balance === 400);

    const extendedBoth = Promise.all([
      once(a.userSocket, CHAT_EVENTS.PACKAGE_EXTENDED, 4000, p => p.chatId === chatId),
      once(a.astroSocket, CHAT_EVENTS.PACKAGE_EXTENDED, 4000, p => p.chatId === chatId),
    ]);
    const ext = await a.asUser('POST', `/chats/${chatId}/continue`, { mode: 'package', packageMinutes: 3, quotedPrice: 60 });
    await extendedBoth;
    check('user approves another 3-min package → both sides resume (₹400 → ₹340)', ext.status === 200 && ext.body.balanceRemaining === 340, ext.body);
    await chatBothWays(a, chatId);
    const { user: st } = await headersAgree(a, chatId, 'second package running');
    check('both read the new package countdown', st.package.phase === 'package');

    const second = await ChatSession.findById(chatId);
    await chatService.runBillingSweep(seconds(second.packageState.endsAt, 1));
    const cont = await a.asUser('POST', `/chats/${chatId}/continue`, { mode: 'per_minute' });
    check('second package ends → user approves per-minute (₹340 → ₹320)', cont.status === 200 && cont.body.balanceRemaining === 320, cont.body);
    const end = await a.asUser('POST', `/chats/${chatId}/end`, {});
    check('ends cleanly', end.status === 200);
    markScenario('pkg-ok', 'Package with enough money → pause → another package → pause → per-minute', end.status === 200 && cont.body.balanceRemaining === 320);
    a.userSocket.close(); a.astroSocket.close();
  }

  console.log('\n=== END-TO-END ===');
  for (const key of Object.keys(scenario)) console.log(`  ${scenario[key].ok ? 'PASS' : 'FAIL'}  ${scenario[key].label}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
