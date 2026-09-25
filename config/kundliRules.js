/**
 * The knowledge base behind the kundli life-area analysis (career, finance,
 * health, marriage) — every rule services/kundliAnalysis.service.js applies,
 * laid out as plain tables so an astrologer can review them without reading
 * code. Nothing here is computed at runtime; it is classical Parashari
 * astrology written down.
 *
 * The analysis is deterministic and rule-based on purpose: AstrologyAPI has
 * no life-area endpoints, so these readings are built from the chart data the
 * 11-call batch already caches. Change a table here and every reading changes
 * with it — there is no second copy anywhere.
 */

/** Zodiac order — index + 1 is the sign's natural house (Aries 1 … Pisces 12). */
const SIGNS = Object.freeze([
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
]);

const SIGN_LORDS = Object.freeze({
  Aries: 'Mars', Taurus: 'Venus', Gemini: 'Mercury', Cancer: 'Moon', Leo: 'Sun', Virgo: 'Mercury',
  Libra: 'Venus', Scorpio: 'Mars', Sagittarius: 'Jupiter', Capricorn: 'Saturn', Aquarius: 'Saturn', Pisces: 'Jupiter',
});

const SIGN_ELEMENTS = Object.freeze({
  Aries: 'fire', Leo: 'fire', Sagittarius: 'fire',
  Taurus: 'earth', Virgo: 'earth', Capricorn: 'earth',
  Gemini: 'air', Libra: 'air', Aquarius: 'air',
  Cancer: 'water', Scorpio: 'water', Pisces: 'water',
});

/** Ayurvedic constitution per element — water is the classical Kapha–Vata blend. */
const ELEMENT_DOSHAS = Object.freeze({
  fire: ['Pitta'],
  earth: ['Kapha'],
  air: ['Vata'],
  water: ['Kapha', 'Vata'],
});

/** What each bhava stands for — `keywords` for prose, `body` for the health reading (the same mapping applies to a sign via its natural house). */
const HOUSES = Object.freeze({
  1: { keywords: 'self, body and vitality', body: 'head and overall vitality' },
  2: { keywords: 'wealth, family and speech', body: 'face, throat and mouth' },
  3: { keywords: 'courage, siblings and communication', body: 'arms, shoulders and lungs' },
  4: { keywords: 'home, property, vehicles and mother', body: 'chest and heart' },
  5: { keywords: 'intelligence, children and investments', body: 'stomach and upper abdomen' },
  6: { keywords: 'disease, debt, enemies and service', body: 'intestines and digestion' },
  7: { keywords: 'marriage, spouse and partnerships', body: 'kidneys and lower abdomen' },
  8: { keywords: 'longevity, sudden events and inheritance', body: 'reproductive and excretory organs' },
  9: { keywords: 'fortune, father and higher learning', body: 'hips and thighs' },
  10: { keywords: 'career, profession and status', body: 'knees and joints' },
  11: { keywords: 'gains, income and elder siblings', body: 'calves and ankles' },
  12: { keywords: 'expenses, foreign lands and losses', body: 'feet, sleep and the lymphatic system' },
});

const KENDRA_HOUSES = Object.freeze([1, 4, 7, 10]);
const TRIKONA_HOUSES = Object.freeze([5, 9]);
const DUSTHANA_HOUSES = Object.freeze([6, 8, 12]);

/**
 * Natural benefics and malefics. Moon and Mercury are conditional — see
 * MOON_DARK_ORB_DEGREES (a Moon close to the Sun counts as malefic) and the
 * "unafflicted Mercury" rule in the service (Mercury sharing a house with a
 * malefic and no benefic counts as malefic).
 */
const NATURAL_BENEFICS = Object.freeze(['Jupiter', 'Venus', 'Mercury', 'Moon']);
const NATURAL_MALEFICS = Object.freeze(['Saturn', 'Mars', 'Rahu', 'Ketu', 'Sun']);
/** Within this many degrees of the Sun (either side) the Moon is treated as waning/dark, i.e. malefic. */
const MOON_DARK_ORB_DEGREES = 72;

/** Drishti — houses counted from the planet's own that it aspects. Every graha has the 7th; the special aspects are the classical ones. */
const ASPECTS = Object.freeze({
  Sun: [7], Moon: [7], Mercury: [7], Venus: [7],
  Mars: [4, 7, 8],
  Jupiter: [5, 7, 9],
  Saturn: [3, 7, 10],
  Rahu: [5, 7, 9],
  Ketu: [5, 7, 9],
});

/**
 * Planet strength, 0–100. Starts at BASE and adds each adjustment that
 * applies; the result is clamped. Moolatrikona placements are all either own
 * or exalted signs, so `dignityOf` already covers them.
 */
const PLANET_SCORE = Object.freeze({
  BASE: 50,
  DIGNITY: Object.freeze({ Exalted: 25, 'Own Sign': 15, Debilitated: -25, Neutral: 0 }),
  SHADBALA_STRONG: 10,
  SHADBALA_WEAK: -10,
  RETROGRADE_BENEFIC: -5,
  RETROGRADE_MALEFIC: 0,
  COMBUST: -15,
  IN_KENDRA: 5,
  IN_TRIKONA: 8,
  IN_DUSTHANA: -10,
  /** A 6/8/12 lord sitting in a dusthana — Viparita, the affliction turns around. */
  VIPARITA: 5,
  BENEFIC_INFLUENCE: 5,
  MALEFIC_INFLUENCE_EACH: -5,
  MALEFIC_INFLUENCE_CAP: -15,
  MIN: 0,
  MAX: 100,
});

/** House strength: the lord's score plus these occupancy/aspect adjustments, the sum of which is capped at ±ADJUST_CAP. The Sun, a mild malefic, counts at half as an occupant and not at all as an aspect; a lord aspecting its own house is never counted as a malefic aspect. */
const HOUSE_SCORE = Object.freeze({
  BENEFIC_PRESENT: 10,
  MALEFIC_OCCUPANT_EACH: -10,
  MALEFIC_ASPECT_EACH: -5,
  /** A lord aspecting its own house protects it — a classical strengthening. */
  LORD_ASPECTS_OWN: 10,
  ADJUST_CAP: 20,
});

/** The words a score maps to in prose — checked in order, first match wins. */
const STRENGTH_BANDS = Object.freeze([
  { min: 70, word: 'strong' },
  { min: 55, word: 'well placed' },
  { min: 45, word: 'moderate' },
  { min: 0, word: 'under pressure' },
]);

/** Career fields per graha, in the order they are named when that graha dominates the 10th house. */
const CAREER_FIELDS = Object.freeze({
  Sun: ['Government', 'Administration', 'Leadership roles', 'Medicine'],
  Moon: ['Public-facing work', 'Hospitality', 'Healthcare', 'Marine and travel'],
  Mars: ['Engineering', 'Defence', 'Sports', 'Surgery', 'Real estate'],
  Mercury: ['Commerce', 'Accounting', 'Writing', 'IT', 'Media', 'Teaching'],
  Jupiter: ['Law', 'Finance', 'Education', 'Consulting', 'Spiritual work'],
  Venus: ['Arts', 'Design', 'Fashion', 'Entertainment', 'Luxury goods'],
  Saturn: ['Manufacturing', 'Construction', 'Oil and mining', 'Law enforcement', 'Labour management'],
  Rahu: ['Technology', 'Foreign trade', 'Aviation', 'Politics'],
  Ketu: ['Research', 'Spirituality', 'Software and coding', 'Healing'],
});

/** Investment styles per graha, named when that graha is the strongest of the wealth-giving ones. Rahu is a caution, never a recommendation. */
const INVESTMENT_TYPES = Object.freeze({
  Venus: 'Gold, jewellery and luxury assets',
  Mars: 'Real estate and land',
  Mercury: 'Trading, mutual funds and business',
  Jupiter: 'Long-term funds, education and gold',
  Saturn: 'Long-term fixed assets and property',
  Moon: 'Liquid savings and fixed deposits',
});
const INVESTMENT_PLANETS = Object.freeze(['Venus', 'Mars', 'Mercury', 'Jupiter', 'Saturn', 'Moon']);

/** Favourable direction from a graha (used for the 10th lord). */
const DIRECTION_BY_PLANET = Object.freeze({
  Sun: 'East', Moon: 'North-West', Mars: 'South', Mercury: 'North', Jupiter: 'North-East',
  Venus: 'South-East', Saturn: 'West', Rahu: 'South-West', Ketu: 'North-West',
});

const WEEKDAY_BY_PLANET = Object.freeze({
  Sun: 'Sunday', Moon: 'Monday', Mars: 'Tuesday', Mercury: 'Wednesday', Jupiter: 'Thursday',
  Venus: 'Friday', Saturn: 'Saturday', Rahu: 'Saturday', Ketu: 'Tuesday',
});

/** Spouse's direction from the sign on the 7th house. */
const SPOUSE_DIRECTION_BY_SIGN = Object.freeze({
  Aries: 'East', Leo: 'East', Sagittarius: 'East',
  Taurus: 'South', Virgo: 'South', Capricorn: 'South',
  Gemini: 'West', Libra: 'West', Aquarius: 'West',
  Cancer: 'North', Scorpio: 'North', Pisces: 'North',
});

/** Classical (naisargika) friendships — who each graha counts as a friend. */
const PLANET_FRIENDS = Object.freeze({
  Sun: ['Moon', 'Mars', 'Jupiter'],
  Moon: ['Sun', 'Mercury'],
  Mars: ['Sun', 'Moon', 'Jupiter'],
  Mercury: ['Sun', 'Venus'],
  Jupiter: ['Sun', 'Moon', 'Mars'],
  Venus: ['Mercury', 'Saturn'],
  Saturn: ['Mercury', 'Venus'],
});

/** Mars in any of these houses from the lagna is Mangal (Manglik) dosha — the same rule the apps' Mangal Dosha tab describes. */
const MANGAL_DOSHA_HOUSES = Object.freeze([1, 2, 4, 7, 8, 12]);

/** Marriage karaka by the native's gender; unknown/other uses both. */
const MARRIAGE_KARAKA_BY_GENDER = Object.freeze({
  male: ['Venus'],
  female: ['Jupiter'],
  other: ['Venus', 'Jupiter'],
});

/** The age band in which marriage timing windows are looked for first. */
const MARRIAGE_AGE_BAND = Object.freeze({ from: 20, to: 38 });

/** Health lifestyle notes keyed by the afflicting (or weak) graha. `short` is the tile value, `text` the factor. */
const HEALTH_NOTES = Object.freeze({
  Saturn: {
    short: 'Rest well; care for bones, joints and chronic complaints',
    text: 'Saturn points to slow-building, chronic complaints — bones, joints and fatigue. Regular rest, warm food and a steady routine keep it in check.',
  },
  Mars: {
    short: 'Moderation; guard against inflammation and accidents',
    text: 'Mars brings heat — inflammation, fevers, cuts and accidents. Moderation in diet and temper, and care during physical activity, are the remedy.',
  },
  Rahu: {
    short: 'Keep a fixed routine; watch anxiety and unusual ailments',
    text: 'Rahu tends towards anxiety, restlessness and ailments that are hard to pin down. A fixed daily routine and clean habits steady it.',
  },
  Ketu: {
    short: 'Grounding habits; watch for hard-to-diagnose complaints',
    text: 'Ketu tends towards sudden, hard-to-diagnose complaints and low immunity. Grounding habits — regular meals, sleep and quiet time — help.',
  },
  Moon: {
    short: 'Protect sleep and emotional balance',
    text: 'An afflicted Moon shows in stress, disturbed sleep and low moods. Protecting sleep and emotional balance protects everything else.',
  },
  Mercury: {
    short: 'Look after the nervous system; avoid overstimulation',
    text: 'An afflicted Mercury shows in the nervous system and skin — restlessness, overthinking and allergies. Breathing practice and less screen time help.',
  },
  Sun: {
    short: 'Build immunity; care for the heart and eyes',
    text: 'A weak Sun lowers vitality — immunity, the heart and the eyes need attention. Morning sunlight and regular exercise strengthen it.',
  },
  Jupiter: {
    short: 'Watch weight, liver and blood sugar',
    text: 'An afflicted Jupiter shows in weight, the liver and blood sugar. Lighter meals and regular movement keep it balanced.',
  },
  Venus: {
    short: 'Care for kidneys, skin and reproductive health',
    text: 'An afflicted Venus shows in the kidneys, skin and reproductive health. Hydration and a clean diet keep it balanced.',
  },
});

/**
 * Per-domain period rules. A dasha lord's period is favourable when it rules
 * a `primaryHouses` house, or is a `karakas` graha or occupies/aspects an
 * `influenceHouses` house while scoring at least KARAKA_FAVOURABLE_SCORE;
 * caution when it is a malefic under MALEFIC_CAUTION_SCORE or rules a
 * `drainHouses` house without also being a primary lord or karaka; and mixed
 * otherwise.
 */
const DOMAINS = Object.freeze({
  career: Object.freeze({ primaryHouses: [10], karakas: ['Sun', 'Saturn', 'Mercury', 'Jupiter'], influenceHouses: [10], drainHouses: [8, 12] }),
  finance: Object.freeze({ primaryHouses: [2, 11], karakas: ['Jupiter', 'Venus'], influenceHouses: [2, 11], drainHouses: [6, 8, 12] }),
  health: Object.freeze({ primaryHouses: [1], karakas: ['Sun', 'Moon', 'Jupiter'], influenceHouses: [], drainHouses: [6, 8, 12] }),
  marriage: Object.freeze({ primaryHouses: [7], karakas: ['Venus', 'Jupiter'], influenceHouses: [7], drainHouses: [6, 8, 12] }),
});
const DOMAIN_NAMES = Object.freeze(Object.keys(DOMAINS));

const PERIOD_RULES = Object.freeze({
  KARAKA_FAVOURABLE_SCORE: 60,
  /** A primary lord this weak gives a mixed period rather than a favourable one. */
  PRIMARY_MIN_SCORE: 40,
  MALEFIC_CAUTION_SCORE: 45,
  HORIZON_YEARS: 12,
  MAX_WINDOWS: 4,
});

/** Tile labels per domain, in display order — the website renders exactly these four. */
const TILE_LABELS = Object.freeze({
  career: ['Best Career Fields', 'Career Period', 'Favorable Direction', 'Lucky Days'],
  finance: ['Financial Outlook', 'Investment Type', 'Caution Period', 'Gain Period'],
  health: ['Body Constitution', 'Sensitive Areas', 'Favorable Period', 'Precaution'],
  marriage: ['Marriage Timing', 'Spouse Direction', 'Compatibility', 'Marriage Life'],
});

const DISCLAIMER =
  "Generated from your birth chart by Shree Astro's rule engine — general guidance, not a substitute for a consultation.";

module.exports = {
  SIGNS,
  SIGN_LORDS,
  SIGN_ELEMENTS,
  ELEMENT_DOSHAS,
  HOUSES,
  KENDRA_HOUSES,
  TRIKONA_HOUSES,
  DUSTHANA_HOUSES,
  NATURAL_BENEFICS,
  NATURAL_MALEFICS,
  MOON_DARK_ORB_DEGREES,
  ASPECTS,
  PLANET_SCORE,
  HOUSE_SCORE,
  STRENGTH_BANDS,
  CAREER_FIELDS,
  INVESTMENT_TYPES,
  INVESTMENT_PLANETS,
  DIRECTION_BY_PLANET,
  WEEKDAY_BY_PLANET,
  SPOUSE_DIRECTION_BY_SIGN,
  PLANET_FRIENDS,
  MANGAL_DOSHA_HOUSES,
  MARRIAGE_KARAKA_BY_GENDER,
  MARRIAGE_AGE_BAND,
  HEALTH_NOTES,
  DOMAINS,
  DOMAIN_NAMES,
  PERIOD_RULES,
  TILE_LABELS,
  DISCLAIMER,
};
