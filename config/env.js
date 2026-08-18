/**
 * Every environment variable the server reads, resolved once with its default.
 *
 * Nothing else in the codebase touches `process.env`, so what the server needs
 * to run is exactly this list — mirrored in .env.example.
 */

require('dotenv').config({ quiet: true });

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),

  mongoUri: process.env.MONGODB_URI || 'mongodb+srv://ronak_db_user:GBvQdOIkblcdMpiT@cluster0.bildcpg.mongodb.net/?appName=Cluster0',

  /** Signs both the REST tokens and the ones a socket hands over on connect. */
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  redis: {
    url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'ecitizen:',
  },

  /** Where uploaded files are written, relative to the backend folder. */
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  /** Largest image an upload may be, in megabytes. */
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 5),
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

module.exports = env;
