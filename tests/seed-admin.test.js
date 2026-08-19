/** The seed script: it makes the admin, and that admin can sign in. */
const DB = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_seed';
process.env.MONGODB_URI = DB;
process.env.NODE_ENV = 'development';
process.env.OTP_MASTER_CODE = '123456';

const path = require('path');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');
const { createApp } = require('../app');

const PORT = 5092;
let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};

const seed = () =>
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'seed-admin.js')], {
    env: { ...process.env, MONGODB_URI: DB },
    encoding: 'utf8',
  });

/**
 * Signs in, both steps.
 *
 * Two-factor is on by default, so the password only earns a code; the second
 * call is what returns a session.
 */
const login = async (email, password) => {
  const first = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await first.json();

  if (!body.requiresOtp) {
    return { status: first.status, body };
  }

  const second = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/admin/login/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    /**
     * A sign-in inside the previous code's cooldown reuses that code, which the
     * response cannot repeat — the master code covers it in development.
     */
    body: JSON.stringify({ email, code: body.devCode ?? '123456' }),
  });
  return { status: second.status, body: await second.json() };
};

(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  const server = createApp().listen(PORT);
  const Admin = require('../models/Admin');

  console.log('');
  seed();
  check('the admin is created', (await Admin.countDocuments()) === 1);

  const ok = await login('admin@shreeastro.com', 'admin@123');
  check('it can sign in', ok.status === 200, ok.body);
  check('it is a super admin', ok.body.admin?.role === 'super_admin');
  check('with every permission', ok.body.admin?.permissions?.includes('admins.manage'));

  const wrong = await login('admin@shreeastro.com', 'wrongpass');
  check('a wrong password is refused', wrong.status === 401);

  seed();
  check('running it again does not duplicate', (await Admin.countDocuments()) === 1);
  const again = await login('admin@shreeastro.com', 'admin@123');
  check('and it still signs in', again.status === 200, again.body);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e.message); process.exit(1); });
