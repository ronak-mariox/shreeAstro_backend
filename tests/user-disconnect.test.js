/**
 * The seeker's app going away mid-consultation — closed, killed, or off the
 * network.
 *
 * Nothing used to happen: the billing sweep carried on charging minute after
 * minute to an app that had been shut. Now the session is marked, held briefly
 * in case it was a blink, and then ended — billed to the moment they went, not
 * to the end of the wait.
 *
 * The wait is what the money turns on, so it is checked precisely: leaving at
 * 110 seconds is two minutes, and the 45 seconds spent seeing whether they came
 * back must not quietly become a third.
 *
 * Also here: that this did not disturb the astrologer's own disconnect, which
 * behaves the opposite way on purpose (pause and hold, because the seeker is
 * still waiting to be served).
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_user_disconnect';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test-disc:';
process.env.NODE_ENV = 'development';

const http = require('http');
const mongoose = require('mongoose');
const ioClient = require('socket.io-client');

const env = require('../config/env');
const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const { ChatSession, CHAT_EVENTS } = require('../models/Chat');
const chatService = require('../services/chat.service');
const authService = require('../services/auth.service');
const { createApp } = require('../app');
const { initSocket } = require('../socket');

let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const seconds = (date, s) => new Date(new Date(date).getTime() + s * 1000);

const GRACE = env.consultation.userReconnectGraceSeconds;

let seq = 0;
/** A live per-minute consultation: requested, accepted (minute 1 charged upfront), active. */
async function liveSession({ balance = 300, rate = 20, packageMinutes } = {}) {
  seq += 1;
  const user = await User.create({
    name: `Seeker ${seq}`, email: `disc-seeker${seq}@x.com`, phone: { number: `9520000${String(seq).padStart(3, '0')}` },
    wallet: { balance },
  });
  const astrologer = await Astrologer.create({
    name: `Astro ${seq}`, email: `disc-astro${seq}@x.com`, phone: { number: `9530000${String(seq).padStart(3, '0')}` },
    applicationStatus: 'approved', status: 'active', commissionPercent: 25,
    services: [{ type: 'chat', isEnabled: true, ratePerMinute: rate }],
    presence: { isOnline: true, maxConcurrentChats: 3 },
  });

  const requested = await chatService.requestChat({
    userId: user._id, astrologerId: astrologer._id, channel: 'chat',
    ...(packageMinutes ? { billing: { mode: 'package', packageMinutes, quotedPrice: packageMinutes * rate } } : {}),
  });
  await chatService.acceptChat({ chatId: requested._id, astrologerId: astrologer._id });

  const chat = await ChatSession.findById(requested._id);
  return { user, astrologer, chat };
}

const balanceOf = async id => (await User.findById(id)).wallet.balance;
const reload = async id => ChatSession.findById(id).lean();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await require('../models/ChatBillingTick').init();
  await require('../models/ChatPackagePurchase').init();

  /* ------------------------------------------------------------ the marking */

  section('their app goes away: the session is marked, not charged for it');
  const gone = await liveSession();
  check('minute 1 was charged on accept, as always', await balanceOf(gone.user._id) === 280);

  const leftAt = new Date();
  await chatService.markUserAway(gone.user._id, leftAt);
  const marked = await reload(gone.chat._id);
  check('the moment they went is on the session', marked.userDisconnectedAt?.getTime() === leftAt.getTime());
  check('still active — nobody has been cut off yet', marked.status === 'active');
  check('nothing extra was charged for going', await balanceOf(gone.user._id) === 280);
  check('and the astrologer\'s own pause was NOT used for this', marked.astrologerDisconnectedAt == null);

  section('a sweep inside the grace leaves it alone');
  const early = await chatService.runBillingSweep(seconds(leftAt, GRACE - 5));
  check('the session is held, not ended', early.some(r => r.chatId === String(gone.chat._id) && r.action === 'user_away_grace'), early);
  check('still active', (await reload(gone.chat._id)).status === 'active');
  check('still nothing charged', await balanceOf(gone.user._id) === 280);

  section('they come back in time: it was a blink, and nothing was lost');
  const beforeReturn = await reload(gone.chat._id);
  await chatService.markUserBack(gone.user._id);
  const back = await reload(gone.chat._id);
  check('the mark is cleared', back.userDisconnectedAt == null);
  check('active as if nothing happened', back.status === 'active');
  check('the billing clock was not moved — dropping the connection buys no free time',
    back.lastBilledAt?.getTime() === beforeReturn.lastBilledAt?.getTime()
    && back.startedAt.getTime() === beforeReturn.startedAt.getTime());
  const laterSweep = await chatService.runBillingSweep(seconds(back.startedAt, 70));
  check('and the meter picks up normally', laterSweep.some(r => r.chatId === String(gone.chat._id) && r.action === 'billed'), laterSweep);
  check('billing minute 2 as usual', await balanceOf(gone.user._id) === 260);

  /* ------------------------------------------------- the end, and its price */

  section('still gone when the grace runs out: the consultation ends');
  const abandoned = await liveSession();
  const startedAt = (await reload(abandoned.chat._id)).startedAt;
  /** They shut the app 110 seconds in — two minutes of consultation. */
  const wentAt = seconds(startedAt, 110);
  await chatService.markUserAway(abandoned.user._id, wentAt);

  const ended = await chatService.runBillingSweep(seconds(wentAt, GRACE + 5));
  check('the sweep ends it', ended.some(r => r.chatId === String(abandoned.chat._id) && r.action === 'ended_user_disconnected'), ended);

  const closed = await reload(abandoned.chat._id);
  check('status ended', closed.status === 'ended');
  check('recorded as the seeker ending it', closed.endedBy === 'user');
  check('with how it happened', closed.endReason === 'user_disconnected');
  check('the record ends when they left, not when we gave up waiting',
    closed.endedAt.getTime() === wentAt.getTime() && closed.durationSeconds === 110,
    { endedAt: closed.endedAt, durationSeconds: closed.durationSeconds });
  check('two minutes billed — the 45s spent waiting did not become a third',
    closed.minutesBilled === 2 && await balanceOf(abandoned.user._id) === 260,
    { minutesBilled: closed.minutesBilled, balance: await balanceOf(abandoned.user._id) });
  check('settled, like any other ended session', closed.billing.isSettled === true);

  section('the astrologer is freed up again');
  check('their active-session count came back down',
    (await Astrologer.findById(abandoned.astrologer._id)).presence.activeSessions === 0);

  section('a second sweep does not end it twice');
  const again = await chatService.runBillingSweep(seconds(wentAt, GRACE + 60));
  check('the ended session is not swept at all any more', !again.some(r => r.chatId === String(abandoned.chat._id)), again);
  check('and nothing more was charged', await balanceOf(abandoned.user._id) === 260);

  /* ---------------------------------------------------------------- package */

  section('a package session ends the same way, and package time stays paid for');
  const pkg = await liveSession({ balance: 300, rate: 20, packageMinutes: 5 });
  check('the package was paid upfront', await balanceOf(pkg.user._id) === 200);
  const pkgStarted = (await reload(pkg.chat._id)).startedAt;
  const pkgLeft = seconds(pkgStarted, 60);
  await chatService.markUserAway(pkg.user._id, pkgLeft);
  await chatService.runBillingSweep(seconds(pkgLeft, GRACE + 5));

  const pkgClosed = await reload(pkg.chat._id);
  check('ended', pkgClosed.status === 'ended' && pkgClosed.endReason === 'user_disconnected');
  check('no per-minute charge on top of the package', await balanceOf(pkg.user._id) === 200);
  check('and no refund for the minutes they walked away from',
    pkgClosed.billing.refundAmount === undefined || pkgClosed.billing.refundAmount === 0, pkgClosed.billing.refundAmount);

  /* -------------------------------------------------- both sides, and order */

  section('both sides gone: the seeker leaving decides it');
  const both = await liveSession();
  const bothStarted = (await reload(both.chat._id)).startedAt;
  await chatService.pauseSessionsForAstrologer(both.astrologer._id, seconds(bothStarted, 30));
  await chatService.markUserAway(both.user._id, seconds(bothStarted, 40));
  const bothSwept = await chatService.runBillingSweep(seconds(bothStarted, 40 + GRACE + 5));
  check('ended as the seeker leaving, not as an astrologer outage',
    bothSwept.some(r => r.chatId === String(both.chat._id) && r.action === 'ended_user_disconnected'), bothSwept);
  check('and the reason on the record says so', (await reload(both.chat._id)).endReason === 'user_disconnected');

  section('the astrologer\'s own disconnect still behaves the opposite way');
  const astroGone = await liveSession();
  const astroStarted = (await reload(astroGone.chat._id)).startedAt;
  await chatService.pauseSessionsForAstrologer(astroGone.astrologer._id, seconds(astroStarted, 20));
  const held = await chatService.runBillingSweep(seconds(astroStarted, 30));
  check('their outage holds the session instead of ending it',
    held.some(r => r.chatId === String(astroGone.chat._id) && r.action === 'astrologer_disconnect_grace'), held);
  await chatService.resumeSessionsForAstrologer(astroGone.astrologer._id, seconds(astroStarted, 40));
  const resumed = await reload(astroGone.chat._id);
  check('and coming back resumes it, with the outage costing the seeker nothing',
    resumed.status === 'active' && resumed.astrologerDisconnectedAt == null
    && resumed.lastBilledAt.getTime() > astroStarted.getTime());

  /* ------------------------------------------------------------ real sockets */

  section('over a real socket: closing the app is what marks it');
  const server = http.createServer(createApp());
  initSocket(server);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const live = await liveSession();
  const token = (await authService.issueTokens(live.user._id, 'user')).accessToken;
  const phone = ioClient(base, { auth: { token }, transports: ['websocket'] });
  await new Promise(r => phone.on('connect', r));
  await sleep(150);
  check('connected, and the session is untouched', (await reload(live.chat._id)).userDisconnectedAt == null);

  /** A second device of theirs, so one closing is not the app going away. */
  const tablet = ioClient(base, { auth: { token }, transports: ['websocket'] });
  await new Promise(r => tablet.on('connect', r));
  await sleep(150);
  phone.disconnect();
  await sleep(300);
  check('one of their two devices closing changes nothing', (await reload(live.chat._id)).userDisconnectedAt == null);

  tablet.disconnect();
  await sleep(300);
  const afterClose = await reload(live.chat._id);
  check('their last device closing marks the session', afterClose.userDisconnectedAt != null, afterClose.userDisconnectedAt);
  check('which the sweep would then end', afterClose.status === 'active');

  /** And reopening the app clears it, over the same wiring. */
  const reopened = ioClient(base, { auth: { token }, transports: ['websocket'] });
  const told = new Promise(r => reopened.on(CHAT_EVENTS.USER_RETURNED, r));
  await new Promise(r => reopened.on('connect', r));
  await Promise.race([told, sleep(1500)]);
  check('reopening it clears the mark', (await reload(live.chat._id)).userDisconnectedAt == null);
  reopened.disconnect();
  await sleep(200);
  server.close();

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
