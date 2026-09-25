/**
 * Something the store sells — a mala, a yantra, a puja kit.
 *
 * Admins manage these from the panel (Shop); the website and the seeker app
 * list only the `active` ones. Stock is decremented with a conditional `$inc`
 * when an order is placed (see services/commerce.service.js), never read and
 * written back, so two orders racing for the last unit cannot both win.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const { applySlug } = require('../utils/slug');

const STATUSES = ['active', 'hidden', 'archived'];

const productSchema = new Schema(
  {
    name: { type: String, trim: true, required: true, maxlength: 120 },
    slug: { type: String, trim: true, lowercase: true, unique: true, index: true },

    /** Lowercase-kebab, free text: 'rudraksha', 'crystals-pyrite', 'yantra' … */
    category: { type: String, trim: true, lowercase: true, required: true, index: true },
    badge: { type: String, trim: true, default: null },
    description: { type: String, trim: true, maxlength: 3000 },
    highlights: [{ type: String, trim: true }],

    imageUrl: { type: String, trim: true },
    images: [{ type: String, trim: true }],

    /** Whole rupees. */
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

    stock: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    sku: { type: String, trim: true },

    rating: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },

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
        ret.inStock = doc.inStock;
        return ret;
      },
    },
  },
);

productSchema.index({ status: 1, category: 1 });
productSchema.index({ status: 1, isFeatured: -1, rating: -1 });

productSchema.virtual('discountPercent').get(function discountPercent() {
  if (!this.oldPrice || this.oldPrice <= this.price) {
    return 0;
  }
  return Math.round(((this.oldPrice - this.price) / this.oldPrice) * 100);
});

productSchema.virtual('inStock').get(function inStock() {
  return this.stock > 0;
});

productSchema.pre('validate', async function setSlug() {
  await applySlug(this, 'name');
});

/** What the website and the seeker app see — no audit fields, no status. */
productSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: String(this._id),
    slug: this.slug,
    name: this.name,
    category: this.category,
    badge: this.badge ?? null,
    imageUrl: this.imageUrl ?? null,
    images: this.images || [],
    price: this.price,
    oldPrice: this.oldPrice ?? null,
    discountPercent: this.discountPercent,
    rating: this.rating,
    ratingCount: this.ratingCount,
    stock: this.stock,
    inStock: this.inStock,
    description: this.description ?? null,
    highlights: this.highlights || [],
    isFeatured: this.isFeatured,
  };
};

module.exports = mongoose.models.Product || mongoose.model('Product', productSchema);
module.exports.STATUSES = STATUSES;
