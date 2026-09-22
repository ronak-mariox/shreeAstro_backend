/**
 * Lucky number, lucky colour and energy level — AstrologyAPI's horoscope
 * response carries none of these, so they're derived locally from each
 * sign's classical ruling planet, seeded by (sign, date) so the same reading
 * shows the same values all day. No Math.random anywhere here: a user
 * reopening the app ten times in one day must see the same lucky number
 * every time, or the feature reads as broken rather than "still today".
 */

const crypto = require('crypto');

/** Classical rulership — the only mapping AstrologyAPI's own /planets endpoints would agree with. */
const RULING_PLANET = {
  aries: 'Mars',
  taurus: 'Venus',
  gemini: 'Mercury',
  cancer: 'Moon',
  leo: 'Sun',
  virgo: 'Mercury',
  libra: 'Venus',
  scorpio: 'Mars',
  sagittarius: 'Jupiter',
  capricorn: 'Saturn',
  aquarius: 'Saturn',
  pisces: 'Jupiter',
};

/**
 * Each planet's classical number (Chaldean/Vedic numerology gives each
 * planet exactly one) and its 2 associated colours. `number` is the ANCHOR
 * the day's lucky number wraps around (see deriveHoroscopeExtras) — not the
 * lucky number itself, which still needs to change day to day.
 */
const PLANET_LUCKY = {
  Sun: { number: 1, colors: ['Gold', 'Orange'] },
  Moon: { number: 2, colors: ['White', 'Silver'] },
  Jupiter: { number: 3, colors: ['Yellow', 'Gold'] },
  Mars: { number: 9, colors: ['Red', 'Coral'] },
  Mercury: { number: 5, colors: ['Green', 'Emerald'] },
  Venus: { number: 6, colors: ['White', 'Pink'] },
  Saturn: { number: 8, colors: ['Blue', 'Black'] },
};

const ENERGY_LEVELS = ['High', 'Medium', 'Low'];

/** A stable integer from sign+date — same inputs always produce the same picks. */
function seedFor(zodiacSign, targetDate) {
  const digest = crypto.createHash('sha256').update(`${zodiacSign}|${targetDate}`).digest('hex');
  return parseInt(digest.slice(0, 8), 16);
}

/**
 * @param {string} zodiacSign Lowercase, e.g. "leo".
 * @param {string} targetDate "YYYY-MM-DD" — the date this reading is for.
 */
function deriveHoroscopeExtras(zodiacSign, targetDate) {
  const planet = RULING_PLANET[zodiacSign];
  if (!planet) {
    throw new Error(`deriveHoroscopeExtras: unknown zodiac sign "${zodiacSign}".`);
  }
  const { number: anchorNumber, colors } = PLANET_LUCKY[planet];
  const seed = seedFor(zodiacSign, targetDate);

  /**
   * The ruling planet's classical number stays the day's starting point
   * (so Leo is always Sun-flavoured, never Saturn-flavoured), but the day
   * itself nudges it around the 1-9 wheel — a flat, unchanging "lucky
   * number" reads as broken to a user who expects it to be about *today*.
   */
  const luckyNumber = ((anchorNumber - 1 + (seed % 9)) % 9) + 1;

  return {
    luckyNumber,
    luckyColor: colors[seed % colors.length],
    energy: ENERGY_LEVELS[seed % ENERGY_LEVELS.length],
  };
}

module.exports = { RULING_PLANET, PLANET_LUCKY, ENERGY_LEVELS, seedFor, deriveHoroscopeExtras };
