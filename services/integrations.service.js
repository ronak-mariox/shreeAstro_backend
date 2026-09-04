/**
 * Third-party credentials: what the panel's Third Parties tab reads and
 * writes, and what each integration (email, sms, s3, push, appleAuth
 * services) reads to know whether it has something to work with.
 *
 * A saved value is never handed back as-is. `list()`, used by the admin API,
 * returns a masked preview of every secret field — so a credential an admin
 * already saved is never sent back to a browser in the clear. `get()`, used
 * only by the integration services themselves (server-side), returns the
 * real decrypted value.
 */

const Integration = require('../models/Integration');
const ApiError = require('../utils/ApiError');
const { encrypt, decrypt } = require('../utils/crypto');

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
 * The decrypted config for one provider — e.g. `{ host, port, username,
 * password }` for `email` — or `null` if it has never been saved.
 */
async function get(provider) {
  const row = await Integration.findOne({ provider });
  if (!row?.enabled || !row.config) {
    return null;
  }
  return decrypt(row.config);
}

/** Every provider, with masked values for the panel's cards. */
async function list() {
  const rows = await Integration.find({});
  const byProvider = new Map(rows.map(row => [row.provider, row]));

  return PROVIDERS.map(provider => {
    const row = byProvider.get(provider);
    const values = row?.config ? decrypt(row.config) || {} : {};

    const masked = {};
    for (const field of PROVIDER_FIELDS[provider]) {
      masked[field.key] = field.secret
        ? maskValue(values[field.key])
        : values[field.key] || null;
    }

    return {
      provider,
      enabled: Boolean(row?.enabled),
      values: masked,
      updatedAt: row?.updatedAt || null,
    };
  });
}

/**
 * Saves a provider's config.
 *
 * A field left blank keeps whatever was already saved for it — the panel
 * never sends a saved secret back for editing (see PROVIDER_FIELDS above), so
 * "blank" has to mean "unchanged", not "clear this", or every save would wipe
 * every secret the admin did not just retype.
 */
async function save(provider, fields, admin) {
  if (!PROVIDERS.includes(provider)) {
    throw ApiError.badRequest('Unknown integration.');
  }

  const row = await Integration.findOne({ provider });
  const current = row?.config ? decrypt(row.config) || {} : {};

  const next = { ...current };
  for (const field of PROVIDER_FIELDS[provider]) {
    const incoming = fields?.[field.key];
    if (incoming !== undefined && String(incoming).trim() !== '') {
      next[field.key] = incoming;
    }
  }

  return Integration.findOneAndUpdate(
    { provider },
    { $set: { config: encrypt(next), enabled: true, updatedBy: admin?._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/** Turns a provider off without losing its saved credentials. */
async function setEnabled(provider, enabled, admin) {
  if (!PROVIDERS.includes(provider)) {
    throw ApiError.badRequest('Unknown integration.');
  }
  return Integration.findOneAndUpdate(
    { provider },
    { $set: { enabled: Boolean(enabled), updatedBy: admin?._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

module.exports = { PROVIDERS, PROVIDER_FIELDS, get, list, save, setEnabled, maskValue };
