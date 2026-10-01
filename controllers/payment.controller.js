/**
 * What the payment gateway tells us directly.
 *
 * Not called by the apps: Razorpay posts here itself when a payment is
 * captured or fails, which is what settles a top-up whose app never came back
 * to confirm it (killed mid-payment, no signal, checkout dismissed while the
 * UPI app was still open).
 */

const razorpayService = require('../services/razorpay.service');
const walletService = require('../services/wallet.service');
const chatService = require('../services/chat.service');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

/**
 * POST /api/v1/payments/razorpay/webhook
 *
 * No account token — the caller proves itself with `X-Razorpay-Signature`, an
 * HMAC of the raw body under the webhook secret. Nothing in the body is acted
 * on before that checks out.
 *
 * Answers 200 for everything genuine, including what it has no use for
 * (`ignored: true`): Razorpay retries anything else, and an event about an
 * order that is not ours does not get better on retry.
 */
const razorpayWebhook = asyncHandler(async (req, res) => {
  const { webhookSecret } = await razorpayService.getConfig();
  if (!webhookSecret) {
    throw new ApiError(503, 'The payment webhook is not configured.', undefined, 'webhook_unconfigured');
  }

  const signature = req.get('x-razorpay-signature');
  const genuine =
    Boolean(signature) &&
    Boolean(req.rawBody) &&
    (await razorpayService.verifyWebhookSignature(req.rawBody, signature));
  if (!genuine) {
    throw ApiError.badRequest('Invalid webhook signature.', undefined, 'webhook_signature_invalid');
  }

  const result = await walletService.applyRazorpayEvent(req.body);

  if (result.credited) {
    /**
     * Same as the confirm endpoint: new balance wakes up this seeker's chats
     * paused for insufficient balance. The money is already in the wallet, so
     * a hiccup here must not turn into a non-200 that makes Razorpay resend.
     */
    try {
      await chatService.resumePausedSessionsForUser(result.userId);
    } catch (error) {
      console.error('[razorpay] credited a top-up but could not resume paused sessions:', error);
    }
  }

  return res.json(result.ignored ? { ok: true, ignored: true } : { ok: true });
});

module.exports = { razorpayWebhook };
