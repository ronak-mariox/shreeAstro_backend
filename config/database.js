/** The single mongoose connection, opened once at boot. */

const mongoose = require('mongoose');

const env = require('./env');

/** Requiring the models registers every schema, so `ref` strings resolve. */
require('../models');

async function connectDatabase(uri = env.mongoUri) {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => console.log('[db] connected'));
  mongoose.connection.on('error', error => console.error('[db] error:', error.message));
  mongoose.connection.on('disconnected', () => console.warn('[db] disconnected'));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  return mongoose.connection;
}

async function disconnectDatabase() {
  await mongoose.connection.close();
}

module.exports = { connectDatabase, disconnectDatabase };
