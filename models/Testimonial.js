/**
 * A curated testimonial — a "Video Testimonial" or a "Success Story" on the
 * reviews page and the homepage.
 *
 * Distinct from reviews: a review is written by a seeker on a consultation or
 * a puja they paid for and lives on that record; a testimonial is editorial,
 * written up by the team with the seeker's permission.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const KINDS = ['video', 'story'];
const STATUSES = ['published', 'draft'];

const testimonialSchema = new Schema(
  {
    kind: { type: String, enum: KINDS, required: true, index: true },
    title: { type: String, trim: true, required: true, maxlength: 120 },
    quote: { type: String, trim: true, maxlength: 1000 },
    name: { type: String, trim: true, required: true, maxlength: 80 },
    city: { type: String, trim: true, maxlength: 60 },
    /** 'Career & Finance', 'Vastu & Home' … */
    tag: { type: String, trim: true, maxlength: 60 },

    /** Stories: the before → after line, e.g. '₹12L debt → Business owner'. */
    outcome: { type: String, trim: true, maxlength: 120 },
    /** Stories: 'in 18 months'. Videos: '2:34'. */
    duration: { type: String, trim: true, maxlength: 40 },

    avatarUrl: { type: String, trim: true },
    thumbnailUrl: { type: String, trim: true },
    videoUrl: { type: String, trim: true },
    views: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: STATUSES, default: 'published', index: true },
    sortOrder: { type: Number, default: 0 },

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
        return ret;
      },
    },
  },
);

testimonialSchema.index({ status: 1, kind: 1, sortOrder: 1 });

/** The card the website draws — no audit fields, no status. */
testimonialSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: String(this._id),
    kind: this.kind,
    title: this.title,
    quote: this.quote ?? null,
    name: this.name,
    city: this.city ?? null,
    tag: this.tag ?? null,
    outcome: this.outcome ?? null,
    duration: this.duration ?? null,
    avatarUrl: this.avatarUrl ?? null,
    thumbnailUrl: this.thumbnailUrl ?? null,
    videoUrl: this.videoUrl ?? null,
    views: this.views || 0,
    sortOrder: this.sortOrder,
  };
};

module.exports =
  mongoose.models.Testimonial || mongoose.model('Testimonial', testimonialSchema);
module.exports.KINDS = KINDS;
module.exports.STATUSES = STATUSES;
