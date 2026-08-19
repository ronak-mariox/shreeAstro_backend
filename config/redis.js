/**
 * One Redis connection for the whole server.
 *
 * Redis is used for things that should expire on their own — login OTPs today.
 * Every key it writes gets a TTL, so nothing has to be cleaned up by hand.
 *
 * `env.redis.url` must be the TCP connection string (`rediss://...:6379` on
 * Upstash), not the REST endpoint — the REST URL will never connect.
 */

const Redis = require('ioredis');

const env = require('./env');

/**
 * `lazyConnect` keeps the socket closed until connectRedis() runs, so a bad
 * URL fails at boot next to the Mongo connection instead of inside the first
 * request that needs an OTP.
 */
const redis = new Redis(env.redis.url, {
  lazyConnect: true,
  keyPrefix: env.redis.keyPrefix,
  maxRetriesPerRequest: 3,
});

/** ioredis retries a dropped connection itself; just log it. */
redis.on('error', error => console.error('[redis]', error.message));

async function connectRedis() {
  await redis.connect();
  console.log('[redis] connected');
}

async function disconnectRedis() {
  await redis.quit();
  console.log('[redis] disconnected');
}

module.exports = { redis, connectRedis, disconnectRedis };
