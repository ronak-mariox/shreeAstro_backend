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
const { parseBirthDate, parseBirthTime, parseBirthPlace } = require('./auth.service');

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
    freeConsultation: user.freeConsultation,
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
  const { ChatSession } = require('../models/Chat');

  const { user, profile } = await loadUser(userId);

  const sign = profile.zodiac?.sunSign;
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
      sunSign: sign,
      dateOfBirth: profile.birthDetails?.dateOfBirth,
    },
    wallet: {
      balance: user.wallet?.balance || 0,
      currency: user.wallet?.currency || 'INR',
    },
    /** No sign on file yet means no reading — the app nudges for birth details. */
    horoscope: sign ? horoscopeService.dailyFor(sign) : null,
    planetPositions: horoscopeService.planetPositions(),
    freeConsultation: user.freeConsultation,
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
};
