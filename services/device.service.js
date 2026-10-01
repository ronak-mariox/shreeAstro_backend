/**
 * Push targets: which phones an account's notifications are sent to.
 *
 * An app registers its FCM token after sign-in (and again whenever Firebase
 * rotates it), and unregisters it on logout. The tokens live on the account
 * itself — `devices` on User and Astrologer (models/common.js deviceSchema) —
 * and notification.service.js sends to every one of them.
 *
 * One rule matters more than the rest: a token belongs to exactly one account
 * at a time. A token identifies an install, not a person, so when someone
 * signs out and another person signs in on the same phone, the token has to
 * leave the first account — otherwise that phone keeps showing the previous
 * person's alerts.
 */

const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const ApiError = require('../utils/ApiError');

/** The roles that have devices at all — an admin uses the panel, not an app. */
const DEVICE_MODELS = { user: User, astrologer: Astrologer };

const PLATFORMS = ['android', 'ios', 'web'];

/** FCM tokens are ~150-250 characters today; Google only promises "under 4 KB". */
const MAX_TOKEN_LENGTH = 4096;

/** Old phones, reinstalls and a tablet or two — beyond this the oldest goes. */
const MAX_DEVICES = 10;

/**
 * A device heartbeat is not an edit to the account, so none of the writes
 * here move its `updatedAt`.
 */
const QUIET = { timestamps: false };

function modelFor(role) {
  const Model = DEVICE_MODELS[role];
  if (!Model) {
    throw ApiError.forbidden('This is not available to your account.');
  }
  return Model;
}

/** The token as it is stored, or a 422 when it cannot be one. */
function cleanToken(fcmToken) {
  const token = typeof fcmToken === 'string' ? fcmToken.trim() : '';
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    throw ApiError.unprocessable('Please check the form.', { fcmToken: 'Invalid device token.' });
  }
  return token;
}

/**
 * Takes a token off every account that holds it — seekers and astrologers
 * both — except `keep`, the account that is registering it right now.
 * Returns how many accounts lost it.
 */
async function pruneToken(fcmToken, { keep } = {}) {
  const token = cleanToken(fcmToken);

  const results = await Promise.all(
    Object.entries(DEVICE_MODELS).map(([role, Model]) => {
      const query = { 'devices.fcmToken': token };
      if (keep && keep.role === role) {
        query._id = { $ne: keep.accountId };
      }
      return Model.updateMany(query, { $pull: { devices: { fcmToken: token } } }, QUIET);
    }),
  );

  return results.reduce((total, result) => total + (result.modifiedCount || 0), 0);
}

/**
 * Adds this install to the caller's devices, or refreshes it when it is
 * already there. Returns how many devices the account now has.
 *
 * Both steps are single atomic updates, so two registrations of the same
 * token arriving together (app start + a token refresh) cannot leave two rows
 * for it: the `$push` only matches while the token is still absent.
 */
async function registerDevice({ role, accountId, fcmToken, platform, appVersion }) {
  const Model = modelFor(role);
  const token = cleanToken(fcmToken);
  if (!PLATFORMS.includes(platform)) {
    throw ApiError.unprocessable('Please check the form.', { platform: 'Unknown platform.' });
  }
  const version =
    typeof appVersion === 'string' && appVersion.trim() ? appVersion.trim().slice(0, 40) : undefined;

  /** First, so the previous owner stops receiving even if the rest fails. */
  await pruneToken(token, { keep: { role, accountId } });

  const now = new Date();
  const refresh = () =>
    Model.updateOne(
      { _id: accountId, 'devices.fcmToken': token },
      {
        $set: {
          'devices.$.platform': platform,
          'devices.$.lastSeenAt': now,
          /** A build that does not report its version keeps the last one known. */
          ...(version ? { 'devices.$.appVersion': version } : {}),
        },
      },
      QUIET,
    );

  let stored = (await refresh()).matchedCount > 0;

  if (!stored) {
    const device = { fcmToken: token, platform, lastSeenAt: now, ...(version ? { appVersion: version } : {}) };
    const added = await Model.updateOne(
      { _id: accountId, 'devices.fcmToken': { $ne: token } },
      /** Oldest first, keep the last MAX_DEVICES: the least recently seen is what falls off. */
      { $push: { devices: { $each: [device], $sort: { lastSeenAt: 1 }, $slice: -MAX_DEVICES } } },
      QUIET,
    );
    stored = added.matchedCount > 0 || (await refresh()).matchedCount > 0;
  }

  const account = await Model.findById(accountId).select('devices');
  if (!account || !stored) {
    throw ApiError.notFound('Account not found.');
  }
  return account.devices.length;
}

/**
 * Takes one token off one account — logout, and a token Firebase says is
 * dead. Not an error when it was not there. Returns whether it was.
 */
async function unregisterDevice({ role, accountId, fcmToken }) {
  const Model = modelFor(role);
  const token = cleanToken(fcmToken);

  const result = await Model.updateOne(
    { _id: accountId },
    { $pull: { devices: { fcmToken: token } } },
    QUIET,
  );
  return (result.modifiedCount || 0) > 0;
}

module.exports = {
  registerDevice,
  unregisterDevice,
  pruneToken,
  PLATFORMS,
  MAX_TOKEN_LENGTH,
  MAX_DEVICES,
};
