/**
 * Money.
 *
 * Every rupee that moves goes through `post()` below. Nothing anywhere else
 * writes `User.wallet.balance` or `Astrologer.earnings.balance` directly —
 * those are running totals, and `post()` is what keeps them true.
 *
 * Why it matters: if two places could change a balance, they would eventually
 * disagree with the list of transactions, and there would be no way to tell
 * which one was right. One write path means the rows always add up.
 */

const mongoose = require('mongoose');
const env = require('../config/env');
const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const AstrologerProfile = require('../models/AstrologerProfile');
const WalletTransaction = require('../models/WalletTransaction');
const Withdrawal = require('../models/Withdrawal');
const ApiError = require('../utils/ApiError');
const { istDateString, startOfIstDay } = require('../utils/istDate');
const settingsService = require('./settings.service');
const notificationService = require('./notification.service');

/**
 * Fallbacks only.
 *
 * The live limits come from the platform settings an admin edits in the panel
 * (models/Settings.js). These are what is used if settings cannot be read.
 */
const MIN_TOPUP = 10;
const MAX_TOPUP = 100000;
const MIN_WITHDRAWAL = 100;

/**
 * Records one movement and updates the running balance.
 *
 * `$inc` is used rather than reading the balance and writing it back, so two
 * transactions landing at the same moment cannot overwrite each other — Mongo
 * applies both increments.
 *
 * A debit is refused when it would take the balance below zero.
 */
async function post({
  ownerRole,
  ownerId,
  direction,
  type,
  amount,
  title,
  description,
  chatSession,
  order,
  pujaBooking,
  payment,
  createdByAdmin,
  status = 'success',
  /**
   * Only ever passed by a caller that needs this write to live or die with
   * others in one atomic unit — see services/chat.service.js's billOneMinute,
   * which debits the seeker, credits the astrologer and moves the session
   * forward all inside one Mongo transaction. Every other call site omits
   * this and gets its usual single-document atomicity from the `findOneAndUpdate`
   * filter guard below, same as always.
   */
  session,
}) {
  const rupees = Math.round(Number(amount));
  if (!Number.isFinite(rupees) || rupees <= 0) {
    throw ApiError.badRequest('Enter a valid amount.');
  }

  const isUser = ownerRole === 'user';
  const Model = isUser ? User : Astrologer;
  const balancePath = isUser ? 'wallet.balance' : 'earnings.balance';

  /**
   * The filter is the guard: for a debit it also requires the balance to be
   * large enough, so a wallet cannot go negative even if two debits race.
   */
  const filter = { _id: ownerId };
  if (direction === 'debit' && status === 'success') {
    filter[balancePath] = { $gte: rupees };
  }

  const change = direction === 'credit' ? rupees : -rupees;
  const update = { $inc: {}, $set: {} };

  /** A pending row (an unpaid top-up) moves no money yet. */
  if (status === 'success') {
    update.$inc[balancePath] = change;

    if (isUser) {
      update.$inc[direction === 'credit' ? 'wallet.totalAdded' : 'wallet.totalSpent'] = rupees;
      update.$set['wallet.lastTransactionAt'] = new Date();
    } else if (direction === 'credit') {
      /**
       * `today` and `thisMonth` are not kept here — there is no midnight or
       * month-boundary job to reset a counter, so one that only ever grew
       * would drift into meaninglessness. They're computed live instead, see
       * `getAstrologerEarnings` below. `lifetime` has no such boundary, so it
       * stays a running total.
       */
      update.$inc['earnings.lifetime'] = rupees;
    }
  }

  const account = await Model.findOneAndUpdate(filter, update, { session, returnDocument: 'after' });

  if (!account) {
    /** Either there is no such account, or the balance guard refused. */
    const existsQuery = Model.exists({ _id: ownerId });
    if (session) existsQuery.session(session);
    const exists = await existsQuery;
    throw exists
      ? ApiError.badRequest('Not enough balance.', undefined)
      : ApiError.notFound('Account not found.');
  }

  const balanceAfter = isUser ? account.wallet.balance : account.earnings.balance;

  const [transaction] = await WalletTransaction.create(
    [
      {
        ownerRole,
        owner: ownerId,
        direction,
        type,
        status,
        amount: rupees,
        balanceAfter,
        title,
        description,
        chatSession,
        order,
        pujaBooking,
        payment,
        createdByAdmin,
      },
    ],
    { session },
  );
  return transaction;
}

/** What a seeker's wallet header shows. */
async function getUserWallet(userId) {
  const user = await User.findById(userId).select('wallet');
  if (!user) {
    throw ApiError.notFound('Account not found.');
  }
  return user.wallet;
}

/**
 * IST midnight today, and the 1st of this IST month at IST midnight — not the
 * server process's own local midnight, which would put "today" on the wrong
 * side of the boundary for hours at a time on a server not itself running in
 * IST (most cloud hosts default to UTC).
 */
function periodStarts() {
  const today = istDateString();
  const startOfToday = startOfIstDay(today);
  const startOfMonth = startOfIstDay(`${today.slice(0, 7)}-01`);

  return { startOfToday, startOfMonth };
}

/**
 * Sum of an astrologer's successful credits since `since`.
 *
 * `astrologerId` arrives as a plain string here — every access token encodes
 * `sub` as `String(accountId)` (see utils/token.js), so `req.account.accountId`
 * is never a real ObjectId. `Model.find()` casts a string id automatically,
 * but an aggregation `$match` does not — it compares the raw BSON types, and a
 * string is never `===` an ObjectId, so this silently matched nothing at all
 * (not even the wrong rows — zero rows) until cast explicitly here.
 */
async function sumCreditsSince(astrologerId, since) {
  const [row] = await WalletTransaction.aggregate([
    {
      $match: {
        owner: new mongoose.Types.ObjectId(astrologerId),
        ownerRole: 'astrologer',
        direction: 'credit',
        status: 'success',
        createdAt: { $gte: since },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row?.total || 0;
}

/**
 * What an astrologer's wallet header shows.
 *
 * `today` and `thisMonth` are summed from the ledger on every read rather than
 * stored as running counters, so they can't drift into always equalling
 * `lifetime` — see `post()`'s comment above.
 */
async function getAstrologerEarnings(astrologerId) {
  const astrologer = await Astrologer.findById(astrologerId).select('earnings');
  if (!astrologer) {
    throw ApiError.notFound('Account not found.');
  }

  const { startOfToday, startOfMonth } = periodStarts();
  const [today, thisMonth] = await Promise.all([
    sumCreditsSince(astrologerId, startOfToday),
    sumCreditsSince(astrologerId, startOfMonth),
  ]);

  const earnings = astrologer.earnings.toObject();
  /** What can still be requested: the balance less what is already reserved by pending withdrawal requests. */
  const available = Math.max(0, (earnings.balance || 0) - (earnings.pendingWithdrawal || 0));
  return { ...earnings, available, today, thisMonth };
}

/**
 * The ledger, newest first.
 *
 * `filter` is what the app's tabs send: 'all', 'added' (credits) or
 * 'spent' (debits).
 */
async function listTransactions({ ownerRole, ownerId, filter = 'all', page = 1, limit = 20 }) {
  const query = { ownerRole, owner: ownerId };

  if (filter === 'added') {
    query.direction = 'credit';
  } else if (filter === 'spent') {
    query.direction = 'debit';
  }

  const skip = (Math.max(Number(page), 1) - 1) * limit;

  const [items, total] = await Promise.all([
    WalletTransaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    WalletTransaction.countDocuments(query),
  ]);

  return { items, total, page: Number(page), limit };
}

/**
 * Refuses a top-up that nothing would verify, where that matters.
 *
 * With no gateway wired up, start + confirm credit a wallet on the word of
 * whoever asked. In development that is the point. In production it is free
 * money — and it is spent on consultations that pay astrologers real rupees —
 * so it is closed there unless ALLOW_UNVERIFIED_TOPUPS explicitly opens it.
 *
 * Deliberately not a silent no-op: the seeker is told recharge is unavailable,
 * and an admin can still credit the wallet by hand for money collected another
 * way (POST /admin/wallets/adjust). Delete this when a gateway verifies a
 * payment between the two calls.
 */
function assertTopUpsAllowed() {
  if (env.isProduction && !env.allowUnverifiedTopUps) {
    throw new ApiError(
      503,
      'Online recharge is temporarily unavailable. Please contact support to add money.',
      undefined,
      'payments_unavailable',
    );
  }
}

/**
 * Starts a top-up.
 *
 * There is no payment gateway wired up yet, so this creates the row as
 * `pending` and hands back an order the app can "pay". When Razorpay (or
 * whichever) lands, create the gateway order here and return its id.
 */
async function startTopUp({ userId, amount, couponCode }) {
  assertTopUpsAllowed();

  const rupees = Math.round(Number(amount));
  const settings = await settingsService.get();
  const min = settings.minRecharge ?? MIN_TOPUP;
  const max = settings.maxRecharge ?? MAX_TOPUP;

  if (!Number.isFinite(rupees) || rupees < min) {
    throw ApiError.badRequest(`Minimum top-up is ₹${min}.`, { amount: 'Too small.' });
  }
  if (rupees > max) {
    throw ApiError.badRequest(`Maximum top-up is ₹${max.toLocaleString('en-IN')}.`, {
      amount: 'Too large.',
    });
  }

  /**
   * A coupon on a top-up is a bonus, not a discount: the seeker pays the full
   * amount and the coupon's worth is credited on top once the payment is
   * confirmed. Checked here so a bad code is refused before anything is
   * opened; redeemed in confirmTopUp, when the money actually lands.
   */
  let bonus = null;
  if (couponCode) {
    const couponService = require('./coupon.service');
    const { coupon, discount } = await couponService.validate({
      code: couponCode,
      context: 'topup',
      amount: rupees,
      userId,
    });
    bonus = { code: coupon.code, coupon: coupon._id, bonusAmount: discount };
  }

  const transaction = await post({
    ownerRole: 'user',
    ownerId: userId,
    direction: 'credit',
    type: 'topup',
    amount: rupees,
    status: 'pending',
    title: 'Money added to wallet',
    payment: { gateway: 'none', orderId: `ORD-${Date.now()}` },
  });
  if (bonus) {
    transaction.coupon = bonus;
    await transaction.save();
  }

  return {
    transactionId: String(transaction._id),
    reference: transaction.reference,
    orderId: transaction.payment.orderId,
    amount: rupees,
    couponCode: bonus ? bonus.code : null,
    bonusAmount: bonus ? bonus.bonusAmount : 0,
    /** No gateway yet — the app calls confirmTopUp straight away. */
    gateway: 'none',
  };
}

/**
 * The coupon bonus promised at startTopUp, paid now that the top-up is real.
 *
 * Re-validated here (the coupon may have been paused, or the seeker may have
 * used it on another top-up in between) and redeemed against this
 * transaction; the redemption's unique index means a confirm that somehow
 * runs twice pays once. A refused coupon silently pays no bonus — the
 * top-up itself already succeeded and must stay that way.
 */
async function creditTopUpBonus(transaction) {
  const promised = transaction.coupon;
  if (!promised?.coupon || !promised.bonusAmount || promised.bonusTransaction) {
    return null;
  }
  const couponService = require('./coupon.service');
  try {
    const { coupon, discount } = await couponService.validate({
      code: promised.code,
      context: 'topup',
      amount: transaction.amount,
      userId: transaction.owner,
    });
    await couponService.redeem({
      coupon,
      userId: transaction.owner,
      context: 'topup',
      reference: transaction._id,
      amountBefore: transaction.amount,
      discount,
    });
    const bonus = await post({
      ownerRole: 'user',
      ownerId: transaction.owner,
      direction: 'credit',
      type: 'bonus',
      amount: discount,
      title: `Coupon ${coupon.code} bonus`,
      description: `Bonus on a ₹${transaction.amount} top-up`,
    });
    transaction.coupon.bonusAmount = discount;
    transaction.coupon.bonusTransaction = bonus._id;
    await transaction.save();
    return bonus;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'coupon_invalid') {
      transaction.coupon.bonusAmount = 0;
      await transaction.save();
      return null;
    }
    throw error;
  }
}

/**
 * Finishes a top-up: marks the pending row successful and credits the wallet.
 *
 * When a real gateway is added, verify its signature before calling this.
 */
async function confirmTopUp({ userId, transactionId, paymentId, method }) {
  /** Again here, not only in startTopUp: a row opened earlier must not become creditable later. */
  assertTopUpsAllowed();

  const transaction = await WalletTransaction.findOne({
    _id: transactionId,
    owner: userId,
    type: 'topup',
  });

  if (!transaction) {
    throw ApiError.notFound('That payment was not found.');
  }
  /** Already done — say so rather than crediting the wallet twice. */
  if (transaction.status === 'success') {
    return transaction;
  }
  if (transaction.status !== 'pending') {
    throw ApiError.badRequest('That payment cannot be completed.');
  }

  const user = await User.findByIdAndUpdate(
    userId,
    {
      $inc: {
        'wallet.balance': transaction.amount,
        'wallet.totalAdded': transaction.amount,
      },
      $set: { 'wallet.lastTransactionAt': new Date() },
    },
    { returnDocument: 'after' },
  );

  transaction.status = 'success';
  transaction.balanceAfter = user.wallet.balance;
  if (paymentId) {
    transaction.payment.paymentId = paymentId;
  }
  /** Cosmetic today (no gateway to report a method back), but the app already asks. */
  if (method) {
    transaction.payment.method = method;
  }
  await transaction.save();

  await creditTopUpBonus(transaction);

  return transaction;
}

/* -------------------------------------------------------------------------- */
/* Withdrawals (astro_app)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * An astrologer asks to be paid out.
 *
 * Nothing leaves `earnings.balance` here: the amount is only reserved in
 * `earnings.pendingWithdrawal` until an admin approves (the balance is
 * deducted then — see admin.service.js's reviewWithdrawal) or rejects (the
 * reservation is simply released). The reservation still stops the same
 * money being requested twice: a request must fit inside
 * `balance − pendingWithdrawal`.
 */
async function requestWithdrawal({ astrologerId, amount, bankAccountId }) {
  const rupees = Math.round(Number(amount));
  const settings = await settingsService.get();
  const min = settings.minPayout ?? MIN_WITHDRAWAL;

  if (!Number.isFinite(rupees) || rupees < min) {
    throw ApiError.badRequest(`Minimum withdrawal is ₹${min}.`, {
      amount: 'Too small.',
    });
  }

  const profile = await AstrologerProfile.findOne({ astrologer: astrologerId });
  const account = bankAccountId
    ? profile?.bankAccounts.id(bankAccountId)
    : profile?.bankAccounts.find(entry => entry.isPrimary);

  if (!account) {
    throw ApiError.badRequest('Add a bank account before withdrawing.');
  }
  if (account.status !== 'approved') {
    throw ApiError.badRequest('That bank account is still being verified.');
  }

  /**
   * The availability check is in the filter, so two requests sent at the same
   * moment cannot both pass — the second one finds the reservation already
   * grown. `balance` itself is not touched.
   */
  const astrologer = await Astrologer.findOneAndUpdate(
    {
      _id: astrologerId,
      $expr: {
        $gte: [
          { $subtract: ['$earnings.balance', { $ifNull: ['$earnings.pendingWithdrawal', 0] }] },
          rupees,
        ],
      },
    },
    { $inc: { 'earnings.pendingWithdrawal': rupees } },
    { returnDocument: 'after' },
  );

  if (!astrologer) {
    throw ApiError.badRequest('Not enough balance to withdraw that much.');
  }

  const withdrawal = await Withdrawal.create({
    astrologer: astrologerId,
    amount: rupees,
    deduction: 'on_approval',
    bankAccount: {
      holderName: account.holderName,
      bankName: account.bankName,
      accountNumber: account.accountNumber,
      ifsc: account.ifsc,
      upiId: account.upiId,
    },
  });

  await notificationService.notifyAdmins({
    type: 'withdrawal',
    title: 'Withdrawal requested',
    body: `${astrologer.name} requested a withdrawal of ₹${rupees}.`,
    /** The panel reviews payouts on Wallets → Payout requests. */
    action: { screen: 'wallets', id: String(astrologerId) },
  });

  await notificationService.notify({
    ownerRole: 'astrologer',
    ownerId: astrologerId,
    type: 'withdrawal',
    title: 'Withdrawal request received',
    body: `Your request for ₹${rupees} is awaiting approval — please allow up to 24 hours. Your balance is deducted only once it is approved.`,
  });

  return withdrawal;
}

/** The astrologer's own payout history. */
async function listWithdrawals({ astrologerId, page = 1, limit = 20 }) {
  const skip = (Math.max(Number(page), 1) - 1) * limit;

  const [items, total] = await Promise.all([
    Withdrawal.find({ astrologer: astrologerId })
      .sort({ requestedAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Withdrawal.countDocuments({ astrologer: astrologerId }),
  ]);

  return { items, total, page: Number(page), limit: Number(limit) };
}

module.exports = {
  post,
  requestWithdrawal,
  listWithdrawals,
  getUserWallet,
  getAstrologerEarnings,
  listTransactions,
  startTopUp,
  confirmTopUp,
  MIN_TOPUP,
  MAX_TOPUP,
  MIN_WITHDRAWAL,
};
