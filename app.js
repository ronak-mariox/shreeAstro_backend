/**
 * The express app.
 *
 * Exported as a factory rather than started here, so index.js owns the boot
 * sequence and tests can mount the app without opening a port.
 *
 * The stack is: platform middleware → health → the v1 API → not-found → the
 * error handler. Everything below /api/v1 is declared in routes/index.js.
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const mongoose = require('mongoose');

const env = require('./config/env');
const routes = require('./routes');
const { uploadRoot } = require('./services/storage.service');
const { notFound, errorHandler } = require('./middlewares/error.middleware');

function createApp() {
  const app = express();

  /**
   * `origin: true` reflects the caller's origin rather than answering "*" —
   * a browser refuses to send cookies to a wildcard origin, so the admin
   * panel's session would never leave the machine otherwise.
   */
  app.use(
    cors({
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  /**
   * Express 5 leaves `req.body` undefined when a request carries no body at
   * all, which several of our POSTs legitimately do — "end this chat", "mark
   * everything read". Defaulting it to an empty object here means a controller
   * can always read `req.body.something` without checking first.
   */
  app.use((req, res, next) => {
    if (req.body === undefined) {
      req.body = {};
    }
    next();
  });
  /** Fills `req.cookies`, which is where the browser clients' tokens arrive. */
  app.use(cookieParser());

  /** Behind a proxy, so `req.ip` and `secure` cookies reflect the real client. */
  if (env.isProduction) {
    app.set('trust proxy', 1);
  }

  /** What a load balancer and the apps' connectivity check poll. */
  app.get('/health', (req, res) => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    res.json({
      ok: mongoose.connection.readyState === 1,
      uptime: Math.round(process.uptime()),
      database: states[mongoose.connection.readyState] || 'unknown',
      env: env.nodeEnv,
    });
  });

  app.get('/', (req, res) => {
    res.json({ name: 'Shree Astro API', version: 'v1' });
  });

  /** Uploaded files are served straight off disk while storage is local. */
  app.use('/uploads', express.static(uploadRoot, { maxAge: '7d' }));

  app.use('/api/v1', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
