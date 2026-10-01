/**
 * /api/v1/payments — where the payment gateway calls in.
 *
 * Deliberately outside /wallet: nothing here carries an account token. The
 * caller is Razorpay, and what authenticates it is the signature over the raw
 * request body, which app.js keeps for exactly this path (`req.rawBody`).
 *
 * The URL to give Razorpay (Dashboard → Settings → Webhooks):
 *   <server>/api/v1/payments/razorpay/webhook
 * with the events payment.captured, order.paid and payment.failed.
 */

const express = require('express');

const paymentController = require('../controllers/payment.controller');

const router = express.Router();

router.post('/razorpay/webhook', paymentController.razorpayWebhook);

module.exports = router;
