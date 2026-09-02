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

const { MAX_UPLOAD_MB } = require('../config/constants');
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
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
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

/**
 * Documents and bank proofs — a scan of an Aadhaar card or a cancelled cheque.
 * A PDF is allowed here as well as an image, because that is what a bank hands
 * people.
 */
const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'];

const documentFilter = (req, file, done) => {
  if (!DOCUMENT_TYPES.includes(file.mimetype)) {
    done(ApiError.badRequest('Upload an image or a PDF.'));
    return;
  }
  done(null, true);
};

/**
 * Records the whole file, not just its URL, as `req.uploadedFile` — documents
 * are stored as a fileSchema (see models/common.js) so they keep their name,
 * type and size for the admin reviewing them.
 */
function attachUploadedFile(req, res, next) {
  if (req.file) {
    req.uploadedFile = {
      url: publicUrlFor(req.file, req),
      key: req.file.filename,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
    };
  }
  next();
}

/** What the Documents and Bank Details screens send their scan as. */
const uploadDocument = [
  multer({
    storage: storageFor('documents'),
    fileFilter: documentFilter,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  }).single('file'),
  attachUploadedFile,
];

module.exports = {
  uploadProfilePhoto,
  uploadDocument,
  singleImage,
  attachUploadedUrl,
  attachUploadedFile,
  IMAGE_TYPES,
  DOCUMENT_TYPES,
};
