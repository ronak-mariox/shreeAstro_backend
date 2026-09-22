/**
 * Live per-minute consultation billing — the tick, the upfront first-minute
 * debit, the precheck, low-balance grace, crash recovery, and endChat's
 * true-up. Real Mongo, real wallet/astrologer-earning math, but never real
 * time: every "a minute has passed" is done by backdating `startedAt`/
 * `lastBilledAt` directly, or by passing an explicit `now` into
 * runBillingSweep/tickOneSession/billNextMinute/expireStaleRequests — all of
 * which take one for exactly this reason. Waiting on a real 60 seconds per
 * assertion would make this file impossible to run.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_chat_billing';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const { ChatSession } = require('../models/Chat');
const ChatBillingTick = require('../models/ChatBillingTick');
const WalletTransaction = require('../models/WalletTransaction');
const chatService = require('../services/chat.service');
const walletService = require('../services/wallet.service');
const env = require('../config/env');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

/** A timestamp safely inside the check-ahead window (`checkAheadSeconds` before the 60s minute is due) — halfway between the window opening and the real due time, regardless of how `CHECK_AHEAD_SECONDS` is configured. */
function insideCheckAheadWindow(lastBilledAt) {
  const windowOpensAtSeconds = 60 - env.consultation.checkAheadSeconds;
  const midpointSeconds = windowOpensAtSeconds + (60 - windowOpensAtSeconds) / 2;
  return new Date(lastBilledAt.getTime() + midpointSeconds * 1000);
}

/** Rewinds a session's clock fields directly, so the tick sees it as if `minutesAgo` minutes have really passed since it started/last billed. */
async function backdate(chatId, { startedMinutesAgo, lastBilledMinutesAgo } = {}) {
  const set = {};
  if (startedMinutesAgo !== undefined) {
    set.startedAt = new Date(Date.now() - startedMinutesAgo * 60 * 1000);
  }
  if (lastBilledMinutesAgo !== undefined) {
    set.lastBilledAt = new Date(Date.now() - lastBilledMinutesAgo * 60 * 1000);
  }
  await ChatSession.updateOne({ _id: chatId }, { $set: set });
}

let userSeq = 0;
async function makeUser(walletBalance) {
  userSeq += 1;
  return User.create({
    name: `Seeker ${userSeq}`,
    email: `seeker${userSeq}@example.com`,
    phone: { countryCode: '+91', number: `98${String(userSeq).padStart(8, '0')}` },
    wallet: { balance: walletBalance },
  });
}

let astroSeq = 0;
async function makeAstrologer({ ratePerMinute = 20, commissionPercent = 25, maxConcurrentChats = 3 } = {}) {
  astroSeq += 1;
  return Astrologer.create({
    name: `Astrologer ${astroSeq}`,
    email: `astro${astroSeq}@example.com`,
    phone: { countryCode: '+91', number: `97${String(astroSeq).padStart(8, '0')}` },
    applicationStatus: 'approved',
    commissionPercent,
    services: [{ type: 'chat', ratePerMinute, isEnabled: true }],
    presence: { isOnline: true, isBusy: false, activeSessions: 0, maxConcurrentChats },
  });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  /**
   * A dropped-and-recreated database starts with none of its indexes built —
   * Mongoose creates them in the background on first model use, with no
   * guarantee they exist before the very first write. Every assertion below
   * that relies on ChatBillingTick's unique (chatSession, minuteNumber) index
   * to catch a double-bill needs it to actually exist first, or the race it's
   * testing simply doesn't happen (both writes succeed, since nothing was
   * there yet to conflict with).
   */
  await ChatBillingTick.init();

  /* ---------------------------------------------------------------- precheck */
  section('precheckSession — read-only, creates nothing');
  const richUser = await makeUser(1000);
  const astro = await makeAstrologer({ ratePerMinute: 20 });

  const okPrecheck = await chatService.precheckSession({ userId: richUser._id, astrologerId: astro._id, channel: 'chat' });
  check('affordable with 1000 balance at ₹20/min', okPrecheck.ok === true && okPrecheck.minutesAffordable === 50);
  check('creates no session', await ChatSession.countDocuments({}) === 0);

  const poorUser = await makeUser(10);
  const shortPrecheck = await chatService.precheckSession({ userId: poorUser._id, astrologerId: astro._id, channel: 'chat' });
  check('not ok — 10 rupees is not even 1 minute', shortPrecheck.ok === false && shortPrecheck.minutesAffordable === 0);
  check('reports the exact shortfall for a ₹20 minimum (1 min x ₹20)', shortPrecheck.shortfallAmount === 20);

  /* -------------------------------------------------------------- requestChat */
  section('requestChat — refuses under the 1-minute minimum');
  let threw = null;
  try {
    await chatService.requestChat({ userId: poorUser._id, astrologerId: astro._id, channel: 'chat' });
  } catch (error) {
    threw = error;
  }
  check('refused', threw?.status === 400);
  check('carries a stable error code the apps can branch on, not just prose', threw?.code === 'insufficient_balance');
  check('nothing charged for a refused request', (await User.findById(poorUser._id)).wallet.balance === 10);

  const chat = await chatService.requestChat({ userId: richUser._id, astrologerId: astro._id, channel: 'chat', intake: { minutes: 10 } });
  check('a session with enough balance is created, status requested', chat.status === 'requested');
  check('rate/commission are frozen onto the session at request time', chat.billing.ratePerMinute === 20 && chat.billing.commissionPercent === 25);

  /* --------------------------------------------------------- acceptChat (upfront) */
  section('acceptChat — bills the first minute upfront, before the session goes active');
  const beforeAccept = (await User.findById(richUser._id)).wallet.balance;
  const accepted = await chatService.acceptChat({ chatId: chat._id, astrologerId: astro._id });
  check('now active', accepted.status === 'active');
  check('minute 1 was billed', accepted.minutesBilled === 1);
  const afterAccept = await User.findById(richUser._id);
  check('exactly one minute\'s rate was debited upfront', beforeAccept - afterAccept.wallet.balance === 20);
  const astroAfterAccept = await Astrologer.findById(astro._id);
  check('the astrologer was paid their share of that one minute (75% of 20 = 15)', astroAfterAccept.earnings.balance === 15);
  check('exactly one ChatBillingTick row exists so far', await ChatBillingTick.countDocuments({ chatSession: chat._id }) === 1);
  check('presence.isBusy is now true', astroAfterAccept.presence.isBusy === true);

  /* ------------------------------------------------------------ billNextMinute idempotency */
  section('billNextMinute — two racing callers billing the same next minute never double-charge');
  /**
   * Simulates the real race this guards against: two independent snapshots
   * of the same session (e.g. the recurring sweep and endChat's true-up
   * landing at nearly the same instant), each unaware the other already
   * billed this exact minute. Re-fetching once and calling billNextMinute
   * twice on the SAME object would not reproduce this — the first call's
   * own in-memory mutation would make the second call ask for the minute
   * after, not the same one.
   */
  const balanceBeforeRace = (await User.findById(richUser._id)).wallet.balance;
  const staleSnapshotA = await ChatSession.findById(chat._id); // minutesBilled: 1
  const staleSnapshotB = await ChatSession.findById(chat._id); // minutesBilled: 1, independent object
  const now = new Date();
  const raceA = await chatService.billNextMinute(staleSnapshotA, now);
  const raceB = await chatService.billNextMinute(staleSnapshotB, now);
  check('exactly one of the two racing attempts is billed', raceA.billed !== raceB.billed);
  const winner = raceA.billed ? raceA : raceB;
  check('the winner billed minute 2 (both started from the same stale minutesBilled: 1)', winner.minuteNumber === 2);
  const loser = raceA.billed ? raceB : raceA;
  check('the loser is told it was already billed, not given a generic error', loser.reason === 'already_billed');
  check('only ONE minute\'s rate was actually debited, not two', balanceBeforeRace - (await User.findById(richUser._id)).wallet.balance === 20);
  check('still exactly one tick row for minute 2 (the unique index did its job)', await ChatBillingTick.countDocuments({ chatSession: chat._id, minuteNumber: 2 }) === 1);

  /* ------------------------------------------------------------------- the tick */
  section('runBillingSweep — bills a session once its next minute is actually due');
  await backdate(chat._id, { lastBilledMinutesAgo: 1 }); // last billed (minute 2, above) exactly 1 minute ago -> minute 3 is due now
  const balanceBeforeTick = (await User.findById(richUser._id)).wallet.balance;
  const tickResults = await chatService.runBillingSweep(new Date());
  const ourResult = tickResults.find(r => r.chatId === String(chat._id));
  check('this session was billed for minute 3', ourResult?.action === 'billed' && ourResult.minuteNumber === 3);
  check('another minute\'s rate was debited', balanceBeforeTick - (await User.findById(richUser._id)).wallet.balance === 20);
  check('minutesBilled is now 3', (await ChatSession.findById(chat._id)).minutesBilled === 3);

  section('runBillingSweep — a session not yet due is skipped, not billed early');
  const notDueResults = await chatService.runBillingSweep(new Date());
  const stillOurs = notDueResults.find(r => r.chatId === String(chat._id));
  check('not due yet (billed 0 seconds ago)', stillOurs?.action === 'not_due');
  check('minutesBilled unchanged', (await ChatSession.findById(chat._id)).minutesBilled === 3);

  /* ------------------------------------------------------- low balance warning */
  section('runBillingSweep — warns once when the wallet can no longer cover LOW_BALANCE_WARNING_MINUTES more');
  const nearlyBrokeAstro = await makeAstrologer({ ratePerMinute: 20 });
  const warnUser = await makeUser(65); // exactly 3 minutes' worth at ₹20 (60) plus a smidge — precheck passes
  const warnChat = await chatService.requestChat({ userId: warnUser._id, astrologerId: nearlyBrokeAstro._id, channel: 'chat' });
  await chatService.acceptChat({ chatId: warnChat._id, astrologerId: nearlyBrokeAstro._id }); // minute 1: balance 65 -> 45
  await backdate(warnChat._id, { lastBilledMinutesAgo: 1 });
  const warnTick = await chatService.tickOneSession(await ChatSession.findById(warnChat._id), new Date()); // minute 2: 45 -> 25 -> only 1 minute left, below the 2-minute warning line
  check('minute 2 billed', warnTick.action === 'billed');
  const warnedChat = await ChatSession.findById(warnChat._id);
  check('lowBalanceWarnedAt was set (25 balance / 20 rate = 1 minute left, under the 2-minute line)', warnedChat.lowBalanceWarnedAt instanceof Date);

  /* ------------------------------------------------------- indefinite pause */
  section('runBillingSweep — balance exhausted pauses the session indefinitely, never auto-ends it');
  const graceUser = await makeUser(60); // exactly 3 minutes at ₹20 — passes precheck, runs out right after minute 3
  const graceAstro = await makeAstrologer({ ratePerMinute: 20 });
  const graceChat = await chatService.requestChat({ userId: graceUser._id, astrologerId: graceAstro._id, channel: 'chat' });
  await chatService.acceptChat({ chatId: graceChat._id, astrologerId: graceAstro._id }); // 60 -> 40, minute 1
  await backdate(graceChat._id, { lastBilledMinutesAgo: 1 });
  await chatService.tickOneSession(await ChatSession.findById(graceChat._id), new Date()); // 40 -> 20, minute 2
  await backdate(graceChat._id, { lastBilledMinutesAgo: 1 });
  await chatService.tickOneSession(await ChatSession.findById(graceChat._id), new Date()); // 20 -> 0, minute 3
  check('all 3 affordable minutes billed, balance now 0', (await User.findById(graceUser._id)).wallet.balance === 0);

  await backdate(graceChat._id, { lastBilledMinutesAgo: 1 });
  const graceStart = await chatService.tickOneSession(await ChatSession.findById(graceChat._id), new Date());
  check('minute 4 cannot be afforded -> paused, not ended', graceStart.action === 'balance_paused');
  check('still active, not ended', (await ChatSession.findById(graceChat._id)).status === 'active');
  check('balanceExhaustedAt recorded', (await ChatSession.findById(graceChat._id)).balanceExhaustedAt instanceof Date);

  /**
   * A client (re)joining while already paused — including one that never saw
   * the live chat:low_balance push at all, e.g. reconnecting after a drop —
   * must be able to recover the true current state from this response alone.
   */
  const pausedJoin = await chatService.joinChat({ chatId: graceChat._id, accountId: graceUser._id, lastSeq: 0 });
  check('joinChat reports the session as paused', pausedJoin.paused === true);
  check(
    'joinChat\'s pausedSince matches the real balanceExhaustedAt exactly',
    new Date(pausedJoin.pausedSince).getTime() === (await ChatSession.findById(graceChat._id)).balanceExhaustedAt.getTime(),
  );
  const pausedState = await chatService.getSessionState({ chatId: graceChat._id, accountId: graceUser._id });
  check('getSessionState (the REST read) agrees: paused, with the same pausedSince', pausedState.paused === true && pausedState.pausedSince.getTime() === pausedJoin.pausedSince.getTime());

  const stillPausedNow = await chatService.tickOneSession(await ChatSession.findById(graceChat._id), new Date());
  check('called again immediately -> still just paused, no re-billing attempt', stillPausedNow.action === 'balance_paused');

  const muchLater = new Date(Date.now() + 60 * 60 * 1000); // an hour later — no timeout exists to expire
  const stillPausedMuchLater = await chatService.tickOneSession(await ChatSession.findById(graceChat._id), muchLater);
  check('even an hour later -> still paused, never auto-ends', stillPausedMuchLater.action === 'balance_paused');
  const stillActiveChat = await ChatSession.findById(graceChat._id);
  check('status is still active an hour on', stillActiveChat.status === 'active');
  check('exactly 3 paid minutes charged in total (₹60), not a 4th', stillActiveChat.billing.amountCharged === 60);

  check(
    'runBillingSweep itself skips a paused session rather than re-attempting billing',
    (await chatService.runBillingSweep(muchLater)).find(r => r.chatId === String(graceChat._id))?.action === 'balance_paused',
  );

  /* ------------------------------------------------------ resume via top-up */
  section('a wallet top-up resumes a paused session automatically — no separate "resume" button');
  const topupUser = await makeUser(60);
  const topupAstro = await makeAstrologer({ ratePerMinute: 20 });
  const topupChat = await chatService.requestChat({ userId: topupUser._id, astrologerId: topupAstro._id, channel: 'chat' });
  await chatService.acceptChat({ chatId: topupChat._id, astrologerId: topupAstro._id }); // 60 -> 40
  await backdate(topupChat._id, { lastBilledMinutesAgo: 1 });
  await chatService.tickOneSession(await ChatSession.findById(topupChat._id), new Date()); // 40 -> 20
  await backdate(topupChat._id, { lastBilledMinutesAgo: 1 });
  await chatService.tickOneSession(await ChatSession.findById(topupChat._id), new Date()); // 20 -> 0
  await backdate(topupChat._id, { lastBilledMinutesAgo: 1 });
  const exhausted = await chatService.tickOneSession(await ChatSession.findById(topupChat._id), new Date());
  check('paused once balance runs out', exhausted.action === 'balance_paused');
  const lastBilledAtBeforeResume = (await ChatSession.findById(topupChat._id)).lastBilledAt;

  // A top-up that still isn't enough for even one more minute leaves it paused.
  await User.updateOne({ _id: topupUser._id }, { $inc: { 'wallet.balance': 10 } }); // only half a minute's rate
  const notEnoughYet = await chatService.resumePausedSessionsForUser(topupUser._id);
  check('₹10 against a ₹20 rate is not enough to resume anything', notEnoughYet.length === 0);
  check('still paused', (await ChatSession.findById(topupChat._id)).balanceExhaustedAt != null);

  // Topping up the rest resumes it — this is what wallet.controller.js's confirmTopUp calls after crediting the wallet.
  await User.updateOne({ _id: topupUser._id }, { $inc: { 'wallet.balance': 10 } }); // now 20, exactly one minute's rate
  const resumedIds = await chatService.resumePausedSessionsForUser(topupUser._id);
  check('resumePausedSessionsForUser reports this chat as resumed', resumedIds.includes(String(topupChat._id)));
  const resumedChat = await ChatSession.findById(topupChat._id);
  check('balanceExhaustedAt cleared', resumedChat.balanceExhaustedAt == null);
  check(
    'lastBilledAt pushed forward by (at least) the pause duration — the pause itself was free',
    resumedChat.lastBilledAt.getTime() >= lastBilledAtBeforeResume.getTime(),
  );

  // The pushed-forward minute bills normally on the very next tick, same as any other minute.
  await backdate(topupChat._id, { lastBilledMinutesAgo: 1 });
  const balancePauseResumedTick = await chatService.tickOneSession(await ChatSession.findById(topupChat._id), new Date());
  check('billed normally once the pushed-forward minute is due', balancePauseResumedTick.action === 'billed');

  /* --------------------------------------------------------------- crash recovery */
  section('runBillingSweep — too long a gap since the last tick ends the session instead of a silent catch-up charge');
  const crashUser = await makeUser(1000);
  const crashAstro = await makeAstrologer({ ratePerMinute: 20 });
  const crashChat = await chatService.requestChat({ userId: crashUser._id, astrologerId: crashAstro._id, channel: 'chat' });
  await chatService.acceptChat({ chatId: crashChat._id, astrologerId: crashAstro._id }); // minute 1 billed, minutesBilled=1
  // The session has genuinely been running 12 minutes, but its last successful tick was 10 minutes ago — the tick job (or the server) was down in between.
  await backdate(crashChat._id, { startedMinutesAgo: 12, lastBilledMinutesAgo: 10 });
  const crashBalanceBefore = (await User.findById(crashUser._id)).wallet.balance;
  const crashResult = await chatService.tickOneSession(await ChatSession.findById(crashChat._id), new Date());
  check('ended for a crash-recovery timeout, not billed for the 12-minute gap at once', crashResult.action === 'ended_timeout');
  const crashedChat = await ChatSession.findById(crashChat._id);
  check('status ended, reason timeout', crashedChat.status === 'ended' && crashedChat.endReason === 'timeout');
  check('minutesBilled stayed at 1 — the true-up in endChat is capped, not backfilled to the 12 minutes actually elapsed', crashedChat.minutesBilled === 1);
  check('only the one minute already billed at accept was ever charged — nothing extra for the outage', crashBalanceBefore === (await User.findById(crashUser._id)).wallet.balance);
  check('durationSeconds still records the real elapsed time (~720s), even though billing was capped', crashedChat.durationSeconds >= 700 && crashedChat.durationSeconds <= 740);

  /* ------------------------------------------------------------- endChat true-up */
  section('endChat — true-up bills exactly minutesFor(elapsed seconds), matching what the old lump-sum settle() computed');
  const endUser = await makeUser(1000);
  const endAstro = await makeAstrologer({ ratePerMinute: 20 });
  const endChatDoc = await chatService.requestChat({ userId: endUser._id, astrologerId: endAstro._id, channel: 'chat' });
  await chatService.acceptChat({ chatId: endChatDoc._id, astrologerId: endAstro._id }); // minute 1 billed, minutesBilled=1
  // Backdate startedAt to 3 min 20 sec ago, with no further ticks having run — endChat's true-up must catch up minutes 2-4 itself.
  await ChatSession.updateOne({ _id: endChatDoc._id }, { $set: { startedAt: new Date(Date.now() - (3 * 60 + 20) * 1000) } });
  const balanceBeforeEnd = (await User.findById(endUser._id)).wallet.balance;
  const ended = await chatService.endChat({ chatId: endChatDoc._id, accountId: endUser._id, endedBy: 'user' });
  check('minutesFor(200s) = 4 minutes total, matching minutesBilled', ended.minutesBilled === 4);
  check('amountCharged is 4 x rate = 80', ended.billing.amountCharged === 80);
  check('the wallet was actually debited 60 more (3 more minutes, minute 1 already taken at accept)', balanceBeforeEnd - (await User.findById(endUser._id)).wallet.balance === 60);
  check('status ended, isSettled true', ended.status === 'ended' && ended.billing.isSettled === true);
  check('durationSeconds recorded', ended.durationSeconds === 200);

  let doubleEndThrew = null;
  try {
    await chatService.endChat({ chatId: endChatDoc._id, accountId: endUser._id, endedBy: 'user' });
  } catch (error) {
    doubleEndThrew = error;
  }
  check('ending an already-ended chat is refused, not double-processed', doubleEndThrew?.status === 400);

  /* -------------------------------------------------------- expireStaleRequests */
  section('expireStaleRequests — a global sweep ages out unanswered requests to missed, no refund needed (nothing was ever charged)');
  const missUser = await makeUser(1000);
  const missAstro = await makeAstrologer({ ratePerMinute: 20 });
  const missChat = await chatService.requestChat({ userId: missUser._id, astrologerId: missAstro._id, channel: 'chat' });
  await ChatSession.updateOne({ _id: missChat._id }, { $set: { requestedAt: new Date(Date.now() - 200 * 1000) } }); // older than REQUEST_TIMEOUT_SECONDS (120s)
  const expiredCount = await chatService.expireStaleRequests(undefined, new Date());
  check('exactly the one stale request was aged out (global sweep, no astrologerId given)', expiredCount === 1);
  const missedChat = await ChatSession.findById(missChat._id);
  check('status missed, endedBy system, endReason recorded', missedChat.status === 'missed' && missedChat.endedBy === 'system' && missedChat.endReason === 'astrologer_no_response');
  check('nothing was ever charged for a request that was never accepted', (await User.findById(missUser._id)).wallet.balance === 1000);

  section('runBillingSweep also ages out stale requests as part of its own pass');
  const missUser2 = await makeUser(1000);
  const missChat2 = await chatService.requestChat({ userId: missUser2._id, astrologerId: missAstro._id, channel: 'chat' });
  await ChatSession.updateOne({ _id: missChat2._id }, { $set: { requestedAt: new Date(Date.now() - 200 * 1000) } });
  await chatService.runBillingSweep(new Date());
  check('the sweep\'s own expireStaleRequests call caught this one too', (await ChatSession.findById(missChat2._id)).status === 'missed');

  /* ------------------------------------------------------- check-ahead phase */
  section('tickOneSession — check-ahead phase warns before the real cutoff, without touching the meter');
  const checkAstro = await makeAstrologer({ ratePerMinute: 20 });
  const checkUser = await makeUser(65); // comfortably past requestChat's own minimum-balance gate
  const checkChat = await chatService.requestChat({ userId: checkUser._id, astrologerId: checkAstro._id, channel: 'chat' });
  await chatService.acceptChat({ chatId: checkChat._id, astrologerId: checkAstro._id }); // minute 1: 65 -> 45
  // Spent elsewhere while the session ran, same as the earlier "insufficient at accept" scenario — down to enough for a bit but not another full minute (needs 20).
  await User.updateOne({ _id: checkUser._id }, { $set: { 'wallet.balance': 5 } });

  const ca1 = await ChatSession.findById(checkChat._id);
  // Inside the check-ahead window (checkAheadSeconds before due, default 40s into a 60s minute -> window opens at +20s) but well before the real due time at +60s.
  const insideWindow = insideCheckAheadWindow(ca1.lastBilledAt);

  const warned = await chatService.tickOneSession(ca1, insideWindow);
  check('check-ahead recognises the seeker can\'t afford the next minute', warned.action === 'check_ahead_warned');
  const afterWarn = await ChatSession.findById(checkChat._id);
  check('nothing was billed yet — still minute 1', afterWarn.minutesBilled === 1);
  check('wallet untouched by the warning itself', (await User.findById(checkUser._id)).wallet.balance === 5);
  check('the flag is set, so a repeat pass in the same window knows it already asked', afterWarn.nextMinuteChecked === true);
  check('status is still plain active — no grace yet, the real cutoff hasn\'t arrived', !afterWarn.balanceExhaustedAt);

  const secondPass = await chatService.tickOneSession(afterWarn, insideWindow);
  check('a repeat pass inside the same window is a no-op (already checked)', secondPass.action === 'not_due');

  // Topping up before the real due time lets the actual debit succeed normally — the warning by itself changed nothing.
  await walletService.post({
    ownerRole: 'user', ownerId: checkUser._id, direction: 'credit', type: 'topup', amount: 100, title: 'Top-up',
  });
  const dueNow = new Date(ca1.lastBilledAt.getTime() + 60 * 1000);
  const freshBeforeDue = await ChatSession.findById(checkChat._id);
  const dueResult = await chatService.tickOneSession(freshBeforeDue, dueNow);
  check('the real cutoff still bills normally once the seeker topped up in time', dueResult.action === 'billed' && dueResult.minuteNumber === 2);
  const afterDue = await ChatSession.findById(checkChat._id);
  check('minutesBilled is now 2, no grace was ever entered', afterDue.minutesBilled === 2 && !afterDue.balanceExhaustedAt);

  section('tickOneSession — check-ahead phase says nothing when the next minute is affordable');
  const okAstro = await makeAstrologer({ ratePerMinute: 20 });
  const okUser = await makeUser(1000);
  const okChat = await chatService.requestChat({ userId: okUser._id, astrologerId: okAstro._id, channel: 'chat' });
  await chatService.acceptChat({ chatId: okChat._id, astrologerId: okAstro._id });
  const okAfterAccept = await ChatSession.findById(okChat._id);
  const okWindow = insideCheckAheadWindow(okAfterAccept.lastBilledAt);
  const okResult = await chatService.tickOneSession(okAfterAccept, okWindow);
  check('plenty of balance -> check-ahead is silent', okResult.action === 'check_ahead_ok');
  const okAfterCheck = await ChatSession.findById(okChat._id);
  check('flagged checked, nothing billed', okAfterCheck.nextMinuteChecked === true && okAfterCheck.minutesBilled === 1);

  section('tickOneSession — check-ahead warns, the seeker never tops up: the real cutoff still pauses the session');
  const gcAstro = await makeAstrologer({ ratePerMinute: 20 });
  const gcUser = await makeUser(65);
  const gcChat = await chatService.requestChat({ userId: gcUser._id, astrologerId: gcAstro._id, channel: 'chat' });
  await chatService.acceptChat({ chatId: gcChat._id, astrologerId: gcAstro._id }); // 65 -> 45
  await User.updateOne({ _id: gcUser._id }, { $set: { 'wallet.balance': 5 } });
  const gc1 = await ChatSession.findById(gcChat._id);
  await chatService.tickOneSession(gc1, insideCheckAheadWindow(gc1.lastBilledAt)); // warns, changes nothing
  const gcFreshAtDue = await ChatSession.findById(gcChat._id);
  const gcDueResult = await chatService.tickOneSession(gcFreshAtDue, new Date(gc1.lastBilledAt.getTime() + 60 * 1000));
  check('still not enough at the real cutoff -> pauses exactly as it always did', gcDueResult.action === 'balance_paused');

  /* ------------------------------------------------ astrologer disconnects */
  section('astrologer disconnects and reconnects within grace — the pause costs the seeker nothing');
  const padAstro = await makeAstrologer({ ratePerMinute: 20 });
  const padUser = await makeUser(65);
  const padChat = await chatService.requestChat({ userId: padUser._id, astrologerId: padAstro._id, channel: 'chat' });
  await chatService.acceptChat({ chatId: padChat._id, astrologerId: padAstro._id }); // 65 -> 45

  const pad1 = await ChatSession.findById(padChat._id);
  const pauseStart = new Date(pad1.lastBilledAt.getTime() + 30 * 1000); // 30s into the minute, well before it would be due
  await chatService.pauseSessionsForAstrologer(padAstro._id, pauseStart);
  const padPaused = await ChatSession.findById(padChat._id);
  check('astrologerDisconnectedAt is set', padPaused.astrologerDisconnectedAt?.getTime() === pauseStart.getTime());

  // A sweep pass well past when the minute would normally have been due — paused, so nothing happens.
  const duringPause = new Date(pauseStart.getTime() + 50 * 1000); // 80s after lastBilledAt — past the ordinary 60s due time
  const pausedTick = (await chatService.runBillingSweep(duringPause)).find(r => r.chatId === String(padChat._id));
  check('a paused session is never ticked, however overdue it looks', pausedTick?.action === 'astrologer_disconnect_grace');
  const stillPaused = await ChatSession.findById(padChat._id);
  check('minutesBilled untouched while paused', stillPaused.minutesBilled === 1);
  check('wallet untouched while paused', (await User.findById(padUser._id)).wallet.balance === 45);

  // Reconnects 50 seconds after disconnecting — inside the 60s grace.
  const resumeAt = new Date(pauseStart.getTime() + 50 * 1000);
  await chatService.resumeSessionsForAstrologer(padAstro._id, resumeAt);
  const padResumed = await ChatSession.findById(padChat._id);
  check('astrologerDisconnectedAt cleared', padResumed.astrologerDisconnectedAt === null);
  check(
    'lastBilledAt pushed forward by exactly the pause duration (50s) — the outage is free',
    padResumed.lastBilledAt.getTime() === pad1.lastBilledAt.getTime() + 50 * 1000,
  );

  // Shortly after resuming, the (pushed-forward) minute is not yet due — a
  // 50s pause is long enough that its own check-ahead window is already
  // open by the time it resumes (not a re-bill, just an early look), so
  // either that or a plain "not due" both prove the point: not billed yet.
  const justAfterResume = (await chatService.runBillingSweep(new Date(resumeAt.getTime() + 5 * 1000)))
    .find(r => r.chatId === String(padChat._id));
  check(
    'not billed yet right after resuming — the pause bought real extra time, not an instant re-bill',
    justAfterResume?.action === 'not_due' || justAfterResume?.action === 'check_ahead_ok',
  );
  check('minutesBilled still 1 immediately after resuming', (await ChatSession.findById(padChat._id)).minutesBilled === 1);

  // Exactly at the newly-pushed due time, billing resumes normally.
  const newDueAt = new Date(padResumed.lastBilledAt.getTime() + 60 * 1000);
  const resumedTick = (await chatService.runBillingSweep(newDueAt)).find(r => r.chatId === String(padChat._id));
  check('billed normally once the pushed-forward minute is actually due', resumedTick?.action === 'billed' && resumedTick.minuteNumber === 2);
  check('exactly one more minute charged — nothing extra for the pause itself', (await User.findById(padUser._id)).wallet.balance === 25);

  section('astrologer disconnects and never comes back — the interrupted minute is refunded on both sides');
  const dcAstro = await makeAstrologer({ ratePerMinute: 20 });
  const dcUser = await makeUser(65);
  const dcChat = await chatService.requestChat({ userId: dcUser._id, astrologerId: dcAstro._id, channel: 'chat' });
  await chatService.acceptChat({ chatId: dcChat._id, astrologerId: dcAstro._id }); // 65 -> 45, astrologer earns 15

  const dc1 = await ChatSession.findById(dcChat._id);
  const dcPauseStart = new Date(dc1.lastBilledAt.getTime() + 10 * 1000);
  await chatService.pauseSessionsForAstrologer(dcAstro._id, dcPauseStart);

  const pastGrace = new Date(dcPauseStart.getTime() + (env.consultation.astrologerReconnectGraceSeconds + 5) * 1000);
  const dcResult = (await chatService.runBillingSweep(pastGrace)).find(r => r.chatId === String(dcChat._id));
  check('never reconnecting within grace ends the session', dcResult?.action === 'ended_astrologer_disconnected');

  const dcEnded = await ChatSession.findById(dcChat._id);
  check('status ended, reason astrologer_disconnected', dcEnded.status === 'ended' && dcEnded.endReason === 'astrologer_disconnected');
  check('the interrupted minute was not trued-up to the full elapsed gap', dcEnded.minutesBilled === 0);
  check('the seeker got the whole interrupted minute back', (await User.findById(dcUser._id)).wallet.balance === 65);
  check('the astrologer\'s matching earning for that minute was reversed too', (await Astrologer.findById(dcAstro._id)).earnings.balance === 0);
  const dcRefundTxn = await WalletTransaction.findOne({ chatSession: dcChat._id, ownerRole: 'user', type: 'refund' });
  const dcAdjustTxn = await WalletTransaction.findOne({ chatSession: dcChat._id, ownerRole: 'astrologer', type: 'adjustment' });
  check('a refund transaction records it on the seeker\'s side', dcRefundTxn?.amount === 20);
  check('an adjustment transaction reverses it on the astrologer\'s side', dcAdjustTxn?.amount === 15);

  section('runBillingSweep skips AI threads — perpetual, no astrologer, never billed');
  const aiUser = await makeUser(1000);
  const aiChat = await ChatSession.create({
    type: 'ai',
    channel: 'chat',
    user: aiUser._id,
    status: 'active',
    startedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    billing: { ratePerMinute: 0, commissionPercent: 0 },
  });
  let aiSweepThrew = null;
  try {
    await chatService.runBillingSweep(new Date());
  } catch (error) {
    aiSweepThrew = error;
  }
  check('the sweep does not throw over a long-idle AI thread (it has no astrologer to end it as)', aiSweepThrew === null, aiSweepThrew?.message);
  const aiChatAfter = await ChatSession.findById(aiChat._id);
  check('the AI thread is left exactly as it was — still active, never timeout-ended', aiChatAfter.status === 'active' && !aiChatAfter.endedAt);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('CRASHED:', e);
  process.exit(1);
});
