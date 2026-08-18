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
const cors = require('cors');
const mongoose = require('mongoose');

const env = require('./config/env');
const routes = require('./routes');
const { uploadRoot } = require('./services/storage.service');
const { notFound, errorHandler } = require('./middlewares/error.middleware');

function createApp() {
  const app = express();

  app.use(
    cors({
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

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
