/**
 * One row per package bought on a consultation — the initial package and
 * every extension — and the idempotency ledger behind them
 * (services/chat.service.js's purchasePackage).
 *
 * Same pattern as ChatBillingTick: the unique index on (chatSession, seq) is
 * what makes a double-tapped "Extend" or a retried accept safe. Two racing
 * purchases both try to insert the same `seq` and only one wins; the loser's
 * debit lives in the same Mongo transaction, so it is rolled back rather
 * than charged and refunded after the fact.
 */

const { Schema, model } = require('mongoose');

const chatPackagePurchaseSchema = new Schema(
  {
    chatSession: { type: Schema.Types.ObjectId, ref: 'ChatSession', required: true },
    /** 1 for the package the session started on, 2+ for each extension. */
    seq: { type: Number, required: true, min: 1 },
    kind: { type: String, enum: ['initial', 'extension'], required: true },
    minutes: { type: Number, required: true, min: 1 },
    ratePerMinute: { type: Number, required: true, min: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    /** minutes × rate, before the admin's package discount. */
    originalAmount: { type: Number, min: 0 },
    /** Rupees actually debited for this package (after the discount). */
    amount: { type: Number, required: true, min: 0 },
    walletTransaction: { type: Schema.Types.ObjectId, ref: 'WalletTransaction' },
    purchasedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

chatPackagePurchaseSchema.index({ chatSession: 1, seq: 1 }, { unique: true });

module.exports = model('ChatPackagePurchase', chatPackagePurchaseSchema);
