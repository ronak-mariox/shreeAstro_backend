/**
 * Every movement of money, for a seeker or an astrologer.
 *
 * One row per movement, and the row is the truth. `User.wallet.balance` and
 * `Astrologer.earnings.balance` are running totals kept for speed — they are
 * only ever changed by posting a transaction here (see services/wallet.service.js),
 * never written directly.
 *
 * `direction` says which way the money went:
 *   credit  money came in   (top-up, consultation earning, refund)
 *   debit   money went out  (consultation charge, withdrawal)
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

/** Who the wallet belongs to. */
const OWNER_ROLES = ['user', 'astrologer'];

const DIRECTIONS = ['credit', 'debit'];

/** Why the money moved. The app groups its ledger by this. */
const TRANSACTION_TYPES = [
  'topup',
  'consultation_charge',
  'consultation_earning',
  'refund',
  'withdrawal',
  'commission',
  'bonus',
  'adjustment',
];

const STATUSES = ['pending', 'success', 'failed', 'cancelled'];

const walletTransactionSchema = new Schema(
  {
    /** Human-facing reference the app prints, e.g. "TXN-8FA21C". */
    reference: { type: String, unique: true, index: true },

    ownerRole: { type: String, enum: OWNER_ROLES, required: true },
    /** A User id or an Astrologer id, depending on ownerRole. */
    owner: { type: Schema.Types.ObjectId, required: true, index: true },

    direction: { type: String, enum: DIRECTIONS, required: true },
    type: { type: String, enum: TRANSACTION_TYPES, required: true },
    status: { type: String, enum: STATUSES, default: 'success', index: true },

    /** Rupees, always positive — `direction` carries the sign. */
    amount: { type: Number, required: true, min: 0 },
    /** The wallet balance straight after this row was applied. */
    balanceAfter: { type: Number, min: 0 },
    currency: { type: String, default: 'INR' },

    /** One line for the ledger row, e.g. "Chat with Pt. Rajesh Sharma". */
    title: { type: String, trim: true },
    description: { type: String, trim: true },

    /** What this movement was about, when it came from a consultation. */
    chatSession: { type: Schema.Types.ObjectId, ref: 'ChatSession' },

    /** Payment-gateway details, for a top-up. */
    payment: {
      gateway: { type: String, trim: true },
      orderId: { type: String, trim: true },
      paymentId: { type: String, trim: true },
      method: { type: String, trim: true },
      failureReason: { type: String, trim: true },
    },

    /** Set when an admin created or reversed the row by hand. */
    createdByAdmin: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true },
);

/** The ledger screens: one owner's rows, newest first. */
walletTransactionSchema.index({ owner: 1, createdAt: -1 });
walletTransactionSchema.index({ type: 1, createdAt: -1 });

/** Gives every row a reference before it is saved. */
walletTransactionSchema.pre('validate', function setReference() {
  if (!this.reference) {
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    this.reference = `TXN-${random}`;
  }
});

module.exports =
  mongoose.models.WalletTransaction ||
  mongoose.model('WalletTransaction', walletTransactionSchema);
module.exports.OWNER_ROLES = OWNER_ROLES;
module.exports.TRANSACTION_TYPES = TRANSACTION_TYPES;
module.exports.DIRECTIONS = DIRECTIONS;
