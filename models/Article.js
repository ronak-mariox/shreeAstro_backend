/**
 * An article in the content library (admin panel → Content Management).
 *
 * Written by an admin, read by the apps. A draft is invisible to the apps until
 * it is published.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const STATUSES = ['draft', 'published', 'archived'];

const articleSchema = new Schema(
  {
    title: { type: String, trim: true, required: true, maxlength: 200 },
    /** URL-friendly version of the title, unique so it can address the article. */
    slug: { type: String, trim: true, lowercase: true, unique: true, index: true },

    category: { type: String, trim: true, index: true },
    /** The by-line as printed; free text, because guests write too. */
    author: { type: String, trim: true },

    excerpt: { type: String, trim: true, maxlength: 500 },
    body: { type: String, trim: true },
    coverImageUrl: { type: String, trim: true },

    status: { type: String, enum: STATUSES, default: 'draft', index: true },
    /** 'everyone' or 'users' — who may read it once published. */
    visibility: { type: String, enum: ['everyone', 'users'], default: 'everyone' },

    views: { type: Number, default: 0, min: 0 },
    publishedAt: { type: Date },

    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true },
);

articleSchema.index({ status: 1, publishedAt: -1 });

/** Builds the slug from the title the first time, if none was given. */
articleSchema.pre('validate', function setSlug() {
  if (!this.slug && this.title) {
    this.slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
  }
});

module.exports = mongoose.models.Article || mongoose.model('Article', articleSchema);
module.exports.STATUSES = STATUSES;
