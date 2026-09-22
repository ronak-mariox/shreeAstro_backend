/**
 * Platform settings — the panel's Settings page, as one document.
 *
 * There is only ever **one** of these. `Settings.load()` fetches it and creates
 * it with the defaults below the first time it is asked for, so nothing has to
 * be seeded and no code ever has to handle "settings are missing".
 *
 * Anything read from here is a number or a switch the business changes without
 * a deploy: the commission, the recharge limits, whether registrations are open.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const settingsSchema = new Schema(
  {
    /** Always "platform" — the key that keeps this document unique. */
    key: { type: String, default: 'platform', unique: true, index: true },

    /** Money rules. */
    commissionPercent: { type: Number, default: 25, min: 0, max: 100 },
    minRecharge: { type: Number, default: 10, min: 1 },
    maxRecharge: { type: Number, default: 100000, min: 1 },
    minPayout: { type: Number, default: 100, min: 1 },
    payoutCycle: {
      type: String,
      enum: ['daily', 'weekly', 'fortnightly', 'monthly'],
      default: 'weekly',
    },

    /**
     * The discount on each consultation package, in percent — edited on the
     * panel's Settings → Platform page. Durations themselves live in
     * config/packages.js; an offered duration with no entry here is simply
     * undiscounted. Read by every package price the server quotes or charges
     * (see config/packages.js's packagesWithDiscounts).
     */
    packageDiscounts: {
      type: [
        new Schema(
          {
            minutes: { type: Number, required: true, min: 1 },
            discountPercent: { type: Number, required: true, min: 0, max: 90 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    /** Parts of the product that can be switched off without a deploy. */
    features: {
      registrationsOpen: { type: Boolean, default: true },
      appleSignIn: { type: Boolean, default: false },
      googleSignIn: { type: Boolean, default: false },
      aiAssistant: { type: Boolean, default: true },
      voiceConsultations: { type: Boolean, default: true },
      /** When on, a new astrologer is listed without an admin approving them. */
      autoApproveAstrologers: { type: Boolean, default: false },
      /** When on, the apps refuse everything but /health and /settings. */
      maintenanceMode: { type: Boolean, default: false },
      /** A code to the admin's email on every panel sign-in. */
      adminTwoFactor: { type: Boolean, default: true },
    },

    /** What the apps check themselves against on launch. */
    appVersions: {
      userAndroid: { type: String, default: '1.0.0' },
      userIos: { type: String, default: '1.0.0' },
      astrologerAndroid: { type: String, default: '1.0.0' },
      astrologerIos: { type: String, default: '1.0.0' },
      minimumSupported: { type: String, default: '1.0.0' },
    },

    supportEmail: { type: String, trim: true, default: 'support@shreeastro.com' },
    supportPhone: { type: String, trim: true },

    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true },
);

/**
 * The one settings document, created with defaults if it does not exist yet.
 *
 * `upsert` means two requests arriving at once cannot create two of them.
 */
settingsSchema.statics.load = function load() {
  return this.findOneAndUpdate(
    { key: 'platform' },
    { $setOnInsert: { key: 'platform' } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
};

module.exports = mongoose.models.Settings || mongoose.model('Settings', settingsSchema);
