/**
 * /api/v1/internal — jobs driven from outside the process.
 *
 * Nothing here belongs to a user, and no account token opens it: the caller is
 * a scheduler, and it proves itself with INTERNAL_API_KEY.
 *
 * It exists for hosts that cannot hold a timer. index.js starts the billing
 * sweep on a 10s `setInterval` and these endpoints are then redundant — but
 * the Vercel serverless entry (api/index.js) has no such process, so without
 * something calling in, an active consultation is billed its opening minute
 * and never again, and a package session never reaches its own end (no
 * warning, no "how do you want to continue?", no settle). That is real money
 * and a running clock, so it must not depend on where this happens to be
 * deployed.
 *
 * Point a cron (Vercel Cron, cron-job.org, a GitHub Action...) at
 * POST /api/v1/internal/billing/sweep as often as the scheduler allows. The
 * sweep is safe to call at any interval and from more than one caller at once:
 * every charge is written through the ChatBillingTick ledger, whose unique
 * (chatSession, minuteNumber) index means a minute already billed cannot be
 * billed twice. Coarser than 10s only means a session's minute is recognised
 * late, never skipped or doubled.
 */

const crypto = require('crypto');
const express = require('express');

const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { runChatBillingSweep } = require('../jobs/chatBilling.job');

const router = express.Router();

/**
 * Compares without leaking, through timing, how much of the key was right.
 * Lengths differing is itself a mismatch, and `timingSafeEqual` throws on
 * unequal buffers, so that case is answered before it gets there.
 */
function keyMatches(presented) {
  const expected = Buffer.from(env.internalApiKey);
  const given = Buffer.from(String(presented || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/**
 * No key configured means these endpoints are switched off, not open — a
 * deployment that never set one should not be one wrong guess from having its
 * jobs driven by strangers. Answered as "not found" so an unconfigured server
 * gives nothing away about what would be here.
 */
function requireInternalKey(req, res, next) {
  if (!env.internalApiKey) {
    throw ApiError.notFound('Not found.');
  }

  /** `Authorization: Bearer <key>` too, since that is what several schedulers send. */
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!keyMatches(req.headers['x-internal-key'] || bearer)) {
    throw ApiError.unauthorized('Invalid internal key.', 'invalid_internal_key');
  }

  return next();
}

router.use(requireInternalKey);

/**
 * POST /api/v1/internal/billing/sweep
 *
 * One pass of exactly what the in-process job runs: bill every active
 * consultation whatever minutes it has passed, advance package sessions
 * (warning, end, the seeker's continue choice, settle), tick astrologer
 * disconnect grace, and expire stale requests.
 *
 * Returns a count per outcome rather than the sessions themselves — enough for
 * a cron's log to show it is doing something, with nobody's consultation in it.
 */
router.post(
  '/billing/sweep',
  asyncHandler(async (req, res) => {
    const results = await runChatBillingSweep();

    const outcomes = {};
    for (const result of results) {
      const key = result?.action || 'unknown';
      outcomes[key] = (outcomes[key] || 0) + 1;
    }

    return res.json({ swept: results.length, outcomes });
  }),
);

module.exports = router;
