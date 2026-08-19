/**
 * /api/v1/wallet — money, for both apps.
 *
 * Reading is shared; topping up is a seeker's action and withdrawing is an
 * astrologer's, so those two are guarded by role.
 */

const express = require('express');

const walletController = require('../controllers/wallet.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authenticate, authorize('user', 'astrologer'));

router.get('/', walletController.getWallet);
router.get('/transactions', walletController.listTransactions);

/** Seekers add money. */
router.post('/topup', authorize('user'), walletController.startTopUp);
router.post('/topup/confirm', authorize('user'), walletController.confirmTopUp);

/** Astrologers take it out. */
router.get('/withdrawals', authorize('astrologer'), walletController.listWithdrawals);
router.post('/withdrawals', authorize('astrologer'), walletController.requestWithdrawal);

module.exports = router;
