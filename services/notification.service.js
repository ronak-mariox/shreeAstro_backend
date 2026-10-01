/**
 * Alerts for one account.
 *
 * Three things happen when a notification is created: a row is stored (so
 * the list screen can show it later), it is pushed straight to any open
 * socket, and it is sent to every device that has registered an FCM token
 * (services/device.service.js) — the last of those only when Firebase is
 * configured on the Third Parties tab; unconfigured, nothing is sent and
 * nothing fails.
 */

const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const Admin = require('../models/Admin');
const Notification = require('../models/Notification');
const pushService = require('./push.service');
const deviceService = require('./device.service');

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
 * What a push carries besides its title and body — what the app needs to act
 * on a tap. FCM `data` values are strings, so `action` (stored as
 * `{ screen, id }`) travels as JSON: '{"screen":"wallets"}', or '' when the
 * notification has nowhere to go. `notificationId` is the row's id, so the
 * app can mark exactly that one read.
 */
function pushData(notification) {
  const plain = typeof notification.toObject === 'function' ? notification.toObject() : notification;
  const { action } = plain;

  let actionText = '';
  if (action && typeof action === 'object') {
    const entries = Object.entries(action).filter(([, value]) => value !== undefined && value !== null);
    actionText = entries.length ? JSON.stringify(Object.fromEntries(entries)) : '';
  } else if (typeof action === 'string') {
    actionText = action;
  }

  return {
    notificationId: String(plain._id ?? plain.id ?? ''),
    type: plain.type || 'system',
    action: actionText,
  };
}

/**
 * Pushes to every device the account has registered, and answers with one
 * `{ sent, reason? }` per device, in order. Not awaited by `notify()` — a slow
 * or unconfigured Firebase must not hold up the request that triggered the
 * notification — but POST /devices/test awaits it to show a human why nothing
 * arrived.
 *
 * Two things are settled here rather than by the caller: an account that has
 * switched push off (`notificationPrefs.push === false`) is sent nothing
 * (`push_disabled`), and a token FCM reports dead is taken off the account so
 * it is not tried again.
 */
async function pushToDevices(ownerRole, ownerId, notification) {
  const owner = await OWNER_MODELS[ownerRole].findById(ownerId).select('devices notificationPrefs');
  const devices = owner?.devices || [];

  if (owner?.notificationPrefs?.push === false) {
    return devices.map(() => ({ sent: false, reason: 'push_disabled' }));
  }

  const data = pushData(notification);

  return Promise.all(
    devices.map(async device => {
      let result;
      try {
        result = await pushService.sendPush({
          token: device.fcmToken,
          title: notification.title,
          body: notification.body,
          data,
        });
      } catch (error) {
        result = { sent: false, reason: 'provider_error' };
      }

      if (result?.reason === 'invalid_token') {
        await deviceService
          .unregisterDevice({ role: ownerRole, accountId: ownerId, fcmToken: device.fcmToken })
          .catch(() => {});
      }
      return result;
    }),
  );
}

/**
 * Creates one notification and pushes it.
 *
 * `push: false` stores it and emits it on the socket but leaves the device
 * push to the caller — for the one caller that wants to await
 * `pushToDevices` itself and report what happened.
 */
async function notify({ ownerRole, ownerId, type, title, body, action, push = true }) {
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

  if (push) {
    pushToDevices(ownerRole, ownerId, notification).catch(() => {});
  }

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

module.exports = { notify, notifyAdmins, pushToDevices, list, markRead };
