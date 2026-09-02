/**
 * JWT, OTP, cookie and upload settings that are fixed behaviour, not
 * per-deployment config — unlike the secrets in config/env.js, these don't
 * vary between environments (or derive from NODE_ENV, which does), so they
 * live in code instead of .env.
 */

const { isProduction } = require('./env');

/** How long an access token is valid for. */
const JWT_EXPIRES_IN = '15m';
/** How long a refresh token is valid for. */
const JWT_REFRESH_EXPIRES_IN = '30d';

/** How long an OTP stays valid, in seconds. */
const OTP_TTL_SECONDS = 300;
/** How long before another OTP may be asked for, in seconds. */
const OTP_RESEND_SECONDS = 30;
/** Wrong guesses allowed before an OTP is burnt. */
const OTP_MAX_ATTEMPTS = 5;

/** The refresh cookie is scoped to the auth routes, not attached to every API call. */
const COOKIE_REFRESH_PATH = '/api/v1/auth';
/** Unset unless the panel and API ever need to share a cookie across subdomains. */
const COOKIE_DOMAIN = undefined;
/**
 * `sameSite: 'none'` requires `secure`, so browsers only accept a cross-site
 * session over HTTPS — which is what the admin panel needs once it is served
 * from its own origin. In development everything is same-origin over http,
 * so 'lax' + insecure is both fine and necessary.
 */
const COOKIE_SAME_SITE = isProduction ? 'none' : 'lax';
const COOKIE_SECURE = isProduction;

/** Where uploaded files are written, relative to the backend folder. */
const UPLOAD_DIR = 'uploads';
/** Largest image an upload may be, in megabytes. */
const MAX_UPLOAD_MB = 5;

module.exports = {
  JWT_EXPIRES_IN,
  JWT_REFRESH_EXPIRES_IN,
  OTP_TTL_SECONDS,
  OTP_RESEND_SECONDS,
  OTP_MAX_ATTEMPTS,
  COOKIE_REFRESH_PATH,
  COOKIE_DOMAIN,
  COOKIE_SAME_SITE,
  COOKIE_SECURE,
  UPLOAD_DIR,
  MAX_UPLOAD_MB,
};
