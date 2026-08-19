/**
 * Platform settings, and a small cache in front of them.
 *
 * These are read on almost every money path — the recharge limits, the
 * commission, the free trial minutes — so reading the document from Mongo every
 * time would be wasteful. It is cached for a few seconds instead, which is
 * short enough that a change made in the panel takes effect while you are still
 * looking at the screen.
 *
 * `update()` clears the cache itself, so a change is visible immediately on the
 * server that made it.
 */

const Settings = require('../models/Settings');

/** How long a cached copy is trusted, in milliseconds. */
const CACHE_MS = 10000;

let cached = null;
let cachedAt = 0;

/** The settings document, from cache when it is fresh enough. */
async function get() {
  if (cached && Date.now() - cachedAt < CACHE_MS) {
    return cached;
  }

  cached = await Settings.load();
  cachedAt = Date.now();
  return cached;
}

/** Throws the cache away — call after anything writes settings. */
function invalidate() {
  cached = null;
  cachedAt = 0;
}

/** Applies a change from the panel and returns the new settings. */
async function update(changes, admin) {
  const settings = await Settings.load();

  const numbers = [
    'commissionPercent', 'minRecharge', 'maxRecharge', 'minPayout', 'freeTrialMinutes',
  ];
  for (const field of numbers) {
    if (changes[field] !== undefined) {
      settings[field] = Number(changes[field]);
    }
  }
  if (changes.payoutCycle) {
    settings.payoutCycle = changes.payoutCycle;
  }
  if (changes.supportEmail !== undefined) {
    settings.supportEmail = changes.supportEmail;
  }
  if (changes.supportPhone !== undefined) {
    settings.supportPhone = changes.supportPhone;
  }

  /** Merged one key at a time, so sending one switch does not clear the rest. */
  for (const key of Object.keys(changes.features || {})) {
    settings.features[key] = Boolean(changes.features[key]);
  }
  for (const key of Object.keys(changes.appVersions || {})) {
    settings.appVersions[key] = changes.appVersions[key];
  }

  settings.updatedBy = admin?._id;
  await settings.save();

  invalidate();
  return settings;
}

/**
 * The subset the apps are allowed to read without being an admin — what they
 * need to draw a screen correctly, and nothing about the business.
 */
async function publicSettings() {
  const settings = await get();

  return {
    minRecharge: settings.minRecharge,
    maxRecharge: settings.maxRecharge,
    minPayout: settings.minPayout,
    freeTrialMinutes: settings.freeTrialMinutes,
    features: {
      registrationsOpen: settings.features.registrationsOpen,
      appleSignIn: settings.features.appleSignIn,
      googleSignIn: settings.features.googleSignIn,
      aiAssistant: settings.features.aiAssistant,
      voiceConsultations: settings.features.voiceConsultations,
      maintenanceMode: settings.features.maintenanceMode,
    },
    appVersions: settings.appVersions,
    supportEmail: settings.supportEmail,
    supportPhone: settings.supportPhone,
  };
}

module.exports = { get, update, invalidate, publicSettings };
