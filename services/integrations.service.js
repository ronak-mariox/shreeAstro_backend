/**
 * Third-party credentials: what the panel's Third Parties tab reads and
 * writes, and what each integration (email, sms, s3, push, appleAuth,
 * googleAuth services) reads to know whether it has something to work with.
 *
 * Backed by the `.env` file (see utils/envFile.js), not a database row — a
 * save writes straight into it and onto `process.env`, so it takes effect on
 * this running process immediately. `list()`, used by the admin API, returns
 * a masked preview of every secret field — so a credential an admin already
 * saved is never sent back to a browser in the clear. `get()`, used only by
 * the integration services themselves (server-side), returns the real value.
 */

const ApiError = require('../utils/ApiError');
const { setEnvValues } = require('../utils/envFile');

/**
 * Field keys per provider, and which of them are secrets — a secret is
 * masked on `list()` and is never pre-filled back into the panel's edit form;
 * leaving it blank there keeps whatever was already saved (see `save` below).
 */
const PROVIDER_FIELDS = {
  apple: [
    { key: 'serviceId', secret: false },
    { key: 'teamId', secret: false },
    { key: 'keyId', secret: false },
    { key: 'privateKey', secret: true },
  ],
  /**
   * ID-token verification only needs the audience(s) to accept — a Google
   * Sign-In client id is not a secret (it's baked into the mobile app's own
   * config), so nothing here is masked. `clientIds` is comma-separated
   * because one backend commonly accepts tokens minted for more than one
   * client (an Android app and an iOS app sharing one Google Cloud project).
   */
  google: [{ key: 'clientIds', secret: false }],
  email: [
    { key: 'host', secret: false },
    { key: 'port', secret: false },
    { key: 'username', secret: false },
    { key: 'password', secret: true },
  ],
  sms: [
    { key: 'authKey', secret: true },
    { key: 'templateId', secret: false },
    { key: 'senderId', secret: false },
  ],
  awsS3: [
    { key: 'accessKeyId', secret: false },
    { key: 'secretAccessKey', secret: true },
    { key: 'bucket', secret: false },
    { key: 'region', secret: false },
  ],
  firebase: [
    { key: 'projectId', secret: false },
    { key: 'clientEmail', secret: false },
    { key: 'privateKey', secret: true },
  ],
};

const PROVIDERS = Object.keys(PROVIDER_FIELDS);

/** "awsS3" -> "AWS_S3", "privateKey" -> "PRIVATE_KEY". */
function envSegment(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** e.g. INTEGRATION_AWS_S3_SECRET_ACCESS_KEY */
function fieldEnvKey(provider, fieldKey) {
  return `INTEGRATION_${envSegment(provider)}_${envSegment(fieldKey)}`;
}

/** e.g. INTEGRATION_AWS_S3_ENABLED */
function enabledEnvKey(provider) {
  return `INTEGRATION_${envSegment(provider)}_ENABLED`;
}

function isEnabled(provider) {
  return process.env[enabledEnvKey(provider)] === 'true';
}

/** Every field this provider actually has a value for, straight off process.env. */
function readValues(provider) {
  const values = {};
  for (const field of PROVIDER_FIELDS[provider]) {
    const raw = process.env[fieldEnvKey(provider, field.key)];
    if (raw !== undefined && raw !== '') {
      values[field.key] = raw;
    }
  }
  return values;
}

/** First 4 and last 2 characters, so a saved credential can be recognised without being readable. */
function maskValue(value) {
  if (!value) {
    return null;
  }
  const str = String(value);
  if (str.length > 6) {
    return `${str.slice(0, 4)}${'*'.repeat(4)}${str.slice(-2)}`;
  }
  return '*'.repeat(Math.max(str.length, 4));
}

/**
 * The config for one provider — e.g. `{ host, port, username, password }`
 * for `email` — or `null` if it's disabled or has never been saved.
 */
async function get(provider) {
  if (!PROVIDERS.includes(provider) || !isEnabled(provider)) {
    return null;
  }
  const values = readValues(provider);
  return Object.keys(values).length ? values : null;
}

/** Every provider, with masked values for the panel's cards. */
async function list() {
  return PROVIDERS.map(provider => {
    const values = readValues(provider);
    const masked = {};
    for (const field of PROVIDER_FIELDS[provider]) {
      masked[field.key] = field.secret ? maskValue(values[field.key]) : values[field.key] ?? null;
    }

    return {
      provider,
      enabled: isEnabled(provider),
      values: masked,
      /** The .env file carries no per-row timestamp — nothing to show here any more. */
      updatedAt: null,
    };
  });
}

/**
 * Saves a provider's config to `.env`.
 *
 * A field left blank keeps whatever was already saved for it — the panel
 * never sends a saved secret back for editing (see PROVIDER_FIELDS above), so
 * "blank" has to mean "unchanged", not "clear this", or every save would wipe
 * every secret the admin did not just retype. Saving always enables the
 * provider, same as it always has.
 */
async function save(provider, fields) {
  if (!PROVIDERS.includes(provider)) {
    throw ApiError.badRequest('Unknown integration.');
  }

  const updates = { [enabledEnvKey(provider)]: 'true' };
  for (const field of PROVIDER_FIELDS[provider]) {
    const incoming = fields?.[field.key];
    if (incoming !== undefined && String(incoming).trim() !== '') {
      updates[fieldEnvKey(provider, field.key)] = String(incoming);
    }
  }

  setEnvValues(updates);
  return { provider, enabled: true };
}

/** Turns a provider off without losing its saved credentials — the fields stay in .env, only the flag flips. */
async function setEnabled(provider, enabled) {
  if (!PROVIDERS.includes(provider)) {
    throw ApiError.badRequest('Unknown integration.');
  }
  setEnvValues({ [enabledEnvKey(provider)]: enabled ? 'true' : 'false' });
  return { provider, enabled: Boolean(enabled) };
}

module.exports = { PROVIDERS, PROVIDER_FIELDS, get, list, save, setEnabled, maskValue };
