/**
 * Every environment variable the server reads, resolved once with its default.
 *
 * Nothing else in the codebase touches `process.env`, so what the server needs
 * to run is exactly this list — mirrored in .env.example. Fixed JWT/OTP/cookie
 * settings that don't vary by deployment live in ./constants instead.
 */

require('dotenv').config({ quiet: true });

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),

  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro',

  /**
   * Signs the short-lived access token — the one a REST call and a socket
   * handshake carry. A leak is survivable because it expires in minutes.
   */
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',

  /**
   * Signs refresh tokens. Kept separate so an access token can never be
   * replayed as a refresh token, and so rotating one secret does not
   * invalidate the other.
   */
  refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-only-change-me-too',

  /**
   * OTP settings.
   *
   * `masterCode` is a temporary stand-in: there is no SMS or email provider
   * yet, so this one code always works for every login. Delete it (and the
   * check in services/otp.service.js) the day a real provider is plugged in.
   */
  otp: {
    /** Peppers the stored code hash, so a leaked Redis dump has no live codes. */
    secret: process.env.OTP_SECRET || 'dev-only-change-me-otp',
    /**
     * `??` and not `||`, so setting `OTP_MASTER_CODE=` (empty) actually turns
     * the master code off. With `||` an empty value fell back to the default,
     * which made the production guard below impossible to satisfy.
     */
    masterCode: process.env.OTP_MASTER_CODE ?? '123456',
  },

  redis: {
    url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'shreeastro:',
  },

  /**
   * Public origin files are served from. Left unset in development, where the
   * URL is derived from the request instead — the apps reach the host under
   * different names (10.0.2.2 from an Android emulator, 127.0.0.1 from iOS).
   */
  publicUrl: process.env.PUBLIC_URL || '',

  /** Comma-separated list, or "*" while the apps are still on Metro. */
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
};

env.isProduction = env.nodeEnv === 'production';

/** A default secret in production would let anyone mint a session. */
if (env.isProduction && env.jwtSecret === 'dev-only-change-me') {
  throw new Error('JWT_SECRET must be set in production.');
}
if (env.isProduction && env.refreshSecret === 'dev-only-change-me-too') {
  throw new Error('JWT_REFRESH_SECRET must be set in production.');
}
/** Without this, every stored OTP is a million-guess offline lookup. */
if (env.isProduction && env.otp.secret === 'dev-only-change-me-otp') {
  throw new Error('OTP_SECRET must be set in production.');
}
/** A master OTP in production would let anyone log in as anyone. */
if (env.isProduction && env.otp.masterCode) {
  throw new Error('OTP_MASTER_CODE must be empty in production. Set `OTP_MASTER_CODE=` in .env.');
}
/** Signing both with one key would make the two token kinds interchangeable. */
if (env.jwtSecret === env.refreshSecret) {
  throw new Error('JWT_REFRESH_SECRET must differ from JWT_SECRET.');
}

module.exports = env;
