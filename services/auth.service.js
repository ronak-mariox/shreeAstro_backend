/**
 * Account creation and sign-in — the rules, with no HTTP in sight.
 *
 * Everything here works in plain values and documents, so the same call serves
 * a REST controller today and anything else later (an admin tool, a seed
 * script, a socket) without being rewritten.
 */

const User = require('../models/User');
const UserProfile = require('../models/UserProfile');
const ApiError = require('../utils/ApiError');
const { signToken } = require('../utils/token');

/** "+91 98765 43210" → "9876543210". */
function localPhoneOf(value) {
  const digits = String(value).replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
}

/** "15/08/1999" → a Date at UTC midnight, so no timezone shifts the day. */
function parseBirthDate(value) {
  const [, day, month, year] = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(String(value).trim());
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

/** "06 : 30 AM" → "06:30"; a 24-hour time is passed through. */
function parseBirthTime(value) {
  const [, hour, minute, meridiem] =
    /^(\d{1,2})\s*:\s*(\d{2})(\s*[APap][Mm])?$/.exec(String(value).trim());

  let hours = Number(hour);
  if (meridiem) {
    const isPm = /p/i.test(meridiem);
    if (hours === 12) {
      hours = isPm ? 12 : 0;
    } else if (isPm) {
      hours += 12;
    }
  }

  return `${String(hours).padStart(2, '0')}:${minute}`;
}

/** "Mumbai, Maharashtra" → the pieces the profile keeps it in. */
function parseBirthPlace(value) {
  const formatted = String(value).trim();
  const [city, state] = formatted.split(',').map(part => part.trim());
  return { formatted, city, state };
}

/**
 * Registers a seeker: the account, and the profile the birth details go on.
 *
 * Both steps of the app's wizard arrive together, so an account is only ever
 * created complete. Throws a 409 when the email or number is already taken.
 */
async function registerUser({
  fullName,
  email,
  phone,
  gender,
  dateOfBirth,
  timeOfBirth,
  placeOfBirth,
  photoUrl,
}) {
  console.log('[auth] registering user', { fullName, email, phone, gender, dateOfBirth, timeOfBirth, placeOfBirth, photoUrl });
  const name = String(fullName).trim();
  const normalisedEmail = String(email).trim().toLowerCase();
  const number = localPhoneOf(phone);

  /** Checked up front so the caller gets a useful message, not a driver error. */
  const existing = await User.findOne({
    $or: [{ email: normalisedEmail }, { 'phone.number': number }],
  });
  if (existing) {
    throw existing.email === normalisedEmail
      ? ApiError.conflict('This email is already registered.', {
          email: 'Already registered.',
        })
      : ApiError.conflict('This mobile number is already registered.', {
          phone: 'Already registered.',
        });
  }

  const user = await User.create({
    name,
    email: normalisedEmail,
    phone: { countryCode: '+91', number },
    authProvider: 'otp',
    avatarUrl: photoUrl,
  });

  const profile = await UserProfile.create({
    user: user._id,
    fullName: name,
    gender,
    avatarUrl: photoUrl,
    birthDetails: {
      fullName: name,
      gender,
      dateOfBirth: parseBirthDate(dateOfBirth),
      timeOfBirth: parseBirthTime(timeOfBirth),
      place: parseBirthPlace(placeOfBirth),
    },
  });

  user.profile = profile._id;
  await user.save();

  return { user, profile, token: signToken(user._id, 'user') };
}

module.exports = {
  registerUser,
  /** Exported for the tests and for reuse by the profile endpoints. */
  localPhoneOf,
  parseBirthDate,
  parseBirthTime,
  parseBirthPlace,
};
