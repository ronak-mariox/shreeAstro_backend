/**
 * An astrologer asking to be paid out (astro_app Withdraw Money).
 *
 * The money is moved out of the withdrawable balance as soon as the request is
 * made, and sits in `earnings.pendingWithdrawal` until an admin approves or
 * rejects it. Rejecting puts it back.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const STATUSES = ['pending', 'approved', 'paid', 'rejected', 'cancelled'];

const withdrawalSchema = new Schema(
  {
    reference: { type: String, unique: true, index: true },

    astrologer: {
      type: Schema.Types.ObjectId,
      ref: 'Astrologer',
      required: true,
      index: true,
    },

    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, default: 'INR' },

    /**
     * A copy of the bank account as it was when the request was made, so a
     * later edit to the account cannot change the history of a past payout.
     */
    bankAccount: {
      holderName: { type: String, trim: true },
      bankName: { type: String, trim: true },
      accountNumber: { type: String, trim: true },
      ifsc: { type: String, trim: true, uppercase: true },
      upiId: { type: String, trim: true },
    },

    status: { type: String, enum: STATUSES, default: 'pending', index: true },
    /**
     * When the money leaves `earnings.balance`. Requests are now settled only
     * on approval ('on_approval'): the balance is untouched while the admin
     * decides, and the amount is merely reserved in `earnings.pendingWithdrawal`.
     * Older rows (no value stored) were deducted at request time and are
     * refunded on rejection — the default keeps them on that path.
     */
    deduction: { type: String, enum: ['on_request', 'on_approval'], default: 'on_request' },
    requestedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    rejectionReason: { type: String, trim: true },

    /** Bank/UPI reference once the transfer has actually been made. */
    payoutReference: { type: String, trim: true },
    paidAt: { type: Date },
  },
  { timestamps: true },
);

withdrawalSchema.index({ astrologer: 1, createdAt: -1 });
withdrawalSchema.index({ status: 1, requestedAt: -1 });

withdrawalSchema.pre('validate', function setReference() {
  if (!this.reference) {
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    this.reference = `WDL-${random}`;
  }
});

module.exports =
  mongoose.models.Withdrawal || mongoose.model('Withdrawal', withdrawalSchema);
module.exports.STATUSES = STATUSES;
