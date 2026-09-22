/**
 * "Where the planets are today" — the Home screen's global planetary
 * snapshot. Unlike a birth chart, this is not per-user: a planet's zodiac
 * SIGN at a given moment is the same everywhere on Earth (it only depends on
 * the moment in time, not the observer's location) — but AstrologyAPI's
 * /planets/extended still wants a full birth-detail-shaped request
 * (day/month/year/hour/min/lat/lon/tzone), so a fixed reference location
 * (New Delhi) stands in for "birth details" here; it has no bearing on the
 * signs that come back.
 *
 * Computed at most once per UTC day, through the exact same choke point
 * (getKundliSection) the birth-chart feature already uses for caching and
 * the credit guard — `birthHash` here is just "daily-transit:<date>" instead
 * of a real birth's hash, so every user loading Home on the same day shares
 * one cached call: at most 1 credit/day for this whole feature, not one per
 * page load.
 */

const { getKundliSection } = require('./kundliCache.service');
const { normalizePlanets } = require('./kundliNormalize');
const env = require('../config/env');

/** Arbitrary — sign placement doesn't depend on this, only the request shape needs it. */
const REFERENCE_PLACE = { latitude: 28.6139, longitude: 77.209 };
const REFERENCE_TZONE = 5.5;

const PLANET_GLYPHS = {
  Sun: '☀',
  Moon: '☽',
  Mars: '♂',
  Mercury: '☿',
  Jupiter: '♃',
  Venus: '♀',
  Saturn: '♄',
  Rahu: '☊',
  Ketu: '☋',
};

/**
 * A birthProfile-shaped object standing in for "right now, at the reference
 * place" — `dateParts`/`timeParts` in astrologyApi.client.js read UTC getters
 * off `dateOfBirth`, so `now` is shifted forward by the reference tzone first
 * (the same trick this codebase already uses for a birth date stored "at UTC
 * midnight" to represent a plain local calendar date without ambiguity).
 */
function referenceProfile(now) {
  const isoDate = now.toISOString().slice(0, 10);
  const localMoment = new Date(now.getTime() + REFERENCE_TZONE * 3600 * 1000);

  return {
    birthHash: `daily-transit:${isoDate}`,
    birthDetails: {
      dateOfBirth: localMoment,
      timeOfBirth: `${String(localMoment.getUTCHours()).padStart(2, '0')}:${String(localMoment.getUTCMinutes()).padStart(2, '0')}`,
      place: REFERENCE_PLACE,
    },
    tzone: REFERENCE_TZONE,
    ayanamsha: env.astrologyApi.ayanamsha,
  };
}

/**
 * @param {Date} [now]
 * @param {(birthProfile, endpoint, pathParam) => Promise<unknown>} [callProvider] Test seam — see kundliCache.service.js.
 */
async function currentPlanetPositions(now = new Date(), callProvider) {
  const profile = referenceProfile(now);
  const raw = await getKundliSection(profile, 'planets/extended', null, callProvider);
  const planets = normalizePlanets(raw);

  return {
    date: now.toISOString().slice(0, 10),
    planets: planets.map(row => ({
      glyph: PLANET_GLYPHS[row.planet] ?? '✦',
      name: row.planet,
      sign: row.sign,
    })),
  };
}

module.exports = { currentPlanetPositions };
