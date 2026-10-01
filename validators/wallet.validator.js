/**
 * What the top-up endpoints added with the payment gateway accept.
 *
 * POST /wallet/topup itself keeps its service-side checks (the limits come
 * from live platform settings); this covers confirming and cancelling one,
 * following the same express-validator + `validate` pattern as the rest.
 *
 * The Razorpay values are only checked for being short strings here. Whether
 * they are *required*, and whether they are genuine, depends on the row and is
 * decided by services/wallet.service.js — a gateway-less top-up sends none of
 * them.
 */

const { body } = require('express-validator');

const { validate } = require('../middlewares/validate.middleware');

/** Razorpay's ids and its hex signature are all well under this. */
const gatewayValue = name =>
  body(name)
    .optional({ values: 'falsy' })
    .isString()
    .isLength({ max: 200 })
    .withMessage('Invalid payment details.');

/** POST /wallet/topup/confirm */
const confirmTopUp = [
  body('transactionId').isMongoId().withMessage('Unknown payment.'),
  gatewayValue('razorpayPaymentId'),
  gatewayValue('razorpayOrderId'),
  gatewayValue('razorpaySignature'),
  /** Razorpay's own spelling, as its checkout returns them. */
  gatewayValue('razorpay_payment_id'),
  gatewayValue('razorpay_order_id'),
  gatewayValue('razorpay_signature'),
  validate,
];

/** POST /wallet/topup/cancel */
const cancelTopUp = [
  body('transactionId').isMongoId().withMessage('Unknown payment.'),
  body('reason').optional({ values: 'falsy' }).isString().withMessage('Invalid reason.'),
  validate,
];

module.exports = { confirmTopUp, cancelTopUp };
