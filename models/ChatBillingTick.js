/**
 * One row per minute actually billed on a consultation — the idempotency
 * ledger behind the live billing tick (services/chat.service.js's
 * billNextMinute, run by jobs/chatBilling.job.js).
 *
 * The unique index on (chatSession, minuteNumber) is what makes the tick job
 * safe to run twice for the same minute — a re-run after a crash, or two
 * overlapping sweeps, both try to insert the same row and only one wins; see
 * MONGO_DUPLICATE_KEY handling at the call site, the same pattern
 * KundliCache/GeoCache already use for the same reason.
 */

const { Schema, model } = require('mongoose');

const chatBillingTickSchema = new Schema(
  {
    chatSession: { type: Schema.Types.ObjectId, ref: 'ChatSession', required: true },
    /** 1-indexed — the Nth minute of this session, free or paid. */
    minuteNumber: { type: Number, required: true, min: 1 },
    /** Rupees actually charged for this minute — 0 for a free minute, never negative. */
    amount: { type: Number, required: true, min: 0 },
    /** Absent for a free minute, which moves no money. */
    walletTransaction: { type: Schema.Types.ObjectId, ref: 'WalletTransaction' },
    billedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

/** The choke point's idempotency key — one row per session+minute, ever. */
chatBillingTickSchema.index({ chatSession: 1, minuteNumber: 1 }, { unique: true });

module.exports = model('ChatBillingTick', chatBillingTickSchema);
