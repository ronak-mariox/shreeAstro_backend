/**
 * The vocabularies the three clients already speak.
 *
 * Every list here is lifted from the apps so a stored value round-trips without
 * translation: expertise/language ids come from the user app's Sort & Filter
 * sheet (user_app/src/data/consultFilters.ts), topics from its chat intake
 * (user_app/src/data/chatIntake.ts), services from the astrologer app's price
 * screen (astro_app/src/data/priceChange.ts), and document types from its
 * upload sheet (astro_app/src/data/documents.ts).
 */

const GENDERS = ['male', 'female', 'other'];

/** Filter ids the directory request sends. */
const EXPERTISE = [
  'vedic',
  'numerology',
  'tarot',
  'vastu',
  'palmistry',
  'face-reading',
  'nadi',
  'krishnamurti-paddhati',
  'prashna',
  'life-coach',
  'horary',
  'lal-kitab',
  'muhurat',
];

const LANGUAGES = [
  'english',
  'hindi',
  'marathi',
  'gujarati',
  'bengali',
  'tamil',
  'telugu',
  'kannada',
  'punjabi',
  'malayalam',
  'odia',
  'urdu',
];

/** What a consultation is about — the intake's topic list plus the consult tabs. */
const TOPICS = [
  'love-relationship',
  'marriage',
  'career-job',
  'business',
  'education',
  'health',
  'wealth-finance',
  'family',
  'kundli-milan',
  'muhurat',
  'vastu',
  'general',
];

/** The badges the "Top Astrologers" filter matches on. */
const BADGES = ['celebrity', 'rising-star', 'top-choice', 'most-trusted'];

/** Billable services; each carries its own rate on the astrologer's profile. */
const SERVICE_TYPES = [
  'chat',
  'call',
  'live_chat',
  'live_call',
  'emergency_chat',
];

/** How a consultation is actually conducted. */
const CHANNELS = ['chat', 'call'];

const DOCUMENT_TYPES = [
  'id_proof',
  'aadhaar_front',
  'aadhaar_back',
  'pan_card',
  'passport',
  'certificate',
  'award',
  'bank_proof',
];

/** Anything an admin must approve before it goes live. */
const REVIEW_STATUS = ['pending', 'approved', 'rejected'];

const ZODIAC_SIGNS = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces',
];

module.exports = {
  GENDERS,
  EXPERTISE,
  LANGUAGES,
  TOPICS,
  BADGES,
  SERVICE_TYPES,
  CHANNELS,
  DOCUMENT_TYPES,
  REVIEW_STATUS,
  ZODIAC_SIGNS,
};
