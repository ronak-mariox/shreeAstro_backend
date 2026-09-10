/**
 * One sun-sign horoscope reading, permanently cached.
 *
 * A sun sign has only 12 possible daily readings across the WHOLE app — one
 * row per (zodiacSign, period, targetDate), same reasoning as KundliCache:
 * caching by the outcome's own natural key, not by which request shape asked
 * for it. `period` is stored from day one even though only 'daily' has a
 * provider call wired up yet (see services/horoscopeCache.service.js), so
 * adding 'monthly' later never means touching this schema.
 */

const { Schema, model } = require('mongoose');

const { ASTROLOGY_API_PROVIDER } = require('../config/constants');

const horoscopeCacheSchema = new Schema(
  {
    /** Lowercase, e.g. "leo" — see utils/zodiac.js. */
    zodiacSign: { type: String, required: true, trim: true, lowercase: true },
    period: { type: String, required: true, trim: true, enum: ['daily', 'monthly'], default: 'daily' },
    /** "YYYY-MM-DD" — the date this reading is FOR, not when it was fetched. */
    targetDate: { type: String, required: true },
    /** The provider's response, verbatim — normalisation happens on read, not on write. */
    payload: { type: Schema.Types.Mixed, required: true },
    /** Lucky number/colour/energy — computed once at cache-miss time and stored here, never recomputed on read. */
    derived: { type: Schema.Types.Mixed, required: true },
    provider: { type: String, trim: true, default: ASTROLOGY_API_PROVIDER },
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

/** The choke point's cache key — one row per sign+period+date, ever. */
horoscopeCacheSchema.index({ zodiacSign: 1, period: 1, targetDate: 1 }, { unique: true });

module.exports = model('HoroscopeCache', horoscopeCacheSchema);
