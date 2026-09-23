/**
 * "This astrologer is busy for about N min" — the estimated wait a seeker is
 * shown on a busy astrologer (services/astrologer.service.js's
 * estimatedWaitSecondsFor), through the directory, the profile and the
 * favourites list.
 *
 * An estimate, not a promise: a package session's remaining time is known
 * exactly, a per-minute one is projected from how long that astrologer's own
 * consultations usually last.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_astrologer_wait';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const { ChatSession } = require('../models/Chat');
const astrologerService = require('../services/astrologer.service');
const userService = require('../services/user.service');
const env = require('../config/env');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);
const minutesFromNow = m => new Date(Date.now() + m * 60 * 1000);
const minutesAgo = m => new Date(Date.now() - m * 60 * 1000);

let seq = 0;
async function makeAstrologer({ busy = false, activeSessions = 0, metrics, maxConcurrentChats = 3 } = {}) {
  seq += 1;
  return Astrologer.create({
    name: `Astro ${seq}`, email: `wait${seq}@x.com`, phone: { number: `94000000${String(seq).padStart(2, '0')}` },
    applicationStatus: 'approved', status: 'active',
    services: [{ type: 'chat', ratePerMinute: 20, isEnabled: true }],
    presence: { isOnline: true, isBusy: busy, activeSessions, maxConcurrentChats },
    metrics,
  });
}
const startSession = (astrologer, user, extra) => ChatSession.create({
  type: 'consultation', channel: 'chat', user: user._id, astrologer: astrologer._id, status: 'active',
  startedAt: new Date(), billing: { ratePerMinute: 20, commissionPercent: 25 }, ...extra,
});
const waitFor = async (astrologer, now = new Date()) =>
  (await astrologerService.estimatedWaitSecondsFor([await Astrologer.findById(astrologer._id)], now)).get(String(astrologer._id));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  const seeker = await User.create({ name: 'Seeker', email: 's@x.com', phone: { number: '9300000000' }, wallet: { balance: 1000 } });

  section('a free astrologer has no wait');
  const free = await makeAstrologer();
  check('not in the map at all → cards read 0 ("free")', (await waitFor(free)) === undefined);
  const freeCard = astrologerService.toDirectoryCard(free, undefined);
  check('the card says free', freeCard.waitSeconds === 0 && freeCard.busy === false);

  section('a package session: the wait is its own remaining time');
  const pkgAstro = await makeAstrologer({ busy: true, activeSessions: 1 });
  const pkgChat = await startSession(pkgAstro, seeker, {
    billing: { mode: 'package', ratePerMinute: 20, commissionPercent: 25 },
    packageState: { endsAt: minutesFromNow(7) },
  });
  const pkgWait = await waitFor(pkgAstro);
  check('~7 minutes left → ~420s', Math.abs(pkgWait - 420) <= 2, pkgWait);
  check('the card carries it, and the app prints "Wait 7 min"', astrologerService.toDirectoryCard(pkgAstro, pkgWait).waitSeconds === pkgWait && Math.ceil(pkgWait / 60) === 7);

  section('never under a minute, and never negative');
  await ChatSession.updateOne({ _id: pkgChat._id }, { $set: { 'packageState.endsAt': new Date(Date.now() + 4000) } });
  check('4s left still reads as a minute', (await waitFor(pkgAstro)) === 60);
  await ChatSession.updateOne({ _id: pkgChat._id }, { $set: { 'packageState.endsAt': minutesAgo(3) } });
  check('already over (waiting on the seeker\'s next move) → a minute', (await waitFor(pkgAstro)) === 60);
  await ChatSession.updateOne({ _id: pkgChat._id }, { $set: { 'packageState.awaitingChoiceSince': new Date() } });
  check('paused on "how do you want to continue?" → a minute', (await waitFor(pkgAstro)) === 60);
  await ChatSession.updateOne({ _id: pkgChat._id }, { $set: { status: 'ended' } });
  check('once it ends they are free again', (await waitFor(pkgAstro)) === undefined);

  section('a per-minute session: projected from their usual length');
  const busyAstro = await makeAstrologer({ busy: true, activeSessions: 1, metrics: { totalConsultations: 8, chatMinutes: 120, callMinutes: 0 } });
  check('usual length = 120 min over 8 consultations = 15 min', astrologerService.typicalConsultationMinutes(await Astrologer.findById(busyAstro._id)) === 15);
  const perMinuteChat = await startSession(busyAstro, seeker, { startedAt: minutesAgo(5) });
  const projected = await waitFor(busyAstro);
  check('5 of ~15 minutes gone → ~10 min left', Math.abs(projected - 600) <= 2, projected);
  await ChatSession.updateOne({ _id: perMinuteChat._id }, { $set: { startedAt: minutesAgo(40) } });
  check('long past the usual length → still a minute, never 0 or negative', (await waitFor(busyAstro)) === 60);

  const noHistory = await makeAstrologer({ busy: true, activeSessions: 1 });
  await startSession(noHistory, seeker, { startedAt: new Date() });
  const fallback = await waitFor(noHistory);
  check(`a brand-new astrologer falls back to the configured ${env.consultation.estimatedConsultationMinutes} min`, Math.abs(fallback - env.consultation.estimatedConsultationMinutes * 60) <= 2, fallback);

  section('several chats at once: whichever ends soonest');
  const multi = await makeAstrologer({ busy: true, activeSessions: 2 });
  await startSession(multi, seeker, { billing: { mode: 'package', ratePerMinute: 20, commissionPercent: 25 }, packageState: { endsAt: minutesFromNow(12) } });
  await startSession(multi, seeker, { billing: { mode: 'package', ratePerMinute: 20, commissionPercent: 25 }, packageState: { endsAt: minutesFromNow(3) } });
  const soonest = await waitFor(multi);
  check('the 3-minute one decides it', Math.abs(soonest - 180) <= 2, soonest);

  section('every list a seeker sees carries it');
  const directory = await astrologerService.listAstrologers({ limit: 50 });
  const rowOf = id => directory.items.find(item => item.id === String(id));
  check('the directory: busy rows have a wait, free ones 0',
    rowOf(busyAstro._id).waitSeconds > 0 && rowOf(multi._id).waitSeconds > 0 && rowOf(free._id).waitSeconds === 0,
    directory.items.map(item => [item.name, item.waitSeconds]));
  const profile = await astrologerService.getAstrologerProfile(busyAstro._id);
  check('the astrologer\'s own profile screen', profile.waitSeconds > 0 && profile.busy === true, profile.waitSeconds);
  await User.updateOne({ _id: seeker._id }, { $set: { favouriteAstrologers: [busyAstro._id, free._id] } });
  const favourites = await userService.listFavourites(seeker._id);
  check('the favourites list', favourites.find(row => row.id === String(busyAstro._id)).waitSeconds > 0
    && favourites.find(row => row.id === String(free._id)).waitSeconds === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
