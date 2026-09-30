/**
 * One seeker brought in by another.
 *
 * Created at registration when a valid referral code was given; moves to
 * `rewarded` the first time the referred seeker spends enough (a paid
 * consultation, a delivered order or a completed puja at or above
 * `settings.referral.minFirstSpend`), which is when both wallets are credited.
 * `referred` is unique — an account is referred at most once, ever.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const STATUSES = ['signed_up', 'rewarded', 'void'];

const referralSchema = new Schema(
  {
    referrer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    referred: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    code: { type: String, trim: true, uppercase: true, required: true },
    status: { type: String, enum: STATUSES, default: 'signed_up', index: true },

    /** Copied from settings when the referral was made, so a later change is not retroactive. */
    rewardAmount: { type: Number, default: 0, min: 0 },
    rewardedAt: { type: Date },
    referrerTransaction: { type: Schema.Types.ObjectId, ref: 'WalletTransaction' },
    referredTransaction: { type: Schema.Types.ObjectId, ref: 'WalletTransaction' },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

referralSchema.index({ referrer: 1, createdAt: -1 });

module.exports = mongoose.models.Referral || mongoose.model('Referral', referralSchema);
module.exports.STATUSES = STATUSES;
