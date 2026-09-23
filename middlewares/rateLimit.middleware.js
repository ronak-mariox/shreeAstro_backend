/**
 * A per-caller ceiling on how often an endpoint may be hit.
 *
 * Only guessable credentials need this, which today means the sign-in
 * endpoints: a login code is six digits, and while OTP_MASTER_CODE stands in
 * for real SMS delivery one particular six-digit code opens every account in
 * the system. Unlimited tries turns that into a few minutes' work, so the
 * tries are not unlimited.
 *
 * Counted in Redis — the same place the codes themselves live — as a fixed
 * window per key: the first request in a window sets a counter with a TTL, and
 * the window simply expires. Nothing sweeps it. It counts across processes,
 * which matters the moment there is more than one.
 *
 * services/otp.service.js has the other half: a budget per phone number or
 * email address, which no amount of switching IP addresses gets around. This
 * limits one caller against everyone; that limits everyone against one
 * account.
 *
 * Fails OPEN. If Redis is unreachable the OTP flow cannot work at all (the
 * codes are in Redis), so refusing here would only turn a broken dependency
 * into a locked-out login with a confusing error.
 */

const { redis } = require('../config/redis');
const ApiError = require('../utils/ApiError');

/**
 * Who is calling.
 *
 * `req.ip` behind a proxy needs `trust proxy`, which app.js sets in
 * production — without it every request would look like it came from the load
 * balancer and share one budget.
 */
function callerKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * @param {object} options
 * @param {string} options.name      Names the counter, so two limited routes never share one budget.
 * @param {number} options.limit     Requests allowed per window.
 * @param {number} options.windowSeconds
 */
function rateLimit({ name, limit, windowSeconds }) {
  return async function limiter(req, res, next) {
    const key = `ratelimit:${name}:${callerKey(req)}`;

    try {
      const hits = await redis.incr(key);
      /**
       * Only the request that created the counter sets the expiry — doing it on
       * every hit would slide the window forward forever and never let it end.
       */
      if (hits === 1) {
        await redis.expire(key, windowSeconds);
      }

      if (hits > limit) {
        /** What is left of the window, so the app can count down instead of guessing. */
        const retryAfter = await redis.ttl(key);
        throw ApiError.tooManyRequests(
          'Too many attempts. Please try again in a little while.',
          'rate_limited',
          retryAfter > 0 ? retryAfter : windowSeconds,
        );
      }
    } catch (error) {
      /** Our own refusal — pass it on. Anything else is Redis, and fails open. */
      if (error instanceof ApiError) {
        return next(error);
      }
      console.error('[rateLimit] not enforced:', error.message);
    }

    return next();
  };
}

module.exports = { rateLimit };
