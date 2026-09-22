/** /api/v1/auth — who may sign in, and how. */

const express = require('express');

const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middlewares/auth.middleware');
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
router.post('/login/otp/request', validateLoginOtpRequest, authController.requestLoginOtp);
router.post('/login/otp/verify', validateLoginOtpVerify, authController.verifyLoginOtp);

/** Signing in with "Continue with Apple" — user_app only. */
router.post('/apple', validateAppleLogin, authController.loginApple);

/** Signing in with "Continue with Google" — user_app only. */
router.post('/google', validateGoogleLogin, authController.loginGoogle);

/**
 * Signing in to the panel: password, then a code to the admin's inbox. The
 * first call answers `requiresOtp` rather than a session when two-factor is on.
 */
router.post('/admin/login', validateAdminLogin, authController.loginAdmin);
router.post('/admin/login/verify', validateAdminOtp, authController.verifyAdminOtp);
router.post('/admin/login/resend', authController.resendAdminOtp);

/**
 * Forgotten password: the same emailed-code mechanism as login's second
 * factor, just under its own purpose so a login code and a reset code can
 * never stand in for each other. Never returns a session — the admin proves
 * the new password by signing in with it afterward, same as a first sign-in.
 */
router.post('/admin/forgot-password', validateAdminForgotPassword, authController.forgotAdminPassword);
router.post('/admin/forgot-password/resend', authController.resendAdminPasswordReset);
router.post('/admin/reset-password', validateAdminResetPassword, authController.resetAdminPassword);

/**
 * Token upkeep. Both are deliberately open: refresh is proved by the refresh
 * token rather than by an access token, and anyone reaching either one has an
 * access token that has probably already expired.
 */
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

router.get('/me', authenticate, authController.me);

module.exports = router;
