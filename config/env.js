/**
 * Centralized environment configuration.
 *
 * All environment variables used by the server are resolved here.
 * Production secrets MUST be provided through deployment environment variables.
 */

require('dotenv').config({ quiet: true });

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Helper for required production environment variables.
 *
 * In development, a fallback can be used.
 * In production, the variable must be explicitly configured.
 */
function getEnv(name, developmentDefault = '') {
  const value = process.env[name];

  if (isProduction && (!value || value.trim() === '')) {
    throw new Error(`${name} must be set in production.`);
  }

  return value || developmentDefault;
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',

  port: Number(process.env.PORT || 5000),

  /**
   * MongoDB
   */
  mongoUri: getEnv(
    'MONGODB_URI',
    'mongodb://127.0.0.1:27017/shree_astro'
  ),

  /**
   * JWT access token secret.
   */
  jwtSecret: getEnv(
    'JWT_SECRET',
    'dev-only-change-me'
  ),

  /**
   * JWT refresh token secret.
   */
  refreshSecret: getEnv(
    'JWT_REFRESH_SECRET',
    'dev-only-change-me-too'
  ),

  /**
   * OTP configuration.
   */
  otp: {
    secret: getEnv(
      'OTP_SECRET',
      'dev-only-change-me-otp'
    ),

    /**
     * Development only.
     *
     * In production this MUST be empty/disabled.
     */
    masterCode: process.env.OTP_MASTER_CODE ?? '123456',
  },

  /**
   * Redis
   */
  redis: {
    url: getEnv(
      'REDIS_URL',
      'redis://127.0.0.1:6379'
    ),

    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'shreeastro:',
  },

  /**
   * Encrypts third-party credentials (SMTP password, MSG91 auth key, AWS
   * secret key, Firebase private key, ...) before they are written to Mongo.
   * See utils/crypto.js and services/integrations.service.js.
   */
  configEncryptionKey: getEnv(
    'CONFIG_ENCRYPTION_KEY',
    'dev-only-change-me-config-key'
  ),

  /**
   * Public URL used for generated/public file URLs.
   */
  publicUrl: process.env.PUBLIC_URL || '',

  /**
   * CORS
   *
   * Example:
   *
   * CORS_ORIGINS=https://admin.example.com,https://app.example.com
   */
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
};

env.isProduction = isProduction;

/**
 * Security checks
 */

// Access and refresh secrets must always be different.
if (env.jwtSecret === env.refreshSecret) {
  throw new Error(
    'JWT_REFRESH_SECRET must differ from JWT_SECRET.'
  );
}

// Master OTP must NEVER be enabled in production.
if (env.isProduction && env.otp.masterCode) {
  throw new Error(
    'OTP_MASTER_CODE must be empty in production.'
  );
}

module.exports = env;