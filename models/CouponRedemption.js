/**
 * One use of one coupon by one seeker, on one thing — an order, a booking or
 * a top-up.
 *
 * The unique index is what makes a retried purchase safe: the same order can
 * never redeem the same coupon twice, and counting a seeker's rows is how
 * `perUserLimit` is enforced.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const { CONTEXTS } = require('./Coupon');

const couponRedemptionSchema = new Schema(
  {
    coupon: { type: Schema.Types.ObjectId, ref: 'Coupon', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    context: { type: String, enum: CONTEXTS, required: true },
    /** The order, booking or wallet transaction the discount landed on. */
    reference: { type: Schema.Types.ObjectId, required: true },
    amountBefore: { type: Number, required: true, min: 0 },
    discount: { type: Number, required: true, min: 0 },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
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

couponRedemptionSchema.index({ coupon: 1, user: 1, reference: 1 }, { unique: true });
couponRedemptionSchema.index({ coupon: 1, createdAt: -1 });

module.exports =
  mongoose.models.CouponRedemption ||
  mongoose.model('CouponRedemption', couponRedemptionSchema);
