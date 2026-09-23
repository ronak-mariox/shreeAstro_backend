/** /api/v1/auth — who may sign in, and how. */

const express = require('express');

const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { rateLimit } = require('../middlewares/rateLimit.middleware');
const { uploadProfilePhoto } = require('../middlewares/upload.middleware');
const {
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
} = require('../validators/auth.validator');

const router = express.Router();

/**
 * Ceilings on the endpoints where something guessable is presented — a
 * six-digit code, or an admin's password.
 *
 * These count per caller, and a caller is an IP address: on a mobile network
 * that is shared by a great many real people at once, so the numbers are set
 * where a whole carrier's worth of ordinary sign-ins fits under them. What
 * stops a determined attacker is not this but the per-destination budget in
 * services/otp.service.js — ten guesses per phone number per 15 minutes,
 * which no amount of changing IP address gets around. This is the other
 * direction: one caller working through many different accounts, which is
 * exactly what guessing OTP_MASTER_CODE looks like while it stands in for real
 * delivery.
 *
 * The admin ceiling is tighter: a handful of people sign in to the panel, from
 * their own machines, and a password is worth more guesses to an attacker.
 *
 * Asking for a code is capped too, so nobody else's phone can be made to ring
 * all afternoon from here.
 */
const limitVerify = rateLimit({ name: 'otp-verify', limit: 60, windowSeconds: 15 * 60 });
const limitRequest = rateLimit({ name: 'otp-request', limit: 30, windowSeconds: 15 * 60 });
const limitAdminLogin = rateLimit({ name: 'admin-login', limit: 10, windowSeconds: 15 * 60 });

/**
 * Creating an account.
 *
 * Both of these carry a photo, so the multipart parser runs first — without it
 * `req.body` would be empty and every field would read as missing.
 */
router.post('/register', uploadProfilePhoto, validateRegister, authController.register);
router.post(
  '/astrologer/register',
  uploadProfilePhoto,
  validateAstrologerRegister,
  authController.registerAstrologer,
);

/**
 * Signing in with a code. One pair of endpoints for both apps: the body's
 * `role` says which, and `channel` says phone or email.
 */
router.post('/login/otp/request', limitRequest, validateLoginOtpRequest, authController.requestLoginOtp);
router.post('/login/otp/verify', limitVerify, validateLoginOtpVerify, authController.verifyLoginOtp);

/** Signing in with "Continue with Apple" — user_app only. */
router.post('/apple', validateAppleLogin, authController.loginApple);

/** Signing in with "Continue with Google" — user_app only. */
router.post('/google', validateGoogleLogin, authController.loginGoogle);

/**
 * Signing in to the panel: password, then a code to the admin's inbox. The
 * first call answers `requiresOtp` rather than a session when two-factor is on.
 */
router.post('/admin/login', limitAdminLogin, validateAdminLogin, authController.loginAdmin);
router.post('/admin/login/verify', limitVerify, validateAdminOtp, authController.verifyAdminOtp);
router.post('/admin/login/resend', limitRequest, authController.resendAdminOtp);

/**
 * Forgotten password: the same emailed-code mechanism as login's second
 * factor, just under its own purpose so a login code and a reset code can
 * never stand in for each other. Never returns a session — the admin proves
 * the new password by signing in with it afterward, same as a first sign-in.
 */
router.post('/admin/forgot-password', limitRequest, validateAdminForgotPassword, authController.forgotAdminPassword);
router.post('/admin/forgot-password/resend', limitRequest, authController.resendAdminPasswordReset);
router.post('/admin/reset-password', limitVerify, validateAdminResetPassword, authController.resetAdminPassword);

/**
 * Token upkeep. Both are deliberately open: refresh is proved by the refresh
 * token rather than by an access token, and anyone reaching either one has an
 * access token that has probably already expired.
 */
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

router.get('/me', authenticate, authController.me);

module.exports = router;
