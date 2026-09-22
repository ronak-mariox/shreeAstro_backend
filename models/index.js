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
const ChatBillingTick = require('./ChatBillingTick');
const ChatPackagePurchase = require('./ChatPackagePurchase');
const AssistantMemory = require('./AssistantMemory');
const WalletTransaction = require('./WalletTransaction');
const Withdrawal = require('./Withdrawal');
const Notification = require('./Notification');
const Article = require('./Article');
const AuditLog = require('./AuditLog');
const Settings = require('./Settings');
const SupportTicket = require('./SupportTicket');
const BirthProfile = require('./BirthProfile');
const KundliCache = require('./KundliCache');
const GeoCache = require('./GeoCache');
const ApiUsage = require('./ApiUsage');
const HoroscopeCache = require('./HoroscopeCache');

module.exports = {
  User,
  UserProfile,
  Astrologer,
  AstrologerProfile,
  Admin,
  ...chat,
  ChatBillingTick,
  ChatPackagePurchase,
  AssistantMemory,
  WalletTransaction,
  Withdrawal,
  Notification,
  Article,
  AuditLog,
  Settings,
  SupportTicket,
  BirthProfile,
  KundliCache,
  GeoCache,
  ApiUsage,
  HoroscopeCache,
  constants,
  common,
};
