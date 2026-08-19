/**
 * The step that turns express-validator's findings into a response.
 *
 * A validation chain — `body('email').isEmail()` — does not answer the request
 * when it fails. It only records what was wrong on `req`, and calls `next()`
 * either way. Something has to read those records and decide, and this is it.
 *
 * So every validator in validators/ ends with this middleware, after its
 * chains. Without it a bad request would sail straight through to the
 * controller as if nothing had happened.
 */

const { validationResult } = require('express-validator');

const ApiError = require('../utils/ApiError');

function validate(req, res, next) {
  const result = validationResult(req);

  if (result.isEmpty()) {
    return next();
  }

  /**
   * One message per field — `onlyFirstError` keeps the first thing that was
   * wrong with each. The apps print these under the input they belong to, and
   * a second message for the same input has nowhere to go.
   */
  const fields = {};
  for (const error of result.array({ onlyFirstError: true })) {
    fields[error.path] = error.msg;
  }

  return next(ApiError.unprocessable('Please check the form.', fields));
}

module.exports = { validate };
