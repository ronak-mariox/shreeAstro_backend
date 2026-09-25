/**
 * A "Festival Discounts" card on the offers page — Ganesh Chaturthi Special,
 * Diwali Prosperity Pack — curated by an admin.
 *
 * Purely editorial: the card links somewhere and may name a coupon, but the
 * discount itself lives on the Coupon. A card shows while `active` and inside
 * its own date window.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const STATUSES = ['active', 'hidden'];

const festivalOfferSchema = new Schema(
  {
    title: { type: String, trim: true, required: true, maxlength: 100 },
    subtitle: { type: String, trim: true, maxlength: 200 },
    /** 'Limited Time' | 'Festive' | 'Mega Sale' | 'Bundle' | anything short. */
    badge: { type: String, trim: true, maxlength: 30 },
    imageUrl: { type: String, trim: true },

    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    /** Where the card's button goes: '/astrologers', '/puja', '/store', '/kundli'… */
    linkTo: { type: String, trim: true, default: '/astrologers', maxlength: 200 },
    couponCode: { type: String, trim: true, uppercase: true, default: null },

    status: { type: String, enum: STATUSES, default: 'active', index: true },
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

festivalOfferSchema.index({ status: 1, sortOrder: 1, startsAt: 1 });

/** The card the website draws. */
festivalOfferSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: String(this._id),
    title: this.title,
    subtitle: this.subtitle ?? null,
    badge: this.badge ?? null,
    imageUrl: this.imageUrl ?? null,
    startsAt: this.startsAt ?? null,
    endsAt: this.endsAt ?? null,
    linkTo: this.linkTo,
    couponCode: this.couponCode ?? null,
    sortOrder: this.sortOrder,
  };
};

module.exports =
  mongoose.models.FestivalOffer || mongoose.model('FestivalOffer', festivalOfferSchema);
module.exports.STATUSES = STATUSES;
