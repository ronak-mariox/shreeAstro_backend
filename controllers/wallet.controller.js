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
 * No payment gateway is wired up yet, so this returns an order the app can
 * confirm straight away. See startTopUp in services/wallet.service.js.
 */
const startTopUp = asyncHandler(async (req, res) => {
  const order = await walletService.startTopUp({
    userId: req.account.accountId,
    amount: req.body.amount,
  });
  return res.status(201).json(order);
});

/** POST /api/v1/wallet/topup/confirm — the payment came back successful. */
const confirmTopUp = asyncHandler(async (req, res) => {
  const transaction = await walletService.confirmTopUp({
    userId: req.account.accountId,
    transactionId: req.body.transactionId,
    paymentId: req.body.paymentId,
    method: req.body.method,
  });

  /** A top-up is also what wakes up any of this seeker's own chats paused for insufficient balance (chat.service.js's tickOneSession). */
  await chatService.resumePausedSessionsForUser(req.account.accountId);

  return res.json({
    transaction: {
      id: String(transaction._id),
      reference: transaction.reference,
      amount: transaction.amount,
      balanceAfter: transaction.balanceAfter,
      status: transaction.status,
      method: transaction.payment?.method,
    },
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
  requestWithdrawal,
  listWithdrawals,
};
