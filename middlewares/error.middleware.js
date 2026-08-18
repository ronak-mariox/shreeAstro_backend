/**
 * The last two middlewares in the stack: what answers an unknown route, and
 * what turns anything thrown along the way into a response.
 */

const multer = require('multer');

const ApiError = require('../utils/ApiError');
const env = require('../config/env');

/** Nothing matched, so the route does not exist. */
function notFound(req, res, next) {
  next(ApiError.notFound(`No route for ${req.method} ${req.originalUrl}`));
}

/**
 * One place decides what a client is told. An {@link ApiError} was raised on
 * purpose and carries its own message; anything else is a bug, and is logged in
 * full while the caller only ever sees a plain 500.
 */
// eslint-disable-next-line no-unused-vars -- express needs the 4th argument.
function errorHandler(error, req, res, next) {
  /** A refused upload is the caller's problem, so it is reported as one. */
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `That image is too large — keep it under ${env.maxUploadMb} MB.`
        : 'That upload could not be accepted.';
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({ error: message, fields: { photo: message } });
    return;
  }

  const isOperational = error instanceof ApiError;

  if (!isOperational) {
    console.error('[error]', error);
  }

  const status = isOperational ? error.status : 500;
  const body = {
    error: isOperational ? error.message : 'Something went wrong.',
  };

  if (isOperational && error.fields) {
    body.fields = error.fields;
  }
  /** The stack is useful while developing and dangerous in production. */
  if (!env.isProduction && !isOperational) {
    body.stack = error.stack;
  }

  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
