/**
 * The four read endpoints — everything a kundli screen asks for once a
 * BirthProfile exists. Every provider section still goes through
 * getKundliSection, so a section missing from a partial batch is simply
 * retried (and re-cached) the next time a screen asks for it — no separate
 * "retry" endpoint needed.
 */

const BirthProfile = require('../models/BirthProfile');
const UserProfile = require('../models/UserProfile');
const { ChatSession } = require('../models/Chat');
const ApiError = require('../utils/ApiError');
const { getKundliSection } = require('./kundliCache.service');
const { getChartImageUrl } = require('./chartStorage.service');
const geoService = require('./geo.service');
const kundliService = require('./kundli.service');
const { SADHESATI_TTL_SECONDS } = kundliService;
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

  const details = birthProfile.birthDetails || {};
  return {
    profileId,
    status: birthProfile.status,
    /** The birth this chart was cast for — the page prints these, never the account's (possibly newer) details. */
    birth: {
      fullName: details.fullName ?? null,
      gender: details.gender ?? null,
      dateOfBirth: details.dateOfBirth ?? null,
      timeOfBirth: details.timeOfBirth ?? null,
      place: details.place
        ? { formatted: details.place.formatted ?? null, city: details.place.city ?? null, country: details.place.country ?? null }
        : null,
    },
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

/**
 * GET /kundli/me — is there already a generated kundli for the seeker's
 * CURRENT birth details?
 *
 * The Kundli tab asks this instead of trusting an id it remembered: the
 * moment any of the date, time or place of birth changes, no stored chart
 * matches any more, so the app offers to generate — which casts a new chart
 * (a new birth means a new cache key) and stores it. Details left alone
 * match the same chart forever, and every later open is a database read,
 * with nothing fetched or paid for again.
 *
 * Deliberately server-side: it is the same answer on every device the seeker
 * signs in on, and the profile's own place text and a generated chart's are
 * both the label the place search returned, so they compare exactly.
 */
async function getCurrentKundli(userId) {
  const profile = await UserProfile.findOne({ user: userId }).select('birthDetails').lean();
  const details = profile?.birthDetails;

  if (!details?.dateOfBirth || !details?.timeOfBirth || !details?.place?.formatted) {
    /** Nothing to match against yet — the app asks for birth details first. */
    return { found: false, reason: 'birth_details_missing' };
  }

  const candidates = await BirthProfile.find({ user: userId }).sort({ createdAt: -1 }).lean();
  const match = candidates.find(candidate => isSameBirth(details, candidate.birthDetails));

  if (!match) {
    /** Their details changed (or they never generated one): a fresh chart is needed. */
    return { found: false, reason: 'not_generated' };
  }
  return { found: true, profileId: String(match._id), status: match.status };
}

/**
 * The same place, written by whoever wrote it.
 *
 * Coordinates when both sides have them — that is what the chart itself was
 * cast from. Otherwise the city, because the two records genuinely spell the
 * place differently: the account's own birth details keep what the seeker
 * picked in the form ("Aligarh", country "India"), while a generated chart
 * keeps what the provider returned ("Aligarh, IN", country "IN"), and only the
 * seeker's side is missing the coordinates.
 *
 * Comparing the formatted text, as this used to, therefore never matched — so
 * the Kundli tab offered "Generate Kundli" even immediately after generating
 * one, and pressing it again cast another.
 */
function coordsOf(place) {
  if (place?.latitude == null || place?.longitude == null) {
    return null;
  }
  /** 3 decimal places is ~100m — the same birth place, not the same GPS reading. */
  return `${Number(place.latitude).toFixed(3)},${Number(place.longitude).toFixed(3)}`;
}

function cityOf(place) {
  const city = place?.city || String(place?.formatted || '').split(',')[0];
  return String(city).trim().toLowerCase();
}

function samePlace(a, b) {
  const [left, right] = [coordsOf(a), coordsOf(b)];
  return left && right ? left === right : cityOf(a) === cityOf(b);
}

/**
 * Whether two sets of birth details describe the same chart: the day, the
 * minute, and the place. A chart is cast from exactly these, so anything that
 * differs here is a different chart and has to be generated.
 */
function isSameBirth(a, b) {
  return (
    dayOf(a?.dateOfBirth) === dayOf(b?.dateOfBirth)
    && (a?.timeOfBirth || '') === (b?.timeOfBirth || '')
    && samePlace(a?.place, b?.place)
  );
}

/** A Date (or ISO string) -> "YYYY-MM-DD" in UTC, the way birth dates are stored (UTC midnight). */
const dayOf = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

/** Only what the astrologer's screen prints about who the chart is for. */
const birthSummary = details =>
  details
    ? {
        fullName: details.fullName,
        gender: details.gender,
        dateOfBirth: details.dateOfBirth,
        timeOfBirth: details.timeOfBirth,
        place: details.place?.formatted,
      }
    : undefined;

/** The chat, with the caller proved to be in it. */
async function participantChatOf(chatId, accountId) {
  const chat = await ChatSession.findById(chatId).catch(() => null);
  if (!chat) {
    throw ApiError.notFound('Chat not found.');
  }
  if (!chat.roleOf(accountId)) {
    throw ApiError.forbidden('You are not part of this chat.');
  }
  return chat;
}

/**
 * Which of the seeker's saved charts to show for this consultation, and how
 * well it actually answers the intake.
 *
 * Every candidate is the seeker's own — they are all BirthProfiles belonging to
 * `chat.user` — so this is never about showing a stranger's chart. It is about
 * being honest, because the intake form and the saved chart routinely disagree:
 * the intake's birth date and time are typed again per consultation (and start
 * from a default), so a seeker whose kundli is for 13/05/2004 08:00 may well
 * file an intake saying 01/01/2000 11:00.
 *
 * Requiring an exact match, as this used to, meant the astrologer was shown
 * nothing at all in that case — with a fully generated kundli sitting in the
 * database. So the match is graded instead, best first, and named in the
 * response so the app can say which it got:
 *
 *   'intake' — same birth date, and same time where both give one.
 *   'date'   — same birth date, different time of birth.
 *   'seeker' — nothing matched the intake; this is the seeker's own chart.
 *
 * (generateSeekerKundliForChat adds a fourth, 'generated': a chart that was
 * just made from details someone typed, which answers those details by
 * definition and needs none of this guessing.)
 *
 * `status: 'ready'` first within each grade (a pending or failed profile has
 * nothing to draw), then the most recently created.
 */
function pickProfileForChat(profiles, intake) {
  const readyFirst = [...profiles].sort(
    (a, b) => Number(b.status === 'ready') - Number(a.status === 'ready'),
  );

  const intakeDay = dayOf(intake?.dateOfBirth);
  const sameDay = intakeDay
    ? readyFirst.filter(entry => dayOf(entry.birthDetails?.dateOfBirth) === intakeDay)
    : [];

  const sameMoment = sameDay.find(
    entry =>
      !intake?.timeOfBirth
      || !entry.birthDetails?.timeOfBirth
      || entry.birthDetails.timeOfBirth === intake.timeOfBirth,
  );
  if (sameMoment) {
    return { profile: sameMoment, match: 'intake' };
  }
  if (sameDay.length > 0) {
    return { profile: sameDay[0], match: 'date' };
  }

  const own = readyFirst.find(entry => entry.relation === 'self') || readyFirst[0];
  return own ? { profile: own, match: 'seeker' } : null;
}

/**
 * Everything the astrologer's kundli sheet draws, from one saved profile.
 *
 * Read-only and credit-free: the overview comes from the same stored sections
 * the seeker's own kundli screen reads, and dasha is the mahadasha list already
 * stored when the kundli was generated (the lazily fetched antardasha breakdown
 * is left out, so opening this never spends).
 */
async function kundliPayloadFor(profile, match, intake, origin) {
  const profileId = String(profile._id);
  const overview = await getKundliOverview(profileId, profile.user, origin);

  let mahadasha = [];
  try {
    const majorRaw = await getKundliSection(profile, 'major_vdasha');
    mahadasha = normalizeDashaPeriods(majorRaw, findCurrentLord(normalizeDashaPeriods(majorRaw)));
  } catch (error) {
    /** Dasha is one tab of several — the chart and planets still show without it. */
    console.error(`[kundliRead] dasha unavailable for ${profileId}:`, error.message);
  }

  return {
    found: true,
    profileId,
    status: profile.status,
    /** How well this chart answers the intake — see pickProfileForChat. */
    match,
    birthDetails: birthSummary(profile.birthDetails),
    /**
     * What the seeker actually filed on this consultation, whenever that is
     * not what the chart is for — so the astrologer sees the difference rather
     * than assuming the chart matches the question.
     */
    intakeBirthDetails: match === 'intake' ? undefined : birthSummary(intake),
    chart: overview.chart,
    lagna: overview.lagna,
    nakshatra: overview.nakshatra,
    keyPositions: overview.keyPositions,
    planetaryPositions: overview.planetaryPositions,
    mahadasha,
  };
}

/**
 * GET /chats/:chatId/kundli — the SEEKER's already-generated kundli, for the
 * astrologer in that consultation (or the seeker themself).
 *
 * Which chart, and how closely it matches what was asked, is pickProfileForChat
 * above. With no saved chart at all, `found: false` with the intake's details,
 * so the app can say so, pre-fill its form, and generate one from there
 * (generateSeekerKundliForChat below).
 */
async function getSeekerKundliForChat({ chatId, accountId, origin }) {
  const chat = await participantChatOf(chatId, accountId);

  const intake = chat.intake?.birthDetails;
  const profiles = await BirthProfile.find({ user: chat.user }).sort({ createdAt: -1 }).lean();
  const picked = pickProfileForChat(profiles, intake);

  if (!picked) {
    return { found: false, birthDetails: birthSummary(intake) };
  }

  return kundliPayloadFor(picked.profile, picked.match, intake, origin);
}

/**
 * POST /chats/:chatId/kundli — generate the seeker's kundli from inside the
 * consultation, when there is no saved chart to show (or none for the birth
 * details being asked about).
 *
 * The chart is generated FOR THE SEEKER, not for the astrologer: it is stored
 * against `chat.user`, exactly as if the seeker had generated it from their own
 * Kundli tab, so it is there next time either of them opens it and is never
 * paid for twice. Which is also why either side of the consultation may call
 * this — the astrologer typing the details in during a reading, or the seeker's
 * own app.
 *
 * Coordinates are never taken from the caller. A `placeId` from /places/search
 * is resolved as usual; a typed place name is searched here and the first match
 * used, which is what the astrologer's form gives (it has no place search of
 * its own) and keeps lat/lon coming only from the provider.
 */
async function generateSeekerKundliForChat({ chatId, accountId, details, origin }) {
  const chat = await participantChatOf(chatId, accountId);

  const { fullName, gender, dateOfBirth, timeOfBirth, place, placeId } = details || {};

  let resolvedPlaceId = placeId;
  if (!resolvedPlaceId) {
    const matches = await geoService.searchPlaces(place);
    if (matches.length === 0) {
      throw ApiError.badRequest('That birth place could not be found. Try the city name on its own.', {
        place: 'Not found — try the city name on its own.',
      });
    }
    resolvedPlaceId = matches[0].id;
  }

  const intake = chat.intake?.birthDetails;

  /**
   * `relation` decides what this chart is to the seeker, and the profile it
   * would reuse (createBirthProfile dedupes on user + birth moment + relation).
   * Their own birth details are their 'self' chart; anyone else they are asking
   * about is 'other', so generating for a relative never overwrites their own.
   */
  const ownProfile = await UserProfile.findOne({ user: chat.user }).lean();
  const ownDetails = ownProfile?.birthDetails;
  /** Parsed by the same helper createBirthProfile will use, so this cannot read it differently. */
  const { dob } = kundliService.parseAndValidateBirthMoment(dateOfBirth, timeOfBirth);
  const isOwnBirth = !ownDetails?.dateOfBirth || dayOf(ownDetails.dateOfBirth) === dayOf(dob);

  const created = await kundliService.createBirthProfile(
    chat.user,
    {
      fullName: fullName || intake?.fullName,
      gender: gender || intake?.gender,
      label: fullName || intake?.fullName,
      relation: isOwnBirth ? 'self' : 'other',
      dateOfBirth,
      timeOfBirth,
      placeId: resolvedPlaceId,
    },
    origin,
  );

  const profile = await BirthProfile.findById(created.id).lean();
  if (!profile) {
    throw ApiError.notFound('Kundli not found.');
  }

  /**
   * 'generated', not a graded match: this chart is exactly the details that
   * were just submitted. Whether those details also answer the intake is a
   * separate thing, and `intakeBirthDetails` carries it.
   */
  return kundliPayloadFor(profile, 'generated', intake, origin);
}

module.exports = {
  getCurrentKundli,
  isSameBirth,
  getSeekerKundliForChat,
  generateSeekerKundliForChat,
  pickProfileForChat,
  loadOwnedBirthProfile,
  getKundliOverview,
  getKundliDasha,
  getKundliAntardasha,
  getKundliDoshas,
  getKundliStrength,
  getKundliRemedies,
};
