/**
 * Auth over HTTP.
 *
 * A controller does three things and nothing else: read what the request
 * carries, hand it to a service, and shape what comes back. The rules live in
 * services/auth.service.js.
 *
 * Every response that opens a session sends the tokens twice over: as httpOnly
 * cookies *and* in the body. The admin panel is a browser and uses the cookies;
 * the two React Native apps read the body, keep both tokens in the device
 * keystore, and send the access one as `Authorization: Bearer`.
 */

const authService = require('../services/auth.service');
const userService = require('../services/user.service');
const astrologerService = require('../services/astrologer.service');
const { removeFile } = require('../services/storage.service');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { setAuthCookies, clearAuthCookies } = require('../utils/cookies');
const { refreshTokenFrom, verifyRefreshToken } = require('../utils/token');
const refreshTokenService = require('../services/refreshToken.service');

/** The seeker account as the app reads it — never the whole document. */
const toAuthUser = (user, profile) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  phone: user.phone?.number,
  gender: profile?.gender,
  avatarUrl: user.avatarUrl,
  /**
   * Whether there is anything left to fill in — see UserProfile's
   * `completion`. Register always leaves this `true` (the wizard collects
   * everything up front); Apple/Google can leave it `false` on a freshly
   * auto-opened account, which is the client's cue to open Edit Profile
   * instead of Home right after signing in.
   */
  profileComplete: profile?.completion?.percent === 100,
});

/** The astrologer account as their app reads it. */
const toAuthAstrologer = astrologer => ({
  id: String(astrologer._id),
  name: astrologer.name,
  email: astrologer.email,
  phone: astrologer.phone?.number,
  photo: astrologer.photoUrl,
  astroCode: astrologer.astroCode,
  applicationStatus: astrologer.applicationStatus,
  onboardingStep: astrologer.onboardingStep,
});

/** The admin as the panel reads it. */
const toAuthAdmin = admin => ({
  id: String(admin._id),
  name: admin.name,
  email: admin.email,
  role: admin.role,
  permissions: admin.permissions,
  avatarUrl: admin.avatarUrl,
});

/** Writes the cookies and returns the body every token response shares. */
function respondWithTokens(res, tokens, extra = {}, status = 200) {
  setAuthCookies(res, tokens);
  return res.status(status).json({ ...tokens, ...extra });
}

/* -------------------------------------------------------------------- users */

/** POST /api/v1/auth/register — the seeker app's two-step Create Account. */
const register = asyncHandler(async (req, res) => {
  try {
    const { user, profile, referralApplied } = await authService.registerUser({
      fullName: req.body.fullName,
      email: req.body.email,
      phone: req.body.phone,
      gender: req.body.gender,
      dateOfBirth: req.body.dateOfBirth,
      timeOfBirth: req.body.timeOfBirth,
      placeOfBirth: req.body.placeOfBirth,
      photoUrl: req.uploadedPhotoUrl,
      /** A friend's code from the website's `?ref=` or the app's field; invalid is ignored, not refused. */
      referralCode: req.body.referralCode,
    });

    /**
     * Fire-and-forget: resolves the real Vedic Moon sign in the background so
     * it's ready by the time the app reaches Home, without making
     * registration itself wait on a geocode + provider round trip. See
     * userService.enrichZodiacFromBirthDetails's own doc comment for why
     * every failure there is swallowed rather than surfaced here.
     */
    userService.enrichZodiacFromBirthDetails(user._id).catch(() => {});

    const tokens = await authService.issueTokens(user._id, 'user');
    return respondWithTokens(
      res,
      tokens,
      { user: toAuthUser(user, profile), referralApplied: Boolean(referralApplied) },
      201,
    );
  } catch (error) {
    /** A registration that is refused takes its orphaned upload with it. */
    removeFile(req.file);
    throw error;
  }
});

/* -------------------------------------------------------------- astrologers */

/** POST /api/v1/auth/astrologer/register — the astrologer app's application. */
const registerAstrologer = asyncHandler(async (req, res) => {
  try {
    const { astrologer } = await authService.registerAstrologer({
      fullName: req.body.fullName,
      email: req.body.email,
      phone: req.body.phone,
      gender: req.body.gender,
      dateOfBirth: req.body.dateOfBirth,
      languages: req.body.languages,
      expertise: req.body.expertise,
      experienceYears: req.body.experienceYears,
      about: req.body.about,
      photoUrl: req.uploadedPhotoUrl,
    });

    const tokens = await authService.issueTokens(astrologer._id, 'astrologer');
    return respondWithTokens(res, tokens, { astrologer: toAuthAstrologer(astrologer) }, 201);
  } catch (error) {
    removeFile(req.file);
    throw error;
  }
});

/* --------------------------------------------------------------- OTP login */

/**
 * POST /api/v1/auth/login/otp/request — send a sign-in code.
 *
 * One endpoint for both apps and both channels: `role` says which app is
 * asking, `channel` says whether the code goes to a number or an inbox.
 */
const requestLoginOtp = asyncHandler(async (req, res) => {
  const result = await authService.requestLoginOtp({
    role: req.body.role || 'user',
    channel: req.body.channel,
    phone: req.body.phone,
    email: req.body.email,
  });

  return res.json({ message: 'Code sent.', ...result });
});

/** POST /api/v1/auth/login/otp/verify — the code, for a session. */
const verifyLoginOtp = asyncHandler(async (req, res) => {
  const role = req.body.role || 'user';

  const account = await authService.verifyLoginOtp({
    role,
    channel: req.body.channel,
    phone: req.body.phone,
    email: req.body.email,
    code: req.body.code,
  });

  const tokens = await authService.issueTokens(account._id, role);

  if (role === 'astrologer') {
    return respondWithTokens(res, tokens, { astrologer: toAuthAstrologer(account) });
  }

  const { profile } = await userService.loadUser(account._id);
  return respondWithTokens(res, tokens, { user: toAuthUser(account, profile) });
});

/** POST /api/v1/auth/apple — user_app's "Continue with Apple". */
const loginApple = asyncHandler(async (req, res) => {
  const account = await authService.loginWithApple({
    identityToken: req.body.identityToken,
    fullName: req.body.fullName,
  });
  const tokens = await authService.issueTokens(account._id, 'user');

  const { profile } = await userService.loadUser(account._id);
  return respondWithTokens(res, tokens, { user: toAuthUser(account, profile) });
});

/** POST /api/v1/auth/google — user_app's "Continue with Google". */
const loginGoogle = asyncHandler(async (req, res) => {
  const account = await authService.loginWithGoogle({
    idToken: req.body.idToken,
    fullName: req.body.fullName,
  });
  const tokens = await authService.issueTokens(account._id, 'user');

  const { profile } = await userService.loadUser(account._id);
  return respondWithTokens(res, tokens, { user: toAuthUser(account, profile) });
});

/* ------------------------------------------------------------- admin login */

/**
 * POST /api/v1/auth/admin/login — step one: email and password.
 *
 * When two-factor is on (the default), this does *not* return a session. It
 * sends a code to the admin's inbox and answers `requiresOtp: true`; the panel
 * then posts that code to /admin/login/verify.
 */
const loginAdmin = asyncHandler(async (req, res) => {
  const result = await authService.loginAdmin({
    email: req.body.email,
    password: req.body.password,
    ip: req.ip,
  });

  if (result.requiresOtp) {
    return res.json({
      requiresOtp: true,
      email: result.admin.email,
      destination: result.destination,
      expiresInSeconds: result.expiresInSeconds,
      resendInSeconds: result.resendInSeconds,
      /** Development only — no mail transport is wired up yet. */
      devCode: result.devCode,
    });
  }

  const tokens = await authService.issueTokens(result.admin._id, 'admin');
  return respondWithTokens(res, tokens, {
    requiresOtp: false,
    admin: toAuthAdmin(result.admin),
  });
});

/** POST /api/v1/auth/admin/login/verify — step two: the emailed code. */
const verifyAdminOtp = asyncHandler(async (req, res) => {
  const admin = await authService.verifyAdminOtp({
    email: req.body.email,
    code: req.body.code,
    ip: req.ip,
  });

  const tokens = await authService.issueTokens(admin._id, 'admin');
  return respondWithTokens(res, tokens, { admin: toAuthAdmin(admin) });
});

/** POST /api/v1/auth/admin/login/resend — send the code again. */
const resendAdminOtp = asyncHandler(async (req, res) => {
  const sent = await authService.resendAdminOtp({ email: req.body.email });
  return res.json({ message: 'Code sent.', ...sent });
});

/**
 * POST /api/v1/auth/admin/forgot-password — step one: where to send the code.
 *
 * Always answers the same shape, whether or not the address belongs to an
 * admin — see authService.requestAdminPasswordReset for why.
 */
const forgotAdminPassword = asyncHandler(async (req, res) => {
  const result = await authService.requestAdminPasswordReset({ email: req.body.email });
  return res.json(result);
});

/** POST /api/v1/auth/admin/forgot-password/resend — send the reset code again. */
const resendAdminPasswordReset = asyncHandler(async (req, res) => {
  const result = await authService.resendAdminPasswordReset({ email: req.body.email });
  return res.json(result);
});

/**
 * POST /api/v1/auth/admin/reset-password — step two: the emailed code and a
 * new password. Does not sign the admin in — they return to the login form
 * and prove the new password there, same as any other first sign-in.
 */
const resetAdminPassword = asyncHandler(async (req, res) => {
  await authService.resetAdminPassword({
    email: req.body.email,
    code: req.body.code,
    password: req.body.password,
  });
  return res.json({ reset: true });
});

/* ----------------------------------------------------------- token upkeep */

/**
 * POST /api/v1/auth/refresh — trade a refresh token for a new pair.
 *
 * Open on purpose: the access token is expected to be expired by the time a
 * client gets here, so requiring one would make the endpoint useless.
 */
const refresh = asyncHandler(async (req, res) => {
  const token = refreshTokenFrom(req);
  if (!token) {
    clearAuthCookies(res);
    throw ApiError.unauthorized('No refresh token.', 'no_refresh_token');
  }

  try {
    const tokens = await authService.refreshTokens(token);
    return respondWithTokens(res, tokens);
  } catch (error) {
    /** The token is no good; do not leave a browser holding it. */
    clearAuthCookies(res);
    throw error;
  }
});

/**
 * POST /api/v1/auth/logout.
 *
 * The apps hold no cookies, so most of signing out is a client-side act: the
 * app deletes both tokens from its keystore regardless of what happens here.
 * What this endpoint can still do — and the reason it exists as more than a
 * formality — is revoke the refresh token server-side, so a copy of it left
 * behind (a compromised device, a stale background request) is dead rather
 * than merely unused. A token that is missing, already expired, or otherwise
 * unreadable is not an error here: there is nothing left to revoke either way.
 */
const logout = asyncHandler(async (req, res) => {
  const token = refreshTokenFrom(req);
  if (token) {
    try {
      const claims = verifyRefreshToken(token);
      await refreshTokenService.revoke(claims);
    } catch (error) {
      /** Already invalid or expired — nothing to revoke. */
    }
  }

  clearAuthCookies(res);
  return res.json({ message: 'Signed out.' });
});

/** GET /api/v1/auth/me — the signed-in account, whichever kind it is. */
const me = asyncHandler(async (req, res) => {
  const { accountId, role } = req.account;

  if (role === 'user') {
    return res.json({ role, user: await userService.getProfile(accountId) });
  }
  if (role === 'astrologer') {
    return res.json({ role, astrologer: await astrologerService.getOwnProfile(accountId) });
  }

  const Admin = require('../models/Admin');
  const admin = await Admin.findById(accountId);
  if (!admin) {
    throw ApiError.unauthorized('This account no longer exists.', 'account_missing');
  }
  if (admin.status !== 'active') {
    throw ApiError.forbidden('This account is not active.', 'account_blocked');
  }
  return res.json({ role, admin: toAuthAdmin(admin) });
});

module.exports = {
  register,
  registerAstrologer,
  requestLoginOtp,
  verifyLoginOtp,
  loginApple,
  loginGoogle,
  loginAdmin,
  verifyAdminOtp,
  resendAdminOtp,
  forgotAdminPassword,
  resendAdminPasswordReset,
  resetAdminPassword,
  refresh,
  logout,
  me,
};
