/**
 * One alert for one account — the rows both apps' notification screens list.
 *
 * Notifications are per-account, so an astrologer and a seeker never share a
 * row. The unread badge is the count of rows where `readAt` is not set, and is
 * also mirrored on the account as `unreadNotifications` so a listing does not
 * have to count them.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const OWNER_ROLES = ['user', 'astrologer', 'admin'];

/** What the alert is about — the app picks its icon and colour from this. */
const NOTIFICATION_TYPES = [
  'consultation_request',
  'consultation_started',
  'consultation_ended',
  'consultation_missed',
  'message',
  'wallet_credit',
  'wallet_debit',
  'withdrawal',
  'review',
  'application',
  'promotion',
  'system',
];

const notificationSchema = new Schema(
  {
    ownerRole: { type: String, enum: OWNER_ROLES, required: true },
    owner: { type: Schema.Types.ObjectId, required: true, index: true },

    type: { type: String, enum: NOTIFICATION_TYPES, default: 'system' },
    title: { type: String, trim: true, required: true },
    body: { type: String, trim: true },

    /** Where tapping it should take the user, e.g. { screen, id }. */
    action: {
      screen: { type: String, trim: true },
      id: { type: String, trim: true },
    },

    readAt: { type: Date },
  },
  { timestamps: true },
);

/** The list screen: one account's rows, newest first. */
notificationSchema.index({ owner: 1, createdAt: -1 });

module.exports =
  mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
