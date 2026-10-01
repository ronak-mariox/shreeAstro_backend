/**
 * Push notifications end to end on the server: an app registers its FCM token
 * (services/device.service.js, /api/v1/devices), and a notification reaches
 * every registered device (services/notification.service.js →
 * services/push.service.js).
 *
 * DB-backed like razorpay-topup. Point TEST_MONGODB_URI at a throwaway
 * mongod, e.g. mongodb://127.0.0.1:27135/shree_astro_test_push?replicaSet=rs0
 *
 * Nothing here reaches Firebase. pushService.setSender() is handed a recorder
 * before anything else runs: it keeps every message it is asked to send and
 * fails the ones a test marks, with errors shaped like firebase-admin's. The
 * "configured" service account below is not a real one and is never parsed —
 * only the real sender builds a credential from it.
 *
 * Firebase is switched on and off by writing `process.env`, never through
 * integrationsService.save(): that writes the `.env` file in the working
 * directory, and this suite must not touch the project's own.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_push';
process.env.NODE_ENV = 'development';

/** Test-only values; not a real service account. */
const PROJECT_ID = 'unit-test-project';
const CLIENT_EMAIL = 'push@unit-test-project.iam.gserviceaccount.com';
const PRIVATE_KEY = 'not-a-real-private-key';

/** Firebase as the admin panel's Third Parties tab leaves it on process.env. */
function useFirebase({ enabled = true, privateKey = PRIVATE_KEY } = {}) {
  process.env.INTEGRATION_FIREBASE_PROJECT_ID = PROJECT_ID;
  process.env.INTEGRATION_FIREBASE_CLIENT_EMAIL = CLIENT_EMAIL;
  process.env.INTEGRATION_FIREBASE_PRIVATE_KEY = privateKey;
  process.env.INTEGRATION_FIREBASE_ENABLED = enabled ? 'true' : 'false';
}
function clearFirebase() {
  process.env.INTEGRATION_FIREBASE_PROJECT_ID = '';
  process.env.INTEGRATION_FIREBASE_CLIENT_EMAIL = '';
  process.env.INTEGRATION_FIREBASE_PRIVATE_KEY = '';
  process.env.INTEGRATION_FIREBASE_ENABLED = 'false';
}

/** Set before anything is required, so a developer's own .env can never hand this suite a real service account. */
useFirebase();

const mongoose = require('mongoose');

const { createApp } = require('../app');
const { signAccessToken } = require('../utils/token');
const pushService = require('../services/push.service');
const deviceService = require('../services/device.service');
const notificationService = require('../services/notification.service');
const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const Notification = require('../models/Notification');
const deviceRoutes = require('../routes/device.routes');

/* ------------------------------------------------------- the fake Firebase */

const fcm = {
  /** Every message the code tried to send, in order. */
  sent: [],
  /** token -> () => Error, for the sends that should fail. */
  failures: new Map(),
  /** When set, every send waits on it — to prove notify() does not. */
  gate: null,
};

/** An error shaped like firebase-admin's FirebaseMessagingError. */
const fcmError = (code, message) => Object.assign(new Error(message), { code, errorInfo: { code, message } });
const UNREGISTERED = () => fcmError('messaging/registration-token-not-registered', 'Requested entity was not found.');

pushService.setSender(async (message, config) => {
  fcm.sent.push({ message, config });
  if (fcm.gate) await fcm.gate;
  const failure = fcm.failures.get(message.token);
  if (failure) throw failure();
  return `projects/${config.projectId}/messages/${fcm.sent.length}`;
});

/** No live socket.io server here; what would have been emitted is kept instead. */
const emitted = [];
require('../socket').getIO = () => ({
  to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
});

const PORT = 5097;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);
const errorOf = async fn => {
  try { await fn(); return null; } catch (error) { return error; }
};
const brief = error => ({ status: error?.status, message: error?.message, fields: error?.fields });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** notify() does not wait for its pushes, so the tests do: polls until `test()` holds. */
async function waitFor(test, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await sleep(15);
  }
  return Boolean(await test());
}
/** Long enough for a push that was (wrongly) started to have shown up. */
const settle = () => sleep(250);

/** push.service logs a failed send; the failures here are deliberate. */
const realConsoleError = console.error;
const logged = [];
const quiet = async fn => {
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try { return await fn(); } finally { console.error = realConsoleError; }
};

/* --------------------------------------------------------------- helpers */

let seq = 0;
async function makeUser(overrides = {}) {
  seq += 1;
  return User.create({
    name: `Push Seeker ${seq}`,
    email: `pushseeker${seq}@example.com`,
    phone: { countryCode: '+91', number: `95${String(seq).padStart(8, '0')}` },
    ...overrides,
  });
}
async function makeAstrologer(overrides = {}) {
  seq += 1;
  return Astrologer.create({
    name: `Push Astrologer ${seq}`,
    email: `pushastro${seq}@example.com`,
    phone: { countryCode: '+91', number: `96${String(seq).padStart(8, '0')}` },
    applicationStatus: 'approved',
    commissionPercent: 25,
    services: [{ type: 'chat', ratePerMinute: 20, isEnabled: true }],
    ...overrides,
  });
}

let tokenSeq = 0;
/** Looks like an FCM token; unique per call. */
const newToken = (label = 'device') => {
  tokenSeq += 1;
  return `fcm-${label}-${tokenSeq}:APA91b${'x'.repeat(120)}`;
};

const devicesOf = async (Model, id) => (await Model.findById(id).select('devices')).devices;
const tokensOf = async (Model, id) => (await devicesOf(Model, id)).map(device => device.fcmToken);
const register = (role, account, fcmToken, extra = {}) =>
  deviceService.registerDevice({ role, accountId: account._id, fcmToken, platform: 'android', ...extra });

/** A signed-in caller over HTTP. */
const api = (account, role) => async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(account ? { Authorization: `Bearer ${signAccessToken(account._id, role)}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

(async () => {
  /* ======================================================= pure unit tests */

  section('unit — sendPush');
  {
    fcm.sent.length = 0;
    const none = await pushService.sendPush({ token: '', title: 'T', body: 'B' });
    check('no token -> { sent: false, reason: "no_token" }, nothing sent', none.sent === false && none.reason === 'no_token' && fcm.sent.length === 0, none);

    const ok = await pushService.sendPush({ token: 'tok-1', title: 'Hello', body: 'World', data: { type: 'system', count: 3, gone: undefined, empty: null, action: '' } });
    const [{ message, config }] = fcm.sent;
    check('a send answers { sent: true }', ok.sent === true && ok.reason === undefined && fcm.sent.length === 1, ok);
    check('to the token, with the title and body', message.token === 'tok-1' && message.notification.title === 'Hello' && message.notification.body === 'World', message);
    check('data values are all strings; undefined/null are left out',
      JSON.stringify(message.data) === JSON.stringify({ type: 'system', count: '3', action: '' }), message.data);
    check('android: high priority, the "default" channel, default sound',
      JSON.stringify(message.android) === JSON.stringify({ priority: 'high', notification: { channelId: 'default', sound: 'default' } }), message.android);
    check('apns: default sound', JSON.stringify(message.apns) === JSON.stringify({ payload: { aps: { sound: 'default' } } }), message.apns);
    check('the sender is handed the saved service account', config.projectId === PROJECT_ID && config.clientEmail === CLIENT_EMAIL && config.privateKey === PRIVATE_KEY);
    check('exact message keys', Object.keys(message).sort().join(',') === 'android,apns,data,notification,token', Object.keys(message));
  }

  section('unit — FCM errors');
  {
    const outcome = async makeError => {
      fcm.failures.set('tok-bad', makeError);
      const result = await quiet(() => pushService.sendPush({ token: 'tok-bad', title: 'T', body: 'B' }));
      fcm.failures.delete('tok-bad');
      return result;
    };
    const reasonIs = (result, reason) => result.sent === false && result.reason === reason && Object.keys(result).sort().join(',') === 'reason,sent';

    check('registration-token-not-registered -> invalid_token', reasonIs(await outcome(UNREGISTERED), 'invalid_token'));
    check('invalid-registration-token -> invalid_token',
      reasonIs(await outcome(() => fcmError('messaging/invalid-registration-token', 'Invalid registration token provided.')), 'invalid_token'));
    check('invalid-argument about the token -> invalid_token',
      reasonIs(await outcome(() => fcmError('messaging/invalid-argument', 'The registration token is not a valid FCM registration token')), 'invalid_token'));
    check('invalid-argument about anything else -> provider_error (a bad payload must not cost a device)',
      reasonIs(await outcome(() => fcmError('messaging/invalid-argument', 'Invalid value at message.data[0].value')), 'provider_error'));
    check('the code is also read from errorInfo',
      reasonIs(await outcome(() => Object.assign(new Error('gone'), { errorInfo: { code: 'messaging/registration-token-not-registered' } })), 'invalid_token'));
    check('a server error -> provider_error', reasonIs(await outcome(() => fcmError('messaging/internal-error', 'Internal error')), 'provider_error'));
    check('bad credentials -> provider_error',
      reasonIs(await outcome(() => fcmError('app/invalid-credential', 'Failed to parse private key')), 'provider_error'));
    check('a network failure -> provider_error', reasonIs(await outcome(() => new Error('getaddrinfo ENOTFOUND fcm.googleapis.com')), 'provider_error'));
    // eslint-disable-next-line no-throw-literal -- on purpose: not everything thrown is an Error.
    check('something thrown that is not an Error -> provider_error, still not thrown', reasonIs(await outcome(() => 'boom'), 'provider_error'));
  }

  section('unit — Firebase not configured');
  {
    fcm.sent.length = 0;
    clearFirebase();
    const unset = await pushService.sendPush({ token: 'tok-1', title: 'T', body: 'B' });
    check('nothing saved -> not_configured, sender never called', unset.sent === false && unset.reason === 'not_configured' && fcm.sent.length === 0, unset);

    useFirebase({ enabled: false });
    const off = await pushService.sendPush({ token: 'tok-1', title: 'T', body: 'B' });
    check('saved but switched off on the panel -> not_configured', off.reason === 'not_configured' && fcm.sent.length === 0, off);

    useFirebase({ privateKey: '' });
    const half = await pushService.sendPush({ token: 'tok-1', title: 'T', body: 'B' });
    check('enabled with no private key -> not_configured', half.reason === 'not_configured' && fcm.sent.length === 0, half);

    useFirebase();
    check('and no_token wins over not_configured either way', (await pushService.sendPush({ token: undefined })).reason === 'no_token');
  }

  section('unit — routes are registered');
  {
    const routesFor = path => deviceRoutes.stack.filter(layer => layer.route?.path === path).map(layer => layer.route);
    const root = routesFor('/');
    check('POST /devices exists, behind a validator', root.some(route => route.methods.post && route.stack.length >= 3));
    check('DELETE /devices exists, behind a validator', root.some(route => route.methods.delete && route.stack.length >= 3));
    check('POST /devices/test exists', routesFor('/test')[0]?.methods.post === true);
  }

  /* ============================================================ integration */

  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  const server = createApp().listen(PORT);

  section('registerDevice stores the device');
  {
    const user = await makeUser();
    const before = (await User.findById(user._id)).updatedAt.getTime();
    const token = newToken();
    const started = Date.now();
    const count = await register('user', user, token, { appVersion: '1.2.3' });
    const devices = await devicesOf(User, user._id);

    check('answers the device count', count === 1, count);
    check('one row: token, platform, appVersion', devices.length === 1 && devices[0].fcmToken === token
      && devices[0].platform === 'android' && devices[0].appVersion === '1.2.3', devices);
    check('lastSeenAt is now', Math.abs(devices[0].lastSeenAt.getTime() - started) < 5000, devices[0].lastSeenAt);
    check('a device heartbeat does not move the account\'s updatedAt', (await User.findById(user._id)).updatedAt.getTime() === before);

    const second = await register('user', user, newToken(), { platform: 'ios' });
    check('a second install is a second row', second === 2 && (await devicesOf(User, user._id)).map(d => d.platform).join(',') === 'android,ios');

    const padded = newToken();
    await register('user', user, `  ${padded}  `);
    check('the token is stored trimmed', (await tokensOf(User, user._id)).includes(padded));

    const noVersion = newToken();
    await register('user', user, noVersion);
    const bare = (await devicesOf(User, user._id)).find(d => d.fcmToken === noVersion);
    check('appVersion is optional', bare && bare.appVersion === undefined, bare);
  }

  section('re-registering refreshes, never duplicates');
  {
    const user = await makeUser();
    const token = newToken();
    await register('user', user, token, { appVersion: '1.0.0' });
    const longAgo = new Date('2024-01-01T00:00:00Z');
    await User.updateOne({ _id: user._id }, { $set: { 'devices.0.lastSeenAt': longAgo } });

    const count = await register('user', user, token, { platform: 'ios', appVersion: '1.1.0' });
    const devices = await devicesOf(User, user._id);
    check('still one row', count === 1 && devices.length === 1, devices);
    check('platform and appVersion are refreshed', devices[0].platform === 'ios' && devices[0].appVersion === '1.1.0', devices[0]);
    check('lastSeenAt moved forward', devices[0].lastSeenAt.getTime() > longAgo.getTime() + 1000, devices[0].lastSeenAt);

    await register('user', user, token);
    const kept = (await devicesOf(User, user._id))[0];
    check('a call without appVersion keeps the last one known', kept.appVersion === '1.1.0' && kept.platform === 'android', kept);

    const racing = newToken();
    const counts = await Promise.all([1, 2, 3, 4, 5].map(() => register('user', user, racing)));
    const after = await tokensOf(User, user._id);
    check('five registrations of one token at the same moment leave one row for it',
      after.filter(t => t === racing).length === 1 && after.length === 2 && counts.every(n => n >= 1 && n <= 2), { after: after.length, counts });
  }

  section('a token belongs to one account at a time');
  {
    const first = await makeUser();
    const second = await makeUser();
    const astrologer = await makeAstrologer();
    const shared = newToken('shared');
    const own = newToken('own');

    await register('user', first, shared);
    await register('user', first, own);
    await register('user', second, shared);
    check('registered by a second seeker: it leaves the first', !(await tokensOf(User, first._id)).includes(shared) && (await tokensOf(User, second._id)).join() === shared);
    check('the first seeker\'s other device is untouched', (await tokensOf(User, first._id)).join() === own);

    await register('astrologer', astrologer, shared);
    check('registered by an astrologer: it leaves the seeker (across both collections)',
      (await tokensOf(User, second._id)).length === 0 && (await tokensOf(Astrologer, astrologer._id)).join() === shared);

    await register('user', first, shared);
    check('and back again', (await tokensOf(Astrologer, astrologer._id)).length === 0 && (await tokensOf(User, first._id)).sort().join() === [own, shared].sort().join());

    fcm.sent.length = 0;
    await notificationService.notify({ ownerRole: 'user', ownerId: second._id, type: 'system', title: 'For the previous owner', body: 'x' });
    await settle();
    check('the account that lost the phone no longer pushes to it', fcm.sent.length === 0, fcm.sent.map(s => s.message.token));

    const everywhere = newToken('everywhere');
    await User.updateOne({ _id: first._id }, { $push: { devices: { fcmToken: everywhere, platform: 'android' } } });
    await Astrologer.updateOne({ _id: astrologer._id }, { $push: { devices: { fcmToken: everywhere, platform: 'android' } } });
    const removed = await deviceService.pruneToken(everywhere);
    check('pruneToken with nothing to keep takes it off every account', removed === 2
      && !(await tokensOf(User, first._id)).includes(everywhere) && !(await tokensOf(Astrologer, astrologer._id)).includes(everywhere), removed);
    check('pruneToken of an unknown token removes nothing', (await deviceService.pruneToken(newToken('nobody'))) === 0);
  }

  section('at most 10 devices per account');
  {
    const user = await makeUser();
    const tokens = [];
    for (let i = 0; i < 10; i += 1) {
      tokens.push(newToken(`cap${i}`));
      await register('user', user, tokens[i]);
    }
    /** Spread them a day apart, tokens[0] the oldest, so "oldest" is not a tie on the same millisecond. */
    for (let i = 0; i < 10; i += 1) {
      await User.updateOne(
        { _id: user._id, 'devices.fcmToken': tokens[i] },
        { $set: { 'devices.$.lastSeenAt': new Date(Date.UTC(2025, 0, 1 + i)) } },
      );
    }
    check('ten fit', (await devicesOf(User, user._id)).length === 10);

    const eleventh = newToken('cap10');
    const count = await register('user', user, eleventh);
    const after = await tokensOf(User, user._id);
    check('the eleventh still leaves ten', count === 10 && after.length === 10, { count, length: after.length });
    check('the new one is in', after.includes(eleventh));
    check('the one seen longest ago is what was dropped', !after.includes(tokens[0]) && tokens.slice(1).every(t => after.includes(t)));

    /** tokens[1] is now the oldest — unless its app comes back first. */
    await register('user', user, tokens[1]);
    await register('user', user, newToken('cap11'));
    const later = await tokensOf(User, user._id);
    check('a device that checked in again is not the one dropped next',
      later.length === 10 && later.includes(tokens[1]) && !later.includes(tokens[2]), later.length);
  }

  section('unregisterDevice');
  {
    const user = await makeUser();
    const other = await makeUser();
    const mine = newToken('mine');
    const staying = newToken('staying');
    const theirs = newToken('theirs');
    await register('user', user, mine);
    await register('user', user, staying);
    await register('user', other, theirs);

    const removed = await deviceService.unregisterDevice({ role: 'user', accountId: user._id, fcmToken: mine });
    check('pulls the token from the caller', removed === true && (await tokensOf(User, user._id)).join() === staying);
    const again = await deviceService.unregisterDevice({ role: 'user', accountId: user._id, fcmToken: mine });
    check('a token that is not there is not an error', again === false && (await tokensOf(User, user._id)).join() === staying);
    await deviceService.unregisterDevice({ role: 'user', accountId: user._id, fcmToken: theirs });
    check('and it cannot remove another account\'s device', (await tokensOf(User, other._id)).join() === theirs);
  }

  section('what the service refuses');
  {
    const user = await makeUser();
    const noToken = await errorOf(() => register('user', user, '   '));
    check('an empty token -> 422', noToken?.status === 422 && Boolean(noToken.fields?.fcmToken), brief(noToken));
    const tooLong = await errorOf(() => register('user', user, 'x'.repeat(4097)));
    check('a token over 4096 characters -> 422', tooLong?.status === 422, brief(tooLong));
    const badPlatform = await errorOf(() => register('user', user, newToken(), { platform: 'windows' }));
    check('an unknown platform -> 422', badPlatform?.status === 422 && Boolean(badPlatform.fields?.platform), brief(badPlatform));
    const admin = await errorOf(() => register('admin', user, newToken()));
    check('a role with no devices -> 403', admin?.status === 403, brief(admin));
    const ghost = await errorOf(() => deviceService.registerDevice({ role: 'user', accountId: new mongoose.Types.ObjectId(), fcmToken: newToken(), platform: 'android' }));
    check('an account that no longer exists -> 404', ghost?.status === 404, brief(ghost));
    check('none of that stored anything', (await devicesOf(User, user._id)).length === 0);
  }

  section('notify() reaches every device');
  let seeker;
  const seekerTokens = [newToken('a'), newToken('b'), newToken('c')];
  {
    seeker = await makeUser();
    for (const token of seekerTokens) await register('user', seeker, token);

    fcm.sent.length = 0;
    emitted.length = 0;
    const notification = await notificationService.notify({
      ownerRole: 'user', ownerId: seeker._id, type: 'wallet_credit',
      title: 'Money added', body: '₹100 was added to your wallet.', action: { screen: 'wallets' },
    });
    check('three devices, three pushes', await waitFor(() => fcm.sent.length === 3), fcm.sent.length);
    await settle();
    check('and only three', fcm.sent.length === 3, fcm.sent.length);
    check('one to each token', fcm.sent.map(s => s.message.token).sort().join() === [...seekerTokens].sort().join());
    check('each with the title and body', fcm.sent.every(s => s.message.notification.title === 'Money added' && s.message.notification.body === '₹100 was added to your wallet.'));

    const { data } = fcm.sent[0].message;
    check('data.notificationId is the stored row', data.notificationId === String(notification._id) && Boolean(await Notification.findById(data.notificationId)), data);
    check('data.type is kept', data.type === 'wallet_credit', data);
    check('data.action is the action as JSON', data.action === '{"screen":"wallets"}' && JSON.parse(data.action).screen === 'wallets', data.action);
    check('exact data keys, all strings', Object.keys(data).sort().join(',') === 'action,notificationId,type' && Object.values(data).every(v => typeof v === 'string'), data);
    check('every device got the same data', fcm.sent.every(s => JSON.stringify(s.message.data) === JSON.stringify(data)));
    check('with the android channel and the sounds', fcm.sent.every(s => s.message.android.notification.channelId === 'default'
      && s.message.android.priority === 'high' && s.message.apns.payload.aps.sound === 'default'));

    check('the row is stored and the unread counter moved', (await User.findById(seeker._id)).unreadNotifications === 1
      && (await Notification.countDocuments({ owner: seeker._id })) === 1);
    check('the socket still gets it, action as an object',
      emitted.length === 1 && emitted[0].room === `user:${seeker._id}` && emitted[0].event === 'notification:new'
      && emitted[0].payload.id === String(notification._id) && emitted[0].payload.action.screen === 'wallets', emitted);

    fcm.sent.length = 0;
    await notificationService.notify({ ownerRole: 'user', ownerId: seeker._id, type: 'message', title: 'New message', body: 'Hi', action: { screen: 'chat', id: 'abc123' } });
    await waitFor(() => fcm.sent.length === 3);
    check('an action with an id carries both', JSON.stringify(JSON.parse(fcm.sent[0].message.data.action)) === JSON.stringify({ screen: 'chat', id: 'abc123' }), fcm.sent[0]?.message.data);

    fcm.sent.length = 0;
    await notificationService.notify({ ownerRole: 'user', ownerId: seeker._id, title: 'No action, no type' });
    await waitFor(() => fcm.sent.length === 3);
    const plain = fcm.sent[0]?.message;
    check('no action -> data.action is "", type defaults to system',
      plain?.data.action === '' && plain.data.type === 'system' && /^[a-f0-9]{24}$/.test(plain.data.notificationId), plain?.data);
    check('never "[object Object]" or "undefined"', fcm.sent.every(s => !/object Object|undefined/.test(JSON.stringify(s.message.data))));
  }

  section('notify() does not wait for the push');
  {
    fcm.sent.length = 0;
    let release;
    fcm.gate = new Promise(resolve => { release = resolve; });
    const result = await Promise.race([
      notificationService.notify({ ownerRole: 'user', ownerId: seeker._id, type: 'system', title: 'Slow Firebase', body: 'x' }),
      sleep(1500).then(() => 'blocked'),
    ]);
    check('notify() resolves while Firebase is still answering', result !== 'blocked' && Boolean(result?._id));
    release();
    fcm.gate = null;
    check('and the pushes still go out', await waitFor(() => fcm.sent.length === 3), fcm.sent.length);
    await settle();
  }

  section('a dead token is pruned');
  {
    const [alive, dead, alsoAlive] = seekerTokens;
    fcm.failures.set(dead, UNREGISTERED);
    fcm.sent.length = 0;
    await notificationService.notify({ ownerRole: 'user', ownerId: seeker._id, type: 'system', title: 'One of these is gone', body: 'x' });
    check('all three are tried', await waitFor(() => fcm.sent.length === 3), fcm.sent.length);
    check('the invalid_token device is removed', await waitFor(async () => !(await tokensOf(User, seeker._id)).includes(dead)));
    check('the others stay', (await tokensOf(User, seeker._id)).sort().join() === [alive, alsoAlive].sort().join());

    fcm.sent.length = 0;
    await notificationService.notify({ ownerRole: 'user', ownerId: seeker._id, type: 'system', title: 'Next one', body: 'x' });
    await waitFor(() => fcm.sent.length === 2);
    await settle();
    check('the next notification is only sent to the two that are left', fcm.sent.length === 2 && !fcm.sent.some(s => s.message.token === dead), fcm.sent.length);
    fcm.failures.delete(dead);

    fcm.failures.set(alive, () => fcmError('messaging/internal-error', 'Internal error'));
    fcm.failures.set(alsoAlive, () => fcmError('messaging/invalid-argument', 'Invalid value at message.data'));
    const results = await quiet(async () => {
      const row = await notificationService.notify({ ownerRole: 'user', ownerId: seeker._id, type: 'system', title: 'Firebase is having a day', body: 'x', push: false });
      return notificationService.pushToDevices('user', seeker._id, row);
    });
    check('a provider_error is reported per device', results.length === 2 && results.every(r => r.sent === false && r.reason === 'provider_error'), results);
    check('and costs no device', (await devicesOf(User, seeker._id)).length === 2);
    fcm.failures.clear();
  }

  section('Firebase not configured: nothing is sent, nothing throws');
  {
    clearFirebase();
    fcm.sent.length = 0;
    const before = await Notification.countDocuments({ owner: seeker._id });
    const error = await errorOf(() => notificationService.notify({ ownerRole: 'user', ownerId: seeker._id, type: 'system', title: 'Stored anyway', body: 'x' }));
    await settle();
    check('notify() resolves', error === null, brief(error));
    check('the row is still stored', (await Notification.countDocuments({ owner: seeker._id })) === before + 1);
    check('the sender is never called', fcm.sent.length === 0, fcm.sent.length);
    check('no device is pruned for it', (await devicesOf(User, seeker._id)).length === 2);

    const row = await Notification.findOne({ owner: seeker._id }).sort({ createdAt: -1 });
    const results = await notificationService.pushToDevices('user', seeker._id, row);
    check('pushToDevices says not_configured for each device',
      results.length === 2 && results.every(r => r.sent === false && r.reason === 'not_configured'), results);
    useFirebase();
  }

  section('accounts with nothing to push to');
  {
    const bare = await makeUser();
    fcm.sent.length = 0;
    const row = await notificationService.notify({ ownerRole: 'user', ownerId: bare._id, type: 'system', title: 'No devices', body: 'x', push: false });
    check('no devices -> []', JSON.stringify(await notificationService.pushToDevices('user', bare._id, row)) === '[]');
    check('an admin (no devices at all) -> [], not a crash',
      JSON.stringify(await notificationService.pushToDevices('admin', new mongoose.Types.ObjectId(), row)) === '[]');
    check('push: false really does skip the push', (await settle(), fcm.sent.length === 0));
  }

  section('notificationPrefs.push is honoured');
  {
    const muted = await makeUser({ notificationPrefs: { push: false } });
    await register('user', muted, newToken('muted'));
    fcm.sent.length = 0;
    const row = await notificationService.notify({ ownerRole: 'user', ownerId: muted._id, type: 'promotion', title: 'Offer', body: 'x' });
    await settle();
    check('push switched off: nothing is sent', fcm.sent.length === 0, fcm.sent.length);
    check('the notification is still stored for the list', (await Notification.countDocuments({ owner: muted._id })) === 1 && (await User.findById(muted._id)).unreadNotifications === 1);
    const results = await notificationService.pushToDevices('user', muted._id, row);
    check('pushToDevices reports push_disabled per device', results.length === 1 && results[0].sent === false && results[0].reason === 'push_disabled', results);
    check('the device stays registered', (await devicesOf(User, muted._id)).length === 1);

    await User.updateOne({ _id: muted._id }, { $set: { 'notificationPrefs.push': true } });
    await notificationService.notify({ ownerRole: 'user', ownerId: muted._id, type: 'promotion', title: 'Offer', body: 'x' });
    check('switched back on: it is sent again', await waitFor(() => fcm.sent.length === 1), fcm.sent.length);
    check('the other switches (email, promotions…) do not gate push', (await (async () => {
      const user = await makeUser({ notificationPrefs: { email: false, promotions: false, dailyHoroscope: false } });
      await register('user', user, newToken('prefs'));
      fcm.sent.length = 0;
      await notificationService.notify({ ownerRole: 'user', ownerId: user._id, type: 'promotion', title: 'Offer', body: 'x' });
      return waitFor(() => fcm.sent.length === 1);
    })()));
  }

  section('an astrologer, the same way');
  {
    const astrologer = await makeAstrologer();
    const first = newToken('astro');
    const second = newToken('astro');
    check('registers', (await register('astrologer', astrologer, first, { appVersion: '2.0.0' })) === 1
      && (await register('astrologer', astrologer, second, { platform: 'ios' })) === 2);
    check('re-registering does not duplicate', (await register('astrologer', astrologer, first)) === 2);

    fcm.sent.length = 0;
    const notification = await notificationService.notify({
      ownerRole: 'astrologer', ownerId: astrologer._id, type: 'consultation_request',
      title: 'New chat request', body: 'Asha wants to chat.', action: { screen: 'requests', id: 'chat42' },
    });
    check('notify() reaches both devices', await waitFor(() => fcm.sent.length === 2), fcm.sent.length);
    const message = fcm.sent.find(s => s.message.token === first)?.message;
    check('with the right title, body and data', message?.notification.title === 'New chat request' && message.notification.body === 'Asha wants to chat.'
      && message.data.type === 'consultation_request' && message.data.notificationId === String(notification._id)
      && JSON.stringify(JSON.parse(message.data.action)) === JSON.stringify({ screen: 'requests', id: 'chat42' }), message);

    fcm.failures.set(second, UNREGISTERED);
    await notificationService.notify({ ownerRole: 'astrologer', ownerId: astrologer._id, type: 'system', title: 'Prune me', body: 'x' });
    check('a dead token is pruned from an astrologer too', await waitFor(async () => (await tokensOf(Astrologer, astrologer._id)).join() === first));
    fcm.failures.clear();

    await Astrologer.updateOne({ _id: astrologer._id }, { $set: { 'notificationPrefs.push': false } });
    await settle();
    fcm.sent.length = 0;
    await notificationService.notify({ ownerRole: 'astrologer', ownerId: astrologer._id, type: 'system', title: 'Muted', body: 'x' });
    await settle();
    check('and an astrologer\'s push switch is honoured too', fcm.sent.length === 0, fcm.sent.length);

    check('unregisters', (await deviceService.unregisterDevice({ role: 'astrologer', accountId: astrologer._id, fcmToken: first })) === true
      && (await devicesOf(Astrologer, astrologer._id)).length === 0);
  }

  section('over HTTP: POST /devices');
  {
    const user = await makeUser();
    const caller = api(user, 'user');
    const token = newToken('http');

    const created = await caller('POST', '/devices', { fcmToken: token, platform: 'android', appVersion: '1.0.0' });
    check('-> 200 { ok: true, devices: 1 }', created.status === 200 && JSON.stringify(created.body) === JSON.stringify({ ok: true, devices: 1 }), created);
    const stored = (await devicesOf(User, user._id))[0];
    check('and it is on the caller', stored?.fcmToken === token && stored.platform === 'android' && stored.appVersion === '1.0.0', stored);

    const repeat = await caller('POST', '/devices', { fcmToken: token, platform: 'android' });
    check('again -> still devices: 1', repeat.status === 200 && repeat.body.devices === 1, repeat);
    const web = await caller('POST', '/devices', { fcmToken: newToken('web'), platform: 'web' });
    const ios = await caller('POST', '/devices', { fcmToken: newToken('ios'), platform: 'ios' });
    check('ios and web are accepted', web.status === 200 && ios.status === 200 && ios.body.devices === 3, { web, ios });
    const longest = await caller('POST', '/devices', { fcmToken: 't'.repeat(4096), platform: 'android' });
    check('a 4096-character token is accepted', longest.status === 200 && longest.body.devices === 4, longest.status);

    const refused = async (body, field) => {
      const res = await caller('POST', '/devices', body);
      return res.status === 422 && typeof res.body.fields?.[field] === 'string' ? true : res;
    };
    const is422 = async (label, body, field) => {
      const result = await refused(body, field);
      check(label, result === true, result);
    };
    await is422('no token -> 422', { platform: 'android' }, 'fcmToken');
    await is422('an empty token -> 422', { fcmToken: '', platform: 'android' }, 'fcmToken');
    await is422('a blank token -> 422', { fcmToken: '    ', platform: 'android' }, 'fcmToken');
    await is422('a token that is not a string -> 422', { fcmToken: 12345, platform: 'android' }, 'fcmToken');
    await is422('an object for a token -> 422', { fcmToken: { $ne: '' }, platform: 'android' }, 'fcmToken');
    await is422('a 4097-character token -> 422', { fcmToken: 't'.repeat(4097), platform: 'android' }, 'fcmToken');
    await is422('no platform -> 422', { fcmToken: newToken() }, 'platform');
    await is422('an unknown platform -> 422', { fcmToken: newToken(), platform: 'windows' }, 'platform');
    await is422('platform is case-sensitive -> 422', { fcmToken: newToken(), platform: 'Android' }, 'platform');
    await is422('an over-long appVersion -> 422', { fcmToken: newToken(), platform: 'android', appVersion: 'v'.repeat(41) }, 'appVersion');
    check('none of the refused calls stored anything', (await devicesOf(User, user._id)).length === 4);

    const anonymous = await api(null)('POST', '/devices', { fcmToken: newToken(), platform: 'android' });
    check('needs a signed-in caller -> 401', anonymous.status === 401, anonymous);
    const admin = await api({ _id: new mongoose.Types.ObjectId() }, 'admin')('POST', '/devices', { fcmToken: newToken(), platform: 'android' });
    check('not for admins -> 403', admin.status === 403, admin);

    const astrologer = await makeAstrologer();
    const moved = await api(astrologer, 'astrologer')('POST', '/devices', { fcmToken: token, platform: 'android' });
    check('an astrologer signing in on that phone takes the token over',
      moved.status === 200 && moved.body.devices === 1 && !(await tokensOf(User, user._id)).includes(token)
      && (await tokensOf(Astrologer, astrologer._id)).join() === token, moved);
  }

  section('over HTTP: DELETE /devices');
  {
    const user = await makeUser();
    const caller = api(user, 'user');
    const token = newToken('logout');
    const other = newToken('tablet');
    await caller('POST', '/devices', { fcmToken: token, platform: 'android' });
    await caller('POST', '/devices', { fcmToken: other, platform: 'android' });

    const removed = await caller('DELETE', '/devices', { fcmToken: token });
    check('-> 200 { ok: true }', removed.status === 200 && JSON.stringify(removed.body) === JSON.stringify({ ok: true }), removed);
    check('the token is gone, the other device stays', (await tokensOf(User, user._id)).join() === other);
    const again = await caller('DELETE', '/devices', { fcmToken: token });
    check('again -> 200 { ok: true } even though it was not there', again.status === 200 && again.body.ok === true, again);
    const never = await caller('DELETE', '/devices', { fcmToken: newToken('never') });
    check('a token never registered -> 200 too', never.status === 200 && never.body.ok === true, never);
    const empty = await caller('DELETE', '/devices', {});
    check('no token -> 422', empty.status === 422 && Boolean(empty.body.fields?.fcmToken), empty);
    const anonymous = await api(null)('DELETE', '/devices', { fcmToken: other });
    check('needs a signed-in caller -> 401', anonymous.status === 401 && (await tokensOf(User, user._id)).join() === other, anonymous);

    fcm.sent.length = 0;
    await caller('DELETE', '/devices', { fcmToken: other });
    await notificationService.notify({ ownerRole: 'user', ownerId: user._id, type: 'system', title: 'After logout', body: 'x' });
    await settle();
    check('after logout nothing is pushed to that phone', fcm.sent.length === 0, fcm.sent.length);
  }

  section('over HTTP: POST /devices/test');
  {
    const user = await makeUser();
    const caller = api(user, 'user');

    const none = await caller('POST', '/devices/test');
    check('no devices -> 200 { ok: true, devices: 0, push: [] }', none.status === 200 && JSON.stringify(none.body) === JSON.stringify({ ok: true, devices: 0, push: [] }), none);

    const good = newToken('good');
    const dead = newToken('dead');
    await caller('POST', '/devices', { fcmToken: good, platform: 'android' });
    await caller('POST', '/devices', { fcmToken: dead, platform: 'ios' });
    fcm.failures.set(dead, UNREGISTERED);
    fcm.sent.length = 0;
    const unreadBefore = (await User.findById(user._id)).unreadNotifications;

    const tested = await caller('POST', '/devices/test');
    check('-> 200 with exactly { ok, devices, push }', tested.status === 200 && Object.keys(tested.body).sort().join(',') === 'devices,ok,push' && tested.body.ok === true, tested);
    check('devices is how many were tried', tested.body.devices === 2, tested.body);
    check('push has one result per device, in order: sent, then invalid_token',
      JSON.stringify(tested.body.push) === JSON.stringify([{ sent: true }, { sent: false, reason: 'invalid_token' }]), tested.body.push);
    await settle();
    check('each device was pushed once, not twice', fcm.sent.length === 2, fcm.sent.length);
    const message = fcm.sent.find(s => s.message.token === good)?.message;
    check('"Test notification" / "Push notifications are working."',
      message?.notification.title === 'Test notification' && message.notification.body === 'Push notifications are working.', message?.notification);
    const row = await Notification.findOne({ owner: user._id }).sort({ createdAt: -1 });
    check('it is a real notification: stored, counted, and named in the push data',
      row?.title === 'Test notification' && row.ownerRole === 'user' && message?.data.notificationId === String(row._id)
      && message.data.type === 'system' && message.data.action === ''
      && (await User.findById(user._id)).unreadNotifications === unreadBefore + 1, { row, data: message?.data });
    check('the dead device was removed by the test itself', (await tokensOf(User, user._id)).join() === good);
    fcm.failures.clear();

    fcm.failures.set(good, () => fcmError('messaging/third-party-auth-error', 'APNs certificate missing'));
    const broken = await quiet(() => caller('POST', '/devices/test'));
    check('a provider failure is a 200 that says provider_error', broken.status === 200 && JSON.stringify(broken.body.push) === JSON.stringify([{ sent: false, reason: 'provider_error' }]), broken);
    fcm.failures.clear();

    clearFirebase();
    fcm.sent.length = 0;
    const unconfigured = await caller('POST', '/devices/test');
    check('Firebase not configured -> 200, push: [{ sent: false, reason: "not_configured" }]',
      unconfigured.status === 200 && unconfigured.body.devices === 1
      && JSON.stringify(unconfigured.body.push) === JSON.stringify([{ sent: false, reason: 'not_configured' }]) && fcm.sent.length === 0, unconfigured);
    useFirebase();

    await User.updateOne({ _id: user._id }, { $set: { 'notificationPrefs.push': false } });
    const muted = await caller('POST', '/devices/test');
    check('push switched off on the account -> push_disabled',
      muted.status === 200 && JSON.stringify(muted.body.push) === JSON.stringify([{ sent: false, reason: 'push_disabled' }]) && fcm.sent.length === 0, muted);

    const astrologer = await makeAstrologer();
    const astroCaller = api(astrologer, 'astrologer');
    const astroToken = newToken('astro-test');
    await astroCaller('POST', '/devices', { fcmToken: astroToken, platform: 'android' });
    fcm.sent.length = 0;
    const astroTest = await astroCaller('POST', '/devices/test');
    check('an astrologer gets the same answer, on their own device',
      astroTest.status === 200 && JSON.stringify(astroTest.body) === JSON.stringify({ ok: true, devices: 1, push: [{ sent: true }] })
      && fcm.sent.length === 1 && fcm.sent[0].message.token === astroToken
      && (await Notification.countDocuments({ owner: astrologer._id, ownerRole: 'astrologer' })) === 1, astroTest);

    const anonymous = await api(null)('POST', '/devices/test');
    check('needs a signed-in caller -> 401', anonymous.status === 401, anonymous);
    const admin = await api({ _id: new mongoose.Types.ObjectId() }, 'admin')('POST', '/devices/test');
    check('not for admins -> 403', admin.status === 403, admin);
  }

  section('nothing left for Firebase');
  {
    check('every message went through the stub, to the unit-test project', fcm.sent.every(s => s.config.projectId === PROJECT_ID));
    const accounts = [...(await User.find({}).select('devices')), ...(await Astrologer.find({}).select('devices'))];
    const all = accounts.flatMap(account => account.devices.map(device => device.fcmToken));
    check(`no token is on two accounts (${all.length} devices across ${accounts.length} accounts)`, new Set(all).size === all.length);
    check('no account holds more than 10', accounts.every(account => account.devices.length <= 10));
    check('no account holds the same token twice', accounts.every(account => new Set(account.devices.map(d => d.fcmToken)).size === account.devices.length));
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(error => {
  console.error('CRASHED:', error);
  process.exit(1);
});
