/**
 * Alerts for one account.
 *
 * Three things happen when a notification is created: a row is stored (so
 * the list screen can show it later), it is pushed straight to any open
 * socket, and it is sent to every device that has registered an FCM token —
 * the last of those only when Firebase is configured on the Third Parties
 * tab; unconfigured, nothing here changes from before it existed.
 */

const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const Admin = require('../models/Admin');
const Notification = require('../models/Notification');
const pushService = require('./push.service');

/** Which model holds the unread counter for each role. */
const OWNER_MODELS = { user: User, astrologer: Astrologer, admin: Admin };

/**
 * Emits to one account's personal room, if the socket server is running.
 *
 * Required lazily to avoid a require cycle: socket/index.js already requires
 * services, so requiring it back at the top of this file would be circular.
 */
function pushToSocket(ownerRole, ownerId, notification) {
  try {
    const { getIO } = require('../socket');
    getIO().to(`${ownerRole}:${ownerId}`).emit('notification:new', notification);
  } catch (error) {
    /** No socket server (a script, a test) — the row is stored either way. */
  }
}

/**
 * Pushes to every device the account has registered. Not awaited by
 * `notify()` — a slow or unconfigured Firebase must not hold up the request
 * that triggered the notification.
 */
async function pushToDevices(ownerRole, ownerId, notification) {
  const owner = await OWNER_MODELS[ownerRole].findById(ownerId).select('devices');
  await Promise.all(
    (owner?.devices || []).map(device =>
      pushService
        .sendPush({
          token: device.fcmToken,
          title: notification.title,
          body: notification.body,
          data: { type: notification.type, action: notification.action || '' },
        })
        .catch(() => {}),
    ),
  );
}

/** Creates one notification and pushes it. */
async function notify({ ownerRole, ownerId, type, title, body, action }) {
  const notification = await Notification.create({
    ownerRole,
    owner: ownerId,
    type,
    title,
    body,
    action,
  });

  await OWNER_MODELS[ownerRole].updateOne(
    { _id: ownerId },
    { $inc: { unreadNotifications: 1 } },
  );

  pushToSocket(ownerRole, ownerId, {
    id: String(notification._id),
    type: notification.type,
    title: notification.title,
    body: notification.body,
    action: notification.action,
    createdAt: notification.createdAt,
  });

  pushToDevices(ownerRole, ownerId, notification).catch(() => {});

  return notification;
}

/**
 * Alerts every active admin about something that needs their attention — a
 * new application, a price-change or withdrawal request, a support ticket.
 *
 * There is no single "the admin" account to notify the way a user/astrologer
 * notification targets one owner, so this fans `notify()` out to every admin
 * currently able to sign in, rather than filtering by which permission the
 * event is nominally about — the panel already gives every admin read access
 * to this data, so an extra alert costs less than a missed one.
 */
async function notifyAdmins({ type, title, body, action }) {
  const admins = await Admin.find({ status: 'active' }).select('_id');
  await Promise.all(
    admins.map(admin =>
      notify({ ownerRole: 'admin', ownerId: admin._id, type, title, body, action }),
    ),
  );
}

/** The notifications screen, newest first. */
async function list({ ownerRole, ownerId, page = 1, limit = 20 }) {
  const query = { ownerRole, owner: ownerId };
  const skip = (Math.max(Number(page), 1) - 1) * limit;

  const [items, total, unread] = await Promise.all([
    Notification.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(query),
    Notification.countDocuments({ ...query, readAt: null }),
  ]);

  return { items, total, unread, page: Number(page), limit };
}

/** Marks one notification read, or all of them when no id is given. */
async function markRead({ ownerRole, ownerId, notificationId }) {
  const query = { ownerRole, owner: ownerId, readAt: null };
  if (notificationId) {
    query._id = notificationId;
  }

  const result = await Notification.updateMany(query, { $set: { readAt: new Date() } });

  const stillUnread = await Notification.countDocuments({
    ownerRole,
    owner: ownerId,
    readAt: null,
  });
  await OWNER_MODELS[ownerRole].updateOne(
    { _id: ownerId },
    { $set: { unreadNotifications: stillUnread } },
  );

  return { updated: result.modifiedCount, unread: stillUnread };
}

module.exports = { notify, notifyAdmins, list, markRead };
