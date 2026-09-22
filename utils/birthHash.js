/**
 * The permanent cache key for a birth: same DOB + time + place always yields
 * the same chart, so this is what every KundliCache row is filed under.
 *
 * lat/lon are rounded to 4 decimals BEFORE hashing. Raw geocode floats for the
 * same city land a few 8th-decimals apart between lookups — hashing the raw
 * value would silently miss the cache on almost every request.
 *
 * This doubles as cache invalidation for free: BirthProfile has no edit
 * endpoint today, but if one is ever added, changing dob/tob/place there
 * naturally produces a different hash, which is a natural cache miss under
 * the new hash — kundli.service.js's countMissingSections/runBatch already
 * handle a birth with nothing cached yet. No explicit KundliCache deletion is
 * needed; the old rows under the old hash are simply never read again.
 */

const crypto = require('crypto');

function computeBirthHash({ dob, tob, lat, lon, ayanamsha }) {
  const key = `${dob}|${tob}|${Number(lat).toFixed(4)}|${Number(lon).toFixed(4)}|${ayanamsha}`;
  return crypto.createHash('sha256').update(key).digest('hex');
}

module.exports = { computeBirthHash };
