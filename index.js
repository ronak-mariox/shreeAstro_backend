/**
 * Server entry point: open the database, start express, attach socket.io.
 *
 * The app and the socket layer are built elsewhere so they stay importable on
 * their own; this file only owns the order things happen in, and the shutdown.
 */

const http = require('http');

const env = require('./config/env');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { connectRedis, disconnectRedis } = require('./config/redis');
const { createApp } = require('./app');
const { initSocket } = require('./socket');

async function start() {
  await connectDatabase();
  /** OTPs live in Redis, so a bad URL should fail here and not mid-login. */
  await connectRedis();

  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);

  server.listen(env.port, () => {
    console.log(`[http] Shree Astro API on :${env.port} (${env.nodeEnv})`);
  });

  /** Stop taking new work, finish what is in flight, then let go of mongo. */
  const shutdown = async signal => {
    console.log(`\n[app] ${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDatabase();
      await disconnectRedis();
      process.exit(0);
    });
    /** Something is stuck; do not hang a deploy on it. */
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(error => {
  console.error('[app] failed to start:', error.message);
  process.exit(1);
});
