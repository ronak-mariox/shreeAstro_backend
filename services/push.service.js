/**
 * Push notifications via Firebase Cloud Messaging (HTTP v1 API).
 *
 * notification.service.js calls this after every notification it stores.
 * Nothing sent a real push before this existed — the `devices[].fcmToken`
 * field was recorded but never used — so an unconfigured Firebase is not a
 * regression, `sendPush` just reports `sent: false` instead of throwing.
 *
 * Needs a full service account (project id, client email, private key), not
 * the legacy "server key" — Google shut the legacy HTTP API down in 2024, so
 * this is the only currently-valid way to send.
 */

const admin = require('firebase-admin');

const integrationsService = require('./integrations.service');

/** Rebuilt only when the config actually changes, not on every push. */
let cachedApp = null;
let cachedKey = null;

function appFor(config) {
  const key = `${config.projectId}:${config.clientEmail}`;
  if (cachedApp && cachedKey === key) {
    return cachedApp;
  }

  cachedApp = admin.initializeApp(
    {
      credential: admin.credential.cert({
        projectId: config.projectId,
        clientEmail: config.clientEmail,
        /** Saved with literal "\n" — a .env-style value can't hold a real newline. */
        privateKey: String(config.privateKey || '').replace(/\\n/g, '\n'),
      }),
    },
    /** A unique name per config, so re-configuring doesn't collide with the old app. */
    `integration-firebase-${Date.now()}`,
  );
  cachedKey = key;
  return cachedApp;
}

/**
 * Sends one push to one device token. Returns `{ sent: true }` on success, or
 * `{ sent: false, reason }` when Firebase is not configured, there is no
 * token, or the send itself failed — never thrown, so a bad/expired token or
 * a Firebase outage cannot fail the notification that triggered it.
 */
async function sendPush({ token, title, body, data }) {
  if (!token) {
    return { sent: false, reason: 'no_token' };
  }

  const config = await integrationsService.get('firebase');
  if (!config?.projectId || !config?.clientEmail || !config?.privateKey) {
    return { sent: false, reason: 'not_configured' };
  }

  try {
    await admin.messaging(appFor(config)).send({
      token,
      notification: { title, body },
      data: data
        ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))
        : undefined,
    });
    return { sent: true };
  } catch (error) {
    console.error('[push] send failed:', error.message);
    return { sent: false, reason: 'provider_error' };
  }
}

module.exports = { sendPush };
