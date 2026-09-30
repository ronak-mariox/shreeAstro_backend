/**
 * Every movement of loyalty points — the ledger behind `User.loyalty`.
 *
 * Same idea as WalletTransaction: the rows are the truth, the counters on the
 * user are running totals kept for speed (services/loyalty.service.js is the
 * only writer). `points` is signed; `balanceAfter` is what the seeker had once
 * this row applied.
 *
 * `dedupeKey` is what makes an award idempotent — "earn for consultation X"
 * can only ever be claimed once, however many times the hook that awards it
 * happens to run.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const TYPES = ['earn', 'redeem', 'adjust', 'bonus'];
const SOURCE_KINDS = ['consultation', 'order', 'puja', 'referral', 'admin', 'signup'];

const loyaltyTransactionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: TYPES, required: true },
    points: { type: Number, required: true, validate: Number.isInteger },
    reason: { type: String, trim: true, maxlength: 200 },
    source: {
      kind: { type: String, enum: SOURCE_KINDS },
      id: { type: Schema.Types.ObjectId },
    },
    balanceAfter: { type: Number, min: 0 },
    dedupeKey: { type: String, trim: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      versionKey: false,
      transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.dedupeKey;
        if (ret.source && ret.source.id) {
          ret.source.id = String(ret.source.id);
        }
        return ret;
      },
    },
  },
);

loyaltyTransactionSchema.index({ user: 1, createdAt: -1 });
loyaltyTransactionSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

module.exports =
  mongoose.models.LoyaltyTransaction ||
  mongoose.model('LoyaltyTransaction', loyaltyTransactionSchema);
module.exports.TYPES = TYPES;
module.exports.SOURCE_KINDS = SOURCE_KINDS;
