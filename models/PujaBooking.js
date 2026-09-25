/**
 * One seeker's booking of one puja on one date and time slot.
 *
 * The puja's name, image, pandit and price are copied in at booking time so
 * the booking still reads correctly if the puja is later edited or archived.
 * A slot is "full" when `maxPerSlot` (on the Puja) `confirmed` rows exist for
 * the same puja + date + time.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const { asRef, randomCode } = require('./Order');

const STATUSES = ['confirmed', 'completed', 'cancelled'];

const pujaBookingSchema = new Schema(
  {
    reference: { type: String, unique: true, index: true, default: () => `PJB-${randomCode()}` },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    puja: { type: Schema.Types.ObjectId, ref: 'Puja', required: true },

    pujaSnapshot: {
      name: { type: String, trim: true },
      imageUrl: { type: String, trim: true },
      panditName: { type: String, trim: true },
      price: { type: Number, min: 0 },
    },

    /** 'YYYY-MM-DD' in IST, and a slot label exactly as listed on the puja. */
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    time: { type: String, required: true, trim: true },

    /** The puja's price at booking; `amount` is what was actually charged after any coupon. */
    subtotal: { type: Number, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    coupon: { type: Schema.Types.ObjectId, ref: 'Coupon' },
    couponCode: { type: String, trim: true, uppercase: true },
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: STATUSES, default: 'confirmed', index: true },

    payment: {
      method: { type: String, default: 'wallet' },
      status: { type: String, enum: ['paid', 'refunded'], default: 'paid' },
      walletTransaction: { type: Schema.Types.ObjectId, ref: 'WalletTransaction' },
      refundTransaction: { type: Schema.Types.ObjectId, ref: 'WalletTransaction' },
    },

    contact: {
      fullName: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true },
      gotra: { type: String, trim: true },
      address: { type: String, trim: true },
    },

    notes: { type: String, trim: true, maxlength: 1000 },
    /** Where the seeker watches the puja live, when the team sets one. */
    streamUrl: { type: String, trim: true },
    adminNote: { type: String, trim: true, maxlength: 1000 },

    rating: { type: Number, min: 1, max: 5, default: null },
    review: { type: String, trim: true, maxlength: 1000 },
    ratedAt: { type: Date },
    /** Taken off the public reviews page by an admin. */
    reviewHidden: { type: Boolean, default: false },
    reviewPinned: { type: Boolean, default: false },
    reviewFlagged: { type: Boolean, default: false },
    reviewFlagReason: { type: String, trim: true },
    reviewReply: { type: String, trim: true, maxlength: 1000 },

    completedAt: { type: Date },
    cancelledAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(doc, ret) {
        if (doc.$isSubdocument) {
          return ret;
        }
        ret.id = String(ret._id);
        delete ret._id;
        ret.user = asRef(ret.user, ['name', 'phone', 'email']);
        ret.puja = asRef(ret.puja, ['slug', 'name', 'imageUrl', 'panditName']);
        ret.coupon = asRef(ret.coupon, ['code']);
        ret.subtotal = ret.subtotal ?? ret.amount;
        ret.discount = ret.discount || 0;
        ret.couponCode = ret.couponCode ?? null;
        ret.total = ret.amount;
        if (ret.payment) {
          ret.payment.walletTransaction = asRef(ret.payment.walletTransaction);
          ret.payment.refundTransaction = asRef(ret.payment.refundTransaction);
        }
        return ret;
      },
    },
  },
);

/** Slot counting: how many confirmed bookings sit on one puja's date + time. */
pujaBookingSchema.index({ puja: 1, date: 1, time: 1, status: 1 });
pujaBookingSchema.index({ user: 1, createdAt: -1 });
pujaBookingSchema.index({ status: 1, date: 1 });

module.exports =
  mongoose.models.PujaBooking || mongoose.model('PujaBooking', pujaBookingSchema);
module.exports.STATUSES = STATUSES;
