/**
 * A puja the platform performs on a seeker's behalf — Rudrabhishek, Navgraha,
 * a personalised ritual.
 *
 * Each puja offers the same fixed list of daily time slots; `maxPerSlot` is how
 * many bookings one slot takes before it is full. Bookings are counted, not
 * stored here (see models/PujaBooking.js).
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const { applySlug } = require('../utils/slug');

const STATUSES = ['active', 'hidden', 'archived'];

const DEFAULT_TIME_SLOTS = [
  '6:00 AM', '7:00 AM', '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM',
  '1:00 PM', '2:00 PM', '3:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM',
];

const pujaSchema = new Schema(
  {
    name: { type: String, trim: true, required: true, maxlength: 120 },
    slug: { type: String, trim: true, lowercase: true, unique: true, index: true },
    tagline: { type: String, trim: true, maxlength: 200 },

    /** Lowercase-kebab: 'shiva', 'health', 'prosperity', 'home-vastu', 'planetary', 'custom'. */
    category: { type: String, trim: true, lowercase: true, index: true },
    /** How the category is printed: 'Health & Protection'. */
    categoryLabel: { type: String, trim: true },
    badge: { type: String, trim: true, default: null },
    deity: { type: String, trim: true },

    imageUrl: { type: String, trim: true },
    description: { type: String, trim: true, maxlength: 5000 },
    benefits: [{ type: String, trim: true }],

    price: { type: Number, required: true, min: 0, validate: Number.isInteger },
    oldPrice: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator(value) {
          return value === null || value === undefined || (Number.isInteger(value) && value > this.price);
        },
        message: 'The old price must be higher than the price.',
      },
    },
    durationText: { type: String, trim: true },
    panditName: { type: String, trim: true },

    timeSlots: { type: [{ type: String, trim: true }], default: () => [...DEFAULT_TIME_SLOTS] },
    maxPerSlot: { type: Number, default: 3, min: 1, validate: Number.isInteger },

    rating: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    /**
     * Bookings ever taken. Also the document every booking of this puja
     * touches inside its transaction, which is what serialises two bookings
     * racing for the last place in a slot — see createBooking.
     */
    bookingCount: { type: Number, default: 0, min: 0 },

    isFeatured: { type: Boolean, default: false },
    status: { type: String, enum: STATUSES, default: 'active', index: true },

    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        ret.discountPercent = doc.discountPercent;
        return ret;
      },
    },
  },
);

pujaSchema.index({ status: 1, category: 1 });

pujaSchema.virtual('discountPercent').get(function discountPercent() {
  if (!this.oldPrice || this.oldPrice <= this.price) {
    return 0;
  }
  return Math.round(((this.oldPrice - this.price) / this.oldPrice) * 100);
});

pujaSchema.pre('validate', async function setSlug() {
  await applySlug(this, 'name');
});

pujaSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: String(this._id),
    slug: this.slug,
    name: this.name,
    tagline: this.tagline ?? null,
    category: this.category ?? null,
    categoryLabel: this.categoryLabel ?? null,
    badge: this.badge ?? null,
    deity: this.deity ?? null,
    imageUrl: this.imageUrl ?? null,
    description: this.description ?? null,
    benefits: this.benefits || [],
    price: this.price,
    oldPrice: this.oldPrice ?? null,
    discountPercent: this.discountPercent,
    durationText: this.durationText ?? null,
    panditName: this.panditName ?? null,
    rating: this.rating,
    ratingCount: this.ratingCount,
    isFeatured: this.isFeatured,
    timeSlots: this.timeSlots || [],
  };
};

module.exports = mongoose.models.Puja || mongoose.model('Puja', pujaSchema);
module.exports.STATUSES = STATUSES;
module.exports.DEFAULT_TIME_SLOTS = DEFAULT_TIME_SLOTS;
