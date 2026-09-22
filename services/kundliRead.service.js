/**
 * The four read endpoints — everything a kundli screen asks for once a
 * BirthProfile exists. Every provider section still goes through
 * getKundliSection, so a section missing from a partial batch is simply
 * retried (and re-cached) the next time a screen asks for it — no separate
 * "retry" endpoint needed.
 */

const BirthProfile = require('../models/BirthProfile');
const ApiError = require('../utils/ApiError');
const { getKundliSection } = require('./kundliCache.service');
const { getChartImageUrl } = require('./chartStorage.service');
const { SADHESATI_TTL_SECONDS } = require('./kundli.service');
const {
  normalizeAstroDetails,
  normalizePlanets,
  normalizeDashaPeriods,
  findCurrentLord,
  normalizeKalsarpa,
  normalizeSadhesati,
  normalizePitraDosha,
  normalizeShadbala,
  normalizeRemedies,
} = require('./kundliNormalize');

/** Scoped by owner in the query itself, not fetch-then-check — a profile that exists but belongs to someone else looks identical to one that doesn't exist at all. */
async function loadOwnedBirthProfile(profileId, userId) {
  const profile = await BirthProfile.findOne({ _id: profileId, user: userId }).lean();
  if (!profile) {
    throw ApiError.notFound('Kundli not found.');
  }
  return profile;
}

/** GET /kundli/:profileId — chart image, key positions, planetary table. */
async function getKundliOverview(profileId, userId, origin) {
  const birthProfile = await loadOwnedBirthProfile(profileId, userId);

  const [astroRaw, planetsRaw, chartUrl] = await Promise.all([
    getKundliSection(birthProfile, 'astro_details'),
    getKundliSection(birthProfile, 'planets/extended'),
    /**
     * Isolated on purpose: the chart is presentational, and a storage failure
     * (misconfigured S3, a transient upload error) must not take down the
     * lagna/planetary data alongside it — those two are cached and already
     * paid for regardless of what happens to the chart.
     */
    getChartImageUrl(birthProfile, origin).catch(error => {
      console.error(`[kundliRead] chart unavailable for ${profileId}:`, error.message);
      return null;
    }),
  ]);

  const astro = normalizeAstroDetails(astroRaw);
  const planets = normalizePlanets(planetsRaw);
  const signOf = planet => planets.find(row => row.planet === planet)?.sign;

  return {
    profileId,
    status: birthProfile.status,
    chart: { url: chartUrl },
    lagna: astro.lagna,
    nakshatra: astro.nakshatra,
    keyPositions: [
      { label: 'Lagna', sign: astro.lagna },
      { label: 'Sun', sign: signOf('Sun') },
      { label: 'Moon', sign: astro.moonSign },
      { label: 'Mars', sign: signOf('Mars') },
      { label: 'Mercury', sign: signOf('Mercury') },
      { label: 'Jupiter', sign: signOf('Jupiter') },
    ],
    planetaryPositions: planets,
  };
}

/**
 * GET /kundli/:profileId/dasha — mahadasha list + the currently running one
 * and its antardasha breakdown.
 *
 * No live /current_vdasha_all call: /major_vdasha is already in the batch
 * (previously fetched and unused), and `findCurrentLord` works out "which one
 * is running now" from that same list against today's date. The one piece
 * /current_vdasha_all still uniquely offered — the current antardasha
 * breakdown — comes from lazily fetching /sub_vdasha for whichever mahadasha
 * lord that turns out to be, the exact same lazy call getKundliAntardasha
 * below already makes for any lord a user taps into.
 */
async function getKundliDasha(profileId, userId) {
  const birthProfile = await loadOwnedBirthProfile(profileId, userId);

  const majorRaw = await getKundliSection(birthProfile, 'major_vdasha');
  const currentMajorLord = findCurrentLord(normalizeDashaPeriods(majorRaw));

  let currentAntardasha = [];
  if (currentMajorLord) {
    const subRaw = await getKundliSection(birthProfile, 'sub_vdasha', currentMajorLord);
    const currentMinorLord = findCurrentLord(normalizeDashaPeriods(subRaw));
    currentAntardasha = normalizeDashaPeriods(subRaw, currentMinorLord);
  }

  return {
    profileId,
    mahadasha: normalizeDashaPeriods(majorRaw, currentMajorLord),
    currentAntardasha,
  };
}

/** GET /kundli/:profileId/dasha/:lord — lazy: only fetched (and only ever billed) the first time this specific lord is asked for. */
async function getKundliAntardasha(profileId, userId, lord) {
  const birthProfile = await loadOwnedBirthProfile(profileId, userId);

  const [subRaw, majorRaw] = await Promise.all([
    getKundliSection(birthProfile, 'sub_vdasha', lord),
    getKundliSection(birthProfile, 'major_vdasha'),
  ]);

  /** Only the currently-running mahadasha has a "current antardasha" at all — a lord the user tapped out of curiosity, past or future, doesn't. */
  const currentMajorLord = findCurrentLord(normalizeDashaPeriods(majorRaw));
  const currentMinorLord = lord === currentMajorLord ? findCurrentLord(normalizeDashaPeriods(subRaw)) : undefined;

  return { profileId, lord, antardasha: normalizeDashaPeriods(subRaw, currentMinorLord) };
}

/** GET /kundli/:profileId/doshas — kaal sarp, sade sati, pitra, normalised into one list. */
async function getKundliDoshas(profileId, userId) {
  const birthProfile = await loadOwnedBirthProfile(profileId, userId);

  const [kalsarpaRaw, sadhesatiRaw, pitraRaw] = await Promise.all([
    getKundliSection(birthProfile, 'kalsarpa_details'),
    /** Saturn-transit-derived, not fixed for life — 30-day TTL, same reasoning as the batch's own SADHESATI_TTL_SECONDS. */
    getKundliSection(birthProfile, 'sadhesati_current_status', null, undefined, { ttlSeconds: SADHESATI_TTL_SECONDS }),
    getKundliSection(birthProfile, 'pitra_dosha_report'),
  ]);

  return {
    profileId,
    doshas: [
      { name: 'Kaal Sarp Dosha', ...normalizeKalsarpa(kalsarpaRaw) },
      { name: 'Sade Sati', ...normalizeSadhesati(sadhesatiRaw) },
      { name: 'Pitra Dosha', ...normalizePitraDosha(pitraRaw) },
    ],
  };
}

/** GET /kundli/:profileId/strength — Shadbala, one row per classical graha in a fixed display order. */
async function getKundliStrength(profileId, userId) {
  const birthProfile = await loadOwnedBirthProfile(profileId, userId);
  const raw = await getKundliSection(birthProfile, 'shadbala');
  return { profileId, strength: normalizeShadbala(raw) };
}

/** GET /kundli/:profileId/remedies — gemstone + puja suggestions merged into the one list the UI renders. */
async function getKundliRemedies(profileId, userId) {
  const birthProfile = await loadOwnedBirthProfile(profileId, userId);

  const [gemRaw, pujaRaw] = await Promise.all([
    getKundliSection(birthProfile, 'basic_gem_suggestion'),
    getKundliSection(birthProfile, 'puja_suggestion'),
  ]);

  return { profileId, remedies: normalizeRemedies(gemRaw, pujaRaw) };
}

module.exports = {
  loadOwnedBirthProfile,
  getKundliOverview,
  getKundliDasha,
  getKundliAntardasha,
  getKundliDoshas,
  getKundliStrength,
  getKundliRemedies,
};
