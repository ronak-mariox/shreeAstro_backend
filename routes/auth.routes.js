/** /api/v1/auth — endpoint declarations only. */

const express = require('express');

const authController = require('../controllers/auth.controller');
const { uploadProfilePhoto } = require('../middlewares/upload.middleware');
const { validateRegister } = require('../validators/auth.validator');

const router = express.Router();

/**
 * Create Account. The photo arrives with the fields, so the multipart parser
 * runs first — without it `req.body` would be empty and every field would
 * read as missing.
 */
router.post('/register', uploadProfilePhoto, validateRegister, authController.register);

module.exports = router;
