/**
 * The seeker's own account: profile, birth details, saved kundlis, favourites.
 *
 * Everything here is about the signed-in user reading or changing their *own*
 * record. Anything that reads someone else's lives in astrologer.service.js,
 * and anything an admin does lives in admin.service.js.
 */

const User = require('../models/User');
const UserProfile = require('../models/UserProfile');
const Astrologer = require('../models/Astrologer');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { parseBirthDate, parseBirthTime, parseBirthPlace } = require('./auth.service');
const { sunSignFromDate } = require('../utils/zodiac');
const { computeBirthHash } = require('../utils/birthHash');

/** "leo" -> "Leo" — ZODIAC_ICONS on the frontend (and the zodiac schema's own enum) key by Title Case. */
function titleCaseSign(sign) {
  return sign.charAt(0).toUpperCase() + sign.slice(1);
}

/**
 * Best-effort background enrichment, fired once right after Birth Details are
 * first saved (see controllers/auth.controller.js's register handler).
 *
 * "Save & Continue" only ever stores the birth place as typed text (see
 * auth.service.js's parseBirthPlace) — no geocoding happens there, since that
 * flow was never required to. Generating a full kundli is the one place that
 * DOES geocode a place, but it needs the seeker to pick one from
 * /places/search and then hit "Generate Kundli" specifically. This closes
 * that gap for the real Vedic Moon sign ("rashi") specifically: it geocodes
 * whatever place text is already on file and fetches only /astro_details
 * (never the full 12-call batch — nothing else here needs it) through the
 * same choke point and shared credit budget as everything else, then caches
 * the result permanently on UserProfile.zodiac so it is computed once ever.
 *
 * Every failure here (an ungeocodable place, the shared credit budget being
 * exhausted, a transient provider error) is swallowed on purpose: this always
 * runs after the response that actually mattered has already gone out, so
 * nothing here may ever surface as a user-facing error. getHome() below
 * simply has no rashi to show yet if this hasn't succeeded.
 */
async function enrichZodiacFromBirthDetails(userId) {
  const geoService = require('./geo.service');
  const { getKundliSection } = require('./kundliCache.service');
  const { normalizeAstroDetails } = require('./kundliNormalize');

  try {
    const profile = await UserProfile.findOne({ user: userId });
    const { birthDetails } = profile ?? {};
    if (!birthDetails?.dateOfBirth || !birthDetails?.timeOfBirth || !birthDetails.place?.formatted) {
      return;
    }

    const [place] = await geoService.searchPlaces(birthDetails.place.formatted);
    if (!place) {
      return;
    }

    const isoDob = birthDetails.dateOfBirth.toISOString().slice(0, 10);
    const { tzone } = await geoService.getTimezoneForDate(place.latitude, place.longitude, isoDob);
    const { ayanamsha } = env.astrologyApi;
    const birthHash = computeBirthHash({
      dob: isoDob,
      tob: birthDetails.timeOfBirth,
      lat: place.latitude,
      lon: place.longitude,
      ayanamsha,
    });

    /**
     * getKundliSection only needs birthHash for a cache HIT — on a miss it
     * hands this straight to astrologyApi.client's callProvider, which reads
     * birthDetails/tzone/ayanamsha off it exactly like a real BirthProfile
     * document would (see services/kundli.service.js's createBirthProfile).
     * A plain object matching that same shape is all callProvider ever reads.
     */
    const pseudoBirthProfile = {
      birthHash,
      birthDetails: {
        dateOfBirth: birthDetails.dateOfBirth,
        timeOfBirth: birthDetails.timeOfBirth,
        place: { latitude: place.latitude, longitude: place.longitude },
      },
      tzone,
      ayanamsha,
    };
    const raw = await getKundliSection(pseudoBirthProfile, 'astro_details');
    const astro = normalizeAstroDetails(raw);

    await UserProfile.updateOne(
      { _id: profile._id },
      {
        $set: {
          'zodiac.sunSign': titleCaseSign(sunSignFromDate(birthDetails.dateOfBirth)),
          'zodiac.moonSign': astro.moonSign,
          'zodiac.ascendant': astro.lagna,
          'zodiac.nakshatra': astro.nakshatra,
          'zodiac.computedAt': new Date(),
        },
      },
    );
  } catch (error) {
    console.error(`[user.service] zodiac enrichment failed for user ${userId}:`, error.message);
  }
}

/** Loads the account and its profile together, or throws. */
async function loadUser(userId) {
  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('Account not found.');
  }

  let profile = await UserProfile.findOne({ user: userId });
  /** Older accounts may predate the profile document; make one rather than 404. */
  if (!profile) {
    profile = await UserProfile.create({ user: userId, fullName: user.name });
    user.profile = profile._id;
    await user.save();
  }

  return { user, profile };
}

/** The profile screen. */
async function getProfile(userId) {
  const { user, profile } = await loadUser(userId);

  return {
    id: String(user._id),
    userCode: user.userCode,
    name: user.name,
    email: user.email,
    phone: user.phone?.number,
    avatarUrl: user.avatarUrl,
    gender: profile.gender,
    birthDetails: profile.birthDetails,
    zodiac: profile.zodiac,
    wallet: user.wallet,
    stats: user.stats,
    unreadNotifications: user.unreadNotifications,
    isPhoneVerified: user.isPhoneVerified,
    isEmailVerified: user.isEmailVerified,
    notificationPrefs: user.notificationPrefs,
    completion: profile.completion,
    profileComplete: profile.completion?.percent === 100,
  };
}

/**
 * Updates what the Edit Profile screen can change.
 *
 * The phone number is not editable here — changing it means proving the new
 * number with an OTP, which is a flow of its own.
 */
async function updateProfile(userId, changes) {
  const { user, profile } = await loadUser(userId);

  if (changes.fullName !== undefined) {
    user.name = String(changes.fullName).trim();
    profile.fullName = user.name;
  }

  if (changes.email !== undefined) {
    const email = String(changes.email).trim().toLowerCase();
    const taken = await User.findOne({ email, _id: { $ne: userId } });
    if (taken) {
      throw ApiError.conflict('That email is already in use.', { email: 'Already in use.' });
    }
    /** A new address is unproven until it is verified again. */
    if (email !== user.email) {
      user.email = email;
      user.isEmailVerified = false;
    }
  }

  if (changes.gender !== undefined) {
    profile.gender = changes.gender;
    profile.birthDetails.gender = changes.gender;
  }
  if (changes.photoUrl) {
    user.avatarUrl = changes.photoUrl;
    profile.avatarUrl = changes.photoUrl;
  }

  /** Birth details are what every chart is cast from, so they travel together. */
  if (changes.dateOfBirth) {
    profile.birthDetails.dateOfBirth = parseBirthDate(changes.dateOfBirth);
  }
  if (changes.timeOfBirth) {
    profile.birthDetails.timeOfBirth = parseBirthTime(changes.timeOfBirth);
  }
  if (changes.placeOfBirth) {
    profile.birthDetails.place = parseBirthPlace(changes.placeOfBirth);
  }
  if (changes.fullName !== undefined) {
    profile.birthDetails.fullName = profile.fullName;
  }

  await profile.save();
  await user.save();

  return getProfile(userId);
}

/** Turns individual alert types on and off. */
async function updateNotificationPrefs(userId, prefs) {
  const user = await User.findByIdAndUpdate(
    userId,
    { $set: Object.fromEntries(Object.entries(prefs).map(([k, v]) => [`notificationPrefs.${k}`, v])) },
    { returnDocument: 'after' },
  );
  if (!user) {
    throw ApiError.notFound('Account not found.');
  }
  return user.notificationPrefs;
}

/**
 * Everything the home screen prints, in one call.
 *
 * The screen opens on this, so it gathers the greeting, the wallet, today's
 * horoscope, where the planets are and the last few consultations rather than
 * making the app fire five requests while the user watches a spinner.
 */
async function getHome(userId) {
  const horoscopeService = require('./horoscope.service');
  const { currentPlanetPositions } = require('./transitPlanets.service');
  const { ChatSession } = require('../models/Chat');

  const { user, profile } = await loadUser(userId);

  /**
   * The real Vedic Moon sign ("rashi") — see enrichZodiacFromBirthDetails,
   * which resolves and caches this once, in the background, right after
   * Birth Details are first saved. Deliberately no fallback to a Western Sun
   * sign here: what Indian users mean by "rashi" is the Moon sign, and
   * showing a Sun sign under that label would just be wrong, not merely
   * approximate. Until enrichment has finished (or if the place on file
   * could never be geocoded), the home screen simply has no rashi yet.
   */
  const moonSign = profile.zodiac?.moonSign;
  const recent = await ChatSession.find({
    user: userId,
    status: 'ended',
    type: 'consultation',
  })
    .sort({ endedAt: -1 })
    .limit(3)
    .populate('astrologer', 'name photoUrl');

  return {
    profile: {
      name: user.name,
      avatarUrl: user.avatarUrl,
      moonSign,
      dateOfBirth: profile.birthDetails?.dateOfBirth,
    },
    wallet: {
      balance: user.wallet?.balance || 0,
      currency: user.wallet?.currency || 'INR',
    },
    /** No rashi resolved yet means no reading — the app nudges to generate a kundli. */
    horoscope: moonSign ? await horoscopeService.dailyFor(moonSign) : null,
    planetPositions: await currentPlanetPositions(),
    unreadNotifications: user.unreadNotifications || 0,
    recentConsultations: recent.map(chat => ({
      id: String(chat._id),
      astrologer: chat.astrologer?.name,
      photo: chat.astrologer?.photoUrl,
      channel: chat.channel,
      durationSeconds: chat.durationSeconds,
      amount: chat.billing?.amountCharged,
      endedAt: chat.endedAt,
    })),
  };
}

/* ----------------------------------------------------------------- kundlis */

/** Every chart the seeker has saved, newest first. */
async function listKundlis(userId) {
  const { profile } = await loadUser(userId);
  return [...profile.savedKundlis].reverse();
}

/**
 * Saves a chart.
 *
 * There is no ephemeris wired up yet, so `chart` is whatever the caller
 * computed. When a provider lands, compute it here instead of trusting the
 * client, and set `provider` to its name.
 */
async function saveKundli(userId, { label, relation = 'self', fullName, gender, dateOfBirth, timeOfBirth, placeOfBirth, chart }) {
  const { profile } = await loadUser(userId);

  profile.savedKundlis.push({
    label: label || fullName,
    relation,
    birthDetails: {
      fullName,
      gender,
      dateOfBirth: parseBirthDate(dateOfBirth),
      timeOfBirth: parseBirthTime(timeOfBirth),
      place: parseBirthPlace(placeOfBirth),
    },
    chart,
    provider: 'client',
  });
  await profile.save();

  await User.updateOne({ _id: userId }, { $inc: { 'stats.kundlis': 1 } });

  return profile.savedKundlis[profile.savedKundlis.length - 1];
}

async function deleteKundli(userId, kundliId) {
  const { profile } = await loadUser(userId);

  const kundli = profile.savedKundlis.id(kundliId);
  if (!kundli) {
    throw ApiError.notFound('That chart is no longer saved.');
  }

  kundli.deleteOne();
  await profile.save();
  return { deleted: true };
}

/* -------------------------------------------------------------- favourites */

/** Adds or removes an astrologer from the seeker's favourites. */
async function toggleFavourite(userId, astrologerId) {
  const exists = await Astrologer.exists({ _id: astrologerId });
  if (!exists) {
    throw ApiError.notFound('That astrologer is not available.');
  }

  const user = await User.findById(userId).select('favouriteAstrologers');
  const already = user.favouriteAstrologers.some(id => String(id) === String(astrologerId));

  await User.updateOne(
    { _id: userId },
    already
      ? { $pull: { favouriteAstrologers: astrologerId } }
      : { $addToSet: { favouriteAstrologers: astrologerId } },
  );

  return { favourite: !already };
}

/** The favourites list, as directory cards. */
async function listFavourites(userId) {
  const { toDirectoryCard } = require('./astrologer.service');

  const user = await User.findById(userId).select('favouriteAstrologers');
  const rows = await Astrologer.find({ _id: { $in: user.favouriteAstrologers } });

  return rows.map(toDirectoryCard);
}

module.exports = {
  loadUser,
  getHome,
  getProfile,
  updateProfile,
  updateNotificationPrefs,
  listKundlis,
  saveKundli,
  deleteKundli,
  toggleFavourite,
  listFavourites,
  enrichZodiacFromBirthDetails,
};
