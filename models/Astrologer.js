/**
 * An astrologer's account — credentials, approval standing, live presence,
 * per-service rates and earnings.
 *
 * This is what the astrologer app signs into (Login → OTP → Dashboard), what
 * decides whether a chat request may be routed to them, and what the seeker
 * app's directory query filters and sorts on. Everything descriptive — about,
 * gallery, documents, bank accounts, rate-change requests — sits on
 * {@link AstrologerProfile}.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const {
  phoneSchema,
  deviceSchema,
  notificationPrefsSchema,
} = require('./common');
const {
  GENDERS,
  EXPERTISE,
  LANGUAGES,
  TOPICS,
  BADGES,
  SERVICE_TYPES,
} = require('./constants');

/**
 * Where an application has reached. The astrologer app walks
 * Personal Info → Professional Details → Documents → Bank → Submitted, and an
 * admin moves it from `under_review` onward.
 */
const APPLICATION_STATUS = [
  'registered',
  'personal_submitted',
  'professional_submitted',
  'documents_submitted',
  'bank_submitted',
  'under_review',
  'approved',
  'rejected',
  'suspended',
];

const ACCOUNT_STATUS = ['active', 'blocked', 'deleted'];

/** One billable service and what it currently costs (dashboard Services card). */
const serviceSchema = new Schema(
  {
    type: { type: String, enum: SERVICE_TYPES, required: true },
    /** The toggle on the dashboard — off means the button greys out for seekers. */
    isEnabled: { type: Boolean, default: false },
    /** Rupees per minute the seeker is charged. */
    ratePerMinute: { type: Number, required: true, min: 0 },
    /** Discount the card strikes the old price through with. */
    offerPercent: { type: Number, default: 0, min: 0, max: 100 },
    /** When the astrologer next opens this service, if scheduled ahead. */
    availableFrom: { type: Date },
  },
  { _id: false },
);

/** What the payable rate works out to once the offer is applied. */
serviceSchema.virtual('effectiveRate').get(function effectiveRate() {
  return Math.round(this.ratePerMinute * (1 - this.offerPercent / 100));
});

/** Live availability — written by the socket layer, read by every listing. */
const presenceSchema = new Schema(
  {
    isOnline: { type: Boolean, default: false },
    /** True while in a session; the card shows a wait countdown instead of Chat. */
    isBusy: { type: Boolean, default: false },
    /** How long the seeker is told to wait, in seconds ("Wait 00:01:21"). */
    waitSeconds: { type: Number, default: 0, min: 0 },
    activeSessions: { type: Number, default: 0, min: 0 },
    /** How many live chats this astrologer will take at once. */
    maxConcurrentChats: { type: Number, default: 3, min: 1 },
    lastSeenAt: { type: Date, default: Date.now },
    socketId: { type: String, trim: true },
  },
  { _id: false },
);

/** Earnings, as the astrologer app's wallet header prints them. */
const earningsSchema = new Schema(
  {
    /** Withdrawable balance, in rupees. */
    balance: { type: Number, default: 0, min: 0 },
    today: { type: Number, default: 0, min: 0 },
    thisMonth: { type: Number, default: 0, min: 0 },
    lifetime: { type: Number, default: 0, min: 0 },
    /** Requested but not yet settled. */
    pendingWithdrawal: { type: Number, default: 0, min: 0 },
    totalWithdrawn: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR' },
  },
  { _id: false },
);

/** The figures the Performance card and the profile stats print. */
const metricsSchema = new Schema(
  {
    rating: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    /** 5★…1★ tallies behind the histogram on the seeker-side profile. */
    ratingBreakdown: {
      five: { type: Number, default: 0, min: 0 },
      four: { type: Number, default: 0, min: 0 },
      three: { type: Number, default: 0, min: 0 },
      two: { type: Number, default: 0, min: 0 },
      one: { type: Number, default: 0, min: 0 },
    },
    totalConsultations: { type: Number, default: 0, min: 0 },
    chatMinutes: { type: Number, default: 0, min: 0 },
    callMinutes: { type: Number, default: 0, min: 0 },
    /** Accepted ÷ received requests, as a percentage. */
    acceptanceRate: { type: Number, default: 0, min: 0, max: 100 },
    requestsReceived: { type: Number, default: 0, min: 0 },
    requestsAccepted: { type: Number, default: 0, min: 0 },
    /** Median seconds to answer a request; feeds the wait estimate. */
    avgResponseSeconds: { type: Number, default: 0, min: 0 },
    repeatSeekers: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const astrologerSchema = new Schema(
  {
    /**
     * Assigned when the application is approved and printed on the profile
     * screen; the astrologer cannot change it (astro_app profile.ts).
     */
    astroCode: { type: String, unique: true, sparse: true, trim: true, index: true },

    /**
     * Not required: an admin can create an account from an email address alone,
     * and the astrologer fills their real name in from their own profile. Until
     * they do, this holds a placeholder taken from the email.
     */
    name: { type: String, trim: true, maxlength: 80 },
    /** The number the app logs in with. */
    phone: { type: phoneSchema, default: () => ({}) },
    secondaryPhone: { type: phoneSchema, default: () => ({}) },
    email: { type: String, trim: true, lowercase: true },
    passwordHash: { type: String, select: false },

    gender: { type: String, enum: GENDERS },
    dateOfBirth: { type: Date },
    photoUrl: { type: String, trim: true },

    isPhoneVerified: { type: Boolean, default: false },
    isEmailVerified: { type: Boolean, default: false },

    profile: { type: Schema.Types.ObjectId, ref: 'AstrologerProfile' },

    applicationStatus: {
      type: String,
      enum: APPLICATION_STATUS,
      default: 'registered',
      index: true,
    },
    /** Which wizard step the app resumes on (0-based). */
    onboardingStep: { type: Number, default: 0, min: 0 },

    /**
     * How the account came to exist.
     *
     *   'self'   the astrologer applied through the app
     *   'admin'  an admin created it from the panel with just an email
     *
     * An admin-created account starts empty and is completed by the astrologer
     * from their own profile screen.
     */
    createdVia: { type: String, enum: ['self', 'admin'], default: 'self' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin' },

    /**
     * Set the first time the astrologer saves a complete profile.
     *
     * It is what separates "still setting up" from "set up": before it, they
     * may set their own rates; after it, a rate change has to be approved.
     */
    profileCompletedAt: { type: Date },

    /**
     * Working hours as plain text — "Mon–Sat · 9 AM – 9 PM" — which is what the
     * admin panel's Availability field collects. Structured slots live on
     * {@link AstrologerProfile}.availability for when a scheduler needs them.
     */
    availabilityNote: { type: String, trim: true, maxlength: 120 },
    approval: {
      at: { type: Date },
      by: { type: Schema.Types.ObjectId, ref: 'Admin' },
      /** Why an application was turned down, shown back in the app. */
      rejectionReason: { type: String, trim: true },
      notes: { type: String, trim: true },
    },

    status: { type: String, enum: ACCOUNT_STATUS, default: 'active', index: true },
    blocked: {
      reason: { type: String, trim: true },
      at: { type: Date },
      by: { type: Schema.Types.ObjectId, ref: 'Admin' },
    },

    services: { type: [serviceSchema], default: [] },
    presence: { type: presenceSchema, default: () => ({}) },
    earnings: { type: earningsSchema, default: () => ({}) },
    metrics: { type: metricsSchema, default: () => ({}) },

    /** The platform's cut, in percent; set per astrologer by an admin. */
    commissionPercent: { type: Number, default: 25, min: 0, max: 100 },

    /**
     * Denormalised from {@link AstrologerProfile} purely so the directory's
     * filter/sort runs against one collection. Kept in sync whenever the
     * profile saves — never edited directly.
     */
    expertise: [{ type: String, enum: EXPERTISE, index: true }],
    languages: [{ type: String, enum: LANGUAGES, index: true }],
    /** Life areas they take questions on — what the seeker's category row filters by. */
    topics: [{ type: String, enum: TOPICS, index: true }],
    experienceYears: { type: Number, default: 0, min: 0 },
    /** "Celebrity", "Top Choice" — the Top Astrologers filter matches these. */
    badges: [{ type: String, enum: BADGES }],
    /** Cheapest enabled service rate; what "Sort by price" orders on. */
    minRatePerMinute: { type: Number, default: 0, min: 0 },

    devices: { type: [deviceSchema], default: [] },
    notificationPrefs: { type: notificationPrefsSchema, default: () => ({}) },
    unreadNotifications: { type: Number, default: 0, min: 0 },

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

astrologerSchema.index(
  { 'phone.countryCode': 1, 'phone.number': 1 },
  {
    unique: true,
    partialFilterExpression: { 'phone.number': { $type: 'string' } },
  },
);
astrologerSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
/** The directory's default sweep: approved, online, best rated first. */
astrologerSchema.index({
  applicationStatus: 1,
  'presence.isOnline': -1,
  'metrics.rating': -1,
});
astrologerSchema.index({ minRatePerMinute: 1 });
astrologerSchema.index({ name: 'text' });

/** Keeps the price-sort key honest whenever a rate or toggle changes. */
astrologerSchema.pre('save', function syncMinRate() {
  const enabled = (this.services || []).filter(service => service.isEnabled);
  this.minRatePerMinute = enabled.length
    ? Math.min(...enabled.map(service => service.effectiveRate))
    : 0;
});

/** The live rate for one service, or null when it is switched off. */
astrologerSchema.methods.rateFor = function rateFor(serviceType) {
  const service = (this.services || []).find(
    entry => entry.type === serviceType && entry.isEnabled,
  );
  return service ? service.effectiveRate : null;
};

/** Whether a new request may be routed here right now. */
astrologerSchema.methods.canAcceptRequest = function canAcceptRequest(serviceType) {
  return (
    this.status === 'active' &&
    this.applicationStatus === 'approved' &&
    this.presence.isOnline &&
    this.presence.activeSessions < this.presence.maxConcurrentChats &&
    this.rateFor(serviceType) !== null
  );
};

/** Adds one rating and rolls the average and its histogram forward. */
astrologerSchema.methods.applyRating = function applyRating(stars) {
  const buckets = ['one', 'two', 'three', 'four', 'five'];
  const bucket = buckets[Math.min(Math.max(Math.round(stars), 1), 5) - 1];
  const total = this.metrics.rating * this.metrics.ratingCount + stars;

  this.metrics.ratingCount += 1;
  this.metrics.rating = Number((total / this.metrics.ratingCount).toFixed(2));
  this.metrics.ratingBreakdown[bucket] += 1;
  return this;
};

module.exports =
  mongoose.models.Astrologer || mongoose.model('Astrologer', astrologerSchema);
module.exports.APPLICATION_STATUS = APPLICATION_STATUS;
module.exports.ACCOUNT_STATUS = ACCOUNT_STATUS;
