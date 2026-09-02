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
 * In production PUBLIC_URL fixes the origin; in development it is taken from
 * the request, because the same server is `10.0.2.2` to an Android emulator and
 * `127.0.0.1` to an iOS one.
 */
function publicUrlFor(file, req) {
  if (!file) {
    return undefined;
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
  if (file?.path) {
    fs.promises.unlink(file.path).catch(() => {});
  }
}

module.exports = { uploadRoot, ensureUploadDir, publicUrlFor, removeFile };
