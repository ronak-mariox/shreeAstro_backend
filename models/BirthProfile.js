/**
 * One birth — DOB + time + place — a user has generated a kundli for.
 *
 * Deliberately its own top-level collection, not another entry in
 * UserProfile.savedKundlis: `birthHash` here is the exact key every
 * KundliCache row is filed under, and `GET /kundli/:profileId` resolves
 * straight off this document's `_id`. Keeping it separate also means two
 * different users who share an identical birth (twins, or simply the same
 * DOB/time/place typed twice) reuse one KundliCache instead of paying for it
 * twice — a lookup this profile's birthHash could not do if it were buried
 * inside a per-user embedded array.
 */

const { Schema, model } = require('mongoose');

const { birthDetailsSchema } = require('./common');

const birthProfileSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** "Self", "My Wife", ... — same vocabulary as the old savedKundli entries. */
    label: { type: String, trim: true, maxlength: 60 },
    relation: {
      type: String,
      enum: ['self', 'partner', 'family', 'friend', 'other'],
      default: 'self',
    },
    birthDetails: { type: birthDetailsSchema, required: true },
    /**
     * Decimal UTC offset AT THE BIRTH DATE (from /timezone_with_dst) — e.g.
     * 5.5 for modern India. Stored per-profile rather than re-derived, because
     * historical Indian offsets were not always +5:30 and this must match
     * what the provider was actually called with, not today's zone.
     */
    tzone: { type: Number, required: true },
    /** Always env.astrologyApi.ayanamsha at creation time — kept on the row so a later env change can't retroactively mismatch an existing chart. */
    ayanamsha: { type: String, required: true },
    /** sha256(dob|tob|lat|lon|ayanamsha) — see utils/birthHash.js. What every KundliCache row for this birth is filed under. */
    birthHash: { type: String, required: true, index: true },
    /**
     * Whole-profile status for a quick UI check without a join. Which of the
     * 12 batch sections actually succeeded is always re-derived from
     * KundliCache (query by birthHash), never duplicated here — one source of
     * truth for what's cached.
     */
    status: {
      type: String,
      enum: ['pending', 'ready', 'partial', 'failed'],
      default: 'pending',
    },
    /**
     * Set once, the first time the chart SVG is actually fetched from
     * AstrologyAPI — see services/chartStorage.service.js. Re-fetching the
     * SVG from the provider costs a credit; re-reading this URL costs
     * nothing, which is the entire reason it lives here instead of being
     * re-derived from KundliCache's raw payload on every read.
     */
    chartUrl: { type: String, trim: true },
  },
  { timestamps: true },
);

birthProfileSchema.index({ user: 1, createdAt: -1 });

module.exports = model('BirthProfile', birthProfileSchema);
