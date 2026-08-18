'use strict';

const Redis = require('ioredis');

const { env } = require('./env');

/**
 * One shared connection for the whole process — everything that touches Redis
 * (OTP records today) imports this client.
 *
 * ioredis speaks the Redis wire protocol, so `env.redis.url` has to be the TCP
 * connection string (`rediss://default:<password>@<host>:6379` on Upstash), not
 * the REST endpoint — the REST URL is a plain HTTPS API and will never connect.
 *
 * `lazyConnect` holds the socket closed until connectRedis() runs, so a wrong
 * URL fails at boot next to the Mongo connection instead of inside the first
 * request that needs an OTP.
 */
const redis = new Redis(env.redis.url, {
  lazyConnect: true,
  keyPrefix: env.redis.keyPrefix,
  maxRetriesPerRequest: 3,
});

// A dropped connection is retried by ioredis on its own; log it rather than let
// it surface as an unhandled error event and take the process down.
redis.on('error', (err) => console.error('Redis error', err.message));

async function connectRedis() {
  await redis.connect();
}

async function disconnectRedis() {
  await redis.quit();
  console.info('Disconnected from Redis');
}

module.exports = { redis, connectRedis, disconnectRedis };
