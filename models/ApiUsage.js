/**
 * One row per real AstrologyAPI call — never per cache hit.
 *
 * This is the credit guard's ledger (see services/kundliCache.service.js):
 * with 150 total credits on the plan, a caching bug that silently misses
 * would otherwise burn the month's budget in a day with no record of why.
 */

const { Schema, model } = require('mongoose');

const { ASTROLOGY_API_PROVIDER } = require('../config/constants');

const apiUsageSchema = new Schema({
  provider: { type: String, trim: true, default: ASTROLOGY_API_PROVIDER },
  endpoint: { type: String, required: true, trim: true },
  /** Which birth this call was for — absent for place lookups, which aren't metered against the kundli budget. */
  birthHash: { type: String, trim: true },
  /**
   * Which monthly budget this call counts against (see the credit guard in
   * services/kundliCache.service.js) — 'horoscope' draws from its own
   * separate ceiling so a month of daily-horoscope prefetching can never
   * starve kundli generation of credits. Rows written before this field
   * existed have none at all, not 'general' — the guard's own query accounts
   * for that (`category: { $ne: 'horoscope' }` for the general count).
   */
  category: { type: String, enum: ['general', 'horoscope'], default: 'general' },
  calledAt: { type: Date, default: Date.now },
});

/** The credit guard's query: how many calls this provider has made since the start of this month. */
apiUsageSchema.index({ provider: 1, calledAt: 1 });

module.exports = model('ApiUsage', apiUsageSchema);
