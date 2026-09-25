/**
 * A store order — what a seeker bought, what they paid, and where it is.
 *
 * Prices are copied onto the line items at purchase time, so a later price
 * change on the product never rewrites history. Payment is always the wallet:
 * the debit row is linked as `payment.walletTransaction`, and a cancellation
 * links its refund credit as `payment.refundTransaction`.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const STATUSES = ['placed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];
/** The statuses an order can still be cancelled from by the seeker. */
const USER_CANCELLABLE = ['placed', 'packed'];
/** The statuses the "active" tab in the app shows. */
const ACTIVE_STATUSES = ['placed', 'packed', 'shipped', 'out_for_delivery'];

/** Six uppercase alphanumerics, e.g. "8FA21C". */
const randomCode = () => Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');

const TAX_PERCENT = 18;
const FREE_SHIPPING_FROM = 999;
const SHIPPING_FEE = 49;

const orderItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, trim: true, required: true },
    imageUrl: { type: String, trim: true },
    /** Unit price at purchase. */
    price: { type: Number, required: true, min: 0 },
    qty: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const trackingSchema = new Schema(
  {
    status: { type: String, enum: STATUSES, required: true },
    note: { type: String, trim: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    /** Set the moment the document is built, so the wallet row can name it before the save. */
    reference: { type: String, unique: true, index: true, default: () => `ORD-${randomCode()}` },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    items: { type: [orderItemSchema], required: true },
    subtotal: { type: Number, required: true, min: 0 },
    tax: { type: Number, required: true, min: 0 },
    shippingFee: { type: Number, required: true, min: 0 },
    /** What a coupon took off the subtotal; `total` is already net of it. */
    discount: { type: Number, default: 0, min: 0 },
    coupon: { type: Schema.Types.ObjectId, ref: 'Coupon' },
    couponCode: { type: String, trim: true, uppercase: true },
    total: { type: Number, required: true, min: 0 },

    status: { type: String, enum: STATUSES, default: 'placed', index: true },

    payment: {
      method: { type: String, default: 'wallet' },
      status: { type: String, enum: ['paid', 'refunded'], default: 'paid' },
      walletTransaction: { type: Schema.Types.ObjectId, ref: 'WalletTransaction' },
      refundTransaction: { type: Schema.Types.ObjectId, ref: 'WalletTransaction' },
    },

    shipping: {
      fullName: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true },
      address: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
    },

    tracking: { type: [trackingSchema], default: [] },

    cancelledAt: { type: Date },
    deliveredAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(doc, ret) {
        /** Line items and tracking rows go through here too; they need nothing. */
        if (doc.$isSubdocument) {
          return ret;
        }
        ret.id = String(ret._id);
        delete ret._id;
        ret.user = asRef(ret.user, ['name', 'phone', 'email']);
        ret.coupon = asRef(ret.coupon, ['code']);
        ret.discount = ret.discount || 0;
        ret.couponCode = ret.couponCode ?? null;
        ret.items = (ret.items || []).map(item => ({
          ...item,
          product: asRef(item.product, ['slug', 'name', 'imageUrl']),
        }));
        if (ret.payment) {
          ret.payment.walletTransaction = asRef(ret.payment.walletTransaction);
          ret.payment.refundTransaction = asRef(ret.payment.refundTransaction);
        }
        return ret;
      },
    },
  },
);

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

/**
 * A ref as a string id, or — when it was populated — a small object carrying
 * `id` plus the named fields. `phone` is the split sub-document on User; it is
 * flattened to the number the panel prints.
 */
function asRef(value, fields = []) {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === 'object') {
    /** A populated Product has already been through its own toJSON, which renames `_id` to `id`. */
    const out = { id: String(value._id ?? value.id) };
    for (const field of fields) {
      if (value[field] === undefined) continue;
      out[field] =
        field === 'phone' && value.phone && typeof value.phone === 'object'
          ? value.phone.number
            ? `${value.phone.countryCode || ''}${value.phone.number}`
            : undefined
          : value[field];
    }
    return out;
  }
  return String(value);
}

/** The bill for a set of `{ price, qty }` lines, in whole rupees. */
orderSchema.statics.totalsFor = function totalsFor(items) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const tax = Math.round((subtotal * TAX_PERCENT) / 100);
  const shippingFee = subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING_FEE;
  return { subtotal, tax, shippingFee, total: subtotal + tax + shippingFee };
};

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);
module.exports.STATUSES = STATUSES;
module.exports.USER_CANCELLABLE = USER_CANCELLABLE;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
module.exports.TAX_PERCENT = TAX_PERCENT;
module.exports.FREE_SHIPPING_FROM = FREE_SHIPPING_FROM;
module.exports.SHIPPING_FEE = SHIPPING_FEE;
module.exports.asRef = asRef;
module.exports.randomCode = randomCode;
