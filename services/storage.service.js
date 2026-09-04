/**
 * Where uploaded files live.
 *
 * Everything that stores or links a file goes through here, so moving from the
 * local disk to S3 or Cloudinary later is a change to this one module: the
 * routes, controllers and services above it only ever see a URL.
 */

const fs = require('fs');
const path = require('path');

const env = require('../config/env');
const { UPLOAD_DIR } = require('../config/constants');
const s3Service = require('./s3.service');

/** Absolute path of the upload directory, created on first use. */
const uploadRoot = path.isAbsolute(UPLOAD_DIR)
  ? UPLOAD_DIR
  : path.join(__dirname, '..', UPLOAD_DIR);

function ensureUploadDir(subdirectory = '') {
  const target = path.join(uploadRoot, subdirectory);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/**
 * The URL a stored file is served from.
 *
 * An S3-backed upload (see middlewares/upload.middleware.js) already carries
 * its final public URL in `file.path`, so this only needs to build one for a
 * local file. In production PUBLIC_URL fixes the origin; in development it is
 * taken from the request, because the same server is `10.0.2.2` to an Android
 * emulator and `127.0.0.1` to an iOS one.
 */
function publicUrlFor(file, req) {
  if (!file) {
    return undefined;
  }

  if (file.storage === 's3') {
    return file.path;
  }

  const relative = path
    .relative(uploadRoot, file.path)
    .split(path.sep)
    .join('/');
  const origin = env.publicUrl || `${req.protocol}://${req.get('host')}`;

  return `${origin}/uploads/${relative}`;
}

/** Deletes a stored file; used when a write fails after the upload landed. */
function removeFile(file) {
  if (!file) {
    return;
  }
  if (file.storage === 's3') {
    s3Service.remove(file.key);
    return;
  }
  if (file.path) {
    fs.promises.unlink(file.path).catch(() => {});
  }
}

module.exports = { uploadRoot, ensureUploadDir, publicUrlFor, removeFile };
