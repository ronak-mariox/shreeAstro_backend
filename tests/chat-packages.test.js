/**
 * Package-based consultations (config/packages.js, services/chat.service.js):
 * pricing, the upfront package charge on accept, the package sweep (warning,
 * extend prompt, no-response auto-end), extending, switching to per-minute,
 * ending, and the money invariants around each. Real Mongo transactions;
 * time is controlled by passing an explicit `now` into the sweep, and by
 * backdating fields directly, the same way chat-billing.test.js does.
 *
 * The socket server is replaced by a recorder, so every live event the
 * service emits can be asserted on.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_chat_packages';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const { ChatSession, Message, CHAT_EVENTS } = require('../models/Chat');
const ChatBillingTick = require('../models/ChatBillingTick');
const ChatPackagePurchase = require('../models/ChatPackagePurchase');
const WalletTransaction = require('../models/WalletTransaction');
const chatService = require('../services/chat.service');
const env = require('../config/env');
const packages = require('../config/packages');

/** Records every emit instead of needing a live socket.io server. */
const events = [];
require('../socket').getIO = () => ({
  to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }),
});
const eventsFor = (chatId, event) => events.filter(entry => entry.event === event && String(entry.payload?.chatId) === String(chatId));

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);
const scenario = {};
const markScenario = (n, label, ok) => { scenario[n] = { label, ok: (scenario[n]?.ok ?? true) && ok }; };

async function expectError(fn) {
  try { await fn(); return null; } catch (error) { return error; }
}
const balanceOf = async id => (await User.findById(id)).wallet.balance;
const earningsOf = async id => (await Astrologer.findById(id)).earnings.balance;
const seconds = (date, s) => new Date(date.getTime() + s * 1000);

let userSeq = 0;
async function makeUser(walletBalance) {
  userSeq += 1;
  return User.create({
    name: `Pkg Seeker ${userSeq}`,
    email: `pkgseeker${userSeq}@example.com`,
    phone: { countryCode: '+91', number: `96${String(userSeq).padStart(8, '0')}` },
    wallet: { balance: walletBalance },
  });
}
let astroSeq = 0;
async function makeAstrologer({ chatRate = 20, callRate = 30, commissionPercent = 25 } = {}) {
  astroSeq += 1;
  return Astrologer.create({
    name: `Pkg Astrologer ${astroSeq}`,
    email: `pkgastro${astroSeq}@example.com`,
    phone: { countryCode: '+91', number: `95${String(astroSeq).padStart(8, '0')}` },
    applicationStatus: 'approved',
    commissionPercent,
    services: [
      { type: 'chat', ratePerMinute: chatRate, isEnabled: true },
      { type: 'call', ratePerMinute: callRate, isEnabled: true },
    ],
    presence: { isOnline: true, isBusy: false, activeSessions: 0, maxConcurrentChats: 5 },
  });
}

/** Request + accept a package session; returns the fresh active chat. */
async function startPackage({ user, astro, minutes, channel = 'chat', quotedPrice }) {
  const requested = await chatService.requestChat({
    userId: user._id,
    astrologerId: astro._id,
    channel,
    intake: {},
    billing: { mode: 'package', packageMinutes: minutes, quotedPrice },
  });
  await chatService.acceptChat({ chatId: requested._id, astrologerId: astro._id });
  return ChatSession.findById(requested._id);
}

/** Runs the sweep for just this chat at `now` (the sweep runs every session; the result for ours is what's returned). */
async function sweepAt(chatId, now) {
  const results = await chatService.runBillingSweep(now);
  return results.find(entry => entry.chatId === String(chatId));
}

(async () => {
  /* ======================================================= pure unit tests */
  section('unit — package price calculation (config/packages.js)');
  check('the package list is 3/5/10/20 minutes', packages.CONSULTATION_PACKAGES.map(p => p.minutes).join(',') === '3,5,10,20');
  check('no package carries a discount today', packages.CONSULTATION_PACKAGES.every(p => p.discountPercent === 0));
  check('3 min × ₹20 = ₹60', packages.packagePrice(20, packages.findPackage(3)) === 60);
  check('20 min × ₹37 = ₹740', packages.packagePrice(37, packages.findPackage(20)) === 740);
  check('a zero rate prices at ₹0', packages.packagePrice(0, packages.findPackage(5)) === 0);
  check('discount hook: 10% off 10 × ₹20 = ₹180', packages.packagePrice(20, { minutes: 10, discountPercent: 10 }) === 180);
  check('discount hook rounds to whole rupees (15% off 3 × ₹15 = ₹38)', packages.packagePrice(15, { minutes: 3, discountPercent: 15 }) === 38);
  check('an unknown duration is not a package', packages.findPackage(7) === null && packages.findPackage('abc') === null);
  check('a string "5" still finds the 5-minute package', packages.findPackage('5')?.minutes === 5);
  check('no package -> no price', packages.packagePrice(20, null) === null);

  section('unit — wallet sufficiency (packageQuotes)');
  const quotes = packages.packageQuotes(20, 100);
  check('priced for every package', quotes.map(q => q.price).join(',') === '60,100,200,400');
  check('₹100 affords 3 and 5 minutes (exactly equal counts as enough)', quotes[0].affordable && quotes[1].affordable);
  check('₹100 does not afford 10 or 20 minutes', !quotes[2].affordable && !quotes[3].affordable);
  check('the shortfall is exact (10 min: ₹100 short, 20 min: ₹300 short)', quotes[2].shortfallAmount === 100 && quotes[3].shortfallAmount === 300);
  check('no balance passed -> no affordability flags', packages.packageQuotes(20)[0].affordable === undefined);

  section('unit — unused seconds & refund hook');
  const t0 = new Date('2026-01-01T10:00:00Z');
  check('90s left on a running package', packages.unusedPackageSeconds({ endsAt: seconds(t0, 90) }, t0) === 90);
  check('0 once the package has run out', packages.unusedPackageSeconds({ endsAt: seconds(t0, -5) }, t0) === 0);
  check('0 while the extend prompt is open', packages.unusedPackageSeconds({ endsAt: seconds(t0, 90), promptedAt: t0 }, t0) === 0);
  check('0 once switched to per-minute', packages.unusedPackageSeconds({ endsAt: seconds(t0, 90), perMinuteStartedAt: t0 }, t0) === 0);
  check('refund hook: seeker ended early -> ₹0', packages.unusedPackageRefund({ unusedSeconds: 120, ratePerMinute: 20, endedBy: 'user' }) === 0);
  check('refund hook: astrologer ended early -> ₹0 (placeholder until policy decided)', packages.unusedPackageRefund({ unusedSeconds: 120, ratePerMinute: 20, endedBy: 'astrologer' }) === 0);

  /* ======================================================= integration */
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await ChatBillingTick.init();
  await ChatPackagePurchase.init();

  /* ------------------------------------------------ scenario 1 & 2: per-minute unchanged */
  section('scenario 1 — per-minute chat: unchanged behaviour');
  {
    const user = await makeUser(1000);
    const astro = await makeAstrologer({ chatRate: 20 });
    const chat = await chatService.requestChat({ userId: user._id, astrologerId: astro._id, channel: 'chat', intake: {} });
    check('no billing sent -> per_minute mode', chat.billing.mode === 'per_minute');
    check('balance untouched at request', await balanceOf(user._id) === 1000);
    const accepted = await chatService.acceptChat({ chatId: chat._id, astrologerId: astro._id });
    const b1 = await balanceOf(user._id);
    check('minute 1 charged upfront on accept (₹20)', b1 === 980 && accepted.minutesBilled === 1);
    check('no package ledger rows for a per-minute chat', await ChatPackagePurchase.countDocuments({ chatSession: chat._id }) === 0);
    const tick = await sweepAt(chat._id, seconds(accepted.lastBilledAt, 61));
    check('the next minute is billed by the sweep', tick?.action === 'billed' && await balanceOf(user._id) === 960);
    const state = await chatService.getSessionState({ chatId: chat._id, accountId: user._id });
    check('state has no package view', state.billingMode === 'per_minute' && state.package === undefined);
    await ChatSession.updateOne({ _id: chat._id }, { $set: { startedAt: new Date(Date.now() - 150 * 1000) } });
    const ended = await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
    check('endChat trues up to minutesFor(150s) = 3 minutes, ₹60 total', ended.billing.amountCharged === 60 && await balanceOf(user._id) === 940);
    check('astrologer paid per minute as before (75% of ₹60 = ₹45)', await earningsOf(astro._id) === 45);
    markScenario(1, 'Per-minute chat — unchanged behaviour',
      ended.billing.mode === 'per_minute' && ended.billing.amountCharged === 60 && (await earningsOf(astro._id)) === 45);
  }

  section('scenario 2 — per-minute call: unchanged behaviour');
  {
    const user = await makeUser(1000);
    const astro = await makeAstrologer({ callRate: 30 });
    const chat = await chatService.requestChat({ userId: user._id, astrologerId: astro._id, channel: 'call', intake: {} });
    const accepted = await chatService.acceptChat({ chatId: chat._id, astrologerId: astro._id });
    check('call rate (₹30) frozen and charged upfront', accepted.billing.ratePerMinute === 30 && await balanceOf(user._id) === 970);
    const tick = await sweepAt(chat._id, seconds(accepted.lastBilledAt, 61));
    check('call minute 2 billed by the sweep', tick?.action === 'billed' && await balanceOf(user._id) === 940);
    const ended = await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
    markScenario(2, 'Per-minute call — unchanged behaviour', ended.billing.mode === 'per_minute' && ended.channel === 'call' && ended.billing.amountCharged === 60);
  }

  /* ------------------------------------------------ precheck */
  section('precheck — package quotes from the real rate');
  {
    const user = await makeUser(100);
    const astro = await makeAstrologer({ chatRate: 20, callRate: 30 });
    const chatCheck = await chatService.precheckSession({ userId: user._id, astrologerId: astro._id, channel: 'chat' });
    check('chat quotes 60/100/200/400', chatCheck.packages.map(q => q.price).join(',') === '60,100,200,400');
    check('flags affordability against the wallet', chatCheck.packages.map(q => q.affordable).join(',') === 'true,true,false,false');
    const callCheck = await chatService.precheckSession({ userId: user._id, astrologerId: astro._id, channel: 'call' });
    check('call quotes use the call rate: 90/150/300/600', callCheck.packages.map(q => q.price).join(',') === '90,150,300,600');
    check('existing precheck fields are unchanged', chatCheck.ok === true && chatCheck.ratePerMinute === 20 && chatCheck.minSessionMinutes === 1);
  }

  /* ------------------------------------------------ scenario 3 */
  section('scenario 3 — 3-min package, sufficient balance');
  let s3;
  {
    const user = await makeUser(300);
    const astro = await makeAstrologer({ chatRate: 20, commissionPercent: 25 });
    const requested = await chatService.requestChat({
      userId: user._id, astrologerId: astro._id, channel: 'chat', intake: {},
      billing: { mode: 'package', packageMinutes: 3, quotedPrice: 60 },
    });
    check('stored as a package request', requested.billing.mode === 'package' && requested.billing.requestedPackageMinutes === 3);
    check('nothing charged at request time', await balanceOf(user._id) === 300);
    const accepted = await chatService.acceptChat({ chatId: requested._id, astrologerId: astro._id });
    const chat = await ChatSession.findById(requested._id);
    check('active after accept', chat.status === 'active');
    check('charged the package price exactly once (₹60)', await balanceOf(user._id) === 240);
    const debits = await WalletTransaction.find({ chatSession: chat._id, ownerRole: 'user', direction: 'debit' });
    check('one debit transaction', debits.length === 1 && debits[0].amount === 60);
    check('one package ledger row', await ChatPackagePurchase.countDocuments({ chatSession: chat._id }) === 1);
    check('no per-minute tick rows', await ChatBillingTick.countDocuments({ chatSession: chat._id }) === 0);
    check('the record stores type, duration and amount',
      chat.billing.packages.length === 1 && chat.billing.packages[0].minutes === 3 && chat.billing.packages[0].kind === 'initial'
      && chat.billing.packageAmountCharged === 60 && chat.billing.amountCharged === 60);
    const runMs = chat.packageState.endsAt.getTime() - accepted.startedAt.getTime();
    check('the package runs 3 minutes from the start', runMs === 3 * 60 * 1000);
    check('astrologer NOT credited yet (settled at the end)', await earningsOf(astro._id) === 0);

    const endsAt = chat.packageState.endsAt;
    const r1 = await sweepAt(chat._id, seconds(chat.startedAt, 61));
    const r2 = await sweepAt(chat._id, seconds(chat.startedAt, 125));
    check('sweeps during the package charge nothing', r1.action === 'package_running' && r2.action === 'package_running' && await balanceOf(user._id) === 240);

    const w = await sweepAt(chat._id, seconds(endsAt, -25));
    check('~30s before the end: warning', w.action === 'package_warned' && eventsFor(chat._id, CHAT_EVENTS.PACKAGE_WARNING).length === 1);
    await sweepAt(chat._id, seconds(endsAt, -15));
    check('the warning fires only once', eventsFor(chat._id, CHAT_EVENTS.PACKAGE_WARNING).length === 1);

    await chatService.sendMessage({ chatId: chat._id, accountId: user._id, type: 'text', content: { text: 'still in time' } });
    const p = await sweepAt(chat._id, seconds(endsAt, 1));
    const prompt = eventsFor(chat._id, CHAT_EVENTS.PACKAGE_ENDED)[0];
    check('at the end: the extend prompt appears', p.action === 'extension_prompted' && Boolean(prompt));
    check('the prompt carries priced options, per-minute affordability and the 60s window',
      prompt?.payload.packages.map(q => q.price).join(',') === '60,100,200,400' && prompt.payload.perMinuteAffordable === true
      && prompt.payload.respondWithinSeconds === env.consultation.packageExtensionResponseSeconds);
    const frozen = await expectError(() => chatService.sendMessage({ chatId: chat._id, accountId: user._id, type: 'text', content: { text: 'hello?' } }));
    check('the chat is frozen while the prompt is open', frozen?.code === 'package_time_up');
    check('still nothing extra charged', await balanceOf(user._id) === 240);
    const view = (await chatService.getSessionState({ chatId: chat._id, accountId: user._id })).package;
    check('session state exposes the prompt (for a reconnecting app)', view.phase === 'awaiting_extension' && view.packages.length === 4 && Boolean(view.respondBy));
    const join = await chatService.joinChat({ chatId: chat._id, accountId: user._id });
    check('the socket rejoin exposes it too', join.package?.phase === 'awaiting_extension' && Boolean(join.serverTime));
    markScenario(3, '3-min package, sufficient balance → deducted once, runs 3 min, extend popup appears',
      (await balanceOf(user._id)) === 240 && runMs === 180000 && Boolean(prompt));
    s3 = { user, astro, chat };
  }

  /* ------------------------------------------------ scenario 5 */
  section('scenario 5 — extend with another package');
  {
    const { user, astro, chat } = s3;
    const before = await balanceOf(user._id);
    const insufficientExt = await expectError(() => chatService.extendPackage({ chatId: chat._id, userId: user._id, packageMinutes: 20, quotedPrice: 400 }));
    check('an unaffordable extension is refused with the exact shortfall', insufficientExt?.code === 'insufficient_balance' && insufficientExt.details?.shortfallAmount === 400 - before);
    const wrongPrice = await expectError(() => chatService.extendPackage({ chatId: chat._id, userId: user._id, packageMinutes: 5, quotedPrice: 1 }));
    check('a tampered/stale client price is refused (server price wins)', wrongPrice?.code === 'price_changed' && wrongPrice.details?.price === 100);
    const notUser = await expectError(() => chatService.extendPackage({ chatId: chat._id, userId: astro._id, packageMinutes: 5 }));
    check('only the seeker can extend', notUser?.status === 403);

    /** A double-tap: two extend calls at once. */
    const results = await Promise.allSettled([
      chatService.extendPackage({ chatId: chat._id, userId: user._id, packageMinutes: 5, quotedPrice: 100 }),
      chatService.extendPackage({ chatId: chat._id, userId: user._id, packageMinutes: 5, quotedPrice: 100 }),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    check('double-tap: exactly one extension succeeds', ok.length === 1, results.map(r => r.status === 'rejected' ? r.reason.message : 'ok'));
    check('second deduction happened exactly once (₹100)', await balanceOf(user._id) === before - 100);
    const after = await ChatSession.findById(chat._id);
    check('the record now holds both packages', after.billing.packages.map(p => `${p.kind}:${p.minutes}:${p.amount}`).join('|') === 'initial:3:60|extension:5:100');
    check('the prompt is cleared and the timer continues for 5 minutes', !after.packageState.promptedAt
      && Math.abs(after.packageState.endsAt.getTime() - (ok[0].value.endsAt.getTime())) === 0
      && Math.abs(after.packageState.endsAt.getTime() - Date.now() - 5 * 60000) < 5000);
    check('chatting works again', Boolean(await chatService.sendMessage({ chatId: chat._id, accountId: user._id, type: 'text', content: { text: 'thanks' } })));
    check('a live package_extended event went out', eventsFor(chat._id, CHAT_EVENTS.PACKAGE_EXTENDED).length === 1);
    const notAwaiting = await expectError(() => chatService.extendPackage({ chatId: chat._id, userId: user._id, packageMinutes: 3 }));
    check('extending while the package is still running is refused', notAwaiting?.code === 'not_awaiting_extension');
    const r = await sweepAt(chat._id, seconds(after.packageState.endsAt, -120));
    check('the new package runs without per-minute charges', r.action === 'package_running' && await ChatBillingTick.countDocuments({ chatSession: chat._id }) === 0);
    markScenario(5, 'Extend with another package → second deduction, timer continues',
      ok.length === 1 && (await balanceOf(user._id)) === before - 100 && !after.packageState.promptedAt);
  }

  /* ------------------------------------------------ scenario 7 (on the s3 session) */
  section('scenario 7 — end at the popup');
  {
    const { user, astro, chat } = s3;
    const fresh = await ChatSession.findById(chat._id);
    await sweepAt(chat._id, seconds(fresh.packageState.endsAt, 1));
    check('prompt open again after the extension ran out', Boolean((await ChatSession.findById(chat._id)).packageState.promptedAt));
    const before = await balanceOf(user._id);
    const ended = await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user', reason: 'user_ended' });
    check('session ended', ended.status === 'ended');
    check('no extra charge at the end', await balanceOf(user._id) === before && ended.billing.amountCharged === 160);
    check('no per-minute minutes billed', ended.minutesBilled === 0 && await ChatBillingTick.countDocuments({ chatSession: chat._id }) === 0);
    check('astrologer credited their share of the packages once, at the end (75% of ₹160 = ₹120)', await earningsOf(astro._id) === 120 && ended.billing.astrologerEarning === 120);
    const again = await expectError(() => chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' }));
    check('ending twice is refused, and pays nothing twice', again?.status === 400 && await earningsOf(astro._id) === 120);
    const astroStats = await Astrologer.findById(astro._id);
    check('stats count the 8 package minutes', astroStats.metrics.chatMinutes === 8);
    markScenario(7, 'End at popup → session ends, no extra charge', (await balanceOf(user._id)) === before && ended.status === 'ended');
  }

  /* ------------------------------------------------ scenario 4 */
  section('scenario 4 — package with insufficient balance');
  {
    const user = await makeUser(50);
    const astro = await makeAstrologer({ chatRate: 20 });
    const error = await expectError(() => chatService.requestChat({
      userId: user._id, astrologerId: astro._id, channel: 'chat', intake: {},
      billing: { mode: 'package', packageMinutes: 3, quotedPrice: 60 },
    }));
    check('blocked with insufficient_balance', error?.status === 400 && error.code === 'insufficient_balance');
    check('carries the exact shortfall (₹10) for the recharge prompt', error?.details?.shortfallAmount === 10 && error.details.price === 60);
    check('no session created, nothing charged', await ChatSession.countDocuments({ user: user._id }) === 0 && await balanceOf(user._id) === 50);
    const perMinuteOk = await chatService.requestChat({ userId: user._id, astrologerId: astro._id, channel: 'chat', intake: {} });
    check('the same wallet can still start per-minute (unchanged rule: 1 minute)', perMinuteOk.status === 'requested');
    const bad = await expectError(() => chatService.requestChat({ userId: user._id, astrologerId: astro._id, intake: {}, billing: { mode: 'package', packageMinutes: 7 } }));
    check('an unknown package duration is refused', bad?.code === 'invalid_package');
    markScenario(4, 'Package with insufficient balance → blocked, recharge prompt data returned', error?.code === 'insufficient_balance' && error.details?.shortfallAmount === 10);
  }

  /* ------------------------------------------------ rate change */
  section('edge — rate changes between opening the form and submitting');
  {
    const user = await makeUser(1000);
    const astro = await makeAstrologer({ chatRate: 20 });
    const pre = await chatService.precheckSession({ userId: user._id, astrologerId: astro._id, channel: 'chat' });
    await Astrologer.updateOne({ _id: astro._id, 'services.type': 'chat' }, { $set: { 'services.$.ratePerMinute': 25 } });
    const error = await expectError(() => chatService.requestChat({
      userId: user._id, astrologerId: astro._id, intake: {},
      billing: { mode: 'package', packageMinutes: 5, quotedPrice: pre.packages[1].price },
    }));
    check('the stale quote (₹100) is refused with price_changed', error?.status === 409 && error.code === 'price_changed');
    check('the new server price is returned (5 × ₹25 = ₹125)', error?.details?.price === 125);
    const chat = await startPackage({ user, astro, minutes: 5, quotedPrice: 125 });
    check('re-confirmed at the new price, charged ₹125', await balanceOf(user._id) === 875 && chat.billing.ratePerMinute === 25);
    await Astrologer.updateOne({ _id: astro._id, 'services.type': 'chat' }, { $set: { 'services.$.ratePerMinute': 40 } });
    await sweepAt(chat._id, seconds(chat.packageState.endsAt, 1));
    const ext = await chatService.extendPackage({ chatId: chat._id, userId: user._id, packageMinutes: 3 });
    check('an extension uses the session\'s frozen rate, not a mid-session change (3 × ₹25 = ₹75)', ext.amount === 75);
    await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
  }

  /* ------------------------------------------------ scenario 6 */
  section('scenario 6 — extend → switch to per-minute');
  {
    const user = await makeUser(500);
    const astro = await makeAstrologer({ chatRate: 20, commissionPercent: 25 });
    const chat = await startPackage({ user, astro, minutes: 3, quotedPrice: 60 });
    const earlyCheck = await sweepAt(chat._id, seconds(chat.startedAt, 90));
    check('no per-minute billing while the package is running', earlyCheck.action === 'package_running' && await ChatBillingTick.countDocuments({ chatSession: chat._id }) === 0);
    const early = await expectError(() => chatService.continuePerMinute({ chatId: chat._id, userId: user._id }));
    check('cannot switch before the package ends', early?.code === 'not_awaiting_extension');
    await sweepAt(chat._id, seconds(chat.packageState.endsAt, 1));
    const before = await balanceOf(user._id);
    check('no per-minute charge between package end and the choice', before === 440);
    const cont = await chatService.continuePerMinute({ chatId: chat._id, userId: user._id });
    check('switching charges the first per-minute minute upfront (₹20)', await balanceOf(user._id) === before - 20 && cont.balanceRemaining === before - 20);
    const switched = await ChatSession.findById(chat._id);
    check('the record keeps mode=package and marks the switch', switched.billing.mode === 'package' && Boolean(switched.packageState.perMinuteStartedAt) && !switched.packageState.promptedAt);
    check('per-minute ledger starts at minute 1', switched.minutesBilled === 1 && await ChatBillingTick.countDocuments({ chatSession: chat._id }) === 1);
    check('a live per_minute_started event went out', eventsFor(chat._id, CHAT_EVENTS.PER_MINUTE_STARTED).length === 1);
    const tick = await sweepAt(chat._id, seconds(switched.lastBilledAt, 61));
    check('the existing per-minute sweep now bills normally', tick.action === 'billed' && await balanceOf(user._id) === before - 40);
    check('astrologer got per-minute earnings as they tick (75% of ₹40 = ₹30), package share still pending', await earningsOf(astro._id) === 30);
    /** 150s of per-minute time -> 3 minutes owed from the switch point, never from the package start. */
    await ChatSession.updateOne({ _id: chat._id }, { $set: { 'packageState.perMinuteStartedAt': new Date(Date.now() - 150 * 1000) } });
    const ended = await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
    check('endChat trues up only the per-minute tail (3 min = ₹60) on top of the package (₹60)', ended.billing.amountCharged === 120 && await balanceOf(user._id) === 380);
    check('astrologer: per-minute ₹45 + package ₹45 = ₹90', await earningsOf(astro._id) === 90);
    markScenario(6, 'Extend → switch to per-minute → per-minute starts only after package ends',
      earlyCheck.action === 'package_running' && before === 440 && ended.billing.amountCharged === 120);
  }

  section('edge — continue per-minute without enough balance');
  {
    const user = await makeUser(65);
    const astro = await makeAstrologer({ chatRate: 20 });
    const chat = await startPackage({ user, astro, minutes: 3, quotedPrice: 60 });
    await sweepAt(chat._id, seconds(chat.packageState.endsAt, 1));
    const error = await expectError(() => chatService.continuePerMinute({ chatId: chat._id, userId: user._id }));
    check('refused with the shortfall (₹15)', error?.code === 'insufficient_balance' && error.details?.shortfallAmount === 15);
    const after = await ChatSession.findById(chat._id);
    check('the prompt stays open, nothing charged, not switched', Boolean(after.packageState.promptedAt) && !after.packageState.perMinuteStartedAt && await balanceOf(user._id) === 5);
    await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
  }

  /* ------------------------------------------------ scenario 8 */
  section('scenario 8 — no response to the popup');
  {
    const user = await makeUser(500);
    const astro = await makeAstrologer({ chatRate: 20 });
    const chat = await startPackage({ user, astro, minutes: 3, quotedPrice: 60 });
    const promptAt = seconds(chat.packageState.endsAt, 2);
    await sweepAt(chat._id, promptAt);
    const waiting = await sweepAt(chat._id, seconds(promptAt, 30));
    check('still waiting 30s in', waiting.action === 'awaiting_extension');
    const before = await balanceOf(user._id);
    const ended = await sweepAt(chat._id, seconds(promptAt, env.consultation.packageExtensionResponseSeconds + 1));
    const row = await ChatSession.findById(chat._id);
    check('auto-ended after the response window', ended.action === 'ended_no_response' && row.status === 'ended');
    check('ended by system, reason package_no_response', row.endedBy === 'system' && row.endReason === 'package_no_response');
    check('no extra charge', await balanceOf(user._id) === before && row.billing.amountCharged === 60);
    check('both sides were told it ended', eventsFor(chat._id, CHAT_EVENTS.ENDED).length === 1);
    const late = await expectError(() => chatService.extendPackage({ chatId: chat._id, userId: user._id, packageMinutes: 3 }));
    check('a late extend after auto-end is refused and charges nothing', late?.status === 400 && await balanceOf(user._id) === before);
    markScenario(8, 'No response to popup → auto end', row.status === 'ended' && row.endReason === 'package_no_response' && (await balanceOf(user._id)) === before);
  }

  section('edge — an answer racing the timeout never charges a closing session');
  {
    const user = await makeUser(500);
    const astro = await makeAstrologer({ chatRate: 20 });
    const chat = await startPackage({ user, astro, minutes: 3, quotedPrice: 60 });
    await sweepAt(chat._id, seconds(chat.packageState.endsAt, 1));
    /** The sweep has claimed the prompt for closing (closingAt set) but not yet ended it. */
    await ChatSession.updateOne({ _id: chat._id }, { $set: { 'packageState.closingAt': new Date() } });
    const before = await balanceOf(user._id);
    const ext = await expectError(() => chatService.extendPackage({ chatId: chat._id, userId: user._id, packageMinutes: 3 }));
    const cont = await expectError(() => chatService.continuePerMinute({ chatId: chat._id, userId: user._id }));
    check('extend and continue both refused', ext?.code === 'not_awaiting_extension' && cont?.code === 'not_awaiting_extension');
    check('nothing charged', await balanceOf(user._id) === before);
    await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'system', reason: 'package_no_response' });
  }

  /* ------------------------------------------------ scenario 9 */
  section('scenario 9 — deduction succeeds but session start fails');
  {
    const user = await makeUser(500);
    const astro = await makeAstrologer({ chatRate: 20 });
    const requested = await chatService.requestChat({
      userId: user._id, astrologerId: astro._id, intake: {}, billing: { mode: 'package', packageMinutes: 5, quotedPrice: 100 },
    });
    /** Fails the step AFTER the debit — the session going active — inside the same transaction. */
    const realSave = ChatSession.prototype.save;
    ChatSession.prototype.save = async function failingSave(...args) {
      if (this.status === 'active' && String(this._id) === String(requested._id)) {
        throw new Error('simulated crash while starting the session');
      }
      return realSave.apply(this, args);
    };
    const error = await expectError(() => chatService.acceptChat({ chatId: requested._id, astrologerId: astro._id }));
    ChatSession.prototype.save = realSave;
    const row = await ChatSession.findById(requested._id);
    check('the start failed', Boolean(error) && row.status === 'requested');
    check('the user was NOT charged (debit rolled back with it)', await balanceOf(user._id) === 500);
    check('no debit transaction and no package ledger row persisted',
      await WalletTransaction.countDocuments({ chatSession: requested._id }) === 0 && await ChatPackagePurchase.countDocuments({ chatSession: requested._id }) === 0);
    const retry = await chatService.acceptChat({ chatId: requested._id, astrologerId: astro._id });
    check('a retry then starts it and charges exactly once', retry.status === 'active' && await balanceOf(user._id) === 400);

    /** Rejected / missed / cancelled requests are never charged, since nothing is charged before accept. */
    const u2 = await makeUser(500);
    const a2 = await makeAstrologer();
    const r1 = await chatService.requestChat({ userId: u2._id, astrologerId: a2._id, intake: {}, billing: { mode: 'package', packageMinutes: 3, quotedPrice: 60 } });
    await chatService.rejectChat({ chatId: r1._id, astrologerId: a2._id });
    const r2 = await chatService.requestChat({ userId: u2._id, astrologerId: a2._id, intake: {}, billing: { mode: 'package', packageMinutes: 3, quotedPrice: 60 } });
    await chatService.cancelChat({ chatId: r2._id, userId: u2._id });
    const r3 = await chatService.requestChat({ userId: u2._id, astrologerId: a2._id, intake: {}, billing: { mode: 'package', packageMinutes: 3, quotedPrice: 60 } });
    await chatService.expireStaleRequests(undefined, new Date(Date.now() + (chatService.REQUEST_TIMEOUT_SECONDS + 5) * 1000));
    check('rejected / cancelled / missed package requests charge nothing', await balanceOf(u2._id) === 500 && (await ChatSession.findById(r3._id)).status === 'missed');
    const dup = await expectError(() => Promise.all([
      chatService.requestChat({ userId: u2._id, astrologerId: a2._id, intake: {}, billing: { mode: 'package', packageMinutes: 3, quotedPrice: 60 } }),
      chatService.requestChat({ userId: u2._id, astrologerId: a2._id, intake: {}, billing: { mode: 'package', packageMinutes: 3, quotedPrice: 60 } }),
    ]));
    const open = await ChatSession.countDocuments({ user: u2._id, status: 'requested' });
    check('double-submitted request: exactly one open request, the duplicate refused with 409', open === 1 && dup?.status === 409, { open, dup: dup?.message });
    let raceOpen = 0;
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [ru, ra] = await Promise.all([makeUser(500), makeAstrologer()]);
      const body = { userId: ru._id, astrologerId: ra._id, intake: {}, billing: { mode: 'package', packageMinutes: 3, quotedPrice: 60 } };
      // eslint-disable-next-line no-await-in-loop
      await Promise.allSettled([chatService.requestChat(body), chatService.requestChat(body), chatService.requestChat(body)]);
      // eslint-disable-next-line no-await-in-loop
      raceOpen += await ChatSession.countDocuments({ user: ru._id, status: 'requested' });
    }
    check('5 rounds of 3 simultaneous submits leave exactly 5 open requests (one each)', raceOpen === 5, { raceOpen });
    const perMinuteDup = await (async () => {
      const [ru, ra] = await Promise.all([makeUser(500), makeAstrologer()]);
      const body = { userId: ru._id, astrologerId: ra._id, intake: {} };
      await Promise.allSettled([chatService.requestChat(body), chatService.requestChat(body)]);
      return ChatSession.countDocuments({ user: ru._id, status: 'requested' });
    })();
    check('the same guard covers per-minute double-submits', perMinuteDup === 1, { perMinuteDup });
    markScenario(9, 'Deduction succeeds but session start fails → user not charged', row.status === 'requested' && (await ChatPackagePurchase.countDocuments({ chatSession: requested._id })) === 1 && retry.billing.amountCharged === 100);
  }

  /* ------------------------------------------------ scenario 10 */
  section('scenario 10 — package flow on a call consultation');
  {
    const user = await makeUser(1000);
    const astro = await makeAstrologer({ chatRate: 20, callRate: 30 });
    const chat = await startPackage({ user, astro, minutes: 5, channel: 'call', quotedPrice: 150 });
    check('priced at the call rate (5 × ₹30 = ₹150) and charged once', chat.channel === 'call' && await balanceOf(user._id) === 850);
    const debit = await WalletTransaction.findOne({ chatSession: chat._id, direction: 'debit' });
    check('ledger title says Call', /^Call consultation — 5-min package/.test(debit.title));
    await sweepAt(chat._id, seconds(chat.packageState.endsAt, -20));
    await sweepAt(chat._id, seconds(chat.packageState.endsAt, 1));
    check('warning and prompt fire for a call too', eventsFor(chat._id, CHAT_EVENTS.PACKAGE_WARNING).length === 1 && eventsFor(chat._id, CHAT_EVENTS.PACKAGE_ENDED).length === 1);
    const ext = await chatService.extendPackage({ chatId: chat._id, userId: user._id, packageMinutes: 3, quotedPrice: 90 });
    check('extension at the call rate (₹90)', ext.amount === 90 && await balanceOf(user._id) === 760);
    const ended = await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
    check('call metrics count the package minutes', (await Astrologer.findById(astro._id)).metrics.callMinutes === 8);
    markScenario(10, 'Package flow on a call consultation (backend)', ended.billing.amountCharged === 240 && (await balanceOf(user._id)) === 760);
  }

  /* ------------------------------------------------ astrologer ends early / disconnects */
  section('edge — astrologer ends before the package is over (refund hook)');
  {
    const user = await makeUser(500);
    const astro = await makeAstrologer({ chatRate: 20 });
    const chat = await startPackage({ user, astro, minutes: 10, quotedPrice: 200 });
    const ended = await chatService.endChat({ chatId: chat._id, accountId: astro._id, endedBy: 'astrologer' });
    check('unused package seconds are recorded on the session (~600s)', ended.packageState.unusedSeconds > 590);
    check('refund hook currently returns ₹0 — no refund posted (POLICY PENDING)', ended.billing.packageRefundAmount === 0 && await balanceOf(user._id) === 300);
    check('astrologer credited for the package at the end (75% of ₹200)', await earningsOf(astro._id) === 150);
  }

  section('edge — astrologer disconnect pauses the package clock');
  {
    const user = await makeUser(500);
    const astro = await makeAstrologer({ chatRate: 20 });
    const chat = await startPackage({ user, astro, minutes: 3, quotedPrice: 60 });
    const originalEnd = chat.packageState.endsAt;
    const droppedAt = new Date();
    await chatService.pauseSessionsForAstrologer(astro._id, droppedAt);
    const during = await sweepAt(chat._id, seconds(droppedAt, 30));
    check('while disconnected the package clock is not ticked (grace routing)', during.action === 'astrologer_disconnect_grace');
    await chatService.resumeSessionsForAstrologer(astro._id, seconds(droppedAt, 40));
    const after = await ChatSession.findById(chat._id);
    check('on reconnect the package end moves forward by the 40s outage', after.packageState.endsAt.getTime() - originalEnd.getTime() === 40000);

    await chatService.pauseSessionsForAstrologer(astro._id, new Date());
    const gone = await sweepAt(chat._id, new Date(Date.now() + (env.consultation.astrologerReconnectGraceSeconds + 1) * 1000));
    const row = await ChatSession.findById(chat._id);
    check('never returning ends it (astrologer_disconnected) with no extra charge', gone.action === 'ended_astrologer_disconnected' && row.endReason === 'astrologer_disconnected' && await balanceOf(user._id) === 440);
    check('unused seconds recorded for the refund hook', row.packageState.unusedSeconds > 0);
  }

  section('edge — history rows carry the booking type');
  {
    const list = await chatService.listChats({ accountId: s3.user._id, role: 'user' });
    check('billingMode and total package minutes on the row', list.items[0].billingMode === 'package' && list.items[0].packageMinutes === 8);
    const systemLines = await Message.find({ chatId: s3.chat._id, senderRole: 'system' }).sort({ seq: 1 });
    check('both sides see package notices in the transcript', systemLines.some(m => m.content.event === 'package_extended') && systemLines.some(m => m.content.event === 'package_ended'));
  }

  /* ------------------------------------------------ HTTP contract */
  section('HTTP — routes, validators and error details');
  {
    const { createApp } = require('../app');
    const { signAccessToken } = require('../utils/token');
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = token => async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const user = await makeUser(70);
    const astro = await makeAstrologer({ chatRate: 20 });
    const asUser = call(signAccessToken(String(user._id), 'user'));
    const asAstro = call(signAccessToken(String(astro._id), 'astrologer'));

    const pre = await asUser('POST', '/chats/precheck', { astrologerId: String(astro._id), channel: 'chat' });
    check('POST /chats/precheck returns priced packages', pre.status === 200 && pre.body.packages?.[0]?.price === 60 && pre.body.packages[1].affordable === false);
    const bad = await asUser('POST', '/chats', { astrologerId: String(astro._id), billing: { mode: 'weird' } });
    check('POST /chats rejects an unknown consultation type (422/400)', bad.status >= 400 && bad.status < 500);
    const short = await asUser('POST', '/chats', { astrologerId: String(astro._id), intake: {}, billing: { mode: 'package', packageMinutes: 5, quotedPrice: 100 } });
    check('POST /chats: insufficient -> 400 + code + details.shortfallAmount', short.status === 400 && short.body.code === 'insufficient_balance' && short.body.details?.shortfallAmount === 30);
    const stale = await asUser('POST', '/chats', { astrologerId: String(astro._id), intake: {}, billing: { mode: 'package', packageMinutes: 3, quotedPrice: 45 } });
    check('POST /chats: stale price -> 409 price_changed + details.price', stale.status === 409 && stale.body.code === 'price_changed' && stale.body.details?.price === 60);
    const ok = await asUser('POST', '/chats', { astrologerId: String(astro._id), intake: {}, billing: { mode: 'package', packageMinutes: 3, quotedPrice: 60 } });
    check('POST /chats: package request created', ok.status === 201 && ok.body.billingMode === 'package' && ok.body.packageMinutes === 3);
    const acc = await asAstro('POST', `/chats/${ok.body.chatId}/accept`);
    check('accept over HTTP charges the package', acc.status === 200 && await balanceOf(user._id) === 10);
    const st = await asUser('GET', `/chats/${ok.body.chatId}`);
    check('GET /chats/:id exposes billingMode, package view and serverTime', st.body.billingMode === 'package' && st.body.package?.phase === 'package' && Boolean(st.body.package.endsAt) && Boolean(st.body.serverTime));
    const early = await asUser('POST', `/chats/${ok.body.chatId}/extend`, { packageMinutes: 3, quotedPrice: 60 });
    check('POST /extend before the package ends -> 409 not_awaiting_extension', early.status === 409 && early.body.code === 'not_awaiting_extension');
    const astroExt = await asAstro('POST', `/chats/${ok.body.chatId}/extend`, { packageMinutes: 3 });
    check('POST /extend is seeker-only (403 for the astrologer)', astroExt.status === 403);
    const noMin = await asUser('POST', `/chats/${ok.body.chatId}/extend`, {});
    check('POST /extend without packageMinutes is refused by the validator', noMin.status >= 400 && noMin.status < 500 && noMin.status !== 409);
    const chat = await ChatSession.findById(ok.body.chatId);
    await sweepAt(chat._id, seconds(chat.packageState.endsAt, 1));
    const cont = await asUser('POST', `/chats/${ok.body.chatId}/continue-per-minute`);
    check('POST /continue-per-minute with ₹10 left for a ₹20 minute -> insufficient + shortfall', cont.status === 400 && cont.body.details?.shortfallAmount === 10);
    const end = await asUser('POST', `/chats/${ok.body.chatId}/end`, { reason: 'user_ended' });
    check('ending from the prompt charges nothing more', end.status === 200 && end.body.amountCharged === 60 && await balanceOf(user._id) === 10);
    server.close();
  }

  console.log('\n=== SCENARIOS ===');
  for (const n of Object.keys(scenario).sort((a, b) => a - b)) {
    console.log(`  ${scenario[n].ok ? 'PASS' : 'FAIL'}  ${n}. ${scenario[n].label}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('CRASHED:', e);
  process.exit(1);
});
