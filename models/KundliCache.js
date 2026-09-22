/**
 * One AstrologyAPI response, cached.
 *
 * A kundli never changes for the same birth, so almost every row here is
 * permanent — the rare transit-derived exception (Sade Sati) opts into a TTL
 * via `cachePolicy`/`ttlSeconds` below. One row per (birth, endpoint[,
 * pathParam]) rather than one blob per birth, so adding a new section later
 * never invalidates what's already cached, and a partial batch failure (see
 * services/kundliCache.service.js) only ever leaves the failed sections
 * missing, not the successful ones.
 */

const { Schema, model } = require('mongoose');

const { ASTROLOGY_API_PROVIDER } = require('../config/constants');

const kundliCacheSchema = new Schema(
  {
    /** sha256 of the rounded birth (dob|tob|lat|lon|ayanamsha) — see utils/birthHash.js. */
    birthHash: { type: String, required: true, trim: true },
    /** The provider path this row answers, e.g. "astro_details", "planets/extended". */
    endpoint: { type: String, required: true, trim: true },
    /**
     * Only set for the lazy per-lord antardasha call ("sub_vdasha/:md" — the
     * mahadasha lord, e.g. "Jupiter"); null for the batch endpoints, which are
     * one-per-birth regardless of path.
     */
    pathParam: { type: String, trim: true, default: null },
    /** The provider's response, verbatim — normalisation happens on read, not on write. */
    payload: { type: Schema.Types.Mixed, required: true },
    provider: { type: String, trim: true, default: ASTROLOGY_API_PROVIDER },
    fetchedAt: { type: Date, default: Date.now },
    /**
     * Almost everything here is 'permanent' (a birth never changes). A row
     * this is 'ttl' for (currently only sadhesati_current_status — Saturn's
     * transit moves) is re-checked against `ttlSeconds` on every read; past
     * it, getKundliSection tries a refresh but keeps serving this same row
     * (never deletes it) if that refresh fails — stale beats an error.
     */
    cachePolicy: { type: String, enum: ['permanent', 'ttl'], default: 'permanent' },
    /** Only meaningful when cachePolicy is 'ttl'. */
    ttlSeconds: { type: Number, default: null },
  },
  { timestamps: true },
);

/** The choke point's cache key — one row per birth+endpoint+pathParam, ever. */
kundliCacheSchema.index({ birthHash: 1, endpoint: 1, pathParam: 1 }, { unique: true });

module.exports = model('KundliCache', kundliCacheSchema);
