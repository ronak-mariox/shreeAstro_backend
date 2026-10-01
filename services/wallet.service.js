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
const razorpayService = require('./razorpay.service');

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

/** What a seeker is told when no top-up can be taken at all. */
function paymentsUnavailable() {
  return new ApiError(
    503,
    'Online recharge is temporarily unavailable. Please contact support to add money.',
    undefined,
    'payments_unavailable',
  );
}

/**
 * Refuses a top-up that nothing would verify, where that matters.
 *
 * With no gateway behind it, start + confirm credit a wallet on the word of
 * whoever asked. In development that is the point. In production it is free
 * money — and it is spent on consultations that pay astrologers real rupees —
 * so it is closed there unless ALLOW_UNVERIFIED_TOPUPS explicitly opens it.
 *
 * Deliberately not a silent no-op: the seeker is told recharge is unavailable,
 * and an admin can still credit the wallet by hand for money collected another
 * way (POST /admin/wallets/adjust).
 */
function assertUnverifiedTopUpsAllowed() {
  if (env.isProduction && !env.allowUnverifiedTopUps) {
    throw paymentsUnavailable();
  }
}

/**
 * May a top-up be started at all, and through what?
 *
 * With Razorpay configured, always: the payment is verified before anything is
 * credited, so there is nothing to guard. Without it, the unverified rule
 * above decides. Hands back the gateway config it looked at, so the caller
 * acts on the same answer it was allowed by.
 */
async function assertTopUpsAllowed() {
  const gateway = await razorpayService.getConfig();
  if (!gateway.enabled) {
    assertUnverifiedTopUpsAllowed();
  }
  return gateway;
}

/** Why a top-up did not complete, kept short enough to sit in a ledger row. */
function failureReasonOf(value, fallback) {
  return String(value || fallback).trim().slice(0, 200) || fallback;
}

/** What Razorpay's checkout pre-fills — only what the account actually has. */
async function checkoutPrefillFor(userId) {
  const user = await User.findById(userId).select('name email phone');
  const prefill = {};
  if (user?.name) {
    prefill.name = user.name;
  }
  if (user?.phone?.number) {
    prefill.contact = `${user.phone.countryCode || ''}${user.phone.number}`;
  }
  if (user?.email) {
    prefill.email = user.email;
  }
  return prefill;
}

/**
 * Starts a top-up.
 *
 * Opens the row as `pending` — no money has moved — and, with Razorpay
 * configured, opens a Razorpay order for the same amount that the app's
 * checkout then pays against. The row remembers that order's id; it is how a
 * payment is later matched back to exactly this top-up, whether the news
 * arrives from the app (confirmTopUp) or from Razorpay itself (the webhook).
 *
 * Without Razorpay this is the old gateway-less flow: `gateway: 'none'`, and
 * the app confirms straight away (development only — see
 * assertUnverifiedTopUpsAllowed).
 */
async function startTopUp({ userId, amount, couponCode }) {
  const gateway = await assertTopUpsAllowed();

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
   * opened; redeemed when the money actually lands (settleTopUp).
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
    payment: gateway.enabled
      ? { gateway: 'razorpay' }
      : { gateway: 'none', orderId: `ORD-${Date.now()}` },
  });
  if (bonus) {
    transaction.coupon = bonus;
    await transaction.save();
  }

  const started = {
    transactionId: String(transaction._id),
    reference: transaction.reference,
    orderId: transaction.payment.orderId,
    /** Rupees. The paise Razorpay's checkout wants are under `razorpay.amount`. */
    amount: rupees,
    couponCode: bonus ? bonus.code : null,
    bonusAmount: bonus ? bonus.bonusAmount : 0,
  };

  if (!gateway.enabled) {
    /** No gateway — the app calls confirmTopUp straight away. */
    return { ...started, gateway: 'none' };
  }

  /** Razorpay counts in paise. */
  const amountPaise = rupees * 100;
  let order;
  try {
    order = await razorpayService.createOrder({
      amountPaise,
      /** Our own reference, so the order can be found from the Razorpay dashboard. */
      receipt: transaction.reference,
      notes: { transactionId: String(transaction._id), userId: String(userId) },
    });
    if (order.amount !== amountPaise) {
      throw new ApiError(502, 'The payment gateway opened an order for a different amount.', undefined, 'payment_gateway_error');
    }
  } catch (error) {
    /** Nothing can ever pay against this row now, so it must not sit there looking payable. */
    await WalletTransaction.updateOne(
      { _id: transaction._id, status: 'pending' },
      { $set: { status: 'failed', 'payment.failureReason': failureReasonOf(error.message, 'Could not open a payment order.') } },
    );
    throw error;
  }

  transaction.payment.orderId = order.id;
  await transaction.save();

  return {
    ...started,
    orderId: order.id,
    gateway: 'razorpay',
    /** Everything the app's checkout needs. The key id is public; the secret never leaves the server. */
    razorpay: {
      keyId: gateway.keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || 'INR',
      name: 'Shree Astro',
      description: 'Wallet top-up',
      prefill: await checkoutPrefillFor(userId),
    },
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
 * The one place a top-up turns into money in a wallet.
 *
 * Two things can report the same payment — the app's confirm and Razorpay's
 * webhook — and they can arrive together, in either order. So the row is
 * claimed with a single conditional update: whoever flips it to `success` is
 * the one that credits, and everyone after finds it already successful and
 * credits nothing. `credited` says which of the two this caller was.
 *
 * The claim, the wallet credit and the row's `balanceAfter` live in one
 * transaction, so a crash between them cannot leave a top-up marked paid that
 * never reached the wallet.
 *
 * `from` is which states may be claimed. A gateway-less row only from
 * `pending`. A Razorpay row from `failed` too — see RAZORPAY_SETTLEABLE.
 */
async function settleTopUp({ transactionId, from, paymentId, method }) {
  const set = { status: 'success' };
  if (paymentId) {
    set['payment.paymentId'] = paymentId;
  }
  if (method) {
    set['payment.method'] = method;
  }

  let credited = false;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      /** withTransaction re-runs this whole function when two claims collide; start each attempt clean. */
      credited = false;

      const claimed = await WalletTransaction.findOneAndUpdate(
        { _id: transactionId, type: 'topup', status: { $in: from } },
        { $set: set, $unset: { 'payment.failureReason': '' } },
        { session, returnDocument: 'after' },
      );
      if (!claimed) {
        return;
      }

      const user = await User.findOneAndUpdate(
        { _id: claimed.owner },
        {
          $inc: { 'wallet.balance': claimed.amount, 'wallet.totalAdded': claimed.amount },
          $set: { 'wallet.lastTransactionAt': new Date() },
        },
        { session, returnDocument: 'after' },
      );
      if (!user) {
        /** Aborts the claim with it — a payment for an account that is gone stays unsettled for a person to look at. */
        throw ApiError.notFound('Account not found.');
      }

      await WalletTransaction.updateOne(
        { _id: claimed._id },
        { $set: { balanceAfter: user.wallet.balance } },
        { session },
      );
      credited = true;
    });
  } finally {
    await session.endSession();
  }

  const transaction = await WalletTransaction.findById(transactionId);
  if (credited) {
    await creditTopUpBonus(transaction);
  }
  return { transaction, credited };
}

/**
 * A Razorpay top-up can still be settled after it was marked `failed`.
 *
 * `failed` only ever means "we were told it did not go through" — the seeker
 * closed the checkout (cancelTopUp), or one attempt was declined
 * (`payment.failed`). Neither is the last word: a UPI request approved a few
 * seconds after the checkout was dismissed, or a second attempt on the same
 * order after a declined card, is money actually taken. When Razorpay then
 * proves a captured payment for this order, the wallet is owed it.
 *
 * `success` is final either way — that is what keeps it exactly-once.
 */
const RAZORPAY_SETTLEABLE = ['pending', 'failed'];

function signatureInvalid(fields) {
  return ApiError.badRequest('That payment could not be verified.', fields, 'payment_signature_invalid');
}

function notCaptured() {
  return ApiError.badRequest(
    'That payment has not gone through. If money was deducted, it will reach your wallet shortly or be refunded by your bank.',
    undefined,
    'payment_not_captured',
  );
}

/**
 * Finishes a Razorpay top-up on the app's say-so — which is worth nothing by
 * itself, so every claim it makes is checked:
 *
 *   1. the order id is this row's own (a signature for someone else's order,
 *      or for a cheaper one, is a valid signature for the wrong thing);
 *   2. the signature is Razorpay's, over exactly that order and payment;
 *   3. Razorpay itself, asked directly, says the payment is for this order,
 *      for the full amount, and captured — i.e. the money was really taken.
 */
async function confirmRazorpayTopUp(transaction, { razorpayPaymentId, razorpayOrderId, razorpaySignature }) {
  /** Already done (this app, another tab, or the webhook got here first) — say so rather than crediting twice. */
  if (transaction.status === 'success') {
    return transaction;
  }
  if (!RAZORPAY_SETTLEABLE.includes(transaction.status)) {
    throw ApiError.badRequest('That payment cannot be completed.');
  }

  /** Keys removed since the order was opened: nothing can be verified, so nothing is credited. */
  const gateway = await razorpayService.getConfig();
  if (!gateway.enabled) {
    throw paymentsUnavailable();
  }

  const missing = {};
  if (!razorpayPaymentId) missing.razorpayPaymentId = 'Required.';
  if (!razorpayOrderId) missing.razorpayOrderId = 'Required.';
  if (!razorpaySignature) missing.razorpaySignature = 'Required.';
  if (Object.keys(missing).length) {
    throw signatureInvalid(missing);
  }

  const orderId = transaction.payment.orderId;
  if (!orderId || razorpayOrderId !== orderId) {
    throw signatureInvalid();
  }
  const genuine = await razorpayService.verifyPaymentSignature({
    orderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature,
  });
  if (!genuine) {
    throw signatureInvalid();
  }

  const amountPaise = transaction.amount * 100;
  let payment = await razorpayService.fetchPayment(razorpayPaymentId);
  if (payment?.order_id !== orderId || payment.amount !== amountPaise || (payment.currency || 'INR') !== 'INR') {
    throw notCaptured();
  }

  if (payment.status === 'authorized') {
    try {
      payment = await razorpayService.capturePayment(razorpayPaymentId, { amountPaise, currency: 'INR' });
    } catch (error) {
      /** Razorpay's own auto-capture can win this by a moment and refuse ours; what matters is where the payment ended up. */
      payment = await razorpayService.fetchPayment(razorpayPaymentId);
    }
  }
  if (payment?.status !== 'captured') {
    throw notCaptured();
  }

  const { transaction: settled } = await settleTopUp({
    transactionId: transaction._id,
    from: RAZORPAY_SETTLEABLE,
    paymentId: razorpayPaymentId,
    /** Razorpay's own word for how it was paid: upi, card, netbanking, wallet. */
    method: payment.method,
  });
  return settled;
}

/**
 * Finishes a top-up: marks the row successful and credits the wallet.
 *
 * A Razorpay row is credited only on a verified payment (confirmRazorpayTopUp).
 * A gateway-less row is credited on the caller's word, which is why that path
 * is only open where assertUnverifiedTopUpsAllowed lets it be — and stays
 * closed in production even with Razorpay configured, so an old unverified row
 * can never be cashed in later.
 */
async function confirmTopUp({
  userId,
  transactionId,
  paymentId,
  method,
  razorpayPaymentId,
  razorpayOrderId,
  razorpaySignature,
}) {
  const transaction = await WalletTransaction.findOne({
    _id: transactionId,
    owner: userId,
    type: 'topup',
  });

  if (!transaction) {
    throw ApiError.notFound('That payment was not found.');
  }

  if (transaction.payment?.gateway === 'razorpay') {
    return confirmRazorpayTopUp(transaction, { razorpayPaymentId, razorpayOrderId, razorpaySignature });
  }

  /** Again here, not only in startTopUp: a row opened earlier must not become creditable later. */
  assertUnverifiedTopUpsAllowed();

  /** Already done — say so rather than crediting the wallet twice. */
  if (transaction.status === 'success') {
    return transaction;
  }
  if (transaction.status !== 'pending') {
    throw ApiError.badRequest('That payment cannot be completed.');
  }

  /** `method` is cosmetic here (no gateway to report one back), but the app already asks. */
  const { transaction: settled } = await settleTopUp({
    transactionId: transaction._id,
    from: ['pending'],
    paymentId,
    method,
  });
  if (settled.status !== 'success') {
    throw ApiError.badRequest('That payment cannot be completed.');
  }
  return settled;
}

/**
 * The seeker backed out, or the payment failed in the checkout.
 *
 * Marks a `pending` row `failed` with the reason, so it stops looking like a
 * payment in progress. Safe to call any number of times and for anything: a
 * row that is already final is handed back untouched — above all a `success`
 * one — and a row that is not this seeker's is simply not found (`null`). The
 * apps call this best-effort on the way out of the checkout, so it does not
 * raise.
 *
 * `failed` here is not final for a Razorpay row — see RAZORPAY_SETTLEABLE.
 *
 * @returns {Promise<{ transaction: object|null, cancelled: boolean }>}
 */
async function cancelTopUp({ userId, transactionId, reason }) {
  const own = { _id: transactionId, owner: userId, type: 'topup' };

  const cancelled = await WalletTransaction.findOneAndUpdate(
    { ...own, status: 'pending' },
    { $set: { status: 'failed', 'payment.failureReason': failureReasonOf(reason, 'Payment cancelled.') } },
    { returnDocument: 'after' },
  );
  if (cancelled) {
    return { transaction: cancelled, cancelled: true };
  }
  return { transaction: await WalletTransaction.findOne(own), cancelled: false };
}

/** The Razorpay webhook events that say something about a top-up. */
const RAZORPAY_PAID_EVENTS = ['payment.captured', 'order.paid'];
const RAZORPAY_FAILED_EVENT = 'payment.failed';

/**
 * Acts on one (already signature-verified) Razorpay webhook event.
 *
 * This is the path that does not depend on the seeker's phone: the app can be
 * killed mid-payment, lose its connection, or have its checkout dismissed
 * while the UPI app is still open — Razorpay still tells the server what
 * happened to the money.
 *
 *   payment.captured / order.paid  the top-up for that order is credited,
 *                                  through the same exactly-once path as the
 *                                  app's confirm;
 *   payment.failed                 a pending top-up is marked failed.
 *
 * Anything else — an event not listed, an order that is not one of ours, an
 * amount that is not the row's — is `ignored`, never an error: Razorpay
 * retries whatever is not answered 200, and none of those get better on retry.
 *
 * @returns {Promise<{ ignored: boolean, credited?: boolean, userId?: string, status?: string, reason?: string }>}
 */
async function applyRazorpayEvent(event) {
  const name = event?.event;
  const payment = event?.payload?.payment?.entity;
  const order = event?.payload?.order?.entity;
  const orderId = payment?.order_id || order?.id;

  const isPaid = RAZORPAY_PAID_EVENTS.includes(name);
  if ((!isPaid && name !== RAZORPAY_FAILED_EVENT) || typeof orderId !== 'string' || !orderId) {
    return { ignored: true, reason: 'not_relevant' };
  }

  const transaction = await WalletTransaction.findOne({
    type: 'topup',
    ownerRole: 'user',
    'payment.gateway': 'razorpay',
    'payment.orderId': orderId,
  });
  if (!transaction) {
    return { ignored: true, reason: 'unknown_order' };
  }

  if (!isPaid) {
    /** Only a row still waiting: one that was paid, or already closed with its own reason, is left as it is. */
    const failed = await WalletTransaction.findOneAndUpdate(
      { _id: transaction._id, status: 'pending' },
      {
        $set: {
          status: 'failed',
          'payment.failureReason': failureReasonOf(
            payment?.error_description || payment?.error_reason,
            'Payment failed.',
          ),
        },
      },
      { returnDocument: 'after' },
    );
    return { ignored: false, credited: false, status: (failed || transaction).status };
  }

  const paidPaise = payment ? payment.amount : order?.amount_paid;
  const currency = payment?.currency || order?.currency || 'INR';
  if (paidPaise !== transaction.amount * 100 || currency !== 'INR') {
    console.warn(
      `[razorpay] ${name} for ${orderId} does not match top-up ${transaction.reference} ` +
        `(paid ${paidPaise} paise ${currency}, expected ${transaction.amount * 100} paise INR) — not credited.`,
    );
    return { ignored: true, reason: 'amount_mismatch' };
  }
  /** `order.paid` and `payment.captured` both carry a captured payment; anything else is not money taken yet. */
  if (payment?.status && payment.status !== 'captured') {
    return { ignored: true, reason: 'not_captured' };
  }

  const { transaction: settled, credited } = await settleTopUp({
    transactionId: transaction._id,
    from: RAZORPAY_SETTLEABLE,
    paymentId: payment?.id,
    method: payment?.method,
  });
  return { ignored: false, credited, userId: String(transaction.owner), status: settled.status };
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
  cancelTopUp,
  applyRazorpayEvent,
  MIN_TOPUP,
  MAX_TOPUP,
  MIN_WITHDRAWAL,
};
