/**
 * Auth over HTTP.
 *
 * A controller does three things and nothing else: read what the request
 * carries, hand it to a service, and shape what comes back. The rules live in
 * services/auth.service.js.
 */

const authService = require('../services/auth.service');
const { removeFile } = require('../services/storage.service');
const asyncHandler = require('../utils/asyncHandler');

/** The account as the apps read it — never the whole document. */
const toAuthUser = (user, profile) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  phone: user.phone.number,
  gender: profile?.gender,
  avatarUrl: user.avatarUrl,
});

/**
 * POST /api/v1/auth/register — the app's two-step Create Account.
 *
 * The photo has already been stored by the upload middleware by the time this
 * runs, so a registration that is then refused takes the orphaned file with it.
 */
const register = asyncHandler(async (req, res) => {
  console.log('[auth] register request body:', req.body);

  try {
    const { user, profile, token } = await authService.registerUser({
      fullName: req.body.fullName,
      email: req.body.email,
      phone: req.body.phone,
      gender: req.body.gender,
      dateOfBirth: req.body.dateOfBirth,
      timeOfBirth: req.body.timeOfBirth,
      placeOfBirth: req.body.placeOfBirth,
      photoUrl: req.uploadedPhotoUrl,
    });

    res.status(201).json({ token, user: toAuthUser(user, profile) });
  } catch (error) {
    removeFile(req.file);
    throw error;
  }
});

module.exports = { register };
