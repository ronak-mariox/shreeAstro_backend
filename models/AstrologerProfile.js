/**
 * Everything an astrologer files about themselves — the professional record the
 * astrologer app's My Profile / Edit Profile screens read and write, the
 * compliance paperwork (documents, bank accounts) an admin verifies, and the
 * rate changes they request.
 *
 * The seeker-side detail screen (user_app AstrologerDetailScreen) is rendered
 * from this joined with {@link Astrologer}'s presence, rates and metrics.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const { fileSchema } = require('./common');
const {
  EXPERTISE,
  LANGUAGES,
  TOPICS,
  SERVICE_TYPES,
  DOCUMENT_TYPES,
  REVIEW_STATUS,
} = require('./constants');

/** A scan filed against the account (Documents screen, upload sheet). */
const documentSchema = new Schema(
  {
    type: { type: String, enum: DOCUMENT_TYPES, required: true },
    /** Aadhaar / PAN / passport number, as typed. */
    idNumber: { type: String, trim: true },
    file: { type: fileSchema, required: true },
    status: { type: String, enum: REVIEW_STATUS, default: 'pending' },
    rejectionReason: { type: String, trim: true },
    reviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true },
);

/** A payout account (Bank Accounts screen, add-account sheet). */
const bankAccountSchema = new Schema(
  {
    holderName: { type: String, trim: true, required: true },
    bankName: { type: String, trim: true, required: true },
    /** Stored in full; the panel and app print it masked. */
    accountNumber: { type: String, trim: true, required: true },
    ifsc: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      match: [/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code.'],
    },
    accountType: { type: String, enum: ['savings', 'current'], default: 'savings' },
    upiId: { type: String, trim: true },
    /** Cancelled cheque or passbook page filed against it. */
    proof: { type: fileSchema },
    status: { type: String, enum: REVIEW_STATUS, default: 'pending' },
    rejectionReason: { type: String, trim: true },
    /** Where payouts go when more than one account is on file. */
    isPrimary: { type: Boolean, default: false },
    reviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true },
);

bankAccountSchema.virtual('maskedAccountNumber').get(function masked() {
  const digits = String(this.accountNumber || '').replace(/\s/g, '');
  return digits ? `••••${digits.slice(-4)}` : '';
});

/**
 * A repricing the astrologer has asked for (Price Change screen). Approving one
 * writes the new rate onto the matching entry in `Astrologer.services`.
 */
const priceChangeRequestSchema = new Schema(
  {
    service: { type: String, enum: SERVICE_TYPES, required: true },
    oldRate: { type: Number, required: true, min: 0 },
    requestedRate: { type: Number, required: true, min: 0 },
    offerPercent: { type: Number, default: 0, min: 0, max: 100 },
    /** "Apply All" on the sheet — set the same rate on every service. */
    applyToAll: { type: Boolean, default: false },
    reason: { type: String, trim: true },
    status: { type: String, enum: REVIEW_STATUS, default: 'pending' },
    requestedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    rejectionReason: { type: String, trim: true },
  },
  { timestamps: true },
);

/** One day's working window; the directory uses it to predict availability. */
const availabilitySlotSchema = new Schema(
  {
    day: {
      type: String,
      enum: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
      required: true,
    },
    /** 24-hour "HH:mm". */
    from: { type: String, match: [/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm.'] },
    to: { type: String, match: [/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm.'] },
  },
  { _id: false },
);

const astrologerProfileSchema = new Schema(
  {
    astrologer: {
      type: Schema.Types.ObjectId,
      ref: 'Astrologer',
      required: true,
      unique: true,
      index: true,
    },

    /** Long-form intro shown under "About" on the seeker-side profile. */
    about: { type: String, trim: true, maxlength: 2000 },
    /** One line under the name in listings, e.g. "Vedic · KP". */
    tagline: { type: String, trim: true, maxlength: 120 },

    expertise: [{ type: String, enum: EXPERTISE }],
    languages: [{ type: String, enum: LANGUAGES }],
    /** Life areas the astrologer takes questions on (dashboard Expertise card). */
    topics: [{ type: String, enum: TOPICS }],
    /** Free-text specialisations the detail screen lists as pills. */
    specializations: [{ type: String, trim: true }],

    experienceYears: { type: Number, default: 0, min: 0 },
    qualifications: [
      {
        title: { type: String, trim: true },
        institute: { type: String, trim: true },
        year: { type: Number },
        certificate: { type: fileSchema },
      },
    ],

    /** Portfolio images shown in the profile gallery. */
    gallery: { type: [fileSchema], default: [] },
    /** Promotional / media clips the astrologer has uploaded. */
    media: { type: [fileSchema], default: [] },

    address: {
      line1: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true, default: 'India' },
      pincode: { type: String, trim: true },
    },

    documents: { type: [documentSchema], default: [] },
    bankAccounts: { type: [bankAccountSchema], default: [] },
    priceChangeRequests: { type: [priceChangeRequestSchema], default: [] },

    availability: { type: [availabilitySlotSchema], default: [] },
    /** Where the working hours above are read in. */
    timezone: { type: String, default: 'Asia/Kolkata' },

    /** Verification snapshot the admin panel's Astrologers table prints. */
    verification: {
      documentsStatus: { type: String, enum: REVIEW_STATUS, default: 'pending' },
      bankStatus: { type: String, enum: REVIEW_STATUS, default: 'pending' },
      verifiedAt: { type: Date },
    },

    /** Monthly allowance for flagging unfair reviews (My Reviews notice). */
    reviewFlagsRemaining: { type: Number, default: 60, min: 0 },
    reviewFlagsResetAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

astrologerProfileSchema.index({ expertise: 1 });
astrologerProfileSchema.index({ languages: 1 });

astrologerProfileSchema.virtual('primaryBankAccount').get(function primary() {
  return (this.bankAccounts || []).find(account => account.isPrimary) || null;
});

/** Rolls each verification block up from the rows filed under it. */
astrologerProfileSchema.pre('save', function rollUpVerification() {
  const rollUp = rows => {
    if (!rows.length) {
      return 'pending';
    }
    if (rows.every(row => row.status === 'approved')) {
      return 'approved';
    }
    if (rows.some(row => row.status === 'rejected')) {
      return 'rejected';
    }
    return 'pending';
  };

  this.verification.documentsStatus = rollUp(this.documents || []);
  this.verification.bankStatus = rollUp(this.bankAccounts || []);
  if (
    this.verification.documentsStatus === 'approved' &&
    this.verification.bankStatus === 'approved' &&
    !this.verification.verifiedAt
  ) {
    this.verification.verifiedAt = new Date();
  }
});

/**
 * Copies the fields the directory filters on onto the account document, so a
 * listing query never has to join. Call after saving the profile.
 */
astrologerProfileSchema.methods.syncToAccount = async function syncToAccount() {
  const Astrologer = mongoose.model('Astrologer');
  return Astrologer.findByIdAndUpdate(this.astrologer, {
    expertise: this.expertise,
    languages: this.languages,
    experienceYears: this.experienceYears,
  });
};

module.exports =
  mongoose.models.AstrologerProfile ||
  mongoose.model('AstrologerProfile', astrologerProfileSchema);
