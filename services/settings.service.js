/**
 * Platform settings, and a small cache in front of them.
 *
 * These are read on almost every money path — the recharge limits, the
 * commission — so reading the document from Mongo every time would be
 * wasteful. It is cached for a few seconds instead, which is short enough
 * that a change made in the panel takes effect while you are still looking
 * at the screen.
 *
 * `update()` clears the cache itself, so a change is visible immediately on the
 * server that made it.
 */

const Settings = require('../models/Settings');
const ApiError = require('../utils/ApiError');
const { mergePackageDiscounts } = require('../config/packages');

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
    'commissionPercent', 'minRecharge', 'maxRecharge', 'minPayout',
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

  /** One entry per package; entries not sent keep their current discount. */
  if (changes.packageDiscounts !== undefined) {
    try {
      settings.packageDiscounts = mergePackageDiscounts(changes.packageDiscounts, settings.packageDiscounts);
    } catch (error) {
      throw ApiError.badRequest(error.message, { packageDiscounts: error.message });
    }
  }

  /** Merged one key at a time, so sending one switch does not clear the rest. */
  for (const key of Object.keys(changes.features || {})) {
    settings.features[key] = Boolean(changes.features[key]);
  }
  for (const key of Object.keys(changes.appVersions || {})) {
    settings.appVersions[key] = changes.appVersions[key];
  }

  /** Loyalty and referral, the same way: only what was sent changes. */
  if (changes.loyalty && typeof changes.loyalty === 'object') {
    const loyalty = changes.loyalty;
    if (loyalty.enabled !== undefined) settings.loyalty.enabled = Boolean(loyalty.enabled);
    if (loyalty.cashbackEnabled !== undefined) settings.loyalty.cashbackEnabled = Boolean(loyalty.cashbackEnabled);
    for (const key of ['referralBonusPoints', 'signupBonusPoints']) {
      if (loyalty[key] !== undefined) settings.loyalty[key] = Math.max(Number(loyalty[key]) || 0, 0);
    }
    for (const key of Object.keys(loyalty.pointsPer100 || {})) {
      if (['chat', 'call', 'order', 'puja'].includes(key)) {
        settings.loyalty.pointsPer100[key] = Math.max(Number(loyalty.pointsPer100[key]) || 0, 0);
      }
    }
    if (Array.isArray(loyalty.tiers)) {
      const keys = new Set();
      const tiers = loyalty.tiers.map(tier => {
        const key = String(tier?.key || '').toLowerCase();
        if (!['silver', 'gold', 'platinum', 'diamond'].includes(key) || keys.has(key)) {
          throw ApiError.badRequest('Tiers must be silver, gold, platinum and diamond, each once.', {
            'loyalty.tiers': 'Unknown or repeated tier.',
          });
        }
        keys.add(key);
        return {
          key,
          minPoints: Math.max(Number(tier.minPoints) || 0, 0),
          cashbackPercent: Math.min(Math.max(Number(tier.cashbackPercent) || 0, 0), 100),
        };
      });
      if (tiers.length !== 4) {
        throw ApiError.badRequest('Send all four tiers.', { 'loyalty.tiers': 'All four tiers are required.' });
      }
      settings.loyalty.tiers = tiers.sort((a, b) => a.minPoints - b.minPoints);
    }
  }
  if (changes.referral && typeof changes.referral === 'object') {
    const referral = changes.referral;
    if (referral.enabled !== undefined) settings.referral.enabled = Boolean(referral.enabled);
    for (const key of ['rewardAmount', 'minFirstSpend']) {
      if (referral[key] !== undefined) settings.referral[key] = Math.max(Math.round(Number(referral[key])) || 0, 0);
    }
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
    loyalty: {
      enabled: settings.loyalty?.enabled !== false,
      pointsPer100: settings.loyalty?.pointsPer100,
      referralBonusPoints: settings.loyalty?.referralBonusPoints,
      signupBonusPoints: settings.loyalty?.signupBonusPoints,
      tiers: settings.loyalty?.tiers,
      cashbackEnabled: Boolean(settings.loyalty?.cashbackEnabled),
    },
    referral: {
      enabled: settings.referral?.enabled !== false,
      rewardAmount: settings.referral?.rewardAmount,
      minFirstSpend: settings.referral?.minFirstSpend,
    },
  };
}

module.exports = { get, update, invalidate, publicSettings };
