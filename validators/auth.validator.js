/**
 * What the auth endpoints accept.
 *
 * Validators are middleware: they check the request's shape and stop it before
 * a controller or service ever sees it, so those two only deal in values that
 * are already the right kind of thing.
 *
 * Each export is an array: one express-validator chain per field, then
 * `validate`, which is what actually refuses the request if any chain found
 * something. Express flattens an array of middleware, so a route still mounts
 * the whole thing as a single argument.
 *
 * The chains also sanitise. `.trim()` writes the trimmed value back to
 * `req.body`, so a controller reading `req.body.email` gets it already tidied.
 * Note that a field which was never sent comes out of `.trim()` as an empty
 * string rather than staying undefined — which is harmless here, because every
 * field that is trimmed is also required, so the request is refused anyway.
 */

const { body } = require('express-validator');

const { GENDERS } = require('../models/constants');
const { validate } = require('../middlewares/validate.middleware');
const { LOGIN_CHANNELS, OTP_ROLES } = require('../services/auth.service');

/** Indian mobile numbers: ten digits starting 6–9. */
const PHONE_PATTERN = /^[6-9]\d{9}$/;
/** As the app's form types them: DD/MM/YYYY and "06 : 30 AM" or "18:30". */
const DATE_PATTERN = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const TIME_PATTERN = /^(\d{1,2})\s*:\s*(\d{2})(\s*[APap][Mm])?$/;
/** The six boxes both OTP screens draw. */
const OTP_PATTERN = /^\d{6}$/;

/**
 * Create Account, as the two-step wizard submits it: the profile step, the
 * birth-details step, and optionally a photo.
 *
 * The photo is not checked here — it is a file, not a body field, and
 * middlewares/upload.middleware.js has already accepted or refused it by the
 * time these run.
 */
const validateRegister = [
  body('fullName').trim().isLength({ min: 2 }).withMessage('Enter your full name.'),

  body('email').trim().isEmail().withMessage('Enter a valid email address.'),

  body('phone')
    .trim()
    .matches(PHONE_PATTERN)
    .withMessage('Enter a 10-digit mobile number.'),

  /** The only optional field: absent is fine, but a wrong value is not. */
  body('gender').optional().isIn(GENDERS).withMessage('Pick a gender.'),

  /** Birth details arrive with the same request, so they are checked with it. */
  body('dateOfBirth')
    .trim()
    .matches(DATE_PATTERN)
    .withMessage('Use the format DD/MM/YYYY.'),

  body('timeOfBirth')
    .trim()
    .matches(TIME_PATTERN)
    .withMessage('Use the format HH:MM AM/PM.'),

  body('placeOfBirth')
    .trim()
    .isLength({ min: 2 })
    .withMessage('Enter your place of birth.'),

  validate,
];

/**
 * Sign-in, both halves of it.
 *
 * One shape serves the mobile and the email screens alike: `channel` says which
 * identifier is being used, and the chain for the other one is skipped
 * entirely. `.if()` is what does that — without it an email login would be
 * refused for having no phone number, and vice versa.
 */
const CHANNEL_CHAINS = [
  /** Which app is asking. Defaults to the seeker app. */
  body('role').optional().isIn(OTP_ROLES).withMessage('Unknown account type.'),

  body('channel')
    .trim()
    .isIn(LOGIN_CHANNELS)
    .withMessage('Choose how you want to sign in.'),

  body('phone')
    .if(body('channel').equals('phone'))
    .trim()
    .matches(PHONE_PATTERN)
    .withMessage('Enter a 10-digit mobile number.'),

  body('email')
    .if(body('channel').equals('email'))
    .trim()
    .isEmail()
    .withMessage('Enter a valid email address.'),
];

/** POST /auth/login/otp/request — send a code to the number or the address. */
const validateLoginOtpRequest = [...CHANNEL_CHAINS, validate];

/** POST /auth/login/otp/verify — the same identifier, plus what was typed. */
const validateLoginOtpVerify = [
  ...CHANNEL_CHAINS,

  body('code')
    .trim()
    .matches(OTP_PATTERN)
    .withMessage('Enter the 6-digit code.'),

  validate,
];

/**
 * `fullName`, shared by Apple and Google: optional, and only ever meaningful
 * the one time it lands on a brand-new account (see auth.service.js's
 * createSocialAccount) — every other call simply doesn't send it.
 */
const SOCIAL_FULL_NAME = body('fullName')
  .optional({ values: 'falsy' })
  .trim()
  .isLength({ min: 2 })
  .withMessage('Enter your full name.');

/** POST /auth/apple — user_app's "Continue with Apple". */
const validateAppleLogin = [
  body('identityToken').trim().notEmpty().withMessage('Missing Apple identity token.'),
  SOCIAL_FULL_NAME,

  validate,
];

/** POST /auth/google — user_app's "Continue with Google". */
const validateGoogleLogin = [
  body('idToken').trim().notEmpty().withMessage('Missing Google ID token.'),
  SOCIAL_FULL_NAME,

  validate,
];

/** POST /auth/astrologer/register — step one and two of the wizard. */
const validateAstrologerRegister = [
  body('fullName').trim().isLength({ min: 2 }).withMessage('Enter your full name.'),

  body('phone')
    .trim()
    .matches(PHONE_PATTERN)
    .withMessage('Enter a 10-digit mobile number.'),

  body('email').optional({ values: 'falsy' }).trim().isEmail().withMessage('Enter a valid email address.'),

  body('gender').optional().isIn(GENDERS).withMessage('Pick a gender.'),

  body('dateOfBirth')
    .optional({ values: 'falsy' })
    .trim()
    .matches(DATE_PATTERN)
    .withMessage('Use the format DD/MM/YYYY.'),

  body('experienceYears')
    .optional()
    .isInt({ min: 0, max: 80 })
    .withMessage('Enter years of experience.'),

  /** Sent as arrays of ids from models/constants.js. */
  body('languages').optional().isArray().withMessage('Pick your languages.'),
  body('expertise').optional().isArray().withMessage('Pick your areas of expertise.'),

  validate,
];

/** POST /auth/admin/login — step one. */
const validateAdminLogin = [
  body('email').trim().isEmail().withMessage('Enter a valid email address.'),
  body('password').isLength({ min: 6 }).withMessage('Enter your password.'),
  validate,
];

/** POST /auth/admin/login/verify — step two. */
const validateAdminOtp = [
  body('email').trim().isEmail().withMessage('Enter a valid email address.'),
  body('code').trim().matches(OTP_PATTERN).withMessage('Enter the 6-digit code.'),
  validate,
];

/** POST /auth/admin/forgot-password — where to send the reset code. */
const validateAdminForgotPassword = [
  body('email').trim().isEmail().withMessage('Enter a valid email address.'),
  validate,
];

/** POST /auth/admin/reset-password — the emailed code and a new password. */
const validateAdminResetPassword = [
  body('email').trim().isEmail().withMessage('Enter a valid email address.'),
  body('code').trim().matches(OTP_PATTERN).withMessage('Enter the 6-digit code.'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters.'),
  validate,
];

module.exports = {
  validateRegister,
  validateAstrologerRegister,
  validateLoginOtpRequest,
  validateLoginOtpVerify,
  validateAppleLogin,
  validateGoogleLogin,
  validateAdminLogin,
  validateAdminOtp,
  validateAdminForgotPassword,
  validateAdminResetPassword,
};
