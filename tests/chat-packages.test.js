/**
 * Package-based consultations (config/packages.js, services/chat.service.js):
 * pricing, the upfront package charge on accept, the package sweep (warning,
 * then PAUSING when the package runs out until the seeker chooses how to
 * continue — per-minute or another package — recharging first if needed),
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
const walletService = require('../services/wallet.service');
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
  check('the built-in defaults carry no discount (admin sets real ones)', packages.CONSULTATION_PACKAGES.every(p => p.discountPercent === 0));
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
  section('scenario 3 — 3-min package ends → session pauses and asks how to continue (nothing auto-charged)');
  let s3;
  {
    const user = await makeUser(300);
    const astro = await makeAstrologer({ chatRate: 20, commissionPercent: 25 });
    const requested = await chatService.requestChat({
      userId: user._id, astrologerId: astro._id, channel: 'chat', intake: {},
      billing: { mode: 'package', packageMinutes: 3, quotedPrice: 60 },
    });
    check('stored as a package request, nothing charged yet', requested.billing.mode === 'package' && await balanceOf(user._id) === 300);
    const accepted = await chatService.acceptChat({ chatId: requested._id, astrologerId: astro._id });
    const chat = await ChatSession.findById(requested._id);
    check('charged the package price exactly once on accept (₹60)', await balanceOf(user._id) === 240
      && (await WalletTransaction.countDocuments({ chatSession: chat._id, direction: 'debit' })) === 1);
    check('one package ledger row, no per-minute rows',
      await ChatPackagePurchase.countDocuments({ chatSession: chat._id }) === 1 && await ChatBillingTick.countDocuments({ chatSession: chat._id }) === 0);
    const runMs = chat.packageState.endsAt.getTime() - accepted.startedAt.getTime();
    check('the package runs 3 minutes', runMs === 3 * 60 * 1000);
    check('astrologer NOT credited yet (settled at the end)', await earningsOf(astro._id) === 0);

    const endsAt = chat.packageState.endsAt;
    const r1 = await sweepAt(chat._id, seconds(chat.startedAt, 61));
    check('sweeps during the package charge nothing', r1.action === 'package_running' && await balanceOf(user._id) === 240);
    const w = await sweepAt(chat._id, seconds(endsAt, -25));
    check('~30s before the end: package warning (wallet is fine)', w.action === 'package_warned' && eventsFor(chat._id, CHAT_EVENTS.PACKAGE_WARNING).length === 1);

    const p = await sweepAt(chat._id, seconds(endsAt, 1));
    const paused = await ChatSession.findById(chat._id);
    const ended = eventsFor(chat._id, CHAT_EVENTS.PACKAGE_ENDED)[0];
    check('at the end: the session PAUSES on the seeker\'s choice', p.action === 'awaiting_choice_opened' && Boolean(paused.packageState.awaitingChoiceSince));
    check('nothing is charged automatically — no per-minute minute', await balanceOf(user._id) === 240 && paused.minutesBilled === 0 && !paused.packageState.perMinuteStartedAt);
    check('both sides are told, with the options priced (per-minute ₹20, packages 60/100/200/400)',
      ended?.payload.ratePerMinute === 20 && ended.payload.perMinuteAffordable === true && ended.payload.canContinue === true
      && ended.payload.packages.map(q => q.price).join(',') === '60,100,200,400');
    const blocked = await expectError(() => chatService.sendMessage({ chatId: chat._id, accountId: user._id, type: 'text', content: { text: 'hello?' } }));
    check('messages are blocked while paused', blocked?.code === 'awaiting_choice');
    const later = await sweepAt(chat._id, seconds(endsAt, 600));
    check('it stays paused (no timeout, nothing billed) until the seeker chooses', later.action === 'awaiting_choice' && await balanceOf(user._id) === 240);
    const view = (await chatService.getSessionState({ chatId: chat._id, accountId: user._id })).package;
    check('a reopened app sees the pause and the options', view.phase === 'awaiting_choice' && view.packages.length === 4 && view.perMinuteAffordable === true);
    const astroView = (await chatService.getSessionState({ chatId: chat._id, accountId: astro._id })).package;
    check('the astrologer\'s app sees the same pause', astroView.phase === 'awaiting_choice');
    markScenario(3, '3-min package, sufficient balance → deducted once, runs 3 min, then pauses and asks (no auto per-minute)',
      runMs === 180000 && p.action === 'awaiting_choice_opened' && (await balanceOf(user._id)) === 240);
    s3 = { user, astro, chat };
  }

  section('scenario 5 — choose another package: charged once, timer continues');
  {
    const { user, astro, chat } = s3;
    const notUser = await expectError(() => chatService.continueConsultation({ chatId: chat._id, userId: astro._id, mode: 'per_minute' }));
    check('only the seeker can choose', notUser?.status === 403);
    const tooBig = await expectError(() => chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'package', packageMinutes: 20, quotedPrice: 400 }));
    check('an unaffordable package is refused with the shortfall (for the recharge popup)', tooBig?.code === 'insufficient_balance' && tooBig.details?.shortfallAmount === 160);
    const stale = await expectError(() => chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'package', packageMinutes: 5, quotedPrice: 1 }));
    check('a stale price is refused (price_changed)', stale?.code === 'price_changed' && stale.details?.price === 100);

    const results = await Promise.allSettled([
      chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'package', packageMinutes: 5, quotedPrice: 100 }),
      chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'package', packageMinutes: 5, quotedPrice: 100 }),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    check('double tap: exactly one continuation succeeds', ok.length === 1, results.map(r => r.status === 'rejected' ? r.reason.message : 'ok'));
    check('charged once (₹240 → ₹140)', await balanceOf(user._id) === 140);
    const after = await ChatSession.findById(chat._id);
    check('unpaused, new 5-minute package running from now', !after.packageState.awaitingChoiceSince
      && Math.abs(after.packageState.endsAt.getTime() - Date.now() - 5 * 60000) < 5000);
    check('the record holds both packages', after.billing.packages.map(p => `${p.kind}:${p.minutes}:${p.amount}`).join('|') === 'initial:3:60|extension:5:100');
    check('both sides told (package_extended)', eventsFor(chat._id, CHAT_EVENTS.PACKAGE_EXTENDED).length === 1);
    check('chatting works again', Boolean(await chatService.sendMessage({ chatId: chat._id, accountId: user._id, type: 'text', content: { text: 'thanks' } })));
    const again = await expectError(() => chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'per_minute' }));
    check('choosing again while a package runs is refused', again?.code === 'not_awaiting_choice');
    markScenario(5, 'Choose another package → charged once, timer continues', ok.length === 1 && (await balanceOf(user._id)) === 140);
  }

  section('scenario 6 — second package ends → choose per-minute: first minute charged, then per-minute');
  {
    const { user, astro, chat } = s3;
    const fresh = await ChatSession.findById(chat._id);
    await sweepAt(chat._id, seconds(fresh.packageState.endsAt, 1));
    check('paused again when the second package runs out', Boolean((await ChatSession.findById(chat._id)).packageState.awaitingChoiceSince));
    const before = await balanceOf(user._id);
    const cont = await chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'per_minute' });
    const switched = await ChatSession.findById(chat._id);
    check('per-minute chosen: first minute charged upfront (₹140 → ₹120)', await balanceOf(user._id) === before - 20 && cont.balanceRemaining === before - 20);
    check('unpaused, per-minute from now, record keeps mode=package', switched.billing.mode === 'package'
      && Boolean(switched.packageState.perMinuteStartedAt) && !switched.packageState.awaitingChoiceSince && switched.minutesBilled === 1);
    check('both sides told (per_minute_started)', eventsFor(chat._id, CHAT_EVENTS.PER_MINUTE_STARTED).length === 1);
    const tick = await sweepAt(chat._id, seconds(switched.lastBilledAt, 61));
    check('the ordinary per-minute sweep bills from here', tick.action === 'billed' && await balanceOf(user._id) === 100);
    await ChatSession.updateOne({ _id: chat._id }, { $set: { 'packageState.perMinuteStartedAt': new Date(Date.now() - 150 * 1000) } });
    const ended = await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
    check('end trues up only the per-minute tail (3 min) on top of the packages', ended.billing.amountCharged === 160 + 60 && await balanceOf(user._id) === 80);
    check('astrologer: per-minute ₹45 + packages ₹120 (75% of ₹160) = ₹165', await earningsOf(astro._id) === 165);
    check('stats count 8 package + 3 per-minute minutes', (await Astrologer.findById(astro._id)).metrics.chatMinutes === 11);
    markScenario(6, 'Choose per-minute → per-minute starts only then, billed from that point', ended.billing.amountCharged === 220);
  }

  section('scenario 7 — end during the pause, and during a package');
  {
    const user = await makeUser(500);
    const astro = await makeAstrologer({ chatRate: 20 });
    const chat = await startPackage({ user, astro, minutes: 3, quotedPrice: 60 });
    await sweepAt(chat._id, seconds(chat.packageState.endsAt, 1));
    const ended = await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
    check('ending while paused: no extra charge', ended.status === 'ended' && await balanceOf(user._id) === 440 && ended.billing.amountCharged === 60);
    check('astrologer settled once (₹45)', await earningsOf(astro._id) === 45);
    const twice = await expectError(() => chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' }));
    check('ending twice is refused', twice?.status === 400 && await earningsOf(astro._id) === 45);
    const late = await expectError(() => chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'per_minute' }));
    check('choosing after it ended is refused, nothing charged', late?.status === 400 && await balanceOf(user._id) === 440);

    const u2 = await makeUser(500);
    const a2 = await makeAstrologer({ chatRate: 20 });
    const c2 = await startPackage({ user: u2, astro: a2, minutes: 5, quotedPrice: 100 });
    const e2 = await chatService.endChat({ chatId: c2._id, accountId: u2._id, endedBy: 'user' });
    check('ending during a package: no extra charge, no refund (seeker\'s choice)', await balanceOf(u2._id) === 400 && e2.billing.packageRefundAmount === 0);
    markScenario(7, 'End at the pause or during a package → no extra charge', ended.status === 'ended' && (await balanceOf(u2._id)) === 400);
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

  /* ------------------------------------------------ scenario 8 */
  section('scenario 8 — package ends with a low wallet: existing low-balance warning, pause, recharge, then choose');
  {
    const user = await makeUser(70);
    const astro = await makeAstrologer({ chatRate: 20 });
    const chat = await startPackage({ user, astro, minutes: 3, quotedPrice: 60 });
    const endsAt = chat.packageState.endsAt;
    const w = await sweepAt(chat._id, seconds(endsAt, -25));
    const low = eventsFor(chat._id, CHAT_EVENTS.LOW_BALANCE)[0];
    check('~30s before the end: the ordinary low-balance warning (existing banner), ₹10 < ₹20',
      w.action === 'package_warned_low_balance' && low?.payload.requiredAmount === 20 && low.payload.balanceRemaining === 10);
    await sweepAt(chat._id, seconds(endsAt, 1));
    const ended = eventsFor(chat._id, CHAT_EVENTS.PACKAGE_ENDED)[0];
    check('at the end: paused, and told nothing is affordable (app recharges first)', ended?.payload.canContinue === false && ended.payload.perMinuteAffordable === false);
    const refused = await expectError(() => chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'per_minute' }));
    check('per-minute refused with the shortfall (₹10)', refused?.code === 'insufficient_balance' && refused.details?.shortfallAmount === 10);
    check('nothing charged', await balanceOf(user._id) === 10);

    await walletService.post({ ownerRole: 'user', ownerId: user._id, direction: 'credit', type: 'topup', amount: 100, title: 'Top-up' });
    const view = (await chatService.getSessionState({ chatId: chat._id, accountId: user._id })).package;
    check('after recharging, the options are affordable (state re-read)', view.phase === 'awaiting_choice' && view.canContinue === true && view.perMinuteAffordable === true);
    check('still paused after the recharge — it waits for the seeker\'s approval', Boolean((await ChatSession.findById(chat._id)).packageState.awaitingChoiceSince));
    const cont = await chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'package', packageMinutes: 3, quotedPrice: 60 });
    check('then they choose a package and it is charged (₹110 → ₹50)', cont.amount === 60 && await balanceOf(user._id) === 50);
    await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
    markScenario(8, 'Package ends with low wallet → warning, pause, recharge, approval to continue', ended?.payload.canContinue === false && cont.amount === 60);
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
    const ext = await chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'package', packageMinutes: 3 });
    check('continuing uses the session\'s frozen rate (3 × ₹25 = ₹75), not a mid-session change', ext.amount === 75 && await balanceOf(user._id) === 800);
    await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
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
    const ended = eventsFor(chat._id, CHAT_EVENTS.PACKAGE_ENDED)[0];
    check('warning, then paused with call-rate options (per-minute ₹30, 3 min ₹90)',
      eventsFor(chat._id, CHAT_EVENTS.PACKAGE_WARNING).length === 1 && ended?.payload.ratePerMinute === 30 && ended.payload.packages[0].price === 90);
    const cont = await chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'per_minute' });
    check('continue per-minute at the call rate (₹30)', cont.ratePerMinute === 30 && await balanceOf(user._id) === 820);
    const endedChat = await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
    check('call metrics count package + per-minute minutes', (await Astrologer.findById(astro._id)).metrics.callMinutes === 6);
    markScenario(10, 'Package flow on a call consultation (backend)', endedChat.billing.amountCharged === 180 && (await balanceOf(user._id)) === 820);
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
    check('both sides see the pause and each choice in the transcript',
      ['package_ended', 'package_extended', 'per_minute_started'].every(event => systemLines.some(m => m.content.event === event)));
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
    const early = await asUser('POST', `/chats/${ok.body.chatId}/continue`, { mode: 'per_minute' });
    check('POST /continue during the package -> 409 not_awaiting_choice', early.status === 409 && early.body.code === 'not_awaiting_choice');
    const badMode = await asUser('POST', `/chats/${ok.body.chatId}/continue`, { mode: 'free' });
    check('POST /continue with an unknown choice is refused by the validator', badMode.status >= 400 && badMode.status < 500 && badMode.status !== 409);
    const astroCont = await asAstro('POST', `/chats/${ok.body.chatId}/continue`, { mode: 'per_minute' });
    check('POST /continue is seeker-only (403)', astroCont.status === 403);
    const httpChat = await ChatSession.findById(ok.body.chatId);
    await sweepAt(httpChat._id, seconds(httpChat.packageState.endsAt, 1));
    const poor = await asUser('POST', `/chats/${ok.body.chatId}/continue`, { mode: 'per_minute' });
    check('POST /continue per-minute with ₹10 for ₹20 -> insufficient + shortfall', poor.status === 400 && poor.body.details?.shortfallAmount === 10);
    const end = await asUser('POST', `/chats/${ok.body.chatId}/end`, { reason: 'user_ended' });
    check('ending at the pause charges nothing more', end.status === 200 && end.body.amountCharged === 60 && await balanceOf(user._id) === 10);
    server.close();
  }

  /* ------------------------------------------------ admin package discounts */
  section('unit — admin package discounts');
  {
    const withDiscounts = packages.packagesWithDiscounts([{ minutes: 5, discountPercent: 10 }, { minutes: 7, discountPercent: 50 }]);
    check('only offered durations are affected; a stale 7-min entry adds nothing', withDiscounts.map(p => `${p.minutes}:${p.discountPercent}`).join(',') === '3:0,5:10,10:0,20:0');
    const q = packages.packageQuotes(20, 95, [{ minutes: 5, discountPercent: 10 }, { minutes: 20, discountPercent: 25 }]);
    check('quotes carry the original and the discounted price', q[1].originalPrice === 100 && q[1].price === 90 && q[1].discountPercent === 10);
    check('20 min at 25% off: ₹400 -> ₹300', q[3].originalPrice === 400 && q[3].price === 300);
    check('affordability is judged on the discounted price (₹95 covers ₹90)', q[1].affordable === true && q[2].affordable === false);
    const merged = packages.mergePackageDiscounts([{ minutes: 10, discountPercent: 15 }], [{ minutes: 5, discountPercent: 10 }]);
    check('an edit merges over the current discounts', merged.map(p => `${p.minutes}:${p.discountPercent}`).join(',') === '3:0,5:10,10:15,20:0');
    const bad = [
      [{ minutes: 5, discountPercent: 95 }],
      [{ minutes: 5, discountPercent: -1 }],
      [{ minutes: 5, discountPercent: 12.5 }],
      [{ minutes: 7, discountPercent: 10 }],
    ];
    check('refuses >90%, negative, fractional and unknown durations', bad.every(entry => { try { packages.mergePackageDiscounts(entry); return false; } catch { return true; } }));
  }

  section('admin package discounts — applied, locked and charged');
  {
    const settingsService = require('../services/settings.service');
    await settingsService.update({ packageDiscounts: [{ minutes: 5, discountPercent: 10 }, { minutes: 20, discountPercent: 25 }] });
    const badSave = await expectError(() => settingsService.update({ packageDiscounts: [{ minutes: 5, discountPercent: 95 }] }));
    check('an invalid admin save is refused with a 400', badSave?.status === 400);
    check('...and leaves the saved discounts untouched', (await settingsService.get()).packageDiscounts.find(d => d.minutes === 5).discountPercent === 10);

    const user = await makeUser(1000);
    const astro = await makeAstrologer({ chatRate: 20, callRate: 30, commissionPercent: 25 });
    const pre = await chatService.precheckSession({ userId: user._id, astrologerId: astro._id, channel: 'chat' });
    check('precheck shows 5 min: ₹100 struck -> ₹90', pre.packages[1].originalPrice === 100 && pre.packages[1].price === 90 && pre.packages[1].discountPercent === 10);
    const callPre = await chatService.precheckSession({ userId: user._id, astrologerId: astro._id, channel: 'call' });
    check('the same discount applies to calls (5 × ₹30 = ₹150 -> ₹135)', callPre.packages[1].price === 135);

    const stale = await expectError(() => chatService.requestChat({
      userId: user._id, astrologerId: astro._id, intake: {}, billing: { mode: 'package', packageMinutes: 5, quotedPrice: 100 },
    }));
    check('the undiscounted price is refused (price_changed -> ₹90)', stale?.code === 'price_changed' && stale.details?.price === 90 && stale.details?.originalPrice === 100);

    const requested = await chatService.requestChat({
      userId: user._id, astrologerId: astro._id, intake: {}, billing: { mode: 'package', packageMinutes: 5, quotedPrice: 90 },
    });
    check('the discounted price is locked onto the request', requested.billing.requestedPackagePrice === 90 && requested.billing.requestedPackageDiscountPercent === 10);

    await settingsService.update({ packageDiscounts: [{ minutes: 5, discountPercent: 50 }] });
    await chatService.acceptChat({ chatId: requested._id, astrologerId: astro._id });
    const chat = await ChatSession.findById(requested._id);
    check('admin changing the discount before accept does not change the charge (₹90, not ₹50)', await balanceOf(user._id) === 910 && chat.billing.amountCharged === 90);
    const entry = chat.billing.packages[0];
    check('the record keeps original ₹100, 10% off, charged ₹90', entry.originalAmount === 100 && entry.discountPercent === 10 && entry.amount === 90);
    const debit = await WalletTransaction.findOne({ chatSession: chat._id, direction: 'debit' });
    check('the wallet line says the discount', debit.amount === 90 && /\(10% off\)/.test(debit.title));

    await sweepAt(chat._id, seconds(chat.packageState.endsAt, 1));
    const ended1 = eventsFor(chat._id, CHAT_EVENTS.PACKAGE_ENDED)[0];
    check('the continue options use the current discount (5 min now ₹50, ₹100 struck)',
      ended1.payload.packages[1].price === 50 && ended1.payload.packages[1].originalPrice === 100);
    await settingsService.update({ packageDiscounts: [{ minutes: 5, discountPercent: 20 }] });
    const changed = await expectError(() => chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'package', packageMinutes: 5, quotedPrice: 50 }));
    check('a discount changed while paused -> price_changed (₹80), nothing charged', changed?.code === 'price_changed' && changed.details?.price === 80 && await balanceOf(user._id) === 910);
    const ext = await chatService.continueConsultation({ chatId: chat._id, userId: user._id, mode: 'package', packageMinutes: 5, quotedPrice: 80 });
    check('re-confirmed at the discounted ₹80', ext.amount === 80 && await balanceOf(user._id) === 830);
    const ended = await chatService.endChat({ chatId: chat._id, accountId: user._id, endedBy: 'user' });
    check('astrologer share is on what was paid (₹170 - 25% = ₹127)', ended.billing.astrologerEarning === 127 && await earningsOf(astro._id) === 127);

    await settingsService.update({ packageDiscounts: [3, 5, 10, 20].map(minutes => ({ minutes, discountPercent: 0 })) });
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
