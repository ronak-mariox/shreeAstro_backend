/**
 * Who the seeker is astrologically — the record the Profile, Edit Profile and
 * Birth Details screens read and write, and the one every kundli is cast from.
 *
 * Kept apart from {@link User} because it is written by a different flow
 * (onboarding step 2 / Edit Profile) and read by astrologers during a
 * consultation, while the account document holds credentials nobody else sees.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const { birthDetailsSchema, zodiacSchema } = require('./common');
const { GENDERS, LANGUAGES, TOPICS } = require('./constants');

/**
 * A chart the seeker has generated and kept (Kundli → Kundli Result). The
 * planetary payload is whatever the ephemeris returned, held as-is so a
 * provider change does not require a migration.
 */
const savedKundliSchema = new Schema(
  {
    label: { type: String, trim: true, maxlength: 60 },
    /** Whose chart it is — "self" for the seeker's own. */
    relation: {
      type: String,
      enum: ['self', 'partner', 'family', 'friend', 'other'],
      default: 'self',
    },
    birthDetails: { type: birthDetailsSchema, required: true },
    zodiac: { type: zodiacSchema, default: () => ({}) },
    /** Lagna/Navamsa houses, planet longitudes, dashas, yogas, doshas. */
    chart: { type: Schema.Types.Mixed },
    /** Which ephemeris produced it, so stale charts can be recomputed. */
    provider: { type: String, trim: true },
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

const userProfileSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },

    fullName: { type: String, trim: true, maxlength: 80 },
    gender: { type: String, enum: GENDERS },
    /** Emoji the app falls back to when no photo is set (AvatarPicker). */
    avatarGlyph: { type: String, trim: true, maxlength: 8 },
    avatarUrl: { type: String, trim: true },

    /** The seeker's own birth data — the default native for every new chart. */
    birthDetails: { type: birthDetailsSchema, default: () => ({}) },
    /** Derived from the above; refreshed whenever birth details change. */
    zodiac: { type: zodiacSchema, default: () => ({}) },

    /** Charts kept from the Kundli flow, newest first. */
    savedKundlis: { type: [savedKundliSchema], default: [] },

    /** Consultation preferences the directory pre-filters on. */
    preferredLanguages: [{ type: String, enum: LANGUAGES }],
    interestedTopics: [{ type: String, enum: TOPICS }],

    /** Optional contact block the panel shows on a user record. */
    address: {
      line1: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true, default: 'India' },
      pincode: { type: String, trim: true },
    },

    maritalStatus: {
      type: String,
      enum: ['single', 'married', 'divorced', 'widowed', 'prefer_not_to_say'],
    },
    occupation: { type: String, trim: true, maxlength: 60 },

    /** How far the onboarding wizard got; drives the "complete profile" nudge. */
    completion: {
      basicDone: { type: Boolean, default: false },
      birthDetailsDone: { type: Boolean, default: false },
      percent: { type: Number, default: 0, min: 0, max: 100 },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

/** "♌ Leo · 15 Aug 1995 · Mumbai", as the profile header prints it. */
userProfileSchema.virtual('identityLine').get(function identityLine() {
  const parts = [];
  if (this.zodiac && this.zodiac.sunSign) {
    parts.push(this.zodiac.sunSign);
  }
  if (this.birthDetails && this.birthDetails.dateOfBirth) {
    parts.push(this.birthDetails.dateOfBirth.toDateString().slice(4));
  }
  if (this.birthDetails && this.birthDetails.place && this.birthDetails.place.city) {
    parts.push(this.birthDetails.place.city);
  }
  return parts.join(' · ');
});

/** Recomputes the completion block so the client never has to. */
userProfileSchema.pre('save', function setCompletion() {
  const basicDone = Boolean(this.fullName && this.gender);
  const birth = this.birthDetails || {};
  const birthDone = Boolean(
    birth.dateOfBirth && birth.timeOfBirth && birth.place && birth.place.formatted,
  );

  this.completion.basicDone = basicDone;
  this.completion.birthDetailsDone = birthDone;
  this.completion.percent = (basicDone ? 50 : 0) + (birthDone ? 50 : 0);
});

module.exports =
  mongoose.models.UserProfile ||
  mongoose.model('UserProfile', userProfileSchema);
