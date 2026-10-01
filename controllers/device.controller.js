/**
 * Push targets over HTTP.
 *
 * Both apps call the same three endpoints — the role on the token decides
 * whether the device is filed under a seeker or an astrologer.
 */

const deviceService = require('../services/device.service');
const notificationService = require('../services/notification.service');
const asyncHandler = require('../utils/asyncHandler');

/**
 * POST /api/v1/devices — "this install belongs to me now".
 *
 * Called after sign-in, on every app start while signed in, and whenever
 * Firebase hands the app a new token. Answers with how many devices the
 * account has.
 */
const registerDevice = asyncHandler(async (req, res) => {
  const devices = await deviceService.registerDevice({
    role: req.account.role,
    accountId: req.account.accountId,
    fcmToken: req.body.fcmToken,
    platform: req.body.platform,
    appVersion: req.body.appVersion,
  });
  return res.json({ ok: true, devices });
});

/**
 * DELETE /api/v1/devices — logout. Best-effort on the app's side, so it is a
 * 200 whether or not the token was there.
 */
const unregisterDevice = asyncHandler(async (req, res) => {
  await deviceService.unregisterDevice({
    role: req.account.role,
    accountId: req.account.accountId,
    fcmToken: req.body.fcmToken,
  });
  return res.json({ ok: true });
});

/**
 * POST /api/v1/devices/test — sends the caller a real notification and says
 * what became of it on each of their devices.
 *
 * Everywhere else a push is fire-and-forget; here it is awaited, because the
 * point is the answer: `push` has one `{ sent, reason? }` per device, where
 * `reason` is why nothing arrived — `not_configured` (Firebase is not set up
 * on the panel), `invalid_token` (that install is gone; the device has just
 * been removed), `provider_error`, `no_token`, or `push_disabled` (the account
 * has push switched off). `devices` is how many were tried; 0 means the app
 * never registered one.
 */
const sendTestPush = asyncHandler(async (req, res) => {
  const { role, accountId } = req.account;

  const notification = await notificationService.notify({
    ownerRole: role,
    ownerId: accountId,
    type: 'system',
    title: 'Test notification',
    body: 'Push notifications are working.',
    /** Pushed below instead, awaited — not twice. */
    push: false,
  });
  const push = await notificationService.pushToDevices(role, accountId, notification);

  return res.json({ ok: true, devices: push.length, push });
});

module.exports = { registerDevice, unregisterDevice, sendTestPush };
