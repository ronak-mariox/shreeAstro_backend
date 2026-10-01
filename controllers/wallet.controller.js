/**
 * Money over HTTP.
 *
 * The same three read endpoints serve both apps — the role on the token decides
 * whether "my wallet" means a seeker's balance or an astrologer's earnings.
 */

const walletService = require('../services/wallet.service');
const chatService = require('../services/chat.service');
const asyncHandler = require('../utils/asyncHandler');

/** GET /api/v1/wallet — balance and totals. */
const getWallet = asyncHandler(async (req, res) => {
  const { accountId, role } = req.account;

  if (role === 'astrologer') {
    return res.json({ earnings: await walletService.getAstrologerEarnings(accountId) });
  }
  return res.json({ wallet: await walletService.getUserWallet(accountId) });
});

/** GET /api/v1/wallet/transactions?filter=all|added|spent */
const listTransactions = asyncHandler(async (req, res) => {
  const result = await walletService.listTransactions({
    ownerRole: req.account.role,
    ownerId: req.account.accountId,
    filter: req.query.filter,
    page: req.query.page,
    limit: req.query.limit,
  });
  return res.json(result);
});

/**
 * POST /api/v1/wallet/topup — start adding money.
 *
 * With Razorpay configured the reply carries `gateway: 'razorpay'` and a
 * `razorpay` block the app opens the checkout with; without it,
 * `gateway: 'none'` and the app confirms straight away (development only).
 * See startTopUp in services/wallet.service.js.
 */
const startTopUp = asyncHandler(async (req, res) => {
  const order = await walletService.startTopUp({
    userId: req.account.accountId,
    amount: req.body.amount,
    /** Optional: a top-up coupon's worth is credited as a bonus once the payment confirms. */
    couponCode: req.body.couponCode,
  });
  return res.status(201).json(order);
});

/** What the apps are shown of a top-up row. */
const topUpView = transaction => ({
  id: String(transaction._id),
  reference: transaction.reference,
  amount: transaction.amount,
  balanceAfter: transaction.balanceAfter,
  status: transaction.status,
  method: transaction.payment?.method,
  couponCode: transaction.coupon?.code ?? null,
  bonusAmount: transaction.coupon?.bonusAmount || 0,
});

/**
 * POST /api/v1/wallet/topup/confirm — the payment came back successful.
 *
 * For a Razorpay top-up the body carries what the checkout handed the app.
 * Both spellings are read: ours (`razorpayPaymentId`, …) and Razorpay's own
 * (`razorpay_payment_id`, …), so an app can pass the checkout's result through
 * untouched.
 */
const confirmTopUp = asyncHandler(async (req, res) => {
  const { body } = req;
  const transaction = await walletService.confirmTopUp({
    userId: req.account.accountId,
    transactionId: body.transactionId,
    paymentId: body.paymentId,
    method: body.method,
    razorpayPaymentId: body.razorpayPaymentId ?? body.razorpay_payment_id,
    razorpayOrderId: body.razorpayOrderId ?? body.razorpay_order_id,
    razorpaySignature: body.razorpaySignature ?? body.razorpay_signature,
  });

  /** A top-up is also what wakes up any of this seeker's own chats paused for insufficient balance (chat.service.js's tickOneSession). */
  await chatService.resumePausedSessionsForUser(req.account.accountId);

  return res.json({ transaction: topUpView(transaction) });
});

/**
 * POST /api/v1/wallet/topup/cancel — the checkout was dismissed, or the
 * payment failed in it.
 *
 * Called best-effort by the apps on the way out of the checkout, so it always
 * answers 200: `cancelled` says whether this call closed a pending row, and
 * `transaction` is the row as it now stands (`null` when it is not this
 * seeker's or does not exist). A top-up that already succeeded is never
 * touched.
 */
const cancelTopUp = asyncHandler(async (req, res) => {
  const { transaction, cancelled } = await walletService.cancelTopUp({
    userId: req.account.accountId,
    transactionId: req.body.transactionId,
    reason: req.body.reason,
  });

  return res.json({
    ok: true,
    cancelled,
    transaction: transaction
      ? { ...topUpView(transaction), failureReason: transaction.payment?.failureReason ?? null }
      : null,
  });
});

/** POST /api/v1/wallet/withdrawals — an astrologer asks to be paid out. */
const requestWithdrawal = asyncHandler(async (req, res) => {
  const withdrawal = await walletService.requestWithdrawal({
    astrologerId: req.account.accountId,
    amount: req.body.amount,
    bankAccountId: req.body.bankAccountId,
  });

  return res.status(201).json({
    withdrawal: {
      id: String(withdrawal._id),
      reference: withdrawal.reference,
      amount: withdrawal.amount,
      status: withdrawal.status,
      requestedAt: withdrawal.requestedAt,
    },
  });
});

/** GET /api/v1/wallet/withdrawals — the astrologer's payout history. */
const listWithdrawals = asyncHandler(async (req, res) => {
  const result = await walletService.listWithdrawals({
    astrologerId: req.account.accountId,
    page: req.query.page,
    limit: req.query.limit,
  });
  return res.json(result);
});

module.exports = {
  getWallet,
  listTransactions,
  startTopUp,
  confirmTopUp,
  cancelTopUp,
  requestWithdrawal,
  listWithdrawals,
};
