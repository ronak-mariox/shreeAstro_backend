/**
 * A customer's review of a product they bought.
 *
 * Unlike a consultation's or a puja's review, which live on the record they
 * were written about, a product review is its own document: one product is
 * bought many times, and every delivered order of it may carry one review
 * per buyer — the unique index below is what enforces that.
 *
 * `Product.rating` / `Product.ratingCount` are never moved by hand; they are
 * recomputed from the non-hidden reviews (see `recomputeProductRating`) after
 * a review lands and after an admin hides or unhides one.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const productReviewSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },

    rating: { type: Number, required: true, min: 1, max: 5, validate: Number.isInteger },
    title: { type: String, trim: true, maxlength: 80 },
    comment: { type: String, trim: true, required: true, minlength: 3, maxlength: 1000 },
    /** Photos the buyer attached (public URLs under uploads/reviews or S3), up to REVIEW_IMAGES_MAX. */
    images: [{ type: String, trim: true }],

    /** Moderation — the same switches a consultation or puja review has. */
    hidden: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
    flagged: { type: Boolean, default: false },
    flagReason: { type: String, trim: true, maxlength: 300 },
    /** Shree Astro's answer, written from the admin panel. */
    reply: { type: String, trim: true, maxlength: 1000 },
    repliedAt: { type: Date },
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

/** One review per buyer per order of a product. */
productReviewSchema.index({ product: 1, order: 1, user: 1 }, { unique: true });
productReviewSchema.index({ product: 1, hidden: 1, pinned: -1, createdAt: -1 });

/**
 * Rewrites a product's `rating` (average to one decimal) and `ratingCount`
 * from its non-hidden reviews — both 0 when there are none.
 */
productReviewSchema.statics.recomputeProductRating = async function recomputeProductRating(productId) {
  const Product = mongoose.model('Product');
  const [row] = await this.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(String(productId)), hidden: { $ne: true } } },
    { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  const rating = row ? Math.round(row.average * 10) / 10 : 0;
  const ratingCount = row?.count || 0;
  await Product.updateOne({ _id: productId }, { $set: { rating, ratingCount } });
  return { rating, ratingCount };
};

/** `recomputeProductRating` is reached as a static: `ProductReview.recomputeProductRating(id)`. */
module.exports = mongoose.models.ProductReview || mongoose.model('ProductReview', productReviewSchema);
