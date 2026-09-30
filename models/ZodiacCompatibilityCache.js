/**
 * One sun-sign pair's compatibility from AstrologyAPI, cached for good.
 *
 * Sign-to-sign compatibility is a fixed text + percentage — it never changes
 * from day to day — so there is no date in this key and no TTL: each ordered
 * pair (sign, partnerSign) is fetched from the provider exactly once in the
 * lifetime of the deployment (see services/zodiacCompatibility.service.js).
 */

const { Schema, model } = require('mongoose');

const { ASTROLOGY_API_PROVIDER } = require('../config/constants');

const zodiacCompatibilityCacheSchema = new Schema(
  {
    /** Lowercase, e.g. "leo" — see utils/zodiac.js. */
    sign: { type: String, required: true, trim: true, lowercase: true },
    partnerSign: { type: String, required: true, trim: true, lowercase: true },
    /** The provider's response, verbatim — normalisation happens on read. */
    payload: { type: Schema.Types.Mixed, required: true },
    provider: { type: String, trim: true, default: ASTROLOGY_API_PROVIDER },
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

zodiacCompatibilityCacheSchema.index({ sign: 1, partnerSign: 1 }, { unique: true });

module.exports = model('ZodiacCompatibilityCache', zodiacCompatibilityCacheSchema);
