/**
 * A discount code — FIRST50, FESTIVE30 — the offers page lists and a seeker
 * types in at checkout, on a puja booking, or when adding money.
 *
 * `appliesTo` says where a code may be used; `perUserLimit` and `usageLimit`
 * are enforced through CouponRedemption rows (one per use), never by trusting
 * a counter alone. `usedCount` is the running total those rows add up to,
 * moved with a guarded `$inc` in services/coupon.service.js.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const KINDS = ['percent', 'flat'];
const CONTEXTS = ['order', 'puja', 'topup'];
const STATUSES = ['active', 'paused', 'expired'];
const TONES = ['orange', 'purple', 'green', 'blue'];

const couponSchema = new Schema(
  {
    code: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      unique: true,
      index: true,
      minlength: 3,
      maxlength: 20,
      match: [/^[A-Z0-9]+$/, 'A code is letters and digits only.'],
    },
    title: { type: String, trim: true, required: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 300 },

    kind: { type: String, enum: KINDS, required: true },
    /** Percent for `percent`, whole rupees for `flat`. */
    value: { type: Number, required: true, min: 1, validate: Number.isInteger },
    /** Percent coupons only: the most a single use may take off. */
    maxDiscount: { type: Number, default: null, min: 0 },
    minAmount: { type: Number, default: 0, min: 0, validate: Number.isInteger },

    appliesTo: {
      type: [{ type: String, enum: CONTEXTS }],
      validate: {
        validator: list => Array.isArray(list) && list.length > 0,
        message: 'Pick at least one place the coupon applies to.',
      },
    },

    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    /** Total uses across everyone; null is unlimited. */
    usageLimit: { type: Number, default: null, min: 1 },
    perUserLimit: { type: Number, default: 1, min: 1, validate: Number.isInteger },
    usedCount: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: STATUSES, default: 'active', index: true },
    /** Listed on the offers page — a private code still works when typed. */
    isPublic: { type: Boolean, default: true },

    tag: { type: String, trim: true, maxlength: 30 },
    tone: { type: String, enum: TONES, default: 'orange' },

    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        ret.label = doc.label;
        return ret;
      },
    },
  },
);

couponSchema.index({ status: 1, isPublic: 1, validTo: 1 });

/** "50% OFF" / "₹200 OFF" — what the coupon card prints big. */
couponSchema.virtual('label').get(function label() {
  return this.kind === 'percent' ? `${this.value}% OFF` : `₹${this.value} OFF`;
});

/** What this coupon takes off `amount`, in whole rupees — never more than the amount itself. */
couponSchema.methods.discountFor = function discountFor(amount) {
  const base = Math.max(Math.round(Number(amount)) || 0, 0);
  let discount =
    this.kind === 'percent' ? Math.round((base * this.value) / 100) : this.value;
  if (this.kind === 'percent' && this.maxDiscount) {
    discount = Math.min(discount, this.maxDiscount);
  }
  return Math.max(Math.min(discount, base), 0);
};

/** Within its own date window, and switched on. */
couponSchema.methods.isLive = function isLive(at = new Date()) {
  if (this.status !== 'active') return false;
  if (this.validFrom && this.validFrom > at) return false;
  if (this.validTo && this.validTo < at) return false;
  return true;
};

/** The offers page and the validate response — no limits, no audit trail. */
couponSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: String(this._id),
    code: this.code,
    title: this.title,
    description: this.description ?? null,
    kind: this.kind,
    value: this.value,
    maxDiscount: this.maxDiscount ?? null,
    minAmount: this.minAmount || 0,
    appliesTo: this.appliesTo || [],
    validTo: this.validTo ?? null,
    tag: this.tag ?? null,
    tone: this.tone,
    label: this.label,
  };
};

module.exports = mongoose.models.Coupon || mongoose.model('Coupon', couponSchema);
module.exports.KINDS = KINDS;
module.exports.CONTEXTS = CONTEXTS;
module.exports.STATUSES = STATUSES;
module.exports.TONES = TONES;
