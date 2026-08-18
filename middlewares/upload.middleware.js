/**
 * Multipart parsing.
 *
 * The apps submit forms that carry an image — Create Account sends the profile
 * photo alongside its fields — so those routes need a multipart parser ahead of
 * validation, or the text fields never reach `req.body` at all.
 *
 * Only the routes that expect a file mount this; everything else stays on the
 * JSON parser.
 */

const crypto = require('crypto');
const path = require('path');

const multer = require('multer');

const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { ensureUploadDir, publicUrlFor } = require('../services/storage.service');

/** What an image upload may be. HEIC is what an iPhone hands over by default. */
const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

/**
 * A file is stored under a name of our own making — an uploaded filename is
 * user input, and must never be trusted to build a path.
 */
const storageFor = subdirectory =>
  multer.diskStorage({
    destination(req, file, done) {
      try {
        done(null, ensureUploadDir(subdirectory));
      } catch (error) {
        done(error);
      }
    },
    filename(req, file, done) {
      const extension = path.extname(file.originalname).toLowerCase().slice(0, 10);
      done(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`);
    },
  });

const imageFilter = (req, file, done) => {
  if (!IMAGE_TYPES.includes(file.mimetype)) {
    done(ApiError.badRequest('Upload a JPEG, PNG, WebP or HEIC image.'));
    return;
  }
  done(null, true);
};

/** One optional image on the named field, stored under `uploads/<folder>`. */
const singleImage = (field, folder) =>
  multer({
    storage: storageFor(folder),
    fileFilter: imageFilter,
    limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1 },
  }).single(field);

/**
 * Hands the stored file's URL to the controller as `req.uploadedPhotoUrl`, so
 * nothing downstream has to know where files are kept.
 */
function attachUploadedUrl(req, res, next) {
  if (req.file) {
    req.uploadedPhotoUrl = publicUrlFor(req.file, req);
  }
  next();
}

/** What Create Account and Edit Profile send their photo as. */
const uploadProfilePhoto = [singleImage('photo', 'profiles'), attachUploadedUrl];

module.exports = { uploadProfilePhoto, singleImage, attachUploadedUrl, IMAGE_TYPES };
