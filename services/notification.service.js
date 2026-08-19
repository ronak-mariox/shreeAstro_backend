/**
 * Alerts for one account.
 *
 * Two things happen when a notification is created: a row is stored (so the
 * list screen can show it later) and, if that account has a socket open, it is
 * pushed straight to them.
 */

const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const Notification = require('../models/Notification');

/** Which model holds the unread counter for each role. */
const OWNER_MODELS = { user: User, astrologer: Astrologer };

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

  return notification;
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

module.exports = { notify, list, markRead };
