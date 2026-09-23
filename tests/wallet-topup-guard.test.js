/**
 * Wallet top-ups while there is no payment gateway.
 *
 * start + confirm credit a wallet with nothing in between checking that anyone
 * paid, which is how the app has always been walked through — and which in
 * production is free money, spendable on consultations that pay astrologers
 * real rupees. So in production it is closed unless ALLOW_UNVERIFIED_TOPUPS
 * opens it on purpose, and an admin can still credit a wallet by hand.
 *
 * `env.isProduction` is flipped directly here rather than by running this whole
 * file as production, so the check is exercised exactly as deployed while the
 * rest of the harness stays ordinary.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_wallet_guard';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');

const env = require('../config/env');
const walletService = require('../services/wallet.service');
const adminService = require('../services/admin.service');
const User = require('../models/User');
const Admin = require('../models/Admin');

let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);
const errorOf = async fn => {
  try { await fn(); return null; } catch (error) { return error; }
};
const balanceOf = async id => (await User.findById(id)).wallet.balance;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const seeker = await User.create({
    name: 'Seeker', email: 'wallet-guard@x.com', phone: { number: '9400000001' },
    wallet: { balance: 0 },
  });

  /* ------------------------------------------------------------ development */

  section('development is unchanged — the flow the app is built against still works');
  const started = await walletService.startTopUp({ userId: seeker._id, amount: 500 });
  check('a pending top-up is opened', Boolean(started.transactionId) && started.gateway === 'none', started);
  await walletService.confirmTopUp({ userId: seeker._id, transactionId: started.transactionId });
  check('confirming credits the wallet', (await balanceOf(seeker._id)) === 500);

  /* ------------------------------------------------------------- production */

  section('production, gateway-less: the self-serve path is closed');
  env.isProduction = true;
  env.allowUnverifiedTopUps = false;

  const startError = await errorOf(() => walletService.startTopUp({ userId: seeker._id, amount: 500 }));
  check('starting one is refused', startError?.status === 503, { status: startError?.status, code: startError?.code });
  check('with a reason the app can act on', startError?.code === 'payments_unavailable', startError?.code);
  check('and something a seeker can actually read', /recharge/i.test(startError?.message || ''), startError?.message);

  /** A row opened before the switch flipped must not become creditable afterwards. */
  env.isProduction = false;
  const stale = await walletService.startTopUp({ userId: seeker._id, amount: 9999 });
  env.isProduction = true;
  const confirmError = await errorOf(() =>
    walletService.confirmTopUp({ userId: seeker._id, transactionId: stale.transactionId }),
  );
  check('an already-pending row cannot be confirmed either', confirmError?.status === 503, confirmError?.status);
  check('nothing was credited', (await balanceOf(seeker._id)) === 500);

  section('an admin can still put money in, for payments collected another way');
  const admin = await Admin.create({
    name: 'Ops', email: 'ops-wallet@x.com', passwordHash: 'x', role: 'super_admin', status: 'active',
  });
  await adminService.adjustWallet({
    ownerRole: 'user', ownerId: seeker._id, direction: 'credit', amount: 300,
    reason: 'UPI collected offline', admin,
  });
  check('credited by hand', (await balanceOf(seeker._id)) === 800);

  section('production with ALLOW_UNVERIFIED_TOPUPS=true: open again, knowingly');
  env.allowUnverifiedTopUps = true;
  const allowed = await walletService.startTopUp({ userId: seeker._id, amount: 200 });
  await walletService.confirmTopUp({ userId: seeker._id, transactionId: allowed.transactionId });
  check('the flow works when it is explicitly opened', (await balanceOf(seeker._id)) === 1000);

  env.isProduction = false;
  env.allowUnverifiedTopUps = false;

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
