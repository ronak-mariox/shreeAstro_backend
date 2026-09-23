/**
 * POST /api/v1/internal/billing/sweep — the billing sweep driven over HTTP by
 * a scheduler, which is the only thing that bills a live consultation on a
 * host that cannot hold a timer (api/index.js, the Vercel entry).
 *
 * Checked over real HTTP, against a real active session: who is allowed to
 * call it, that it charges exactly what the in-process job would, and that a
 * cron firing twice for the same minute cannot charge that minute twice.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_internal_jobs';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test:';
process.env.NODE_ENV = 'development';

const http = require('http');
const mongoose = require('mongoose');

const env = require('../config/env');
const { createApp } = require('../app');

let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

const KEY = 'cron-secret-value';

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const server = http.createServer(createApp());
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const User = require('../models/User');
  const Astrologer = require('../models/Astrologer');
  const { ChatSession } = require('../models/Chat');
  const chatService = require('../services/chat.service');
  await require('../models/ChatBillingTick').init();

  const sweep = async headers => {
    const res = await fetch(`${base}/api/v1/internal/billing/sweep`, { method: 'POST', headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  /* ------------------------------------------------------------- switched off */

  section('no INTERNAL_API_KEY configured — the endpoint does not exist');
  env.internalApiKey = '';
  const off = await sweep({ 'x-internal-key': KEY });
  check('404, not an invitation to guess the key', off.status === 404, off);

  /* -------------------------------------------------------------------- auth */

  section('configured — only the key opens it');
  env.internalApiKey = KEY;
  check('no key at all → 401', (await sweep({})).status === 401);
  check('wrong key of the same length → 401', (await sweep({ 'x-internal-key': 'cron-secret-WRONG' })).status === 401);
  check('wrong key of a different length → 401 (not a crash)', (await sweep({ 'x-internal-key': 'short' })).status === 401);
  const authed = await sweep({ 'x-internal-key': KEY });
  check('the right key → 200', authed.status === 200, authed);
  check('Authorization: Bearer <key> works too — what several schedulers send',
    (await sweep({ Authorization: `Bearer ${KEY}` })).status === 200);
  check('a seeker\'s own access token is not a key', (await sweep({ Authorization: 'Bearer some.user.jwt' })).status === 401);

  /* ------------------------------------------------ it bills, like the job does */

  section('a live consultation is billed by the HTTP sweep alone');
  const user = await User.create({
    name: 'Seeker', email: 'internal-seeker@x.com', phone: { number: '9300000001' },
    wallet: { balance: 100 },
  });
  const astrologer = await Astrologer.create({
    name: 'Pt. Astro', email: 'internal-astro@x.com', phone: { number: '9310000001' },
    applicationStatus: 'approved', status: 'active', commissionPercent: 25,
    services: [{ type: 'chat', isEnabled: true, ratePerMinute: 20 }],
    presence: { isOnline: true, maxConcurrentChats: 3 },
  });

  const chat = await chatService.requestChat({ userId: user._id, astrologerId: astrologer._id, channel: 'chat' });
  await chatService.acceptChat({ chatId: chat._id, astrologerId: astrologer._id });
  check('minute 1 charged upfront on accept, before any sweep', (await User.findById(user._id)).wallet.balance === 80);

  /** Time moves: the session is now a minute and a half old, so minute 2 is due. */
  await ChatSession.updateOne(
    { _id: chat._id },
    { $set: { lastBilledAt: new Date(Date.now() - 90 * 1000) } },
  );

  const billed = await sweep({ 'x-internal-key': KEY });
  check('200, and it reports what it swept', billed.status === 200 && billed.body.swept >= 1, billed.body);
  check('the due minute was billed', billed.body.outcomes.billed === 1, billed.body.outcomes);
  check('the wallet is down by one minute at the session\'s rate', (await User.findById(user._id)).wallet.balance === 60);
  check('minutesBilled is 2', (await ChatSession.findById(chat._id)).minutesBilled === 2);

  section('a cron that fires twice, or overlaps itself, cannot bill a minute twice');
  const again = await sweep({ 'x-internal-key': KEY });
  check('the second call bills nothing — not yet due', again.body.outcomes.billed === undefined, again.body.outcomes);
  check('balance unchanged', (await User.findById(user._id)).wallet.balance === 60);

  /** Two schedulers racing on the same due minute. */
  await ChatSession.updateOne({ _id: chat._id }, { $set: { lastBilledAt: new Date(Date.now() - 90 * 1000) } });
  const [raceA, raceB] = await Promise.all([sweep({ 'x-internal-key': KEY }), sweep({ 'x-internal-key': KEY })]);
  const billedBoth = [raceA, raceB].filter(r => r.body.outcomes?.billed === 1).length;
  check('exactly one of the two concurrent sweeps billed the minute', billedBoth === 1, { raceA: raceA.body, raceB: raceB.body });
  check('one minute charged between them, not two', (await User.findById(user._id)).wallet.balance === 40);
  check('minutesBilled is 3', (await ChatSession.findById(chat._id)).minutesBilled === 3);

  /* ------------------------------------------------------------------ package */

  section('a package session reaches its end through the HTTP sweep');
  const pkgUser = await User.create({
    name: 'Package Seeker', email: 'internal-pkg@x.com', phone: { number: '9300000002' },
    wallet: { balance: 300 },
  });
  const pkgChat = await chatService.requestChat({
    userId: pkgUser._id, astrologerId: astrologer._id, channel: 'chat',
    billing: { mode: 'package', packageMinutes: 3, quotedPrice: 60 },
  });
  await chatService.acceptChat({ chatId: pkgChat._id, astrologerId: astrologer._id });
  const purchased = await ChatSession.findById(pkgChat._id);
  check('the package was paid for upfront', (await User.findById(pkgUser._id)).wallet.balance === 240);
  check('and it has an end time to run down to', Boolean(purchased.packageState?.endsAt));

  /** Wind the package's end back past now, as three minutes of talking would. */
  await ChatSession.updateOne(
    { _id: pkgChat._id },
    { $set: { 'packageState.endsAt': new Date(Date.now() - 1000) } },
  );
  const ended = await sweep({ 'x-internal-key': KEY });
  const afterEnd = await ChatSession.findById(pkgChat._id);
  check('the sweep noticed the package ran out', Boolean(afterEnd.packageState?.awaitingChoiceSince), ended.body.outcomes);
  check('nothing more was charged for it — package time was prepaid',
    (await User.findById(pkgUser._id)).wallet.balance === 240);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  await mongoose.disconnect();
  await new Promise(r => server.close(r));
  process.exit(fail === 0 ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
