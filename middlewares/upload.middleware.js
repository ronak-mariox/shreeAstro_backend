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
const fs = require('fs');
const path = require('path');

const multer = require('multer');

const { MAX_UPLOAD_MB } = require('../config/constants');
const ApiError = require('../utils/ApiError');
const { ensureUploadDir, publicUrlFor } = require('../services/storage.service');
const s3Service = require('../services/s3.service');

/** What an image upload may be. HEIC is what an iPhone hands over by default. */
const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

/** An uploaded filename is user input, and must never be trusted to build a path. */
function generatedFilename(originalname) {
  const extension = path.extname(originalname).toLowerCase().slice(0, 10);
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`;
}

/**
 * A multer storage engine that writes to AWS S3 when it is configured on the
 * Third Parties tab, and to local disk — exactly as this always has — when it
 * is not. The choice is made per file, at the moment it is actually received,
 * so turning S3 on or off in the panel takes effect on the very next upload
 * with no restart.
 */
class HybridStorage {
  constructor(subdirectory) {
    this.subdirectory = subdirectory;
  }

  async _handleFile(req, file, done) {
    const filename = generatedFilename(file.originalname);

    /**
     * Falls back to local disk on any failure to check — including a slow or
     * unreachable database — rather than failing the upload outright. This is
     * what keeps an upload working exactly as it always has when S3 was never
     * configured in the first place.
     */
    const useS3 = await s3Service.isConfigured().catch(error => {
      console.error('[upload] could not check S3 configuration, using local disk:', error.message);
      return false;
    });

    if (useS3) {
      const chunks = [];
      file.stream.on('data', chunk => chunks.push(chunk));
      file.stream.on('error', done);
      file.stream.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const key = `${this.subdirectory}/${filename}`;
          const url = await s3Service.upload({ buffer, key, contentType: file.mimetype });
          done(null, { filename, path: url, key, size: buffer.length, storage: 's3' });
        } catch (error) {
          done(error);
        }
      });
      return;
    }

    /** Local disk — today's behavior, unchanged. */
    let destination;
    try {
      destination = ensureUploadDir(this.subdirectory);
    } catch (error) {
      done(error);
      return;
    }

    const target = path.join(destination, filename);
    const outStream = fs.createWriteStream(target);
    file.stream.on('error', done);
    outStream.on('error', done);
    file.stream.pipe(outStream);
    outStream.on('finish', () => {
      done(null, { filename, path: target, size: outStream.bytesWritten, storage: 'local' });
    });
  }

  _removeFile(req, file, done) {
    if (file.storage === 's3' && file.key) {
      s3Service.remove(file.key).then(() => done(null)).catch(done);
      return;
    }
    if (file.path) {
      fs.unlink(file.path, () => done(null));
      return;
    }
    done(null);
  }
}

const storageFor = subdirectory => new HybridStorage(subdirectory);

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

/** The same, for an article's cover image — a different name so a form that carries both never mixes them up. */
function attachUploadedCoverUrl(req, res, next) {
  if (req.file) {
    req.uploadedCoverUrl = publicUrlFor(req.file, req);
  }
  next();
}

/** What Create Account and Edit Profile send their photo as. */
const uploadProfilePhoto = [singleImage('photo', 'profiles'), attachUploadedUrl];

/**
 * One portfolio photo for the Edit Profile gallery — separate from the single
 * profile photo above. Recorded as a whole file (not just a URL), the same as
 * a document, so it can be listed with its own metadata.
 */
const uploadGalleryImage = [singleImage('image', 'gallery'), attachUploadedFile];

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
      /** The S3 object key when stored there; otherwise the local filename. */
      key: req.file.key || req.file.filename,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
    };
  }
  next();
}

/**
 * Several optional images on named fields in one form — a testimonial's
 * `avatar` and `thumbnail`. Their URLs land on `req.uploadedUrls[field]`.
 */
const multipleImages = (fields, folder) =>
  multer({
    storage: storageFor(folder),
    fileFilter: imageFilter,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: fields.length },
  }).fields(fields.map(name => ({ name, maxCount: 1 })));

function attachUploadedUrls(req, res, next) {
  req.uploadedUrls = {};
  for (const [field, files] of Object.entries(req.files || {})) {
    if (files && files[0]) {
      req.uploadedUrls[field] = publicUrlFor(files[0], req);
    }
  }
  next();
}

/** How many gallery files one product form may carry; the product itself caps the gallery at 8. */
const PRODUCT_GALLERY_PER_REQUEST = 6;

/**
 * A product's cover (`image`, one) and gallery (`images`, up to six) in one
 * form, all stored under `uploads/products`. Both optional.
 */
const productImages = () =>
  multer({
    storage: storageFor('products'),
    fileFilter: imageFilter,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: PRODUCT_GALLERY_PER_REQUEST + 1 },
  }).fields([
    { name: 'image', maxCount: 1 },
    { name: 'images', maxCount: PRODUCT_GALLERY_PER_REQUEST },
  ]);

/**
 * The cover lands on `req.uploadedPhotoUrl` — the same name a single-image
 * form uses, so the controller reads it the same way — and the gallery on
 * `req.uploadedImageUrls` (always an array, empty when none were sent).
 * `req.uploadedFiles` keeps the raw files so a refused write can discard them.
 */
function attachUploadedProductImages(req, res, next) {
  const cover = req.files?.image?.[0];
  const gallery = req.files?.images || [];
  if (cover) {
    req.uploadedPhotoUrl = publicUrlFor(cover, req);
  }
  req.uploadedImageUrls = gallery.map(file => publicUrlFor(file, req));
  req.uploadedFiles = [...(cover ? [cover] : []), ...gallery];
  next();
}

/** How many photos a product review may carry. */
const REVIEW_IMAGES_MAX = 3;

/**
 * A buyer's photos on a product review — `images`, up to three, stored under
 * `uploads/reviews`. Optional; the review body itself is plain multipart text.
 */
const reviewImages = () =>
  multer({
    storage: storageFor('reviews'),
    fileFilter: imageFilter,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: REVIEW_IMAGES_MAX },
  }).array('images', REVIEW_IMAGES_MAX);

/** Their URLs land on `req.uploadedImageUrls` (always an array); `req.uploadedFiles` lets a refused review discard them. */
function attachUploadedReviewImages(req, res, next) {
  const files = req.files || [];
  req.uploadedImageUrls = files.map(file => publicUrlFor(file, req));
  req.uploadedFiles = files;
  next();
}

/** A resume: a PDF or a Word document, alongside the image types a scan may be. */
const RESUME_TYPES = [
  ...DOCUMENT_TYPES,
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const RESUME_MAX_MB = 5;

const resumeFilter = (req, file, done) => {
  if (!RESUME_TYPES.includes(file.mimetype)) {
    done(ApiError.badRequest('Upload a PDF or Word document.'));
    return;
  }
  done(null, true);
};

/** What the careers page's application form sends its CV as — field `resume`, optional. */
const uploadResume = [
  multer({
    storage: storageFor('resumes'),
    fileFilter: resumeFilter,
    limits: { fileSize: RESUME_MAX_MB * 1024 * 1024, files: 1 },
  }).single('resume'),
  attachUploadedFile,
];

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
  uploadGalleryImage,
  uploadDocument,
  uploadResume,
  singleImage,
  multipleImages,
  productImages,
  reviewImages,
  attachUploadedReviewImages,
  REVIEW_IMAGES_MAX,
  attachUploadedUrl,
  attachUploadedProductImages,
  attachUploadedCoverUrl,
  attachUploadedUrls,
  attachUploadedFile,
  IMAGE_TYPES,
  DOCUMENT_TYPES,
  RESUME_TYPES,
};
