/**
 * One day's panchang for one place, cached for a day.
 *
 * The website's Panchang page is the same for every visitor (it is computed
 * for the one place in config/env.js's `panchang`), so the natural key is
 * (date, place) — one row per calendar day, filled by the first request of
 * that day and served from here to everyone after. Unlike KundliCache and
 * HoroscopeCache this is NOT permanent: a TTL index drops a row 24 hours
 * after it was written, so the collection never grows past a month or so of
 * days that were actually looked at, and a re-fetch is at most one a day.
 *
 * `payload` is the already-mapped response (see services/panchang.service.js's
 * `mapPanchang`) minus the `cache` block, which is computed on read from
 * `createdAt` — storing the mapped shape rather than the two raw provider
 * responses means a hit costs no mapping work and the shape the site sees
 * never depends on which mapper version wrote the row.
 */

const { Schema, model } = require('mongoose');

const { ASTROLOGY_API_PROVIDER } = require('../config/constants');

/** How long a row lives — a panchang changes every day, so a day. */
const PANCHANG_TTL_SECONDS = 24 * 60 * 60;

const panchangCacheSchema = new Schema({
  /** "YYYY-MM-DD" — the IST calendar date this panchang is FOR. */
  date: { type: String, required: true },
  /** "lat,lon", each to 4 decimals — see services/panchang.service.js's `locationKeyFor`. */
  locationKey: { type: String, required: true },
  /** The full mapped response minus `cache`. */
  payload: { type: Schema.Types.Mixed, required: true },
  provider: { type: String, trim: true, default: ASTROLOGY_API_PROVIDER },
  /** When the provider was called — the TTL clock, and `cache.fetchedAt` on read. */
  createdAt: { type: Date, default: Date.now },
});

/** The choke point's cache key — one row per day per place, ever. */
panchangCacheSchema.index({ date: 1, locationKey: 1 }, { unique: true });

/** Mongo deletes a row itself once it is a day old. */
panchangCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: PANCHANG_TTL_SECONDS });

const PanchangCache = model('PanchangCache', panchangCacheSchema);

module.exports = PanchangCache;
module.exports.PANCHANG_TTL_SECONDS = PANCHANG_TTL_SECONDS;
