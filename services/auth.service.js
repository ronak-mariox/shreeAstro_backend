/**
 * Sign-up and sign-in for all three clients.
 *
 * Three kinds of account, and they log in differently:
 *
 *   user        (user_app)     OTP to a mobile number or an email address
 *   astrologer  (astro_app)    OTP to a mobile number
 *   admin       (admin_panel)  email + password
 *
 * Whichever way someone comes in, they leave with the same pair of tokens from
 * issueTokens() at the bottom of this file.
 *
 * There is no HTTP in here on purpose — controllers read the request, this
 * decides what is allowed, and the models hold the data.
 */

const env = require('../config/env');
const User = require('../models/User');
const UserProfile = require('../models/UserProfile');
const Astrologer = require('../models/Astrologer');
const AstrologerProfile = require('../models/AstrologerProfile');
const Admin = require('../models/Admin');
const ApiError = require('../utils/ApiError');
const { verifyPassword } = require('../utils/password');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require('../utils/token');
const otpService = require('./otp.service');
const settingsService = require('./settings.service');

/** Which collection each role's accounts live in. */
const ACCOUNT_MODELS = {
  user: User,
  astrologer: Astrologer,
  admin: Admin,
};

/** Roles that can log in with an OTP. Admins use a password instead. */
const OTP_ROLES = ['user', 'astrologer'];

/** Ways an OTP can be sent. Astrologers only ever use 'phone'. */
const LOGIN_CHANNELS = ['phone', 'email'];

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** "+91 98765 43210" -> "9876543210". */
function localPhoneOf(value) {
  const digits = String(value).replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
}

/** "15/08/1999" -> a Date at UTC midnight, so no timezone shifts the day. */
function parseBirthDate(value) {
  const [, day, month, year] = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(String(value).trim());
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

/** "06 : 30 AM" -> "06:30". A 24-hour time is passed straight through. */
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

/** "Mumbai, Maharashtra" -> the pieces the profile stores it in. */
function parseBirthPlace(value) {
  const formatted = String(value).trim();
  const [city, state] = formatted.split(',').map(part => part.trim());
  return { formatted, city, state };
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Creates a seeker account (user_app Create Account).
 *
 * Both steps of the wizard arrive in one request, so an account is only ever
 * created complete. Throws 409 if the email or number is already taken.
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
  const name = String(fullName).trim();
  const normalisedEmail = String(email).trim().toLowerCase();
  const number = localPhoneOf(phone);

  const existing = await User.findOne({
    $or: [{ email: normalisedEmail }, { 'phone.number': number }],
  });
  if (existing) {
    throw existing.email === normalisedEmail
      ? ApiError.conflict('This email is already registered.', { email: 'Already registered.' })
      : ApiError.conflict('This mobile number is already registered.', { phone: 'Already registered.' });
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

  return { user, profile };
}

/**
 * Creates an astrologer account (astro_app registration wizard).
 *
 * The account starts as `pending` — it cannot take consultations until an admin
 * approves it from the panel. Documents and bank details are filed afterwards,
 * against the account this creates.
 */
async function registerAstrologer({
  fullName,
  email,
  phone,
  gender,
  dateOfBirth,
  languages = [],
  expertise = [],
  experienceYears = 0,
  about,
  photoUrl,
}) {
  const name = String(fullName).trim();
  const normalisedEmail = email ? String(email).trim().toLowerCase() : undefined;
  const number = localPhoneOf(phone);

  const existing = await Astrologer.findOne({
    $or: [{ 'phone.number': number }, ...(normalisedEmail ? [{ email: normalisedEmail }] : [])],
  });
  if (existing) {
    throw ApiError.conflict('An application already exists for this number.', {
      phone: 'Already registered.',
    });
  }

  const astrologer = await Astrologer.create({
    name,
    email: normalisedEmail,
    phone: { countryCode: '+91', number },
    gender,
    dateOfBirth: dateOfBirth ? parseBirthDate(dateOfBirth) : undefined,
    languages,
    expertise,
    experienceYears: Number(experienceYears) || 0,
    photoUrl,
    /**
     * The account exists and can sign in, but `applicationStatus` is what
     * decides whether it can take consultations. Documents and bank details
     * come next, then an admin approves it. See the Astrologer model.
     */
    applicationStatus: 'professional_submitted',
    onboardingStep: 2,
  });

  const profile = await AstrologerProfile.create({
    astrologer: astrologer._id,
    about,
    expertise,
    experienceYears: Number(experienceYears) || 0,
  });

  astrologer.profile = profile._id;
  await astrologer.save();

  return { astrologer, profile };
}

/* -------------------------------------------------------------------------- */
/* OTP login (user_app and astro_app)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Finds the account an OTP is being sent to.
 *
 * `role` picks the collection, `channel` picks the field.
 */
function findLoginAccount({ role, channel, phone, email }) {
  const Model = ACCOUNT_MODELS[role];
  const query =
    channel === 'phone'
      ? { 'phone.number': localPhoneOf(phone) }
      : { email: String(email).trim().toLowerCase() };

  return Model.findOne(query);
}

/** The value the code is actually sent to, and stored against in Redis. */
function destinationOf({ channel, phone, email }) {
  return channel === 'phone' ? localPhoneOf(phone) : String(email).trim().toLowerCase();
}

/**
 * Refuses anything that is not an account that can log in right now.
 *
 * "No such account" is answered plainly so the app can send the person to
 * Register instead of pretending to send a code to nobody.
 */
function assertCanLogIn(account, { role, channel }) {
  if (!account) {
    throw ApiError.notFound(
      channel === 'phone'
        ? 'No account is registered with this mobile number.'
        : 'No account is registered with this email address.',
      'account_not_found',
    );
  }

  if (account.status === 'blocked' || account.status === 'deleted') {
    throw ApiError.forbidden('This account is not active.', 'account_blocked');
  }

  /**
   * An astrologer whose application is still being reviewed may sign in — the
   * app shows them the "application submitted" screen. Only a rejection stops
   * them at the door.
   */
  if (role === 'astrologer' && account.applicationStatus === 'rejected') {
    throw ApiError.forbidden('This application was not approved.', 'application_rejected');
  }
  if (role === 'astrologer' && account.applicationStatus === 'suspended') {
    throw ApiError.forbidden('This account is suspended.', 'account_suspended');
  }
}

/**
 * Step one of signing in: send a code.
 *
 * @param role     'user' or 'astrologer'
 * @param channel  'phone' or 'email'
 */
async function requestLoginOtp({ role, channel, phone, email }) {
  if (!OTP_ROLES.includes(role)) {
    throw ApiError.badRequest('That account type does not use an OTP.');
  }
  if (!LOGIN_CHANNELS.includes(channel)) {
    throw ApiError.badRequest('Choose how you want to sign in.');
  }

  const account = await findLoginAccount({ role, channel, phone, email });
  assertCanLogIn(account, { role, channel });

  const destination = destinationOf({ channel, phone, email });

  let sent;
  try {
    sent = await otpService.sendOtp({ channel, destination, purpose: 'login' });
  } catch (error) {
    /** Thrown by sendOtp while a previous code is still inside its cooldown. */
    if (error.cooldown) {
      throw ApiError.tooManyRequests(error.message, 'otp_cooldown', error.cooldown);
    }
    throw error;
  }

  return {
    channel,
    destination: otpService.maskDestination(channel, destination),
    ...sent,
  };
}

/** What each OTP failure is answered with. */
const OTP_FAILURES = {
  not_requested: () =>
    ApiError.badRequest('Ask for a code first.', { code: 'No code was sent.' }),
  expired: () =>
    ApiError.badRequest('That code has expired. Ask for a new one.', { code: 'Expired.' }),
  attempts_exceeded: () =>
    ApiError.tooManyRequests('Too many wrong attempts. Ask for a new code.', 'otp_attempts_exceeded'),
};

/**
 * Step two of signing in: check the code and hand back the account.
 *
 * Verifying also marks that channel verified — proving you control a number is
 * the same act whether it is called "signing in" or "confirming your phone".
 *
 * Tokens are minted by the caller, so this stays about the account.
 */
async function verifyLoginOtp({ role, channel, phone, email, code }) {
  if (!OTP_ROLES.includes(role)) {
    throw ApiError.badRequest('That account type does not use an OTP.');
  }
  if (!LOGIN_CHANNELS.includes(channel)) {
    throw ApiError.badRequest('Choose how you want to sign in.');
  }

  const account = await findLoginAccount({ role, channel, phone, email });
  assertCanLogIn(account, { role, channel });

  const destination = destinationOf({ channel, phone, email });
  const result = await otpService.verifyOtp({ channel, destination, code, purpose: 'login' });

  if (!result.ok) {
    if (result.reason === 'invalid') {
      const left = result.attemptsLeft;
      throw ApiError.badRequest(
        left > 0
          ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
          : 'That code is not right. Ask for a new one.',
        { code: 'Incorrect code.' },
      );
    }
    throw OTP_FAILURES[result.reason]();
  }

  if (channel === 'phone') {
    account.isPhoneVerified = true;
  } else {
    account.isEmailVerified = true;
  }
  account.lastLoginAt = new Date();
  account.lastActiveAt = new Date();
  await account.save();

  return account;
}

/* -------------------------------------------------------------------------- */
/* Password login (admin_panel)                                               */
/* -------------------------------------------------------------------------- */

/** How many wrong passwords lock an admin account, and for how long. */
const MAX_ADMIN_ATTEMPTS = 5;
const ADMIN_LOCK_MINUTES = 15;

/**
 * Signs an admin in with an email and password.
 *
 * A wrong password is counted, and enough of them lock the account for a
 * while — an admin login is the most valuable door in the system, so it is the
 * one worth slowing down.
 *
 * The answer to a wrong email and a wrong password is deliberately the same, so
 * the form cannot be used to find out which addresses are admins.
 */
async function loginAdmin({ email, password, ip }) {
  const admin = await Admin.findOne({ email: String(email).trim().toLowerCase() })
    .select('+passwordHash');

  const refuse = () => ApiError.unauthorized('Email or password is incorrect.', 'invalid_credentials');

  if (!admin) {
    throw refuse();
  }
  if (admin.status !== 'active') {
    throw ApiError.forbidden('This account is not active.', 'account_blocked');
  }
  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    const minutes = Math.ceil((admin.lockedUntil - Date.now()) / 60000);
    throw ApiError.tooManyRequests(
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      'account_locked',
      minutes * 60,
    );
  }

  const correct = await verifyPassword(password, admin.passwordHash);

  if (!correct) {
    admin.failedLoginAttempts += 1;
    if (admin.failedLoginAttempts >= MAX_ADMIN_ATTEMPTS) {
      admin.lockedUntil = new Date(Date.now() + ADMIN_LOCK_MINUTES * 60000);
      admin.failedLoginAttempts = 0;
    }
    await admin.save();
    throw refuse();
  }

  admin.failedLoginAttempts = 0;
  admin.lockedUntil = undefined;
  await admin.save();

  /**
   * Step two, when the platform asks for it: a code to the admin's inbox.
   *
   * The password alone is not a session yet — `stampSignIn` below is what
   * finishes it, and only verifyAdminOtp calls that.
   */
  const settings = await settingsService.get();
  if (settings.features.adminTwoFactor) {
    const sent = await otpService.sendOtp({
      channel: 'email',
      destination: admin.email,
      purpose: 'admin_login',
    }).catch(error => {
      /** Already sent one moments ago — reuse it rather than refusing. */
      if (error.cooldown) {
        return { expiresInSeconds: 0, resendInSeconds: error.cooldown };
      }
      throw error;
    });

    return {
      admin,
      requiresOtp: true,
      destination: otpService.maskDestination('email', admin.email),
      ...sent,
    };
  }

  await stampSignIn(admin, ip);
  return { admin, requiresOtp: false };
}

/** Records the sign-in. Called once the last factor has been proved. */
async function stampSignIn(admin, ip) {
  admin.lastLoginAt = new Date();
  admin.lastActiveAt = new Date();
  admin.lastLoginIp = ip;
  await admin.save();
  return admin;
}

/**
 * Step two of the admin sign-in: the emailed code.
 *
 * The password was already proved in loginAdmin, so this only has to prove the
 * second factor. Nothing about the first step is remembered between the two
 * calls — the code is tied to the email address, which is what makes it safe to
 * be stateless here.
 */
async function verifyAdminOtp({ email, code, ip }) {
  const admin = await Admin.findOne({ email: String(email).trim().toLowerCase() });

  if (!admin) {
    throw ApiError.unauthorized('Email or password is incorrect.', 'invalid_credentials');
  }
  if (admin.status !== 'active') {
    throw ApiError.forbidden('This account is not active.', 'account_blocked');
  }

  const result = await otpService.verifyOtp({
    channel: 'email',
    destination: admin.email,
    code,
    purpose: 'admin_login',
  });

  if (!result.ok) {
    if (result.reason === 'invalid') {
      const left = result.attemptsLeft;
      throw ApiError.unauthorized(
        left > 0
          ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
          : 'That code is not right. Ask for a new one.',
        'otp_invalid',
      );
    }
    if (result.reason === 'attempts_exceeded') {
      throw ApiError.tooManyRequests('Too many wrong attempts. Sign in again.', 'otp_attempts_exceeded');
    }
    throw ApiError.unauthorized('That code has expired. Sign in again.', 'otp_expired');
  }

  await stampSignIn(admin, ip);
  return admin;
}

/** Sends the sign-in code again. */
async function resendAdminOtp({ email }) {
  const admin = await Admin.findOne({ email: String(email).trim().toLowerCase() });
  if (!admin || admin.status !== 'active') {
    throw ApiError.unauthorized('Email or password is incorrect.', 'invalid_credentials');
  }

  try {
    return await otpService.sendOtp({
      channel: 'email',
      destination: admin.email,
      purpose: 'admin_login',
    });
  } catch (error) {
    if (error.cooldown) {
      throw ApiError.tooManyRequests(error.message, 'otp_cooldown', error.cooldown);
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The pair of tokens that *is* a signed-in client.
 *
 * Nothing is written down server-side, which has one consequence worth saying
 * out loud: a token cannot be taken back before it expires. Signing out clears
 * the client's copy, but a refresh token already copied off a device keeps
 * working until it expires. JWT_REFRESH_EXPIRES_IN is the lever that bounds it.
 */
function issueTokens(accountId, role) {
  if (!ACCOUNT_MODELS[role]) {
    throw new Error(`Cannot issue tokens for role "${role}".`);
  }

  return {
    accessToken: signAccessToken(accountId, role),
    refreshToken: signRefreshToken(accountId, role),
  };
}

/**
 * Trades a refresh token for a fresh pair.
 *
 * The account is re-read on the way through, which is the one late check this
 * flow can still make: blocking an account bites here, within one access
 * token's lifetime.
 */
async function refreshTokens(token) {
  let claims;
  try {
    claims = verifyRefreshToken(token);
  } catch (error) {
    throw ApiError.unauthorized(error.message, error.code);
  }

  const account = await ACCOUNT_MODELS[claims.role].findById(claims.accountId).select('status');

  if (!account) {
    throw ApiError.unauthorized('This account no longer exists.', 'account_missing');
  }
  if (account.status === 'blocked' || account.status === 'deleted') {
    throw ApiError.forbidden('This account is not active.', 'account_blocked');
  }

  return issueTokens(claims.accountId, claims.role);
}

module.exports = {
  registerUser,
  registerAstrologer,
  requestLoginOtp,
  verifyLoginOtp,
  loginAdmin,
  verifyAdminOtp,
  resendAdminOtp,
  issueTokens,
  refreshTokens,
  LOGIN_CHANNELS,
  OTP_ROLES,
  /** Shared with the profile endpoints and the tests. */
  localPhoneOf,
  parseBirthDate,
  parseBirthTime,
  parseBirthPlace,
};
