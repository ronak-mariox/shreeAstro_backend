/**
 * Push notifications via Firebase Cloud Messaging (HTTP v1 API).
 *
 * notification.service.js calls this for every device an account has
 * registered (services/device.service.js), after each notification it
 * stores. An unconfigured Firebase is not an error — `sendPush` just reports
 * `sent: false` instead of throwing.
 *
 * Needs a full service account (project id, client email, private key), not
 * the legacy "server key" — Google shut the legacy HTTP API down in 2024, so
 * this is the only currently-valid way to send.
 */

/**
 * firebase-admin 13+ only ships the modular API — the old namespaced
 * credential/messaging calls are gone, and using them threw on every send.
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const integrationsService = require('./integrations.service');

/** Rebuilt only when the config actually changes, not on every push. */
let cachedApp = null;
let cachedKey = null;

/**
 * The service account's private key, as PEM, however it was pasted into the
 * panel. A `.env` value cannot hold a real newline, so the key is saved with
 * literal "\n" — turned back here. And the "-----BEGIN/END PRIVATE KEY-----"
 * lines are easy to leave out when copying the value from the JSON file: a
 * bare base64 body is wrapped rather than rejected as an unreadable key.
 */
function normalizePrivateKey(value) {
  let key = String(value || '').trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n').trim();
  if (key && !key.includes('-----BEGIN')) {
    key = `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`;
  }
  return key ? `${key}\n` : key;
}

function appFor(config) {
  /** The private key is part of it: a rotated key for the same account must not keep sending with the old one. */
  const key = `${config.projectId}:${config.clientEmail}:${config.privateKey}`;
  if (cachedApp && cachedKey === key) {
    return cachedApp;
  }

  cachedApp = initializeApp(
    {
      credential: cert({
        projectId: config.projectId,
        clientEmail: config.clientEmail,
        privateKey: normalizePrivateKey(config.privateKey),
      }),
    },
    /** A unique name per config, so re-configuring doesn't collide with the old app. */
    `integration-firebase-${Date.now()}`,
  );
  cachedKey = key;
  return cachedApp;
}

/** The real thing: hands one message to FCM with the saved service account. */
const firebaseSender = (message, config) => getMessaging(appFor(config)).send(message);

/**
 * What actually delivers a message — `(message, config) => Promise`, throwing
 * the way firebase-admin does. Swapped by tests (`setSender`) so nothing they
 * do can reach Google; `setSender()` with no argument puts the real one back.
 */
let sender = firebaseSender;

function setSender(fn) {
  sender = typeof fn === 'function' ? fn : firebaseSender;
}

/**
 * Codes that mean "this token will never work again" — the app was
 * uninstalled, its data was cleared, or the token was never a real one. The
 * caller's cue to forget the device rather than keep trying it.
 */
const DEAD_TOKEN_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
];

/**
 * FCM answers a malformed token with a plain INVALID_ARGUMENT — the same code
 * it uses for a bad payload — so that one only counts when the message says
 * the token is what was wrong. A payload problem must not cost a device.
 */
function isDeadToken(error) {
  const code = error?.code || error?.errorInfo?.code;
  if (DEAD_TOKEN_CODES.includes(code)) {
    return true;
  }
  return code === 'messaging/invalid-argument' && /token/i.test(String(error?.message || ''));
}

/**
 * Sends one push to one device token. Returns `{ sent: true }` on success, or
 * `{ sent: false, reason }` — never thrown, so a bad/expired token or a
 * Firebase outage cannot fail the notification that triggered it:
 *
 *   no_token        nothing to send to
 *   not_configured  Firebase is not set up (or switched off) on the panel
 *   invalid_token   FCM says this token is dead — drop the device
 *   provider_error  anything else FCM or the credentials got wrong
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
    await sender(
      {
        token,
        notification: { title, body },
        /** FCM only carries strings in `data`; a missing value is left out. */
        data: data
          ? Object.fromEntries(
              Object.entries(data)
                .filter(([, value]) => value !== undefined && value !== null)
                .map(([key, value]) => [key, String(value)]),
            )
          : undefined,
        /**
         * `high` wakes a dozing phone — an incoming consultation cannot wait
         * for the next maintenance window. The channel is the one the apps
         * create at startup; Android 8+ drops a notification whose channel
         * does not exist.
         */
        android: { priority: 'high', notification: { channelId: 'default', sound: 'default' } },
        apns: { payload: { aps: { sound: 'default' } } },
      },
      config,
    );
    return { sent: true };
  } catch (error) {
    if (isDeadToken(error)) {
      return { sent: false, reason: 'invalid_token' };
    }
    console.error('[push] send failed:', error?.message);
    return { sent: false, reason: 'provider_error' };
  }
}

module.exports = { sendPush, setSender, normalizePrivateKey };
