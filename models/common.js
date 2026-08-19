/**
 * Sub-documents shared by more than one model.
 *
 * Birth details are the clearest case: the seeker files them once on their
 * profile (user_app BirthDetailsScreen) and again per session in the chat
 * intake (user_app ChatIntakeScreen), and the astrologer reads the same shape
 * off the incoming-request popup (astro_app IncomingRequestPopup).
 */

const { Schema } = require('mongoose');

const { GENDERS, ZODIAC_SIGNS } = require('./constants');

/** A phone number kept split, because the apps type the two parts separately. */
const phoneSchema = new Schema(
  {
    countryCode: { type: String, default: '+91', trim: true },
    number: {
      type: String,
      trim: true,
      match: [/^\d{6,14}$/, 'Enter the number without spaces or dial code.'],
    },
  },
  { _id: false },
);

phoneSchema.virtual('e164').get(function e164() {
  return this.number ? `${this.countryCode}${this.number}` : undefined;
});

/** Where someone was born, geocoded so an ephemeris can be called with it. */
const birthPlaceSchema = new Schema(
  {
    /** As the user typed / picked it: "Mumbai, Maharashtra". */
    formatted: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true, default: 'India' },
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    /** IANA zone — charts are cast in local time, so this must travel with it. */
    timezone: { type: String, default: 'Asia/Kolkata' },
    utcOffsetMinutes: { type: Number, default: 330 },
  },
  { _id: false },
);

/** Everything a kundli needs about the native. */
const birthDetailsSchema = new Schema(
  {
    fullName: { type: String, trim: true, maxlength: 80 },
    gender: { type: String, enum: GENDERS },
    dateOfBirth: { type: Date },
    /** 24-hour "HH:mm" — the apps' AM/PM wheels are formatted on the client. */
    timeOfBirth: {
      type: String,
      match: [/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm.'],
    },
    /** False when the seeker does not know it; the chart falls back to noon. */
    isBirthTimeKnown: { type: Boolean, default: true },
    place: { type: birthPlaceSchema, default: () => ({}) },
  },
  { _id: false },
);

/** The signs a chart resolves to, cached so listings need not recompute them. */
const zodiacSchema = new Schema(
  {
    sunSign: { type: String, enum: ZODIAC_SIGNS },
    moonSign: { type: String, enum: ZODIAC_SIGNS },
    ascendant: { type: String, enum: ZODIAC_SIGNS },
    nakshatra: { type: String, trim: true },
    computedAt: { type: Date },
  },
  { _id: false },
);

/** An uploaded file, wherever it is held (S3/Cloudinary/local). */
const fileSchema = new Schema(
  {
    url: { type: String, trim: true, required: true },
    /** Storage key, so the file can be deleted without parsing the URL. */
    key: { type: String, trim: true },
    fileName: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    sizeBytes: { type: Number, min: 0 },
    width: { type: Number, min: 0 },
    height: { type: Number, min: 0 },
    durationSeconds: { type: Number, min: 0 },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/** A push target; one row per install. */
const deviceSchema = new Schema(
  {
    fcmToken: { type: String, trim: true, required: true },
    platform: { type: String, enum: ['android', 'ios', 'web'], required: true },
    appVersion: { type: String, trim: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * A one-time password, held hashed.
 *
 * Login codes do *not* use this — they live in Redis with a TTL, so they expire
 * on their own (see services/otp.service.js). This is kept for the codes that
 * do belong on a document, such as an admin's two-factor code.
 */
const otpSchema = new Schema(
  {
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0, min: 0 },
    lastSentAt: { type: Date, default: Date.now },
    /** Which flow asked for it, so a login code cannot verify an email change. */
    purpose: {
      type: String,
      enum: ['login', 'signup', 'phone_change', 'email_verify', 'withdrawal'],
      default: 'login',
    },
  },
  { _id: false },
);

/** Which alerts someone has left switched on (both apps' notification screens). */
const notificationPrefsSchema = new Schema(
  {
    push: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
    sms: { type: Boolean, default: false },
    whatsapp: { type: Boolean, default: false },
    /** Seeker-side: daily horoscope, transit and promo alerts. */
    dailyHoroscope: { type: Boolean, default: true },
    promotions: { type: Boolean, default: true },
  },
  { _id: false },
);

module.exports = {
  phoneSchema,
  birthPlaceSchema,
  birthDetailsSchema,
  zodiacSchema,
  fileSchema,
  deviceSchema,
  otpSchema,
  notificationPrefsSchema,
};
