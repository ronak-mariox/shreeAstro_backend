/**
 * Daily horoscope and planet positions.
 *
 * There is no ephemeris or astrology provider wired up yet, so the reading is
 * assembled from a fixed set of lines picked by the sign and the date. It is
 * deterministic on purpose: the same sign gets the same reading all day, which
 * is what a horoscope has to do, and it changes at midnight.
 *
 * **This is the seam.** When a provider is chosen, replace `dailyFor` with the
 * call to it and delete the arrays below. Nothing above this file changes: the
 * shape it returns is what the home screen already reads.
 */

const { ZODIAC_SIGNS } = require('../models/constants');

const READINGS = [
  'Today is favourable for new beginnings. Confidence and vitality are with you — focus on creative work and take the lead where you can.',
  'A steady day. Progress comes from finishing what is already started rather than beginning something new.',
  'Conversations go well today. Say the thing you have been putting off; it will be received better than you expect.',
  'Money matters need a second look. Read the details before agreeing to anything.',
  'Rest is not idleness today. Protect your energy and let the small things wait.',
  'An old connection resurfaces. Answer it — there is something useful in it.',
  'Work asks more of you than usual, and rewards it. Keep your evening light.',
];

const COLOURS = ['Gold', 'Saffron', 'White', 'Green', 'Red', 'Blue', 'Yellow'];
const ENERGIES = ['High ↑', 'Steady →', 'Rising ↑', 'Gentle →'];

/** The same number for the same sign on the same day, and different tomorrow. */
function seedFor(sign, date) {
  const key = `${sign}-${date.toISOString().slice(0, 10)}`;
  let total = 0;
  for (const character of key) {
    total = (total * 31 + character.charCodeAt(0)) % 100000;
  }
  return total;
}

/** One sign's reading for a given day. */
function dailyFor(sign, date = new Date()) {
  const seed = seedFor(sign, date);

  return {
    sign,
    date: date.toISOString().slice(0, 10),
    reading: READINGS[seed % READINGS.length],
    luckyNumber: (seed % 9) + 1,
    colour: COLOURS[seed % COLOURS.length],
    energy: ENERGIES[seed % ENERGIES.length],
  };
}

/** Every sign at once, for a listing screen. */
function dailyForAll(date = new Date()) {
  return ZODIAC_SIGNS.map(sign => dailyFor(sign, date));
}

/**
 * Where the planets are today.
 *
 * Placeholder positions, moving slowly and predictably with the date so the
 * screen is not static. Replace with the ephemeris at the same time as the
 * reading above.
 */
function planetPositions(date = new Date()) {
  const day = Math.floor(date.getTime() / 86400000);

  const planets = [
    { glyph: '☀', name: 'Sun', speed: 1 },
    { glyph: '☽', name: 'Moon', speed: 13 },
    { glyph: '♂', name: 'Mars', speed: 0.5 },
    { glyph: '♃', name: 'Jupiter', speed: 0.08 },
    { glyph: '♀', name: 'Venus', speed: 1.2 },
    { glyph: '♄', name: 'Saturn', speed: 0.03 },
  ];

  return {
    date: date.toISOString().slice(0, 10),
    planets: planets.map((planet, index) => ({
      glyph: planet.glyph,
      name: planet.name,
      sign: ZODIAC_SIGNS[Math.floor(day * planet.speed + index * 30) % 12],
    })),
  };
}

module.exports = { dailyFor, dailyForAll, planetPositions, READINGS };
