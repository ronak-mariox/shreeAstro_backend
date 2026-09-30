/**
 * Voice-call tokens (services/callToken.service.js): the Agora RTC credential
 * a participant fetches to join a `call` consultation's audio.
 *
 * Pure part first (the token builder on its own), then DB-backed like
 * chat-billing/chat-packages: real sessions requested and accepted through
 * services/chat.service.js, so the guard runs on exactly what production
 * stores. Agora env is set here to test values — the builder is an HMAC over
 * them, no network involved — and unset again for the 503 case.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_call_token';
process.env.NODE_ENV = 'development';
/** Test-only values; not real Agora credentials. */
process.env.AGORA_APP_ID = 'a'.repeat(32);
process.env.AGORA_APP_CERTIFICATE = 'b'.repeat(32);
process.env.AGORA_TOKEN_TTL_SECONDS = '600';

const mongoose = require('mongoose');
const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const { ChatSession } = require('../models/Chat');
const env = require('../config/env');
const chatService = require('../services/chat.service');
const callTokenService = require('../services/callToken.service');
const settingsService = require('../services/settings.service');
const chatRoutes = require('../routes/chat.routes');

/** Records every emit instead of needing a live socket.io server. */
require('../socket').getIO = () => ({ to: () => ({ emit: () => {} }) });

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

async function expectError(fn) {
  try { await fn(); return null; } catch (error) { return error; }
}

let userSeq = 0;
async function makeUser(walletBalance = 1000) {
  userSeq += 1;
  return User.create({
    name: `Call Seeker ${userSeq}`,
    email: `callseeker${userSeq}@example.com`,
    phone: { countryCode: '+91', number: `93${String(userSeq).padStart(8, '0')}` },
    wallet: { balance: walletBalance },
  });
}
let astroSeq = 0;
async function makeAstrologer() {
  astroSeq += 1;
  return Astrologer.create({
    name: `Call Astrologer ${astroSeq}`,
    email: `callastro${astroSeq}@example.com`,
    phone: { countryCode: '+91', number: `92${String(astroSeq).padStart(8, '0')}` },
    applicationStatus: 'approved',
    commissionPercent: 25,
    services: [
      { type: 'chat', ratePerMinute: 20, isEnabled: true },
      { type: 'call', ratePerMinute: 30, isEnabled: true },
    ],
    presence: { isOnline: true, isBusy: false, activeSessions: 0, maxConcurrentChats: 5 },
  });
}

/** Request (+ optionally accept) a session; returns the fresh chat. */
async function startSession({ user, astro, channel, accept = true }) {
  const requested = await chatService.requestChat({ userId: user._id, astrologerId: astro._id, channel, intake: {} });
  if (accept) await chatService.acceptChat({ chatId: requested._id, astrologerId: astro._id });
  return ChatSession.findById(requested._id);
}

/** Agora's 007 token: "007" + base64 of the packed payload. */
const looksLikeAgoraToken = token =>
  typeof token === 'string'
  && token.startsWith(callTokenService.AGORA_TOKEN_VERSION_PREFIX)
  && token.length > 40
  && /^[A-Za-z0-9+/=]+$/.test(token.slice(3));

(async () => {
  /* ======================================================= pure unit tests */
  section('unit — env');
  check('agora env is read and enabled with both values set', env.agora.enabled === true && env.agora.appId.length === 32);
  check('ttl comes from AGORA_TOKEN_TTL_SECONDS', env.agora.tokenTtlSeconds === 600);
  check('fixed uids: seeker 1001, astrologer 2001', callTokenService.CALL_UIDS.user === 1001 && callTokenService.CALL_UIDS.astrologer === 2001);

  section('unit — buildRtcToken');
  const built = callTokenService.buildRtcToken({
    appId: env.agora.appId, appCertificate: env.agora.appCertificate, channelName: 'abc123', uid: 1001, ttlSeconds: 600,
  });
  check('builds a string token with Agora\'s 007 version prefix', looksLikeAgoraToken(built), built?.slice(0, 10));
  const again = callTokenService.buildRtcToken({
    appId: env.agora.appId, appCertificate: env.agora.appCertificate, channelName: 'abc123', uid: 1001, ttlSeconds: 600,
  });
  check('every token is salted (two builds differ)', again !== built);
  const otherUid = callTokenService.buildRtcToken({
    appId: env.agora.appId, appCertificate: env.agora.appCertificate, channelName: 'abc123', uid: 2001, ttlSeconds: 600,
  });
  check('a different uid gives a different token', otherUid !== built && looksLikeAgoraToken(otherUid));

  section('unit — route is registered');
  const callTokenLayer = chatRoutes.stack.find(layer => layer.route?.path === '/:chatId/call-token');
  check('GET /chats/:chatId/call-token exists', Boolean(callTokenLayer) && callTokenLayer.route.methods.get === true);
  check('it runs the chatId validator before the controller', (callTokenLayer?.route.stack.length ?? 0) >= 3);

  /* ======================================================= integration */
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  section('GET /settings says calls are available');
  {
    const pub = await settingsService.publicSettings();
    check('calls: { provider: "agora", enabled: true }', pub.calls?.provider === 'agora' && pub.calls.enabled === true);
    check('the payload never carries the credentials', JSON.stringify(pub).includes(env.agora.appCertificate) === false
      && JSON.stringify(pub).includes(env.agora.appId) === false);
  }

  section('an active call: both sides get a token');
  let active;
  {
    const user = await makeUser();
    const astro = await makeAstrologer();
    active = await startSession({ user, astro, channel: 'call' });
    check('the session is an active call', active.channel === 'call' && active.status === 'active');

    const mine = await callTokenService.issueCallToken({ chatId: active._id, accountId: user._id });
    check('seeker: provider agora, role user, uid 1001, peer 2001',
      mine.provider === 'agora' && mine.role === 'user' && mine.uid === 1001 && mine.peerUid === 2001, mine);
    check('channelName is the session id', mine.channelName === String(active._id));
    check('appId is the configured one', mine.appId === env.agora.appId);
    check('token looks like an Agora 007 token', looksLikeAgoraToken(mine.token), mine.token?.slice(0, 10));
    check('ttl and an ISO expiresAt about ttl from now', mine.ttlSeconds === 600
      && Math.abs(new Date(mine.expiresAt).getTime() - (Date.now() + 600 * 1000)) < 5000
      && mine.expiresAt === new Date(mine.expiresAt).toISOString());
    check('the response never carries the certificate', !JSON.stringify(mine).includes(env.agora.appCertificate));
    check('exact response keys', Object.keys(mine).sort().join(',')
      === ['provider', 'appId', 'channelName', 'uid', 'peerUid', 'role', 'token', 'expiresAt', 'ttlSeconds'].sort().join(','), Object.keys(mine));

    const theirs = await callTokenService.issueCallToken({ chatId: String(active._id), accountId: String(astro._id) });
    check('astrologer: role astrologer, uid 2001, peer 1001',
      theirs.role === 'astrologer' && theirs.uid === 2001 && theirs.peerUid === 1001, theirs);
    check('same channel for both sides', theirs.channelName === mine.channelName);
    check('the two tokens differ', theirs.token !== mine.token && looksLikeAgoraToken(theirs.token));

    const stranger = await makeUser();
    const notMine = await expectError(() => callTokenService.issueCallToken({ chatId: active._id, accountId: stranger._id }));
    check('a stranger is refused with 403', notMine?.status === 403, notMine?.message);
    const otherAstro = await makeAstrologer();
    const notTheirs = await expectError(() => callTokenService.issueCallToken({ chatId: active._id, accountId: otherAstro._id }));
    check('another astrologer is refused with 403', notTheirs?.status === 403, notTheirs?.message);
    const unknown = await expectError(() => callTokenService.issueCallToken({ chatId: new mongoose.Types.ObjectId(), accountId: user._id }));
    check('an unknown chat is 404', unknown?.status === 404, unknown?.message);
    const missing = await expectError(() => callTokenService.issueCallToken({ chatId: undefined, accountId: user._id }));
    check('no chatId is 400', missing?.status === 400, missing?.message);
  }

  section('a chat session is not a call');
  {
    const user = await makeUser();
    const astro = await makeAstrologer();
    const chat = await startSession({ user, astro, channel: 'chat' });
    const err = await expectError(() => callTokenService.issueCallToken({ chatId: chat._id, accountId: user._id }));
    check('400 not_a_call for the seeker', err?.status === 400 && err.code === 'not_a_call', err?.message);
    const err2 = await expectError(() => callTokenService.issueCallToken({ chatId: chat._id, accountId: astro._id }));
    check('400 not_a_call for the astrologer too', err2?.status === 400 && err2.code === 'not_a_call');
  }

  section('only an active call gets a token');
  {
    const user = await makeUser();
    const astro = await makeAstrologer();
    const requested = await startSession({ user, astro, channel: 'call', accept: false });
    check('the request is still pending', requested.status === 'requested');
    const early = await expectError(() => callTokenService.issueCallToken({ chatId: requested._id, accountId: user._id }));
    check('requested -> 409 not_active', early?.status === 409 && early.code === 'not_active', early?.message);
    const earlyAstro = await expectError(() => callTokenService.issueCallToken({ chatId: requested._id, accountId: astro._id }));
    check('...for the astrologer as well', earlyAstro?.status === 409 && earlyAstro.code === 'not_active');

    await chatService.acceptChat({ chatId: requested._id, astrologerId: astro._id });
    const ok = await callTokenService.issueCallToken({ chatId: requested._id, accountId: user._id });
    check('once accepted, a token is issued', looksLikeAgoraToken(ok.token));

    await chatService.endChat({ chatId: requested._id, accountId: user._id, endedBy: 'user' });
    const late = await expectError(() => callTokenService.issueCallToken({ chatId: requested._id, accountId: user._id }));
    check('ended -> 409 not_active', late?.status === 409 && late.code === 'not_active', late?.message);

    const rejected = await startSession({ user, astro, channel: 'call', accept: false });
    await chatService.rejectChat({ chatId: rejected._id, astrologerId: astro._id, reason: 'busy' });
    const rej = await expectError(() => callTokenService.issueCallToken({ chatId: rejected._id, accountId: user._id }));
    check('rejected -> 409 not_active', rej?.status === 409 && rej.code === 'not_active');
  }

  section('Agora env unset -> 503 calls_unconfigured');
  {
    const saved = { ...env.agora };
    env.agora.appId = '';
    env.agora.appCertificate = '';
    env.agora.enabled = false;
    try {
      const err = await expectError(() => callTokenService.issueCallToken({ chatId: active._id, accountId: active.user }));
      check('an active call still refuses with 503 calls_unconfigured', err?.status === 503 && err.code === 'calls_unconfigured', err?.message);
      const pub = await settingsService.publicSettings();
      check('GET /settings says calls.enabled: false', pub.calls?.enabled === false && pub.calls.provider === 'agora');
      const chatUser = await makeUser();
      const astro = await makeAstrologer();
      const chat = await startSession({ user: chatUser, astro, channel: 'chat' });
      const notCall = await expectError(() => callTokenService.issueCallToken({ chatId: chat._id, accountId: chatUser._id }));
      check('not_a_call still wins over the config check (a chat is never a call)', notCall?.code === 'not_a_call');
    } finally {
      Object.assign(env.agora, saved);
    }
    const back = await callTokenService.issueCallToken({ chatId: active._id, accountId: active.user });
    check('restored env issues tokens again', looksLikeAgoraToken(back.token));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('CRASHED:', e);
  process.exit(1);
});
