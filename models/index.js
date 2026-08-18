/**
 * Every model, in one place.
 *
 * Requiring this module registers all schemas with mongoose, so `ref` strings
 * resolve no matter which model is touched first.
 */

const constants = require('./constants');
const common = require('./common');

const User = require('./User');
const UserProfile = require('./UserProfile');
const Astrologer = require('./Astrologer');
const AstrologerProfile = require('./AstrologerProfile');
const Admin = require('./Admin');
const chat = require('./Chat');

module.exports = {
  User,
  UserProfile,
  Astrologer,
  AstrologerProfile,
  Admin,
  ...chat,
  constants,
  common,
};
