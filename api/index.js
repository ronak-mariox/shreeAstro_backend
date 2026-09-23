/**
 * Vercel serverless entry point.
 *
 * index.js (the normal entry) boots once, opens Mongo and Redis, and keeps a
 * process alive to hold them open. Vercel has no "once" — every cold start is
 * its own process, and a warm invocation reuses whatever the last one already
 * opened. `ready` is memoized in module scope for exactly that: it survives
 * across invocations in the same warm container, and concurrent requests
 * during a cold start all await the same connect instead of racing it.
 *
 * Socket.IO is not started here — a WebSocket cannot stay open across
 * separate serverless invocations. Every socket-fed feature (live chat push,
 * notifications, astrologer presence-on-connect) already tolerates a missing
 * socket server and falls back to its REST path; see socket/index.js and the
 * getIO() call sites in services/. That fallback is what makes this safe:
 * nothing here is unreachable, it just stops arriving instantly.
 *
 * The recurring jobs index.js owns are not started here either, for the same
 * reason — and unlike the socket there is no fallback for the billing sweep.
 * Left undriven it means an active consultation is charged its opening minute
 * and then nothing, and a package session never reaches its end: no 30s
 * warning, no continue choice, no settle. A deployment on this entry MUST set
 * INTERNAL_API_KEY and have a cron call POST /api/v1/internal/billing/sweep
 * (routes/internal.routes.js) as often as it can. A host that keeps one
 * process alive is the better answer: run index.js there and sockets and the
 * 10s sweep both come back.
 */

const { createApp } = require('../app');
const { connectDatabase } = require('../config/database');
const { connectRedis } = require('../config/redis');

const app = createApp();

let ready;
function ensureConnected() {
  if (!ready) {
    ready = Promise.all([connectDatabase(), connectRedis()]).catch(error => {
      /** A failed connect must not be cached, or every request after it fails too. */
      ready = undefined;
      throw error;
    });
  }
  return ready;
}

module.exports = async (req, res) => {
  await ensureConnected();
  app(req, res);
};
