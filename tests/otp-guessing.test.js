/**
 * How hard it is to guess a way in.
 *
 * OTP_MASTER_CODE is in use in production until MSG91 credentials land, which
 * means one six-digit value signs in as ANY account — so the two things that
 * keep that from being a few minutes' work are checked here: the per-destination
 * guess budget in services/otp.service.js, and the per-caller ceiling on the
 * sign-in endpoints (middlewares/rateLimit.middleware.js), over real HTTP.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_otp_guessing';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test-otp:';
process.env.NODE_ENV = 'development';
process.env.OTP_MASTER_CODE = '123456';

const http = require('http');
const mongoose = require('mongoose');

const { createApp } = require('../app');
const { redis, connectRedis, disconnectRedis } = require('../config/redis');
const otpService = require('../services/otp.service');
const { OTP_MAX_ATTEMPTS } = require('../config/constants');

let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

/** Everything this test wrote, so one run never inherits another's counters. */
const clearKeys = async () => {
  const keys = await redis.keys(`${process.env.REDIS_KEY_PREFIX}otp:*`);
  const bare = keys.map(k => k.slice(process.env.REDIS_KEY_PREFIX.length));
  if (bare.length) await redis.del(...bare);
  const limits = await redis.keys(`${process.env.REDIS_KEY_PREFIX}ratelimit:*`);
  const bareLimits = limits.map(k => k.slice(process.env.REDIS_KEY_PREFIX.length));
  if (bareLimits.length) await redis.del(...bareLimits);
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await connectRedis();
  await clearKeys();

  const server = http.createServer(createApp());
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A real account to aim at, so nothing here passes only because it doesn't exist. */
  const User = require('../models/User');
  await User.create({ name: 'Victim', email: 'victim@x.com', phone: { number: '9876500111' } });

  const verify = (destination, code) =>
    otpService.verifyOtp({ channel: 'phone', destination, code, purpose: 'login' });

  /* --------------------------------------------- the master code still works */

  section('the master code still signs in, as it must until delivery is configured');
  const master = await verify('9876500111', '123456');
  check('accepted for an account that never asked for a code', master.ok === true && master.usedMasterCode === true, master);

  /* ------------------------------------- guessing it against one destination */

  section('guessing the master code against one number is budgeted');
  await clearKeys();
  const target = '9876500222';
  const outcomes = [];
  for (let i = 0; i < otpService.MAX_GUESSES_PER_DESTINATION + 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    outcomes.push((await verify(target, '000000')).reason);
  }
  const budget = otpService.MAX_GUESSES_PER_DESTINATION;
  check(`the first ${budget} wrong guesses are simply wrong`,
    outcomes.slice(0, budget).every(r => r === 'not_requested'), outcomes.slice(0, budget));
  check('after that the destination is shut, not still guessable',
    outcomes.slice(budget).every(r => r === 'attempts_exceeded'), outcomes.slice(budget));

  section('a resend does not hand back a fresh budget');
  /** The way out of a lockout for a real code — it must not also be the way around this. */
  await otpService.sendOtp({ channel: 'phone', destination: target, purpose: 'login' });
  check('still shut after asking for a new code', (await verify(target, '000000')).reason === 'attempts_exceeded');

  section('the real code, and the master code, still work for everyone else');
  const other = '9876500333';
  const sent = await otpService.sendOtp({ channel: 'phone', destination: other, purpose: 'login' });
  check('one number being shut does not shut another', (await verify(other, sent.devCode)).ok === true);
  check('the master code is unaffected elsewhere too', (await verify('9876500444', '123456')).ok === true);

  section('signing in clears the budget');
  await clearKeys();
  const recovering = '9876500555';
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await verify(recovering, '000000');
  }
  const codeFor = await otpService.sendOtp({ channel: 'phone', destination: recovering, purpose: 'login' });
  check('the right code is accepted after a few typos', (await verify(recovering, codeFor.devCode)).ok === true);
  check('and the counter is gone, so the next session starts clean',
    (await redis.get(`otp:guesses:login:phone:${recovering}`)) === null);

  section('a real code is still burnt by its own attempt limit first');
  await clearKeys();
  const burning = '9876500666';
  const burnt = await otpService.sendOtp({ channel: 'phone', destination: burning, purpose: 'login' });
  const reasons = [];
  for (let i = 0; i < OTP_MAX_ATTEMPTS + 1; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    reasons.push((await verify(burning, '111111')).reason);
  }
  check(`${OTP_MAX_ATTEMPTS} wrong tries, then the code is spent`,
    reasons.filter(r => r === 'invalid').length === OTP_MAX_ATTEMPTS && reasons.at(-1) === 'attempts_exceeded', reasons);
  check('the right code no longer works either', (await verify(burning, burnt.devCode)).ok === false);

  /* --------------------------------------------------- the per-caller ceiling */

  section('over HTTP: one caller cannot keep trying forever');
  await clearKeys();
  /**
   * The per-caller ceiling is deliberately high — an IP address is a whole
   * mobile carrier's worth of real people — so this walks up to it rather than
   * assuming a small number.
   */
  const VERIFY_CEILING = 60;
  const REQUEST_CEILING = 30;
  const post = (path, body) =>
    fetch(`${base}/api/v1${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const statuses = [];
  for (let i = 0; i < VERIFY_CEILING + 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post('/auth/login/otp/verify', {
      role: 'user', channel: 'phone', phone: `9${String(100000000 + i)}`, code: '000000',
    });
    statuses.push(res.status);
    if (res.status === 429) {
      // eslint-disable-next-line no-await-in-loop
      const body = await res.json();
      check('the refusal says how long to wait', body.retryAfterSeconds > 0 && body.code === 'rate_limited', body);
      check('and it carries the standard header', Boolean(res.headers.get('retry-after')));
      break;
    }
  }
  check('trying a different number each time does not dodge the ceiling — the caller is the same',
    statuses.includes(429), statuses);
  check('and the tries before it were answered normally, not refused',
    statuses.filter(s => s === 429).length === 1 && statuses[0] !== 429, statuses);

  section('asking for codes is capped too, so nobody else\'s phone can be made to ring');
  await clearKeys();
  const requestStatuses = [];
  for (let i = 0; i < REQUEST_CEILING + 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post('/auth/login/otp/request', {
      role: 'user', channel: 'phone', phone: `9${String(200000000 + i)}`,
    });
    requestStatuses.push(res.status);
    if (res.status === 429) break;
  }
  check('the ceiling is reached', requestStatuses.includes(429), requestStatuses);
  check(`it took the whole ceiling to get there, not a couple of tries`,
    requestStatuses.indexOf(429) === REQUEST_CEILING, requestStatuses.indexOf(429));

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  await clearKeys();
  await mongoose.disconnect();
  await disconnectRedis();
  await new Promise(r => server.close(r));
  process.exit(fail === 0 ? 0 : 1);
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
