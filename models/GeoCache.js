/**
 * A geocoded place, cached forever under the query text that found it.
 *
 * Also permanent, same reasoning as KundliCache: "Mumbai, Maharashtra" always
 * geocodes to the same lat/lon, so there's nothing to expire. Keyed by the
 * normalised query string itself (see services/geo.service.js) rather than a
 * generated id, since that string *is* the natural lookup key for both
 * /geo_details and /timezone_with_dst results.
 */

const { Schema, model } = require('mongoose');

const geoCacheSchema = new Schema(
  {
    /** The normalised place query, e.g. "mumbai, maharashtra". */
    _id: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

module.exports = model('GeoCache', geoCacheSchema);
