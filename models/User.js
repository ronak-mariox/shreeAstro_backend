/**
 * A seeker's account — identity, credentials, wallet and standing.
 *
 * This is the record the user app authenticates against (LoginOptions → OTP /
 * Email / Google / Apple) and the one the admin panel's Users page lists. What
 * a seeker *is* astrologically lives on {@link UserProfile}, which this points
 * at, so a login response stays small.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const {
  phoneSchema,
  deviceSchema,
  notificationPrefsSchema,
} = require('./common');

const AUTH_PROVIDERS = ['otp', 'email', 'google', 'apple', 'facebook'];
const USER_STATUS = ['active', 'blocked', 'deleted'];

/** The wallet the Add Money → Payment → Success flow tops up. */
const walletSchema = new Schema(
  {
    /** Rupees. Never written directly — post a WalletTransaction and let it settle. */
    balance: { type: Number, default: 0, min: 0 },
    totalAdded: { type: Number, default: 0, min: 0 },
    totalSpent: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR' },
    lastTransactionAt: { type: Date },
  },
  { _id: false },
);

/** Counters the profile header and the admin table print without a join. */
const statsSchema = new Schema(
  {
    consultations: { type: Number, default: 0, min: 0 },
    chatMinutes: { type: Number, default: 0, min: 0 },
    callMinutes: { type: Number, default: 0, min: 0 },
    kundlis: { type: Number, default: 0, min: 0 },
    reviewsGiven: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    /** Human-facing id the panel shows ("u-1024"); assigned on create. */
    userCode: { type: String, unique: true, sparse: true, trim: true },

    name: { type: String, trim: true, maxlength: 80 },
    phone: { type: phoneSchema, default: () => ({}) },
    email: { type: String, trim: true, lowercase: true },

    /** How the account was opened; the panel prints it as "Signup". */
    authProvider: { type: String, enum: AUTH_PROVIDERS, default: 'otp' },
    /** Present only for provider logins, so two Google users cannot collide. */
    providerId: { type: String, trim: true, select: false },
    /** Only set when the seeker chose email + password. */
    passwordHash: { type: String, select: false },

    isPhoneVerified: { type: Boolean, default: false },
    isEmailVerified: { type: Boolean, default: false },
    /** The panel's "verified" tick — KYC-level, not just a verified channel. */
    isVerified: { type: Boolean, default: false },

    profile: { type: Schema.Types.ObjectId, ref: 'UserProfile' },
    /** Mirrors profile.avatar so listings need no join. */
    avatarUrl: { type: String, trim: true },

    wallet: { type: walletSchema, default: () => ({}) },
    stats: { type: statsSchema, default: () => ({}) },

    /**
     * The first-consultation offer the directory prints as "Free". Held here so
     * a seeker cannot claim it twice by switching astrologers.
     */
    freeConsultation: {
      isUsed: { type: Boolean, default: false },
      minutes: { type: Number, default: 3, min: 0 },
      usedAt: { type: Date },
      usedInSession: { type: Schema.Types.ObjectId, ref: 'ChatSession' },
    },

    /** Which astrologers the seeker follows / has favourited. */
    favouriteAstrologers: [{ type: Schema.Types.ObjectId, ref: 'Astrologer' }],

    status: { type: String, enum: USER_STATUS, default: 'active', index: true },
    blocked: {
      reason: { type: String, trim: true },
      at: { type: Date },
      by: { type: Schema.Types.ObjectId, ref: 'Admin' },
    },

    referralCode: { type: String, trim: true, uppercase: true, sparse: true, unique: true },
    referredBy: { type: Schema.Types.ObjectId, ref: 'User' },

    devices: { type: [deviceSchema], default: [] },
    notificationPrefs: { type: notificationPrefsSchema, default: () => ({}) },
    unreadNotifications: { type: Number, default: 0, min: 0 },

    locale: { type: String, default: 'en' },
    lastActiveAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date },
    deletedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

/**
 * A number identifies an account, so it is unique — but `sparse` alone will not
 * do it on a nested path that is always present, hence the partial index.
 */
userSchema.index(
  { 'phone.countryCode': 1, 'phone.number': 1 },
  {
    unique: true,
    partialFilterExpression: { 'phone.number': { $type: 'string' } },
  },
);
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
userSchema.index({ createdAt: -1 });

userSchema.virtual('displayPhone').get(function displayPhone() {
  return this.phone && this.phone.number
    ? `${this.phone.countryCode} ${this.phone.number}`
    : undefined;
});

/** An account can consult only while it is active and has been verified. */
userSchema.methods.canConsult = function canConsult() {
  return this.status === 'active' && (this.isPhoneVerified || this.isEmailVerified);
};

/** What the seeker can afford at a given per-minute rate, in whole minutes. */
userSchema.methods.affordableMinutes = function affordableMinutes(ratePerMinute) {
  if (!ratePerMinute) {
    return 0;
  }
  return Math.floor(this.wallet.balance / ratePerMinute);
};

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
module.exports.AUTH_PROVIDERS = AUTH_PROVIDERS;
module.exports.USER_STATUS = USER_STATUS;
